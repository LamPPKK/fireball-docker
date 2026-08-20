import { spawn, spawnSync } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";

import WebSocket, { WebSocketServer } from "ws";

const AUTHENTICATION_TIMEOUT_MS = 5_000;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_BUFFERED_BYTES = 1024 * 1024;
const INTERNAL_HOME = "file:///usr/share/fireball-session/home.html";
const PROFILE_CONFIGURATION = Object.freeze({
  "1080p30": Object.freeze({ width: 1920, height: 1080, fps: 30, bitrate: 6_000_000 }),
  "720p15": Object.freeze({ width: 1280, height: 720, fps: 15, bitrate: 3_000_000 }),
  "480p10": Object.freeze({ width: 854, height: 480, fps: 10, bitrate: 1_200_000 }),
});

export function parseConfiguration(environment) {
  const secret = environment.FIREBALL_INTERNAL_SIGNALING_SECRET;
  if (typeof secret !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(secret)) {
    throw new Error("FIREBALL_INTERNAL_SIGNALING_SECRET must contain 256 bits in base64url form");
  }

  const profileName = environment.FIREBALL_STREAM_PROFILE ?? "720p15";
  const profile = PROFILE_CONFIGURATION[profileName];
  if (!profile) throw new Error("FIREBALL_STREAM_PROFILE is unsupported");

  const startUrl = validateStartUrl(environment.FIREBALL_START_URL ?? INTERNAL_HOME);
  return Object.freeze({ secret, profileName, profile, startUrl });
}

export function childEnvironment(environment) {
  const { FIREBALL_INTERNAL_SIGNALING_SECRET: _secret, ...safeEnvironment } = environment;
  return safeEnvironment;
}

export function pipelineArguments(configuration) {
  const { width, height, fps, bitrate } = configuration.profile;
  return [
    "-e",
    "wpesrc",
    "name=web",
    `location=${configuration.startUrl}`,
    "web.video",
    "!",
    "queue",
    "leaky=downstream",
    "max-size-buffers=2",
    "!",
    "video/x-raw,format=BGRA",
    "!",
    "videoconvert",
    "!",
    "videoscale",
    "!",
    "videorate",
    "!",
    `video/x-raw,format=I420,width=${width},height=${height},framerate=${fps}/1`,
    "!",
    "openh264enc",
    "usage-type=screen",
    "rate-control=bitrate",
    "complexity=low",
    "enable-frame-skip=true",
    `gop-size=${fps * 2}`,
    `bitrate=${bitrate}`,
    "!",
    "h264parse",
    "config-interval=-1",
    "!",
    "video/x-h264,profile=constrained-baseline",
    "!",
    "webrtcsink",
    "name=rtc",
    "video-caps=video/x-h264",
    "enable-control-data-channel=true",
    "run-signalling-server=true",
    "signalling-server-host=127.0.0.1",
    "signalling-server-port=8443",
    "run-web-server=false",
    "stun-server=",
    "meta=meta,name=fireball-session",
    "web.audio_0",
    "!",
    "queue",
    "leaky=downstream",
    "max-size-buffers=8",
    "!",
    "audioconvert",
    "!",
    "audioresample",
    "!",
    "opusenc",
    "bitrate=64000",
    "!",
    "rtc.",
  ];
}

export function parseAuthenticationFrame(data, isBinary, expectedSecret) {
  if (isBinary) return false;
  try {
    const frame = JSON.parse(Buffer.from(data).toString("utf8"));
    if (
      typeof frame !== "object"
      || frame === null
      || Array.isArray(frame)
      || Object.keys(frame).sort().join(",") !== "secret,type"
      || frame.type !== "authenticate"
      || typeof frame.secret !== "string"
    ) {
      return false;
    }
    const actual = Buffer.from(frame.secret, "utf8");
    const expected = Buffer.from(expectedSecret, "utf8");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export async function createSignalingProxy({
  secret,
  host = "0.0.0.0",
  port = 8444,
  upstreamUrl = "ws://127.0.0.1:8443",
}) {
  const server = new WebSocketServer({
    host,
    port,
    maxPayload: MAX_PAYLOAD_BYTES,
    perMessageDeflate: false,
    clientTracking: true,
  });
  let activeLease;

  server.on("connection", (client) => {
    if (activeLease) {
      closeSocket(client, 1008, "controller already connected");
      return;
    }

    const lease = { client, upstream: undefined, phase: "authenticating" };
    activeLease = lease;
    const authenticationTimer = setTimeout(
      () => shutdownLease(lease, 1008, "authentication timeout"),
      AUTHENTICATION_TIMEOUT_MS,
    );
    authenticationTimer.unref();

    const shutdownLease = (target, code, reason) => {
      if (target.phase === "closed") return;
      target.phase = "closed";
      clearTimeout(authenticationTimer);
      if (activeLease === target) activeLease = undefined;
      closeSocket(target.client, code, reason);
      if (target.upstream) closeSocket(target.upstream, code, reason);
    };

    const forward = (destination, data, isBinary) => {
      if (destination.readyState !== WebSocket.OPEN) {
        shutdownLease(lease, 1011, "relay peer unavailable");
        return;
      }
      const size = rawDataLength(data);
      if (destination.bufferedAmount + size > MAX_BUFFERED_BYTES) {
        shutdownLease(lease, 1013, "relay backpressure limit");
        return;
      }
      destination.send(data, { binary: isBinary, compress: false }, (error) => {
        if (error) shutdownLease(lease, 1011, "relay write failed");
      });
    };

    client.on("message", (data, isBinary) => {
      if (lease.phase === "authenticating") {
        if (!parseAuthenticationFrame(data, isBinary, secret)) {
          shutdownLease(lease, 1008, "authentication failed");
          return;
        }
        lease.phase = "connecting";
        clearTimeout(authenticationTimer);
        const upstream = new WebSocket(upstreamUrl, {
          followRedirects: false,
          handshakeTimeout: 3_000,
          maxPayload: MAX_PAYLOAD_BYTES,
          perMessageDeflate: false,
        });
        lease.upstream = upstream;
        upstream.once("open", () => {
          if (lease.phase !== "connecting") return;
          lease.phase = "relaying";
          client.send(JSON.stringify({ type: "authenticated" }), { compress: false });
        });
        upstream.on("message", (upstreamData, upstreamBinary) => {
          if (lease.phase === "relaying") forward(client, upstreamData, upstreamBinary);
        });
        upstream.once("close", () => shutdownLease(lease, 1011, "upstream closed"));
        upstream.once("error", () => shutdownLease(lease, 1011, "upstream unavailable"));
        return;
      }
      if (lease.phase === "connecting") {
        shutdownLease(lease, 1008, "wait for relay readiness");
        return;
      }
      if (lease.phase === "relaying" && lease.upstream) {
        forward(lease.upstream, data, isBinary);
      }
    });
    client.once("close", () => shutdownLease(lease, 1000, "client disconnected"));
    client.once("error", () => shutdownLease(lease, 1011, "client connection failed"));
  });

  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("signaling proxy did not bind a TCP address");
  }

  return {
    port: address.port,
    close: async () => {
      if (activeLease) {
        for (const socket of [activeLease.client, activeLease.upstream]) {
          if (socket) socket.terminate();
        }
        activeLease = undefined;
      }
      for (const client of server.clients) client.terminate();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function rawDataLength(data) {
  if (Array.isArray(data)) return data.reduce((total, chunk) => total + chunk.length, 0);
  if (data instanceof ArrayBuffer) return data.byteLength;
  return data.length;
}

function validateStartUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("FIREBALL_START_URL must be an absolute URL");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error("FIREBALL_START_URL must not contain credentials");
  }
  if (parsed.protocol === "file:") {
    if (parsed.href !== INTERNAL_HOME) throw new Error("FIREBALL_START_URL may only use the packaged file route");
    return parsed.href;
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("FIREBALL_START_URL scheme is unsupported");
  }
  return parsed.href;
}

function closeSocket(socket, code, reason) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.close(code, reason);
    const forceClose = setTimeout(() => {
      if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
    }, 1_000);
    forceClose.unref();
  } else if (socket.readyState === WebSocket.CONNECTING) {
    socket.terminate();
  }
}

function preflight() {
  for (const element of ["wpesrc", "webrtcsink", "openh264enc", "h264parse", "opusenc"]) {
    const result = spawnSync("gst-inspect-1.0", [element], { stdio: "ignore", timeout: 5_000 });
    if (result.status !== 0) throw new Error(`required GStreamer element is unavailable: ${element}`);
  }
}

async function main() {
  const configuration = parseConfiguration(process.env);
  const safeEnvironment = childEnvironment(process.env);
  delete process.env.FIREBALL_INTERNAL_SIGNALING_SECRET;
  mkdirSync("/run/fireball-session/home", { recursive: true, mode: 0o700 });
  mkdirSync("/run/fireball-session/runtime", { recursive: true, mode: 0o700 });
  preflight();

  const pipeline = spawn("gst-launch-1.0", pipelineArguments(configuration), {
    env: safeEnvironment,
    stdio: ["ignore", "inherit", "inherit"],
  });
  const proxy = await createSignalingProxy({ secret: configuration.secret });
  let shuttingDown = false;

  const shutdown = async (exitCode) => {
    if (shuttingDown) return;
    shuttingDown = true;
    await proxy.close();
    if (pipeline.exitCode === null && pipeline.signalCode === null) {
      pipeline.kill("SIGTERM");
      const killTimer = setTimeout(() => pipeline.kill("SIGKILL"), 3_000);
      killTimer.unref();
    }
    process.exitCode = exitCode;
  };

  pipeline.once("error", (error) => {
    process.stderr.write(`fireball-session: pipeline launch failed: ${error.message}\n`);
    void shutdown(1);
  });
  pipeline.once("exit", (code, signal) => {
    if (!shuttingDown) {
      process.stderr.write(`fireball-session: pipeline exited unexpectedly (${code ?? signal ?? "unknown"})\n`);
      void shutdown(1);
    }
  });
  process.once("SIGTERM", () => void shutdown(0));
  process.once("SIGINT", () => void shutdown(0));
  process.stdout.write(`fireball-session: ready (${configuration.profileName})\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`fireball-session: startup failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
