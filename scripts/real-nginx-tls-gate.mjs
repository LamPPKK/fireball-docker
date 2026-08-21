import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";

import WebSocket from "ws";

import { DevelopmentAuthenticator } from "../dist/src/auth/authenticator.js";
import { buildApp } from "../dist/src/app.js";
import { SessionService } from "../dist/src/domain/session-service.js";
import { DockerEngineRuntime } from "../dist/src/runtime/docker-engine-runtime.js";
import { readSessionSeccompProfile } from "../dist/src/runtime/seccomp-profile.js";
import { SignalingConnectionRegistry } from "../dist/src/signaling/connection-registry.js";
import { SignalingGateway } from "../dist/src/signaling/signaling-gateway.js";
import { WebSocketSignalingConnector } from "../dist/src/signaling/upstream-connector.js";
import { renderNginxConfig } from "./render-nginx-config.mjs";

const image = process.argv[2];
const platform = process.argv[3];
const appArmorProfile = process.env.FIREBALL_SMOKE_APPARMOR_PROFILE;
const seccompProfilePath = process.env.FIREBALL_SMOKE_SECCOMP_PROFILE;
const publicHost = "browser.fireball.test";
const publicOrigin = `https://${publicHost}`;

if (typeof image !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/@:-]{0,254}$/.test(image)) {
  throw new Error("usage: node real-nginx-tls-gate.mjs <image> <linux/amd64|linux/arm64>");
}
if (!["linux/amd64", "linux/arm64"].includes(platform)) {
  throw new Error("real Nginx/TLS gate platform is unsupported");
}
if (!appArmorProfile || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(appArmorProfile)) {
  throw new Error("FIREBALL_SMOKE_APPARMOR_PROFILE is required");
}
if (!seccompProfilePath || !/^\/[A-Za-z0-9._/-]+$/.test(seccompProfilePath)) {
  throw new Error("FIREBALL_SMOKE_SECCOMP_PROFILE must be a safe absolute path");
}

const suffix = randomBytes(6).toString("hex");
const instanceId = `nginx-tls-${suffix}`;
const directory = mkdtempSync(join(tmpdir(), "fireball-nginx-tls-"));
chmodSync(directory, 0o755);
const certificatePath = join(directory, "certificate.pem");
const certificateKeyPath = join(directory, "certificate-key.pem");
const includePath = join(directory, "fireball.conf");
const mainConfigPath = join(directory, "nginx.conf");
const pidPath = join(directory, "nginx.pid");
const seccompProfile = await readSessionSeccompProfile(seccompProfilePath);
const runtime = new DockerEngineRuntime({
  socketPath: "/var/run/docker.sock",
  apiVersion: "1.47",
  image,
  instanceId,
  appArmorProfile,
  seccompProfile,
  requestTimeoutMs: 60_000,
  startupHealthAttempts: 120,
  startupHealthIntervalMs: 1_000,
});
const connections = new SignalingConnectionRegistry();
const sessions = new SessionService(runtime, {
  maximumSessionsPerTenant: 1,
  hostCapacity: {
    maximumSessions: 2,
    memoryMiB: 1_024,
    cpuShares: 1_024,
    pids: 256,
  },
  revokeSignalingConnections: (sessionId) => connections.revoke(sessionId),
});
const app = buildApp({
  authenticator: new DevelopmentAuthenticator("test"),
  sessions,
  signaling: new SignalingGateway(
    sessions,
    new WebSocketSignalingConnector(),
    connections,
  ),
  signalingAllowedOrigins: new Set([publicOrigin]),
});

let nginxStarted = false;
let socket;

try {
  assert.deepEqual(await runtime.reconcile(), { containersRemoved: 0, networksRemoved: 0 });
  const internalUrl = new URL(await app.listen({ host: "127.0.0.1", port: 0 }));
  createCertificate();
  writeFileSync(includePath, renderNginxConfig({
    FIREBALL_PUBLIC_HOST: publicHost,
    FIREBALL_TLS_CERTIFICATE: certificatePath,
    FIREBALL_TLS_CERTIFICATE_KEY: certificateKeyPath,
    FIREBALL_UPSTREAM_PORT: internalUrl.port,
  }), { encoding: "utf8", mode: 0o644, flag: "wx" });
  writeFileSync(mainConfigPath, mainNginxConfig(), { encoding: "utf8", mode: 0o644, flag: "wx" });

  sudoNginx(["-t"]);
  sudoNginx([]);
  nginxStarted = true;
  const certificate = readFileSync(certificatePath);
  const health = await waitForHealth(certificate);
  assert.equal(health.statusCode, 204);
  assert.equal(health.tls.authorized, true, health.tls.authorizationError ?? "TLS authorization failed");
  assert.match(health.tls.protocol ?? "", /^TLSv1\.[23]$/);
  assert.equal(health.headers["strict-transport-security"], "max-age=31536000");
  assert.equal(health.headers["x-content-type-options"], "nosniff");

  await expectWrongOriginRejected(certificate);
  const created = await createSession(certificate);
  const token = await exchangeTicket(certificate, created.signalingTicket);
  socket = await authenticatePublic(certificate, token, created.session.id);
  const staleTicket = await issueTicket(certificate, created.session.id);
  const closed = nextClose(socket);
  await burnSession(certificate, created.session.id);
  const terminal = await closed;
  socket = undefined;
  assert.equal(terminal.code, 1008);
  assert.match(terminal.reason, /session ended/);
  await expectTicketRevoked(certificate, staleTicket.signalingTicket);
  assert.equal(managedContainers().length, 0, "TLS gate left a managed container");
  assert.equal(managedNetworks().length, 0, "TLS gate left a managed network");

  process.stdout.write(`real nginx -t and external TLS/WebSocket gate passed for ${platform}\n`);
} catch (error) {
  reportManagedContainerLogs();
  reportNginxLog();
  throw error;
} finally {
  socket?.terminate();
  await app.close().catch(() => {});
  await runtime.reconcile().catch(() => {});
  if (nginxStarted) sudoNginx(["-s", "quit"], true);
  await waitForNginxExit();
  command("sudo", ["chown", "-R", `${process.getuid()}:${process.getgid()}`, directory], true);
  rmSync(directory, { recursive: true, force: true });
}

function createCertificate() {
  command("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes", "-days", "1",
    "-subj", `/CN=${publicHost}`,
    "-addext", `subjectAltName=DNS:${publicHost}`,
    "-keyout", certificateKeyPath,
    "-out", certificatePath,
  ]);
  chmodSync(certificatePath, 0o644);
  chmodSync(certificateKeyPath, 0o600);
  command("openssl", ["x509", "-in", certificatePath, "-noout", "-checkend", "60"]);
}

function mainNginxConfig() {
  return [
    `pid ${pidPath};`,
    `error_log ${join(directory, "error.log")} info;`,
    "events { worker_connections 128; }",
    "http {",
    `  access_log ${join(directory, "access.log")};`,
    `  include ${includePath};`,
    "}",
    "",
  ].join("\n");
}

function sudoNginx(arguments_, allowFailure = false) {
  return command("sudo", [
    "nginx", "-p", `${directory}/`, "-c", "nginx.conf", ...arguments_,
  ], allowFailure);
}

async function waitForHealth(certificate) {
  let diagnostic = "TLS endpoint unavailable";
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await requestTls(certificate, "/healthz", { method: "GET" });
      if (response.statusCode === 204) return response;
      diagnostic = `${response.statusCode}: ${response.body}`;
    } catch (error) {
      diagnostic = errorMessage(error);
    }
    await delay(100);
  }
  throw new Error(`Nginx TLS health check timed out: ${diagnostic}`);
}

async function createSession(certificate) {
  const response = await requestTls(certificate, "/orchestrator/v1/sessions", {
    method: "POST",
    headers: authorization(),
  });
  assert.equal(response.statusCode, 201, response.body);
  return JSON.parse(response.body);
}

async function issueTicket(certificate, sessionId) {
  const response = await requestTls(
    certificate,
    `/orchestrator/v1/sessions/${sessionId}/signaling/tickets`,
    { method: "POST", headers: authorization() },
  );
  assert.equal(response.statusCode, 201, response.body);
  return JSON.parse(response.body);
}

async function exchangeTicket(certificate, ticket) {
  const response = await requestTls(certificate, "/orchestrator/v1/signaling/tickets/exchange", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ticket }),
  });
  assert.equal(response.statusCode, 200, response.body);
  return JSON.parse(response.body).signalingToken;
}

async function burnSession(certificate, sessionId) {
  const response = await requestTls(certificate, `/orchestrator/v1/sessions/${sessionId}`, {
    method: "DELETE",
    headers: authorization(),
  });
  assert.equal(response.statusCode, 204, response.body);
}

async function expectTicketRevoked(certificate, ticket) {
  const response = await requestTls(certificate, "/orchestrator/v1/signaling/tickets/exchange", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ticket }),
  });
  assert.equal(response.statusCode, 401, "burned ticket crossed the TLS deployment boundary");
}

function requestTls(certificate, path, { method, headers = {}, body = "" }) {
  return new Promise((resolve, reject) => {
    const request = httpsRequest({
      hostname: publicHost,
      port: 443,
      path,
      method,
      headers: {
        ...headers,
        ...(body === "" ? {} : { "content-length": Buffer.byteLength(body) }),
      },
      ca: certificate,
      servername: publicHost,
      lookup: loopbackLookup,
      timeout: 10_000,
    }, (response) => {
      const tls = {
        authorized: response.socket.authorized,
        authorizationError: response.socket.authorizationError,
        protocol: response.socket.getProtocol(),
      };
      const chunks = [];
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 64 * 1024) request.destroy(new Error("TLS response exceeds 64 KiB"));
        else chunks.push(chunk);
      });
      response.once("end", () => resolve({
        statusCode: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
        tls,
      }));
    });
    request.once("timeout", () => request.destroy(new Error("TLS request timed out")));
    request.once("error", reject);
    request.end(body);
  });
}

async function expectWrongOriginRejected(certificate) {
  const endpoint = `wss://${publicHost}/orchestrator/v1/signaling`;
  const status = await new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint, {
      ca: certificate,
      origin: "https://wrong.fireball.test",
      lookup: loopbackLookup,
      handshakeTimeout: 5_000,
      perMessageDeflate: false,
    });
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("wrong-origin WebSocket was not rejected"));
    }, 10_000);
    socket.once("unexpected-response", (_request, response) => {
      clearTimeout(timer);
      response.resume();
      resolve(response.statusCode);
    });
    socket.once("open", () => {
      clearTimeout(timer);
      socket.terminate();
      reject(new Error("wrong-origin WebSocket was accepted"));
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  assert.equal(status, 403);
}

async function authenticatePublic(certificate, token, sessionId) {
  const endpoint = `wss://${publicHost}/orchestrator/v1/signaling`;
  const socket = await new Promise((resolve, reject) => {
    const candidate = new WebSocket(endpoint, {
      ca: certificate,
      origin: publicOrigin,
      lookup: loopbackLookup,
      handshakeTimeout: 5_000,
      maxPayload: 64 * 1024,
      perMessageDeflate: false,
    });
    const timer = setTimeout(() => {
      candidate.terminate();
      reject(new Error("timed out opening TLS WebSocket"));
    }, 10_000);
    candidate.once("open", () => {
      clearTimeout(timer);
      resolve(candidate);
    });
    candidate.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  socket.send(JSON.stringify({ type: "authenticate", token }));
  assert.deepEqual(JSON.parse(await nextMessage(socket)), { type: "ready", sessionId });
  return socket;
}

function nextMessage(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for TLS WebSocket message")), 10_000);
    socket.once("message", (data) => {
      clearTimeout(timer);
      resolve(Buffer.from(data).toString("utf8"));
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once("close", (code, reason) => {
      clearTimeout(timer);
      reject(new Error(`TLS WebSocket closed before ready (${code}: ${reason.toString("utf8")})`));
    });
  });
}

function nextClose(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("timed out waiting for burned TLS WebSocket close"));
    }, 20_000);
    socket.once("close", (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString("utf8") });
    });
    socket.once("error", () => {
      // The close frame is the terminal relay result asserted by the gate.
    });
  });
}

function loopbackLookup(_hostname, options, callback) {
  if (typeof options === "object" && options?.all === true) {
    callback(null, [{ address: "127.0.0.1", family: 4 }]);
    return;
  }
  callback(null, "127.0.0.1", 4);
}

function managedContainers() {
  return managedDockerResources("ps", "--all");
}

function managedNetworks() {
  return managedDockerResources("network", "ls");
}

function managedDockerResources(...commandPrefix) {
  return docker([
    ...commandPrefix, "--quiet",
    "--filter", "label=dev.fireball.managed=true",
    "--filter", `label=dev.fireball.instance=${instanceId}`,
  ]).split("\n").filter(Boolean);
}

function reportManagedContainerLogs() {
  try {
    for (const container of managedContainers()) {
      const logs = docker(["logs", container], true);
      if (logs) process.stderr.write(`--- ${container} TLS gate logs ---\n${logs}\n`);
    }
  } catch (error) {
    process.stderr.write(`unable to collect TLS gate container logs: ${errorMessage(error)}\n`);
  }
}

function reportNginxLog() {
  try {
    const log = readFileSync(join(directory, "error.log"), "utf8");
    if (log) process.stderr.write(`--- nginx TLS gate log ---\n${log}\n`);
  } catch {
    // The config may have failed before Nginx created its log.
  }
}

async function waitForNginxExit() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      readFileSync(pidPath, "utf8");
    } catch {
      return;
    }
    await delay(100);
  }
}

function authorization() {
  return { authorization: "Bearer dev:tls:operator" };
}

function docker(arguments_, allowFailure = false) {
  return command("docker", arguments_, allowFailure);
}

function command(program, arguments_, allowFailure = false) {
  const result = spawnSync(program, arguments_, {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: 180_000,
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join("").trim();
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`${program} ${arguments_[0] ?? ""} failed (${result.status}): ${output}`);
  }
  return output;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : "unknown error";
}
