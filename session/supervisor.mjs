import { spawn, spawnSync } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
} from "node:fs";
import { isIP } from "node:net";
import { pathToFileURL } from "node:url";

import WebSocket, { WebSocketServer } from "ws";

const AUTHENTICATION_TIMEOUT_MS = 5_000;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_BUFFERED_BYTES = 1024 * 1024;
const MAX_ICE_CONFIGURATION_BYTES = 16 * 1024;
const INTERNAL_HOME = "file:///usr/share/fireball-session/home.html";
const ICE_CONFIGURATION_PATH = "/run/fireball-secrets/ice-servers.json";
const PROFILE_CONFIGURATION = Object.freeze({
  "1080p30": Object.freeze({ width: 1920, height: 1080, fps: 30, bitrate: 6_000_000 }),
  "720p15": Object.freeze({ width: 1280, height: 720, fps: 15, bitrate: 3_000_000 }),
  "480p10": Object.freeze({ width: 854, height: 480, fps: 10, bitrate: 1_200_000 }),
});

export function parseConfiguration(environment, iceConfigurationLoader = loadIceServerConfiguration) {
  const secret = environment.FIREBALL_INTERNAL_SIGNALING_SECRET;
  if (typeof secret !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(secret)) {
    throw new Error("FIREBALL_INTERNAL_SIGNALING_SECRET must contain 256 bits in base64url form");
  }

  const profileName = environment.FIREBALL_STREAM_PROFILE ?? "720p15";
  const profile = PROFILE_CONFIGURATION[profileName];
  if (!profile) throw new Error("FIREBALL_STREAM_PROFILE is unsupported");

  const startUrl = validateStartUrl(environment.FIREBALL_START_URL ?? INTERNAL_HOME);
  const ice = environment.FIREBALL_ICE_SERVERS_FILE === undefined
    ? Object.freeze({ stunServer: "", turnServers: Object.freeze([]), iceTransportPolicy: "all" })
    : iceConfigurationLoader(validateIceConfigurationPath(environment.FIREBALL_ICE_SERVERS_FILE));
  const iceDiagnostics = environment.FIREBALL_GST_ICE_DIAGNOSTICS === "1";
  if (environment.FIREBALL_GST_ICE_DIAGNOSTICS !== undefined && !iceDiagnostics) {
    throw new Error("FIREBALL_GST_ICE_DIAGNOSTICS must be 1 when set");
  }
  return Object.freeze({ secret, profileName, profile, startUrl, ice, iceDiagnostics });
}

export function childEnvironment(environment) {
  const {
    FIREBALL_INTERNAL_SIGNALING_SECRET: _secret,
    FIREBALL_ICE_SERVERS_FILE: _iceServersFile,
    FIREBALL_GST_ICE_DIAGNOSTICS: _iceDiagnostics,
    ...safeEnvironment
  } = environment;
  return safeEnvironment;
}

export function parseIceServerConfiguration(source) {
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("ICE server configuration must be valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("ICE server configuration must be an object");
  }
  const keys = Object.keys(parsed).sort();
  const expectedKeys = parsed.stun_server === undefined
    ? ["ice_transport_policy", "schema_version", "turn_servers"]
    : ["ice_transport_policy", "schema_version", "stun_server", "turn_servers"];
  if (keys.join(",") !== expectedKeys.sort().join(",")) {
    throw new Error("ICE server configuration contains unsupported fields");
  }
  if (parsed.schema_version !== 1) {
    throw new Error("ICE server configuration schema_version must be 1");
  }
  if (!Array.isArray(parsed.turn_servers) || parsed.turn_servers.length < 1 || parsed.turn_servers.length > 4) {
    throw new Error("ICE server configuration must contain one to four TURN servers");
  }
  const turnServers = parsed.turn_servers.map((value) => validateTurnServer(value));
  if (new Set(turnServers).size !== turnServers.length) {
    throw new Error("ICE server configuration TURN servers must be unique");
  }
  const stunServer = parsed.stun_server === undefined
    ? ""
    : validateStunServer(parsed.stun_server);
  if (!(["all", "relay"].includes(parsed.ice_transport_policy))) {
    throw new Error("ICE transport policy must be all or relay");
  }
  return Object.freeze({
    stunServer,
    turnServers: Object.freeze(turnServers),
    iceTransportPolicy: parsed.ice_transport_policy,
  });
}

export function validateIceServerFileMetadata(metadata) {
  if (!metadata.isFile) throw new Error("ICE server configuration must be a regular file");
  if (metadata.size < 2 || metadata.size > MAX_ICE_CONFIGURATION_BYTES) {
    throw new Error("ICE server configuration has an unsafe size");
  }
  if (metadata.uid !== 0 || metadata.gid !== 10001 || (metadata.mode & 0o777) !== 0o440) {
    throw new Error("ICE server configuration must be owned by root:10001 with mode 0440");
  }
}

export function loadIceServerConfiguration(filePath) {
  const descriptor = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = fstatSync(descriptor);
    validateIceServerFileMetadata({
      isFile: metadata.isFile(),
      size: metadata.size,
      uid: metadata.uid,
      gid: metadata.gid,
      mode: metadata.mode,
    });
    return parseIceServerConfiguration(readFileSync(descriptor, "utf8"));
  } finally {
    closeSync(descriptor);
  }
}

export function pipelineArguments(configuration) {
  const { width, height, fps, bitrate } = configuration.profile;
  const iceArguments = [
    configuration.ice.stunServer === ""
      ? 'stun-server=""'
      : `stun-server=${configuration.ice.stunServer}`,
    ...(configuration.ice.turnServers.length === 0
      ? []
      : [`turn-servers=<${configuration.ice.turnServers.map((server) => `"${server}"`).join(",")}>`]),
    `ice-transport-policy=${configuration.ice.iceTransportPolicy}`,
  ];
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
    ...iceArguments,
    "meta=meta,name=fireball-session",
    "audiomixer",
    "name=audio_mix",
    "!",
    "queue",
    "max-size-buffers=8",
    "!",
    "audioconvert",
    "!",
    "audioresample",
    "!",
    "audio/x-raw,format=S16LE,rate=48000,channels=2",
    "!",
    "opusenc",
    "bitrate=64000",
    "!",
    "rtc.",
    "audiotestsrc",
    "wave=silence",
    "is-live=true",
    "do-timestamp=true",
    "!",
    "queue",
    "max-size-buffers=8",
    "!",
    "audioconvert",
    "!",
    "audioresample",
    "!",
    "audio/x-raw,format=S16LE,rate=48000,channels=2",
    "!",
    "audio_mix.",
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
    "audio/x-raw,format=S16LE,rate=48000,channels=2",
    "!",
    "audio_mix.",
  ];
}

function validateIceConfigurationPath(value) {
  if (value !== ICE_CONFIGURATION_PATH) {
    throw new Error(`FIREBALL_ICE_SERVERS_FILE must be ${ICE_CONFIGURATION_PATH}`);
  }
  return value;
}

function validateStunServer(value) {
  assertObjectWithExactKeys(value, ["host", "port"], "STUN server");
  return `stun://${serializeIceHost(validateIceHost(value.host))}:${validateIcePort(value.port)}`;
}

function validateTurnServer(value) {
  assertObjectWithExactKeys(value, ["host", "password", "port", "scheme", "username"], "TURN server");
  if (!(value.scheme === "turn" || value.scheme === "turns")) {
    throw new Error("TURN server scheme must be turn or turns");
  }
  const host = serializeIceHost(validateIceHost(value.host));
  const port = validateIcePort(value.port);
  const username = encodeIceCredential(value.username, "username", 128);
  const password = encodeIceCredential(value.password, "password", 256);
  return `${value.scheme}://${username}:${password}@${host}:${port}`;
}

function assertObjectWithExactKeys(value, keys, label) {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")
  ) {
    throw new Error(`${label} must contain only ${keys.join(", ")}`);
  }
}

function validateIceHost(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 253) {
    throw new Error("ICE server host is invalid");
  }
  const addressFamily = isIP(value);
  if (addressFamily === 4 || addressFamily === 6) {
    if (value !== value.toLowerCase()) throw new Error("ICE server host is invalid");
    return value;
  }
  if (
    value !== value.toLowerCase()
    || !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(value)
  ) {
    throw new Error("ICE server host is invalid");
  }
  return value;
}

function validateIcePort(value) {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error("ICE server port must be between 1 and 65535");
  }
  return value;
}

function encodeIceCredential(value, label, maximumLength) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximumLength || !/^[\x21-\x7e]+$/.test(value)) {
    throw new Error(`TURN server ${label} must contain printable ASCII without spaces`);
  }
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => (
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  ));
}

function serializeIceHost(host) {
  return isIP(host) === 6 ? `[${host}]` : host;
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
  for (const element of [
    "wpesrc",
    "webrtcsink",
    "openh264enc",
    "h264parse",
    "opusenc",
    "audiotestsrc",
    "audiomixer",
    "nicesrc",
  ]) {
    const result = spawnSync("gst-inspect-1.0", [element], { stdio: "ignore", timeout: 5_000 });
    if (result.status !== 0) throw new Error(`required GStreamer element is unavailable: ${element}`);
  }
}

async function main() {
  const configuration = parseConfiguration(process.env);
  const safeEnvironment = childEnvironment(process.env);
  if (configuration.iceDiagnostics) {
    safeEnvironment.GST_DEBUG = "webrtcnice:7,webrtcbin:6,webrtcsink:5";
  }
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
