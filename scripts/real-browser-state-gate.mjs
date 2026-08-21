import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

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
  throw new Error("usage: node real-browser-state-gate.mjs <image> <linux/amd64|linux/arm64>");
}
if (!["linux/amd64", "linux/arm64"].includes(platform)) {
  throw new Error("real browser-state gate platform is unsupported");
}
if (!appArmorProfile || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(appArmorProfile)) {
  throw new Error("FIREBALL_SMOKE_APPARMOR_PROFILE is required");
}
if (!seccompProfilePath || !/^\/[A-Za-z0-9._/-]+$/.test(seccompProfilePath)) {
  throw new Error("FIREBALL_SMOKE_SECCOMP_PROFILE must be a safe absolute path");
}

const suffix = randomBytes(6).toString("hex");
const instanceId = `browser-state-${suffix}`;
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
  signalingAllowedOrigins: new Set([allowedOrigin]),
});

let baseUrl;

try {
  assert.deepEqual(await runtime.reconcile(), { containersRemoved: 0, networksRemoved: 0 });
  baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });

  const alpha = await createSession("alpha", "alice");
  const beta = await createSession("beta", "bob");
  assert.notEqual(alpha.session.id, beta.session.id);

  let containers = managedContainers(instanceId);
  assert.equal(containers.length, 2, "browser-state gate did not create two containers");
  const alphaContainer = containerFor(containers, "alpha", alpha.session.id);
  const betaContainer = containerFor(containers, "beta", beta.session.id);
  const initialAlpha = await waitForReport(alphaContainer.Id, 0);
  const initialBeta = await waitForReport(betaContainer.Id, 0);
  assertEmptyState(initialAlpha);
  assertEmptyState(initialBeta);

  const alphaMarker = `alpha-${randomBytes(12).toString("hex")}`;
  const betaMarker = `beta-${randomBytes(12).toString("hex")}`;

  sendCommand(alphaContainer.Id, { sequence: 1, action: "seed", marker: alphaMarker });
  assertMarkerState(await waitForReport(alphaContainer.Id, 1), alphaMarker);
  sendCommand(betaContainer.Id, { sequence: 1, action: "observe" });
  assertEmptyState(await waitForReport(betaContainer.Id, 1));

  sendCommand(betaContainer.Id, { sequence: 2, action: "seed", marker: betaMarker });
  assertMarkerState(await waitForReport(betaContainer.Id, 2), betaMarker);
  sendCommand(alphaContainer.Id, { sequence: 2, action: "observe" });
  assertMarkerState(await waitForReport(alphaContainer.Id, 2), alphaMarker);

  await burnSession("alpha", "alice", alpha.session.id);
  await burnSession("beta", "bob", beta.session.id);
  assert.equal(managedContainers(instanceId).length, 0, "containers remain after browser-state burn");
  assert.equal(managedNetworks(instanceId).length, 0, "networks remain after browser-state burn");

  const replacement = await createSession("alpha", "alice");
  assert.notEqual(replacement.session.id, alpha.session.id, "burn reused the prior session identity");
  containers = managedContainers(instanceId);
  assert.equal(containers.length, 1, "replacement browser-state container is missing");
  const replacementContainer = containerFor(containers, "alpha", replacement.session.id);
  assertEmptyState(await waitForReport(replacementContainer.Id, 0));
  await burnSession("alpha", "alice", replacement.session.id);
  assert.equal(managedContainers(instanceId).length, 0, "replacement container remains after burn");
  assert.equal(managedNetworks(instanceId).length, 0, "replacement network remains after burn");

  process.stdout.write(`real cookie/localStorage/service-worker isolation and burn gate passed for ${platform}\n`);
} catch (error) {
  reportManagedContainerLogs(instanceId);
  throw error;
} finally {
  await app.close().catch(() => {});
  await runtime.reconcile().catch(() => {});
}

async function createSession(tenant, subject) {
  const response = await request("/orchestrator/v1/sessions", {
    method: "POST",
    headers: authorization(tenant, subject),
  });
  await assertResponseStatus(response, 201);
  return await response.json();
}

async function burnSession(tenant, subject, sessionId) {
  const response = await request(`/orchestrator/v1/sessions/${sessionId}`, {
    method: "DELETE",
    headers: authorization(tenant, subject),
  });
  await assertResponseStatus(response, 204);
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

function authorization(tenant, subject) {
  return { authorization: `Bearer dev:${tenant}:${subject}` };
}

function managedContainers(managedInstance) {
  const ids = docker([
    "ps", "--all", "--quiet",
    "--filter", "label=dev.fireball.managed=true",
    "--filter", `label=dev.fireball.instance=${managedInstance}`,
  ]).split("\n").filter(Boolean);
  if (ids.length === 0) return [];
  return JSON.parse(docker(["inspect", ...ids]));
}

function managedNetworks(managedInstance) {
  return docker([
    "network", "ls", "--quiet",
    "--filter", "label=dev.fireball.managed=true",
    "--filter", `label=dev.fireball.instance=${managedInstance}`,
  ]).split("\n").filter(Boolean);
}

function containerFor(containers, tenant, sessionId) {
  const container = containers.find((candidate) => (
    candidate.Config?.Labels?.["dev.fireball.tenant"] === tenant
    && candidate.Config?.Labels?.["dev.fireball.session"] === sessionId
  ));
  assert.ok(container, `browser-state container for ${tenant} was not found`);
  assert.equal(container.State?.Health?.Status, "healthy");
  return container;
}

function sendCommand(containerId, command) {
  const output = containerFetch(containerId, "/command", command);
  assert.deepEqual(JSON.parse(output), command);
}

async function waitForReport(containerId, sequence) {
  const deadline = Date.now() + 30_000;
  let diagnostic = "report unavailable";
  while (Date.now() < deadline) {
    const output = containerFetch(containerId, "/report", undefined, true);
    if (output.status === 0) {
      try {
        const document = JSON.parse(output.stdout);
        diagnostic = JSON.stringify(document);
        if (document.sequence === sequence) return document;
      } catch {
        diagnostic = output.stdout.slice(0, 256);
      }
    } else {
      diagnostic = output.stderr.slice(0, 256);
    }
    await delay(200);
  }
  throw new Error(`browser-state report ${sequence} timed out: ${diagnostic}`);
}

function containerFetch(containerId, path, body, allowFailure = false) {
  const program = [
    "const path=process.argv[1];const body=process.argv[2];",
    "const response=await fetch('http://127.0.0.1:18080'+path,{method:body?'POST':'GET',headers:body?{'content-type':'application/json'}:undefined,body:body||undefined,signal:AbortSignal.timeout(3000)});",
    "const text=await response.text();if(!response.ok){process.stderr.write(text);process.exit(42)}process.stdout.write(text);",
  ].join("");
  const arguments_ = [
    "exec", containerId, "/usr/bin/node", "--input-type=module", "--eval", program, path,
    body === undefined ? "" : JSON.stringify(body),
  ];
  if (allowFailure) return dockerResult(arguments_);
  return docker(arguments_);
}

function assertEmptyState(document) {
  assertReportShape(document);
  assert.equal(document.cookieMarker, "", "cookie crossed a tenant or burn boundary");
  assert.equal(document.localStorageMarker, "", "localStorage crossed a tenant or burn boundary");
  assert.equal(document.serviceWorkerRegistered, false, "service worker registration crossed a boundary");
  assert.equal(document.serviceWorkerMarker, "", "service worker state crossed a boundary");
}

function assertMarkerState(document, marker) {
  assertReportShape(document);
  assert.equal(document.cookieMarker, marker);
  assert.equal(document.localStorageMarker, marker);
  assert.equal(document.serviceWorkerRegistered, true);
  assert.equal(document.serviceWorkerMarker, marker);
}

function assertReportShape(document) {
  assert.deepEqual(Object.keys(document).sort(), [
    "cookieMarker",
    "error",
    "localStorageMarker",
    "schemaVersion",
    "sequence",
    "serviceWorkerMarker",
    "serviceWorkerRegistered",
    "serviceWorkerSupported",
  ]);
  assert.equal(document.schemaVersion, 1);
  assert.equal(document.serviceWorkerSupported, true, "WPE service workers are unavailable");
  assert.equal(document.error, "", document.error);
}

function reportManagedContainerLogs(managedInstance) {
  try {
    for (const container of managedContainers(managedInstance)) {
      const logs = docker(["logs", container.Id], { allowFailure: true });
      if (logs) process.stderr.write(`--- ${container.Name} browser-state logs ---\n${logs}\n`);
    }
  } catch (error) {
    process.stderr.write(`unable to collect browser-state logs: ${errorMessage(error)}\n`);
  }
}

function docker(arguments_, { allowFailure = false } = {}) {
  const result = dockerResult(arguments_);
  const output = [result.stdout, result.stderr].filter(Boolean).join("").trim();
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`docker ${arguments_[0]} failed (${result.status}): ${output}`);
  }
  return output;
}

function dockerResult(arguments_) {
  return spawnSync("docker", arguments_, {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: 180_000,
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : "unknown error";
}
