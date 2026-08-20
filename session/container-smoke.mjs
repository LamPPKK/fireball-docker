import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";

import WebSocket from "ws";

const image = process.argv[2];
const platform = process.argv[3];

if (typeof image !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/@:-]{0,254}$/.test(image)) {
  throw new Error("usage: node container-smoke.mjs <image> [linux/amd64|linux/arm64]");
}
if (platform !== undefined && !["linux/amd64", "linux/arm64"].includes(platform)) {
  throw new Error("container smoke platform is unsupported");
}

const suffix = randomBytes(6).toString("hex");
const containerName = `fireball-session-smoke-${suffix}`;
const secret = randomBytes(32).toString("base64url");
let containerCreated = false;

try {
  const platformArguments = platform ? ["--platform", platform] : [];
  docker([
    "run",
    "--detach",
    "--name",
    containerName,
    ...platformArguments,
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges:true",
    "--pids-limit=128",
    "--memory=512m",
    "--tmpfs",
    "/run/fireball-session:rw,noexec,nosuid,nodev,size=256m,mode=0700,uid=10001,gid=10001",
    "--publish",
    "127.0.0.1::8444",
    "--env",
    `FIREBALL_INTERNAL_SIGNALING_SECRET=${secret}`,
    image,
  ]);
  containerCreated = true;

  await waitForHealthy();
  assert.equal(docker(["inspect", "--format", "{{.Config.User}}", containerName]), "10001:10001");
  assert.equal(docker(["inspect", "--format", "{{.HostConfig.ReadonlyRootfs}}", containerName]), "true");
  assert.equal(docker(["inspect", "--format", "{{.HostConfig.SecurityOpt}}", containerName]), "[no-new-privileges:true]");

  const portOutput = docker(["port", containerName, "8444/tcp"]);
  const portMatch = /^127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(portOutput);
  assert.ok(portMatch, `signaling port is not loopback-only: ${portOutput}`);
  const port = Number(portMatch[1]);
  assert.ok(Number.isSafeInteger(port) && port <= 65_535);
  const endpoint = `ws://127.0.0.1:${port}/internal/v1/signaling`;

  await expectAuthenticationRejected(endpoint, "B".repeat(43));
  const controller = await authenticate(endpoint, secret);
  await expectControllerRejected(endpoint, secret);
  await closeSocket(controller);

  await delay(250);
  const reconnected = await authenticate(endpoint, secret);
  await closeSocket(reconnected);
  assert.equal(await containerHealth(), "running healthy");

  process.stdout.write(`session container smoke passed for ${platform ?? "native"}\n`);
} catch (error) {
  if (containerCreated) {
    const logs = docker(["logs", containerName], { allowFailure: true });
    if (logs) process.stderr.write(`--- session container logs ---\n${logs}\n`);
  }
  throw error;
} finally {
  if (containerCreated) docker(["rm", "--force", "--volumes", containerName], { allowFailure: true });
}

async function waitForHealthy() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const state = await containerHealth();
    if (state === "running healthy") return;
    if (!state.startsWith("running ")) throw new Error(`session container stopped before healthy: ${state}`);
    if (state === "running unhealthy" || state === "running missing") {
      throw new Error(`session container health check failed: ${state}`);
    }
    await delay(1_000);
  }
  throw new Error("session container did not become healthy within 120 seconds");
}

async function containerHealth() {
  return docker([
    "inspect",
    "--format",
    "{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}",
    containerName,
  ]);
}

async function expectAuthenticationRejected(endpoint, attemptedSecret) {
  const socket = await openSocket(endpoint);
  socket.send(JSON.stringify({ type: "authenticate", secret: attemptedSecret }));
  const closed = await nextClose(socket);
  assert.equal(closed.code, 1008);
  assert.match(closed.reason, /authentication failed/);
}

async function expectControllerRejected(endpoint, attemptedSecret) {
  const socket = await openSocket(endpoint);
  socket.send(JSON.stringify({ type: "authenticate", secret: attemptedSecret }));
  const closed = await nextClose(socket);
  assert.equal(closed.code, 1008);
  assert.match(closed.reason, /controller already connected/);
}

async function authenticate(endpoint, bootstrapSecret) {
  const socket = await openSocket(endpoint);
  socket.send(JSON.stringify({ type: "authenticate", secret: bootstrapSecret }));
  const frame = JSON.parse(await nextMessage(socket));
  assert.deepEqual(frame, { type: "authenticated" });
  return socket;
}

function openSocket(endpoint) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint, {
      followRedirects: false,
      handshakeTimeout: 5_000,
      maxPayload: 64 * 1024,
      perMessageDeflate: false,
    });
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("timed out opening session signaling socket"));
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
    const timer = setTimeout(() => reject(new Error("timed out waiting for session authentication")), 10_000);
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
      reject(new Error(`session signaling closed before authentication (${code}: ${reason.toString("utf8")})`));
    });
  });
}

function nextClose(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("timed out waiting for session signaling close"));
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
  const closed = nextClose(socket);
  socket.close(1000, "smoke complete");
  await closed;
}

function docker(arguments_, { allowFailure = false } = {}) {
  const result = spawnSync("docker", arguments_, {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
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
