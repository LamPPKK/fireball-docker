import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

import WebSocket from "ws";

import { DevelopmentAuthenticator } from "../dist/src/auth/authenticator.js";
import { buildApp } from "../dist/src/app.js";
import { SessionService } from "../dist/src/domain/session-service.js";
import { DockerEngineRuntime } from "../dist/src/runtime/docker-engine-runtime.js";
import { readSessionSeccompProfile } from "../dist/src/runtime/seccomp-profile.js";
import { SignalingConnectionRegistry } from "../dist/src/signaling/connection-registry.js";
import { SignalingGateway } from "../dist/src/signaling/signaling-gateway.js";
import { WebSocketSignalingConnector } from "../dist/src/signaling/upstream-connector.js";

const image = process.argv[2];
const platform = process.argv[3];
const appArmorProfile = process.env.FIREBALL_SMOKE_APPARMOR_PROFILE;
const seccompProfilePath = process.env.FIREBALL_SMOKE_SECCOMP_PROFILE;
const allowedOrigin = "http://127.0.0.1:8787";

if (typeof image !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/@:-]{0,254}$/.test(image)) {
  throw new Error("usage: node real-restart-crash-gate.mjs <image> <linux/amd64|linux/arm64>");
}
if (!["linux/amd64", "linux/arm64"].includes(platform)) {
  throw new Error("real restart/crash gate platform is unsupported");
}
if (!appArmorProfile || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(appArmorProfile)) {
  throw new Error("FIREBALL_SMOKE_APPARMOR_PROFILE is required");
}
if (!seccompProfilePath || !/^\/[A-Za-z0-9._/-]+$/.test(seccompProfilePath)) {
  throw new Error("FIREBALL_SMOKE_SECCOMP_PROFILE must be a safe absolute path");
}

const suffix = randomBytes(6).toString("hex");
const instanceId = `restart-crash-${suffix}`;
const seccompProfile = await readSessionSeccompProfile(seccompProfilePath);
const runtimes = [];
let currentApp;
let currentRuntime;
let baseUrl;
let publicSocket;

try {
  const first = createStack(createRuntime());
  currentRuntime = first.runtime;
  currentApp = first.app;
  assert.deepEqual(await currentRuntime.reconcile(), { containersRemoved: 0, networksRemoved: 0 });
  baseUrl = await currentApp.listen({ host: "127.0.0.1", port: 0 });

  const abandoned = await createSession("restart", "alice");
  assert.equal(managedContainers().length, 1, "restart fixture container was not created");
  assert.equal(managedNetworks().length, 1, "restart fixture network was not created");

  await currentApp.close();
  currentApp = undefined;
  baseUrl = undefined;

  const restarted = createStack(createRuntime());
  currentRuntime = restarted.runtime;
  currentApp = restarted.app;
  assert.deepEqual(
    await currentRuntime.reconcile(),
    { containersRemoved: 1, networksRemoved: 1 },
    "orchestrator restart did not reconcile the abandoned session",
  );
  assert.equal(managedContainers().length, 0, "container survived restart reconciliation");
  assert.equal(managedNetworks().length, 0, "network survived restart reconciliation");
  baseUrl = await currentApp.listen({ host: "127.0.0.1", port: 0 });
  await expectSessionMissing("restart", "alice", abandoned.session.id);
  await expectTicketRevoked(abandoned.signalingTicket);

  const afterRestart = await createSession("restart", "alice");
  assert.notEqual(afterRestart.session.id, abandoned.session.id, "restart reused an abandoned session id");
  await burnSession("restart", "alice", afterRestart.session.id);
  assertNoResidue("restart replacement burn");

  const crashed = await createSession("crash", "bob");
  const crashContainer = containerFor(managedContainers(), "crash", crashed.session.id);
  assert.equal(crashContainer.HostConfig?.RestartPolicy?.Name, "no");
  assert.equal(crashContainer.HostConfig?.RestartPolicy?.MaximumRetryCount, 0);
  const token = await exchangeTicket(crashed.signalingTicket);
  publicSocket = await authenticatePublic(token, crashed.session.id);
  const staleTicket = await issueTicket("crash", "bob", crashed.session.id);

  const socketClosed = nextClose(publicSocket);
  killPipeline(crashContainer.Id);
  const stopped = await waitForContainerStopped(crashContainer.Id);
  const close = await socketClosed;
  publicSocket = undefined;
  assert.equal(close.code, 1011, `pipeline crash closed signaling with ${close.code}: ${close.reason}`);
  assert.match(close.reason, /upstream (?:closed|failed)/);
  assert.equal(stopped.State?.Running, false, "crashed pipeline container is still running");
  assert.notEqual(stopped.State?.ExitCode, 0, "crashed pipeline container exited successfully");
  assert.equal(stopped.RestartCount, 0, "Docker restarted a failed session container");

  await expectSessionFailed("crash", "bob", crashed.session.id, "runtime stopped unexpectedly");
  await expectTicketRevoked(staleTicket.signalingTicket);
  await burnSession("crash", "bob", crashed.session.id);
  assertNoResidue("pipeline crash burn");

  const recovered = await createSession("crash", "bob");
  assert.notEqual(recovered.session.id, crashed.session.id, "crash recovery reused the failed session id");
  const recoveredContainer = containerFor(managedContainers(), "crash", recovered.session.id);
  assert.equal(recoveredContainer.State?.Health?.Status, "healthy");
  await burnSession("crash", "bob", recovered.session.id);
  assertNoResidue("crash replacement burn");

  process.stdout.write(`real orchestrator restart and pipeline crash containment gate passed for ${platform}\n`);
} catch (error) {
  reportManagedContainerLogs();
  throw error;
} finally {
  publicSocket?.terminate();
  await currentApp?.close().catch(() => {});
  for (const runtime of runtimes) await runtime.reconcile().catch(() => {});
}

function createRuntime() {
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
  runtimes.push(runtime);
  return runtime;
}

function createStack(runtime) {
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
  return {
    runtime,
    app: buildApp({
      authenticator: new DevelopmentAuthenticator("test"),
      sessions,
      signaling: new SignalingGateway(
        sessions,
        new WebSocketSignalingConnector(),
        connections,
      ),
      signalingAllowedOrigins: new Set([allowedOrigin]),
    }),
  };
}

async function createSession(tenant, subject) {
  const response = await request("/orchestrator/v1/sessions", {
    method: "POST",
    headers: authorization(tenant, subject),
  });
  await assertResponseStatus(response, 201);
  return await response.json();
}

async function issueTicket(tenant, subject, sessionId) {
  const response = await request(`/orchestrator/v1/sessions/${sessionId}/signaling/tickets`, {
    method: "POST",
    headers: authorization(tenant, subject),
  });
  await assertResponseStatus(response, 201);
  return await response.json();
}

async function exchangeTicket(ticket) {
  const response = await request("/orchestrator/v1/signaling/tickets/exchange", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ticket }),
  });
  await assertResponseStatus(response, 200);
  return (await response.json()).signalingToken;
}

async function burnSession(tenant, subject, sessionId) {
  const response = await request(`/orchestrator/v1/sessions/${sessionId}`, {
    method: "DELETE",
    headers: authorization(tenant, subject),
  });
  await assertResponseStatus(response, 204);
}

async function expectSessionMissing(tenant, subject, sessionId) {
  const response = await request(`/orchestrator/v1/sessions/${sessionId}`, {
    method: "GET",
    headers: authorization(tenant, subject),
  });
  assert.equal(response.status, 404, "abandoned session survived orchestrator restart");
}

async function expectSessionFailed(tenant, subject, sessionId, failure) {
  const response = await request(`/orchestrator/v1/sessions/${sessionId}`, {
    method: "GET",
    headers: authorization(tenant, subject),
  });
  await assertResponseStatus(response, 200);
  const body = await response.json();
  assert.equal(body.session?.id, sessionId, "failed session response changed identity");
  assert.equal(body.session?.phase, "failed", "stopped runtime remained active in the public API");
  assert.equal(body.session?.failure, failure, "stopped runtime returned an unexpected failure reason");
}

async function expectTicketRevoked(ticket) {
  const response = await request("/orchestrator/v1/signaling/tickets/exchange", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ticket }),
  });
  assert.equal(response.status, 401, "stale signaling ticket remained usable");
}

async function request(path, options) {
  assert.ok(baseUrl);
  return await fetch(new URL(path, baseUrl), {
    ...options,
    signal: AbortSignal.timeout(180_000),
  });
}

async function assertResponseStatus(response, expectedStatus) {
  if (response.status === expectedStatus) return;
  const body = await response.text();
  assert.equal(response.status, expectedStatus, body);
}

async function authenticatePublic(token, expectedSessionId) {
  assert.ok(baseUrl);
  const endpoint = new URL("/orchestrator/v1/signaling", baseUrl);
  endpoint.protocol = "ws:";
  const socket = await openSocket(endpoint.href);
  socket.send(JSON.stringify({ type: "authenticate", token }));
  const frame = JSON.parse(await nextMessage(socket));
  assert.deepEqual(frame, { type: "ready", sessionId: expectedSessionId });
  return socket;
}

function openSocket(endpoint) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint, {
      origin: allowedOrigin,
      followRedirects: false,
      handshakeTimeout: 5_000,
      maxPayload: 64 * 1024,
      perMessageDeflate: false,
    });
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("timed out opening WebSocket"));
    }, 10_000);
    socket.once("open", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function nextMessage(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for WebSocket message")), 10_000);
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
      reject(new Error(`WebSocket closed before message (${code}: ${reason.toString("utf8")})`));
    });
  });
}

function nextClose(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("timed out waiting for WebSocket close"));
    }, 20_000);
    socket.once("close", (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString("utf8") });
    });
    socket.once("error", () => {
      // The close event carries the relay's authoritative terminal code.
    });
  });
}

function killPipeline(containerId) {
  const program = [
    "const fs=require('fs');let killed=0;",
    "for(const name of fs.readdirSync('/proc')){if(!/^\\d+$/.test(name))continue;try{",
    "const argv=fs.readFileSync('/proc/'+name+'/cmdline').toString('utf8').split('\\0');",
    "if(argv[0]==='/usr/bin/fireball-session-runtime'){process.kill(Number(name),'SIGKILL');killed++;}",
    "}catch{}}",
    "if(killed!==1){process.stderr.write('expected one Fireball native runtime, killed '+killed+'\\n');process.exit(42)}",
  ].join("");
  docker(["exec", containerId, "/usr/bin/node", "-e", program]);
}

async function waitForContainerStopped(containerId) {
  let diagnostic = "container state unavailable";
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const inspect = JSON.parse(docker(["inspect", containerId]))[0];
    diagnostic = JSON.stringify(inspect.State);
    if (inspect.State?.Running === false) return inspect;
    await delay(200);
  }
  throw new Error(`pipeline crash did not stop the container: ${diagnostic}`);
}

function managedContainers() {
  const ids = docker([
    "ps", "--all", "--quiet",
    "--filter", "label=dev.fireball.managed=true",
    "--filter", `label=dev.fireball.instance=${instanceId}`,
  ]).split("\n").filter(Boolean);
  if (ids.length === 0) return [];
  return JSON.parse(docker(["inspect", ...ids]));
}

function managedNetworks() {
  return docker([
    "network", "ls", "--quiet",
    "--filter", "label=dev.fireball.managed=true",
    "--filter", `label=dev.fireball.instance=${instanceId}`,
  ]).split("\n").filter(Boolean);
}

function containerFor(containers, tenant, sessionId) {
  const container = containers.find((candidate) => (
    candidate.Config?.Labels?.["dev.fireball.tenant"] === tenant
    && candidate.Config?.Labels?.["dev.fireball.session"] === sessionId
  ));
  assert.ok(container, `container for ${tenant} was not found`);
  assert.equal(container.State?.Health?.Status, "healthy");
  return container;
}

function assertNoResidue(stage) {
  assert.equal(managedContainers().length, 0, `${stage}: managed containers remain`);
  assert.equal(managedNetworks().length, 0, `${stage}: managed networks remain`);
}

function authorization(tenant, subject) {
  return { authorization: `Bearer dev:${tenant}:${subject}` };
}

function reportManagedContainerLogs() {
  try {
    for (const container of managedContainers()) {
      const logs = docker(["logs", container.Id], { allowFailure: true });
      if (logs) process.stderr.write(`--- ${container.Name} restart/crash logs ---\n${logs}\n`);
    }
  } catch (error) {
    process.stderr.write(`unable to collect restart/crash logs: ${errorMessage(error)}\n`);
  }
}

function docker(arguments_, { allowFailure = false } = {}) {
  const result = spawnSync("docker", arguments_, {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: 180_000,
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join("").trim();
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`docker ${arguments_[0]} failed (${result.status}): ${output}`);
  }
  return output;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : "unknown error";
}
