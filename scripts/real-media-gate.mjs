import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { isIP } from "node:net";
import { isAbsolute, normalize } from "node:path";

import WebSocket, { WebSocketServer } from "ws";

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
const browserIceFile = process.env.FIREBALL_SMOKE_BROWSER_ICE_FILE;
const expectRelay = process.env.FIREBALL_SMOKE_EXPECT_RELAY === "1";
const turnProbeHost = process.env.FIREBALL_SMOKE_TURN_PROBE_HOST;
const turnProbePort = process.env.FIREBALL_SMOKE_TURN_PROBE_PORT;
const fixtureTemplate = await readFile(
  new URL("./fixtures/rswebrtc-media-smoke.html", import.meta.url),
  "utf8",
);

if (typeof image !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/@:-]{0,254}$/.test(image)) {
  throw new Error("usage: node real-media-gate.mjs <image> <linux/amd64|linux/arm64>");
}
if (!["linux/amd64", "linux/arm64"].includes(platform)) {
  throw new Error("real media gate platform is unsupported");
}
if (!appArmorProfile || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(appArmorProfile)) {
  throw new Error("FIREBALL_SMOKE_APPARMOR_PROFILE is required");
}
if (!seccompProfilePath || !/^\/[A-Za-z0-9._/-]+$/.test(seccompProfilePath)) {
  throw new Error("FIREBALL_SMOKE_SECCOMP_PROFILE must be a safe absolute path");
}
if (expectRelay) {
  validateSafeAbsolutePath(iceServersFile, "FIREBALL_SMOKE_ICE_SERVERS_FILE");
  validateSafeAbsolutePath(browserIceFile, "FIREBALL_SMOKE_BROWSER_ICE_FILE");
  if (typeof turnProbeHost !== "string" || isIP(turnProbeHost) !== 4) {
    throw new Error("FIREBALL_SMOKE_TURN_PROBE_HOST must be an IPv4 address");
  }
  if (typeof turnProbePort !== "string" || !/^[1-9]\d{0,4}$/.test(turnProbePort)) {
    throw new Error("FIREBALL_SMOKE_TURN_PROBE_PORT must be a canonical port");
  }
  const numericTurnProbePort = Number(turnProbePort);
  if (numericTurnProbePort > 65_535) throw new Error("FIREBALL_SMOKE_TURN_PROBE_PORT is out of range");
} else if (
  iceServersFile !== undefined
  || browserIceFile !== undefined
  || turnProbeHost !== undefined
  || turnProbePort !== undefined
) {
  throw new Error("TURN files require FIREBALL_SMOKE_EXPECT_RELAY=1");
}
const browserIceConfiguration = expectRelay
  ? parseBrowserIceConfiguration(await readFile(browserIceFile, "utf8"))
  : { iceServers: [] };
const fixtureMarker = "__FIREBALL_ICE_CONFIGURATION__";
assert.equal(fixtureTemplate.split(fixtureMarker).length, 2, "browser ICE configuration marker is invalid");
const fixture = Buffer.from(
  fixtureTemplate.replace(fixtureMarker, JSON.stringify(browserIceConfiguration)),
  "utf8",
);
assertCommand("geckodriver", ["--version"]);
assertCommand("firefox", ["--version"]);

const suffix = randomBytes(6).toString("hex");
const instanceId = `media-${suffix}`;
const tenant = "media";
const subject = "gate";
const seccompProfile = await readSessionSeccompProfile(seccompProfilePath);
const runtime = new DockerEngineRuntime({
  socketPath: "/var/run/docker.sock",
  apiVersion: "1.47",
  image,
  instanceId,
  appArmorProfile,
  seccompProfile,
  iceServersFile,
  requestTimeoutMs: 60_000,
  startupHealthAttempts: 120,
  startupHealthIntervalMs: 1_000,
});
const connections = new SignalingConnectionRegistry();
const sessions = new SessionService(runtime, {
  maximumSessionsPerTenant: 1,
  hostCapacity: {
    maximumSessions: 1,
    memoryMiB: 512,
    cpuShares: 512,
    pids: 256,
  },
  signalingTokenTTLSeconds: 120,
  revokeSignalingConnections: (sessionId) => connections.revoke(sessionId),
});

const browserSockets = new Set();
const publicSockets = new Set();
let bridgeCredential;
let latestBridge;
let pageOrigin;
let baseUrl;
let webdriver;
let webdriverSessionId;
let app;

const pageServer = createServer((request, response) => {
  let pathname;
  try {
    pathname = new URL(request.url ?? "", "http://media-gate.invalid").pathname;
  } catch {
    pathname = "";
  }
  if (request.method !== "GET" || !["/", "/index.html"].includes(pathname)) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found\n");
    return;
  }
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-length": fixture.byteLength,
    "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; media-src 'self'; style-src 'unsafe-inline'",
    "content-type": "text/html; charset=utf-8",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
  response.end(fixture);
});
const browserBridge = new WebSocketServer({
  noServer: true,
  maxPayload: 64 * 1024,
  perMessageDeflate: false,
});

pageServer.on("upgrade", (request, socket, head) => {
  if (request.url !== "/signaling" || request.headers.origin !== pageOrigin) {
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  browserBridge.handleUpgrade(request, socket, head, (client) => {
    browserBridge.emit("connection", client, request);
  });
});

browserBridge.on("connection", (client) => {
  const credential = bridgeCredential;
  bridgeCredential = undefined;
  if (!credential) {
    client.close(1008, "media bridge is not armed");
    return;
  }
  browserSockets.add(client);
  const bridge = createPublicBridge(client, credential);
  latestBridge = bridge;
  bridge.closed.finally(() => browserSockets.delete(client));
});

try {
  assert.deepEqual(await runtime.reconcile(), { containersRemoved: 0, networksRemoved: 0 });
  await listen(pageServer);
  const pageAddress = pageServer.address();
  if (typeof pageAddress !== "object" || pageAddress === null) throw new Error("media page did not bind TCP");
  pageOrigin = `http://127.0.0.1:${pageAddress.port}`;

  app = buildApp({
    authenticator: new DevelopmentAuthenticator("test"),
    sessions,
    signaling: new SignalingGateway(
      sessions,
      new WebSocketSignalingConnector({ connectTimeoutMs: 10_000 }),
      connections,
    ),
    signalingAllowedOrigins: new Set([pageOrigin]),
  });
  baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });

  const created = await createSession();
  assert.equal(created.session.phase, "active");
  assert.equal(managedContainers(instanceId).length, 1);
  if (expectRelay) assertContainerTurnPreflight(instanceId);

  webdriver = await startWebDriver();
  webdriverSessionId = await createWebDriverSession(webdriver.endpoint);

  const firstToken = await exchangeTicket(created.signalingTicket);
  armBridge(firstToken, created.session.id);
  const first = await runBrowserPass("first");
  assertMediaEvidence(first);
  await stopBrowserPass();

  const secondTicket = await issueTicket(created.session.id);
  const secondToken = await exchangeTicket(secondTicket.signalingTicket);
  armBridge(secondToken, created.session.id);
  const second = await runBrowserPass("reconnect");
  assertMediaEvidence(second);

  const staleTicket = await issueTicket(created.session.id);
  const activeBridge = latestBridge;
  assert.ok(activeBridge, "active browser signaling bridge is missing");
  await burnSession(created.session.id);
  await waitFor(async () => {
    const state = await browserState();
    return state?.signalingClosed === true ? state : undefined;
  }, 15_000, "browser signaling did not close after burn");
  await executeBrowserScript("window.__fireballMarkBurned(); return window.__fireballSmoke;");
  await activeBridge.closed;
  await expectTicketRevoked(staleTicket.signalingTicket);
  assert.equal(managedContainers(instanceId).length, 0, "container remains after media burn");
  assert.equal(managedNetworks(instanceId).length, 0, "network remains after media burn");

  process.stdout.write(
    `real rswebrtc H.264/Opus/control ${expectRelay ? "TURN relay-only " : ""}gate passed twice for ${platform}\n`,
  );
} catch (error) {
  await reportBrowserState();
  reportWebDriverDiagnostics();
  reportManagedContainerLogs(instanceId);
  throw error;
} finally {
  bridgeCredential = undefined;
  for (const socket of browserSockets) socket.terminate();
  for (const socket of publicSockets) socket.terminate();
  if (webdriverSessionId && webdriver) {
    await webDriverRequest(webdriver.endpoint, "DELETE", `/session/${webdriverSessionId}`).catch(() => {});
  }
  if (webdriver) await webdriver.close();
  if (app) await app.close().catch(() => {});
  await closeWebSocketServer(browserBridge);
  await closeHttpServer(pageServer);
  await runtime.reconcile().catch(() => {});
}

function createPublicBridge(browser, credential) {
  assert.ok(baseUrl);
  const endpoint = new URL("/orchestrator/v1/signaling", baseUrl);
  endpoint.protocol = "ws:";
  const upstream = new WebSocket(endpoint, {
    origin: pageOrigin,
    followRedirects: false,
    handshakeTimeout: 10_000,
    maxPayload: 64 * 1024,
    perMessageDeflate: false,
  });
  publicSockets.add(upstream);
  let ready = false;
  let closed = false;
  const browserFrames = [];
  let resolveClosed = () => {};
  const closedPromise = new Promise((resolve) => {
    resolveClosed = resolve;
  });

  const shutdown = (code, reason) => {
    if (closed) return;
    closed = true;
    publicSockets.delete(upstream);
    closeSocket(browser, code, reason);
    closeSocket(upstream, code, reason);
    resolveClosed();
  };
  browser.on("message", (data, isBinary) => {
    if (!ready) {
      if (browserFrames.length >= 16) {
        shutdown(1013, "media bridge buffer exceeded");
        return;
      }
      browserFrames.push({ data: Buffer.from(data), isBinary });
      return;
    }
    forward(upstream, data, isBinary, shutdown);
  });
  browser.once("close", () => shutdown(1000, "browser disconnected"));
  browser.once("error", () => shutdown(1011, "browser bridge failed"));

  upstream.once("open", () => {
    upstream.send(JSON.stringify({ type: "authenticate", token: credential.token }), { compress: false });
  });
  upstream.on("message", (data, isBinary) => {
    if (!ready) {
      if (isBinary) {
        shutdown(1008, "public relay ready frame was binary");
        return;
      }
      let frame;
      try {
        frame = JSON.parse(Buffer.from(data).toString("utf8"));
      } catch {
        shutdown(1008, "public relay ready frame was invalid");
        return;
      }
      if (
        !frame
        || typeof frame !== "object"
        || Object.keys(frame).sort().join(",") !== "sessionId,type"
        || frame.type !== "ready"
        || frame.sessionId !== credential.sessionId
      ) {
        shutdown(1008, "public relay session identity mismatch");
        return;
      }
      ready = true;
      for (const queued of browserFrames.splice(0)) {
        forward(upstream, queued.data, queued.isBinary, shutdown);
      }
      return;
    }
    forward(browser, data, isBinary, shutdown);
  });
  upstream.once("close", () => shutdown(1008, "public relay closed"));
  upstream.once("error", () => shutdown(1011, "public relay failed"));

  return { closed: closedPromise };
}

function armBridge(token, sessionId) {
  assert.equal(bridgeCredential, undefined, "media bridge already has pending credentials");
  bridgeCredential = { token, sessionId };
  latestBridge = undefined;
}

async function runBrowserPass(name) {
  assert.ok(pageOrigin);
  const passId = `${name}-${randomBytes(4).toString("hex")}`;
  await webDriverRequest(
    webdriver.endpoint,
    "POST",
    `/session/${webdriverSessionId}/url`,
    { url: `${pageOrigin}/index.html?pass=${encodeURIComponent(passId)}` },
  );
  const state = await waitFor(async () => {
    const current = await browserState();
    if (current?.phase === "failed") {
      throw new Error(`browser media gate failed: ${current.errors?.join("; ") ?? "unknown browser failure"}`);
    }
    return current?.phase === "passed" ? current : undefined;
  }, 90_000, `${name} browser media pass timed out`);
  assert.ok(latestBridge, `${name} browser did not consume bridge credentials`);
  return state;
}

async function stopBrowserPass() {
  const bridge = latestBridge;
  assert.ok(bridge, "browser signaling bridge is missing");
  await executeBrowserScript("window.__fireballStop(); return window.__fireballSmoke;");
  await Promise.race([
    bridge.closed,
    delay(10_000).then(() => { throw new Error("browser signaling bridge did not close for reconnect"); }),
  ]);
}

function assertMediaEvidence(state) {
  assert.equal(state.phase, "passed");
  assert.equal(state.signalingReady, true);
  assert.equal(state.producerCount, 1);
  assert.equal(state.sessionStarted, true);
  assert.equal(state.offerHasH264, true);
  assert.equal(state.offerHasOpus, true);
  assert.equal(state.videoTrack, true);
  assert.equal(state.audioTrack, true);
  assert.equal(state.videoCodec.toLowerCase(), "video/h264");
  assert.equal(state.audioCodec.toLowerCase(), "audio/opus");
  assert.ok(state.videoPackets > 0);
  assert.ok(state.audioPackets > 0);
  assert.ok(state.videoFrames > 0);
  if (expectRelay) {
    assert.equal(state.localCandidateType.toLowerCase(), "relay");
    assert.equal(state.remoteCandidateType.toLowerCase(), "relay");
  }
  assert.equal(state.controlOpen, true);
  assert.equal(state.controlAcknowledged, true);
  assert.deepEqual(state.errors, []);
}

async function browserState() {
  return await executeBrowserScript("return window.__fireballSmoke ?? null;");
}

async function reportBrowserState() {
  if (!webdriver || !webdriverSessionId) return;
  try {
    const state = await browserState();
    if (state) process.stderr.write(`browser media state: ${JSON.stringify(redactState(state))}\n`);
  } catch {
    // Browser diagnostics are best effort and must not hide the original failure.
  }
}

function redactState(state) {
  return {
    phase: state.phase,
    signalingReady: state.signalingReady,
    producerCount: state.producerCount,
    sessionStarted: state.sessionStarted,
    offerHasH264: state.offerHasH264,
    offerHasOpus: state.offerHasOpus,
    videoTrack: state.videoTrack,
    audioTrack: state.audioTrack,
    videoCodec: state.videoCodec,
    audioCodec: state.audioCodec,
    videoPackets: state.videoPackets,
    audioPackets: state.audioPackets,
    videoFrames: state.videoFrames,
    localCandidateType: state.localCandidateType,
    remoteCandidateType: state.remoteCandidateType,
    localCandidateTypes: Array.isArray(state.localCandidateTypes) ? state.localCandidateTypes.slice(0, 4) : [],
    remoteCandidateTypes: Array.isArray(state.remoteCandidateTypes) ? state.remoteCandidateTypes.slice(0, 4) : [],
    iceErrors: Array.isArray(state.iceErrors) ? state.iceErrors.slice(0, 4) : [],
    controlOpen: state.controlOpen,
    controlAcknowledged: state.controlAcknowledged,
    signalingClosed: state.signalingClosed,
    errors: Array.isArray(state.errors) ? state.errors.slice(0, 4) : [],
  };
}

function parseBrowserIceConfiguration(source) {
  let document;
  try {
    document = JSON.parse(source);
  } catch {
    throw new Error("browser ICE configuration is not valid JSON");
  }
  if (
    !isRecord(document)
    || Object.keys(document).sort().join(",") !== "iceServers,iceTransportPolicy"
    || document.iceTransportPolicy !== "relay"
    || !Array.isArray(document.iceServers)
    || document.iceServers.length !== 1
  ) {
    throw new Error("browser ICE configuration shape is invalid");
  }
  const server = document.iceServers[0];
  if (
    !isRecord(server)
    || Object.keys(server).sort().join(",") !== "credential,urls,username"
    || typeof server.username !== "string"
    || !/^[A-Za-z0-9_-]{16,128}$/.test(server.username)
    || typeof server.credential !== "string"
    || !/^[A-Za-z0-9_-]{32,256}$/.test(server.credential)
    || !Array.isArray(server.urls)
    || server.urls.length !== 1
    || typeof server.urls[0] !== "string"
    || !/^turn:(?:\d{1,3}\.){3}\d{1,3}:\d{1,5}\?transport=udp$/.test(server.urls[0])
  ) {
    throw new Error("browser TURN server configuration is invalid");
  }
  return document;
}

function validateSafeAbsolutePath(value, name) {
  if (
    typeof value !== "string"
    || !isAbsolute(value)
    || normalize(value) !== value
    || !/^\/[A-Za-z0-9._/-]+$/.test(value)
    || value.length > 4_096
  ) {
    throw new Error(`${name} must be a safe absolute path`);
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function createSession() {
  const response = await request("/orchestrator/v1/sessions", {
    method: "POST",
    headers: authorization(),
  });
  await assertResponseStatus(response, 201);
  return await response.json();
}

async function issueTicket(sessionId) {
  const response = await request(`/orchestrator/v1/sessions/${sessionId}/signaling/tickets`, {
    method: "POST",
    headers: authorization(),
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

async function burnSession(sessionId) {
  const response = await request(`/orchestrator/v1/sessions/${sessionId}`, {
    method: "DELETE",
    headers: authorization(),
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

function authorization() {
  return { authorization: `Bearer dev:${tenant}:${subject}` };
}

async function startWebDriver() {
  const port = await reserveLoopbackPort();
  const child = spawn("geckodriver", ["--log", "debug", "--host", "127.0.0.1", "--port", String(port)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let diagnostics = "";
  const append = (chunk) => {
    diagnostics = `${diagnostics}${chunk}`.slice(-16 * 1024);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  const endpoint = `http://127.0.0.1:${port}`;
  try {
    await waitFor(async () => {
      if (child.exitCode !== null) throw new Error(`geckodriver exited early: ${diagnostics}`);
      try {
        const response = await fetch(`${endpoint}/status`, { signal: AbortSignal.timeout(1_000) });
        return response.ok ? true : undefined;
      } catch {
        return undefined;
      }
    }, 20_000, "geckodriver did not become ready");
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }
  return {
    endpoint,
    diagnostics: () => diagnostics,
    close: async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await Promise.race([onceExit(child), delay(5_000)]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    },
  };
}

function reportWebDriverDiagnostics() {
  const diagnostics = webdriver?.diagnostics?.();
  if (!diagnostics) return;
  process.stderr.write(`WebDriver diagnostics:\n${diagnostics}\n`);
}

async function createWebDriverSession(endpoint) {
  const response = await webDriverRequest(endpoint, "POST", "/session", {
    capabilities: {
      alwaysMatch: {
        browserName: "firefox",
        acceptInsecureCerts: false,
        pageLoadStrategy: "normal",
        "moz:firefoxOptions": {
          args: ["-headless", "--width=1280", "--height=720"],
          prefs: {
            "media.autoplay.default": 0,
            "media.autoplay.blocking_policy": 0,
            "media.gmp-gmpopenh264.enabled": true,
            "media.gmp-manager.updateEnabled": false,
            "media.peerconnection.ice.obfuscate_host_addresses": false,
            "media.peerconnection.ice.default_address_only": false,
            "media.peerconnection.ice.no_host": false,
          },
        },
      },
    },
  }, 60_000);
  assert.match(response.sessionId ?? "", /^[A-Za-z0-9-]+$/);
  return response.sessionId;
}

async function executeBrowserScript(script) {
  const response = await webDriverRequest(
    webdriver.endpoint,
    "POST",
    `/session/${webdriverSessionId}/execute/sync`,
    { script, args: [] },
  );
  return response;
}

async function webDriverRequest(endpoint, method, path, body, timeout = 15_000) {
  const response = await fetch(new URL(path, endpoint), {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  const document = await response.json();
  if (!response.ok || document?.value?.error) {
    throw new Error(`WebDriver ${method} ${path} failed: ${String(document?.value?.message ?? response.status)}`);
  }
  return document.value;
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

function assertContainerTurnPreflight(managedInstance) {
  const containers = managedContainers(managedInstance);
  assert.equal(containers.length, 1, "TURN preflight requires one managed container");
  const containerId = containers[0].Id;
  assert.match(containerId, /^[a-f0-9]{64}$/);
  const configurationProbe = [
    "const {parseConfiguration}=await import('/opt/fireball-session/supervisor.mjs');",
    "const configuration=parseConfiguration(process.env);",
    "process.stdout.write(JSON.stringify({policy:configuration.ice.iceTransportPolicy,turnServers:configuration.ice.turnServers.length,stun:Boolean(configuration.ice.stunServer)}));",
  ].join("");
  const configuration = JSON.parse(docker([
    "exec", containerId, "/usr/bin/node", "--input-type=module", "--eval", configurationProbe,
  ]));
  assert.deepEqual(configuration, { policy: "relay", turnServers: 1, stun: false });

  const connectivityProbe = [
    "import {randomBytes} from 'node:crypto';",
    "import {createSocket} from 'node:dgram';",
    "const host=process.argv[1];const port=Number(process.argv[2]);",
    "const transaction=randomBytes(12);const request=Buffer.alloc(20);",
    "request.writeUInt16BE(1,0);request.writeUInt32BE(0x2112a442,4);transaction.copy(request,8);",
    "const socket=createSocket('udp4');",
    "const response=await new Promise((resolve,reject)=>{",
    "const timer=setTimeout(()=>reject(new Error('TURN STUN binding timed out')),5000);",
    "socket.once('error',reject);socket.once('message',(message)=>{clearTimeout(timer);resolve(message);});",
    "socket.send(request,port,host);",
    "});socket.close();",
    "if(response.length<20||response.readUInt16BE(0)!==0x0101||!response.subarray(8,20).equals(transaction))throw new Error('TURN STUN binding response was invalid');",
  ].join("");
  docker([
    "exec", containerId, "/usr/bin/node", "--input-type=module", "--eval", connectivityProbe,
    turnProbeHost, turnProbePort,
  ]);
  process.stdout.write("container TURN configuration and UDP reachability preflight passed\n");
}

function reportManagedContainerLogs(managedInstance) {
  try {
    for (const container of managedContainers(managedInstance)) {
      const logs = docker(["logs", container.Id], { allowFailure: true });
      if (logs) process.stderr.write(`--- ${container.Name} logs (redacted) ---\n${redactContainerLogs(logs)}\n`);
    }
  } catch (error) {
    process.stderr.write(`unable to collect managed container logs: ${errorMessage(error)}\n`);
  }
}

function redactContainerLogs(logs) {
  const credentialSecrets = expectRelay
    ? [browserIceConfiguration.iceServers[0].username, browserIceConfiguration.iceServers[0].credential]
    : [];
  const redacted = logs.split("\n").map((line) => {
    if (
      line.includes("Received message")
      && (line.includes('\\"type\\":\\"peer\\"') || line.includes('\\"type\\":\\"authenticate\\"'))
    ) {
      return "[redacted rswebrtc signaling frame]";
    }
    let safeLine = line;
    for (const secret of credentialSecrets) safeLine = safeLine.replaceAll(secret, "[redacted]");
    return safeLine
      .replace(/a=ice-ufrag:[^\\\s"]+/giu, "a=ice-ufrag:[redacted]")
      .replace(/a=ice-pwd:[^\\\s"]+/giu, "a=ice-pwd:[redacted]")
      .replace(/\bufrag:[^\s,;]+/giu, "ufrag:[redacted]")
      .replace(/\bpwd:[^\s,;]+/giu, "pwd:[redacted]")
      .replace(/a=fingerprint:[^\\\r\n"]+/giu, "a=fingerprint:[redacted]")
      .replace(/candidate:[^\\\r\n"]+/giu, "candidate:[redacted]")
      .replace(/\b(turns?):\/\/[^@\s"]+@/giu, "$1://[redacted]@");
  }).join("\n");
  return redacted.slice(-64 * 1024);
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

function assertCommand(command, arguments_) {
  const result = spawnSync(command, arguments_, { encoding: "utf8", timeout: 10_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} is unavailable`);
}

function forward(destination, data, isBinary, shutdown) {
  if (destination.readyState !== WebSocket.OPEN) {
    shutdown(1011, "media bridge peer unavailable");
    return;
  }
  if (destination.bufferedAmount + data.byteLength > 1024 * 1024) {
    shutdown(1013, "media bridge backpressure limit");
    return;
  }
  destination.send(data, { binary: isBinary, compress: false }, (error) => {
    if (error) shutdown(1011, "media bridge write failed");
  });
}

function closeSocket(socket, code, reason) {
  if (socket.readyState === WebSocket.OPEN) socket.close(code, reason);
  else if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
}

async function waitFor(probe, timeout, message) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result !== undefined && result !== false) return result;
    await delay(250);
  }
  throw new Error(message);
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

async function reserveLoopbackPort() {
  const server = createServer();
  await listen(server);
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("port reservation failed");
  await closeHttpServer(server);
  return address.port;
}

function closeHttpServer(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(resolve));
}

function closeWebSocketServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function onceExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", resolve));
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : "unknown error";
}
