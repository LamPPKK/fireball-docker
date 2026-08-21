import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";

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
const iceServersFile = process.env.FIREBALL_SMOKE_ICE_SERVERS_FILE;
const allowedOrigin = "http://127.0.0.1:8787";

if (typeof image !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/@:-]{0,254}$/.test(image)) {
  throw new Error("usage: node real-isolation-gate.mjs <image> <linux/amd64|linux/arm64>");
}
if (!["linux/amd64", "linux/arm64"].includes(platform)) {
  throw new Error("real isolation gate platform is unsupported");
}
if (!appArmorProfile || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(appArmorProfile)) {
  throw new Error("FIREBALL_SMOKE_APPARMOR_PROFILE is required");
}
if (!seccompProfilePath || !/^\/[A-Za-z0-9._/-]+$/.test(seccompProfilePath)) {
  throw new Error("FIREBALL_SMOKE_SECCOMP_PROFILE must be a safe absolute path");
}
if (!iceServersFile || !/^\/[A-Za-z0-9._/-]+$/.test(iceServersFile)) {
  throw new Error("FIREBALL_SMOKE_ICE_SERVERS_FILE must be a safe absolute path");
}

const suffix = randomBytes(6).toString("hex");
const instanceId = `isolation-${suffix}`;
const seccompProfile = await readSessionSeccompProfile(seccompProfilePath);
const runtime = new DockerEngineRuntime({
  socketPath: "/var/run/docker.sock",
  apiVersion: "1.47",
  image,
  instanceId,
  appArmorProfile,
  seccompProfile,
  iceServersFile,
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

const sockets = new Set();
let baseUrl;

try {
  assert.deepEqual(await runtime.reconcile(), { containersRemoved: 0, networksRemoved: 0 });
  baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });

  const alpha = await createSession("alpha", "alice");
  const beta = await createSession("beta", "bob");
  assert.notEqual(alpha.session.id, beta.session.id);
  assert.notEqual(alpha.signalingTicket, beta.signalingTicket);
  assertPublicSession(alpha.session);
  assertPublicSession(beta.session);

  await expectTenantDenied("beta", "bob", alpha.session.id);
  await expectTenantDenied("alpha", "alice", beta.session.id);

  const containers = managedContainers(instanceId);
  assert.equal(containers.length, 2, "isolation gate did not create exactly two containers");
  const alphaContainer = containerFor(containers, "alpha", alpha.session.id);
  const betaContainer = containerFor(containers, "beta", beta.session.id);
  assertContainerBoundary(alphaContainer, alpha.session.id);
  assertContainerBoundary(betaContainer, beta.session.id);
  assert.notEqual(alphaContainer.Id, betaContainer.Id);
  assert.notEqual(alphaContainer.HostConfig.NetworkMode, betaContainer.HostConfig.NetworkMode);

  const alphaNamespaces = namespaceIdentity(alphaContainer.Id);
  const betaNamespaces = namespaceIdentity(betaContainer.Id);
  for (const name of ["pid", "net", "mnt"]) {
    assert.notEqual(alphaNamespaces[name], betaNamespaces[name], `${name} namespace is shared`);
  }

  const alphaMarker = `alpha-${randomBytes(12).toString("hex")}`;
  const betaMarker = `beta-${randomBytes(12).toString("hex")}`;
  writeRuntimeMarker(alphaContainer.Id, alphaMarker);
  writeRuntimeMarker(betaContainer.Id, betaMarker);
  assert.equal(readRuntimeMarker(alphaContainer.Id), alphaMarker);
  assert.equal(readRuntimeMarker(betaContainer.Id), betaMarker);

  startProcessMarker(alphaContainer.Id, alphaMarker);
  startProcessMarker(betaContainer.Id, betaMarker);
  const alphaProcesses = await waitForProcessMarker(alphaContainer.Id, alphaMarker);
  const betaProcesses = await waitForProcessMarker(betaContainer.Id, betaMarker);
  assert.match(alphaProcesses, new RegExp(alphaMarker));
  assert.doesNotMatch(alphaProcesses, new RegExp(betaMarker));
  assert.match(betaProcesses, new RegExp(betaMarker));
  assert.doesNotMatch(betaProcesses, new RegExp(alphaMarker));

  const alphaAddress = containerAddress(alphaContainer);
  const betaAddress = containerAddress(betaContainer);
  startNetworkMarker(alphaContainer.Id, alphaMarker);
  startNetworkMarker(betaContainer.Id, betaMarker);
  assertOwnNetworkMarker(alphaContainer.Id, alphaMarker);
  assertOwnNetworkMarker(betaContainer.Id, betaMarker);
  assertNetworkPeerIsUnreachable(alphaContainer.Id, betaAddress);
  assertNetworkPeerIsUnreachable(betaContainer.Id, alphaAddress);

  const alphaSecret = internalSecret(alphaContainer);
  const betaSecret = internalSecret(betaContainer);
  assert.notEqual(alphaSecret, betaSecret);
  await expectInternalAuthenticationRejected(internalEndpoint(alphaContainer), betaSecret);
  await expectInternalAuthenticationRejected(internalEndpoint(betaContainer), alphaSecret);

  const alphaToken = await exchangeTicket(alpha.signalingTicket);
  const betaToken = await exchangeTicket(beta.signalingTicket);
  const alphaSocket = await authenticatePublic(alphaToken, alpha.session.id);
  const betaSocket = await authenticatePublic(betaToken, beta.session.id);
  sockets.add(alphaSocket);
  sockets.add(betaSocket);

  const staleAlphaTicket = await issueTicket("alpha", "alice", alpha.session.id);
  const staleBetaTicket = await issueTicket("beta", "bob", beta.session.id);
  await closeSocket(alphaSocket);
  await closeSocket(betaSocket);
  sockets.delete(alphaSocket);
  sockets.delete(betaSocket);

  await burnSession("alpha", "alice", alpha.session.id);
  await burnSession("beta", "bob", beta.session.id);
  await expectTicketRevoked(staleAlphaTicket.signalingTicket);
  await expectTicketRevoked(staleBetaTicket.signalingTicket);
  assert.equal(managedContainers(instanceId).length, 0, "containers remain after burn");
  assert.equal(managedNetworks(instanceId).length, 0, "networks remain after burn");

  process.stdout.write(`real two-tenant isolation gate passed for ${platform}\n`);
} catch (error) {
  try {
    reportManagedContainerLogs(instanceId);
  } catch (reportError) {
    process.stderr.write(`unable to collect managed container logs: ${errorMessage(reportError)}\n`);
  }
  throw error;
} finally {
  for (const socket of sockets) socket.terminate();
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

async function expectTenantDenied(tenant, subject, sessionId) {
  for (const [method, suffix] of [
    ["GET", ""],
    ["POST", "/signaling/tickets"],
    ["DELETE", ""],
  ]) {
    const response = await request(`/orchestrator/v1/sessions/${sessionId}${suffix}`, {
      method,
      headers: authorization(tenant, subject),
    });
    assert.equal(response.status, 404, `cross-tenant ${method} was not denied`);
  }
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

async function issueTicket(tenant, subject, sessionId) {
  const response = await request(`/orchestrator/v1/sessions/${sessionId}/signaling/tickets`, {
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

async function expectTicketRevoked(ticket) {
  const response = await request("/orchestrator/v1/signaling/tickets/exchange", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ticket }),
  });
  assert.equal(response.status, 401);
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
  const socket = await openSocket(endpoint.href, { origin: allowedOrigin });
  socket.send(JSON.stringify({ type: "authenticate", token }));
  const frame = JSON.parse(await nextMessage(socket));
  assert.deepEqual(frame, { type: "ready", sessionId: expectedSessionId });
  return socket;
}

async function expectInternalAuthenticationRejected(endpoint, secret) {
  const socket = await openSocket(endpoint);
  socket.send(JSON.stringify({ type: "authenticate", secret }));
  const closed = await nextClose(socket);
  assert.equal(closed.code, 1008);
  assert.match(closed.reason, /authentication failed/);
}

function openSocket(endpoint, options = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint, {
      ...options,
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
    }, 10_000);
    socket.once("close", (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString("utf8") });
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function closeSocket(socket) {
  if (socket.readyState === WebSocket.CLOSED) return;
  const closed = nextClose(socket);
  socket.close(1000, "isolation gate complete");
  await closed;
}

function managedContainers(managedInstance) {
  const ids = docker([
    "ps",
    "--all",
    "--quiet",
    "--filter",
    "label=dev.fireball.managed=true",
    "--filter",
    `label=dev.fireball.instance=${managedInstance}`,
  ]).split("\n").filter(Boolean);
  if (ids.length === 0) return [];
  return JSON.parse(docker(["inspect", ...ids]));
}

function managedNetworks(managedInstance) {
  return docker([
    "network",
    "ls",
    "--quiet",
    "--filter",
    "label=dev.fireball.managed=true",
    "--filter",
    `label=dev.fireball.instance=${managedInstance}`,
  ]).split("\n").filter(Boolean);
}

function containerFor(containers, tenant, sessionId) {
  const container = containers.find((candidate) => (
    candidate.Config?.Labels?.["dev.fireball.tenant"] === tenant
    && candidate.Config?.Labels?.["dev.fireball.session"] === sessionId
  ));
  assert.ok(container, `container for ${tenant} was not found`);
  return container;
}

function assertContainerBoundary(container, sessionId) {
  assert.equal(container.Name, `/fireball-${sessionId}`);
  assert.equal(container.State?.Health?.Status, "healthy");
  assert.equal(container.Config?.User, "10001:10001");
  assert.equal(container.HostConfig?.ReadonlyRootfs, true);
  assert.equal(container.HostConfig?.PidMode, "");
  assert.deepEqual(container.HostConfig?.CapDrop, ["ALL"]);
  assert.equal(container.HostConfig?.Memory, 512 * 1024 * 1024);
  assert.equal(container.HostConfig?.CpuShares, 512);
  assert.equal(container.HostConfig?.PidsLimit, 128);
  assert.equal(container.HostConfig?.NetworkMode, `fireball-net-${sessionId}`);
  assert.equal(
    container.HostConfig?.Tmpfs?.["/run/fireball-session"],
    "rw,noexec,nosuid,nodev,size=256m,mode=0700,uid=10001,gid=10001",
  );
  assert.ok(container.HostConfig?.SecurityOpt?.includes("no-new-privileges:true"));
  assert.ok(container.HostConfig?.SecurityOpt?.includes(`apparmor=${appArmorProfile}`));
  assert.ok(container.HostConfig?.SecurityOpt?.some((value) => value.startsWith("seccomp=")));
  assert.equal(container.AppArmorProfile, appArmorProfile);
  const networks = Object.keys(container.NetworkSettings?.Networks ?? {});
  assert.deepEqual(networks, [`fireball-net-${sessionId}`]);
}

function namespaceIdentity(containerId) {
  return JSON.parse(docker([
    "exec",
    containerId,
    "node",
    "-e",
    "const fs=require('fs');console.log(JSON.stringify(Object.fromEntries(['pid','net','mnt'].map(n=>[n,fs.readlinkSync('/proc/self/ns/'+n)]))))",
  ]));
}

function writeRuntimeMarker(containerId, marker) {
  docker([
    "exec",
    containerId,
    "node",
    "-e",
    "require('fs').writeFileSync('/run/fireball-session/isolation-marker',process.argv[1],{mode:0o600})",
    marker,
  ]);
}

function readRuntimeMarker(containerId) {
  return docker(["exec", containerId, "node", "-e", "process.stdout.write(require('fs').readFileSync('/run/fireball-session/isolation-marker','utf8'))"]);
}

function startProcessMarker(containerId, marker) {
  docker([
    "exec",
    "--detach",
    containerId,
    "node",
    "-e",
    "setInterval(()=>{},1000)",
    marker,
  ]);
}

function processCommandLines(containerId) {
  return docker([
    "exec",
    containerId,
    "node",
    "-e",
    "const fs=require('fs');for(const p of fs.readdirSync('/proc').filter(x=>/^\\d+$/.test(x))){try{process.stdout.write(fs.readFileSync('/proc/'+p+'/cmdline').toString().replaceAll('\\0',' ')+'\\n')}catch{}}",
  ]);
}

async function waitForProcessMarker(containerId, marker) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const commandLines = processCommandLines(containerId);
    if (commandLines.includes(marker)) return commandLines;
    await delay(100);
  }
  throw new Error("tenant process marker did not start");
}

function containerAddress(container) {
  const network = container.NetworkSettings.Networks[container.HostConfig.NetworkMode];
  assert.match(network?.IPAddress ?? "", /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/);
  return network.IPAddress;
}

function startNetworkMarker(containerId, marker) {
  docker([
    "exec",
    "--detach",
    containerId,
    "node",
    "-e",
    "require('net').createServer(s=>s.end(process.argv[1])).listen(9191,'0.0.0.0');setInterval(()=>{},1000)",
    marker,
  ]);
}

function assertOwnNetworkMarker(containerId, marker) {
  docker([
    "exec",
    containerId,
    "node",
    "-e",
    "const net=require('net');const expected=process.argv[1];const deadline=Date.now()+5000;const connect=()=>{let data='';const s=net.connect({host:'127.0.0.1',port:9191});s.setEncoding('utf8');s.on('data',c=>data+=c);s.on('end',()=>process.exit(data===expected?0:43));s.on('error',()=>{if(Date.now()<deadline)setTimeout(connect,100);else process.exit(44)})};connect()",
    marker,
  ]);
}

function assertNetworkPeerIsUnreachable(containerId, peerAddress) {
  docker([
    "exec",
    containerId,
    "node",
    "-e",
    "const net=require('net');const s=net.connect({host:process.argv[1],port:9191});const t=setTimeout(()=>{s.destroy();process.exit(0)},1500);s.on('connect',()=>{clearTimeout(t);process.exit(42)});s.on('error',()=>{clearTimeout(t);process.exit(0)})",
    peerAddress,
  ]);
}

function internalSecret(container) {
  const environment = container.Config?.Env;
  assert.ok(Array.isArray(environment), "container environment is missing");
  const entry = environment.find((value) => value.startsWith("FIREBALL_INTERNAL_SIGNALING_SECRET="));
  assert.match(entry ?? "", /^FIREBALL_INTERNAL_SIGNALING_SECRET=[A-Za-z0-9_-]{43}$/);
  return entry.slice("FIREBALL_INTERNAL_SIGNALING_SECRET=".length);
}

function internalEndpoint(container) {
  const binding = container.NetworkSettings?.Ports?.["8444/tcp"]?.[0];
  assert.equal(binding?.HostIp, "127.0.0.1");
  assert.match(binding?.HostPort ?? "", /^[1-9][0-9]{0,4}$/);
  return `ws://127.0.0.1:${binding.HostPort}/internal/v1/signaling`;
}

function assertPublicSession(session) {
  assert.deepEqual(Object.keys(session).sort(), ["createdAt", "id", "phase", "quota"]);
  assert.equal(session.phase, "active");
}

function authorization(tenant, subject) {
  return { authorization: `Bearer dev:${tenant}:${subject}` };
}

function reportManagedContainerLogs(managedInstance) {
  for (const container of managedContainers(managedInstance)) {
    const logs = docker(["logs", container.Id], { allowFailure: true });
    if (logs) process.stderr.write(`--- ${container.Name} logs ---\n${logs}\n`);
  }
}

function docker(arguments_, { allowFailure = false } = {}) {
  const result = spawnSync("docker", arguments_, {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: 180_000,
  });
  if (result.error) throw result.error;
  const output = [result.stdout, result.stderr].filter(Boolean).join("").trim();
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
