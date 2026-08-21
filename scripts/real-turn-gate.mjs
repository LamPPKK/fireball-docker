import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const image = process.argv[2];
const platform = process.argv[3];

if (typeof image !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/@:-]{0,254}$/.test(image)) {
  throw new Error("usage: node real-turn-gate.mjs <image> <linux/amd64|linux/arm64>");
}
if (!["linux/amd64", "linux/arm64"].includes(platform)) {
  throw new Error("real TURN gate platform is unsupported");
}
for (const [command, arguments_] of [
  ["turnserver", ["--version"]],
  ["iptables", ["--version"]],
  ["ip", ["-Version"]],
  ["ss", ["--version"]],
  ["sudo", ["--version"]],
]) {
  assertCommand(command, arguments_);
}

const suffix = randomBytes(6).toString("hex");
const username = randomBytes(18).toString("base64url");
const password = randomBytes(32).toString("base64url");
const hostIp = primaryIPv4Address();
const listeningPort = 37_000 + randomBytes(2).readUInt16BE(0) % 1_000;
const relayPortStart = 49_200 + randomBytes(1).readUInt8(0) % 50;
const relayPortEnd = relayPortStart + 40;
const temporaryRoot = await mkdtemp(join(tmpdir(), "fireball-turn-gate-"));
const turnConfigPath = join(temporaryRoot, "turnserver.conf");
const turnLogPath = join(temporaryRoot, "turnserver.log");
const turnPidPath = join(temporaryRoot, "turnserver.pid");
const turnDatabasePath = join(temporaryRoot, "turndb");
const candidateIcePath = join(temporaryRoot, "session-ice.json");
const browserIcePath = join(temporaryRoot, "browser-ice.json");
const installedIcePath = `/tmp/fireball-turn-${suffix}.json`;
let turnserver;
let mediaGate;
let failure;
let firewallRuleInstalled = false;

try {
  await writeFile(turnConfigPath, turnConfiguration(), { mode: 0o600, flag: "wx" });
  await writeFile(candidateIcePath, `${JSON.stringify(sessionIceConfiguration(), null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  await writeFile(browserIcePath, `${JSON.stringify(browserIceConfiguration(), null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  command("sudo", [
    "install", "-o", "root", "-g", "10001", "-m", "0440",
    candidateIcePath,
    installedIcePath,
  ]);

  turnserver = spawn("turnserver", ["-c", turnConfigPath], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  turnserver.once("error", (error) => {
    failure = error;
  });
  await waitFor(() => {
    if (failure) throw failure;
    if (turnserver.exitCode !== null || turnserver.signalCode !== null) {
      throw new Error("coturn exited before opening its listener");
    }
    const sockets = command("ss", ["-H", "-lun"], { allowFailure: true });
    return sockets.split("\n").some((line) => line.includes(`${hostIp}:${listeningPort}`));
  }, 10_000, "coturn did not open its UDP listener");
  command("sudo", ["iptables", ...firewallRuleArguments("-I")]);
  firewallRuleInstalled = true;
  command("turnutils_uclient", [
    "-y", "-c", "-X", "-g", "-m", "1", "-n", "1",
    "-p", String(listeningPort),
    "-u", username,
    "-w", password,
    hostIp,
  ]);

  mediaGate = spawn(
    process.execPath,
    [new URL("./real-media-gate.mjs", import.meta.url).pathname, image, platform],
    {
      env: {
        ...process.env,
        FIREBALL_SMOKE_ICE_SERVERS_FILE: installedIcePath,
        FIREBALL_SMOKE_BROWSER_ICE_FILE: browserIcePath,
        FIREBALL_SMOKE_EXPECT_RELAY: "1",
      },
      stdio: "inherit",
    },
  );
  const result = await childResult(mediaGate);
  if (result.code !== 0) {
    throw new Error(`relay-only media gate exited with ${result.code ?? result.signal ?? "unknown status"}`);
  }
} catch (error) {
  failure = error;
  await reportCoturnLog();
} finally {
  if (mediaGate && mediaGate.exitCode === null && mediaGate.signalCode === null) mediaGate.kill("SIGTERM");
  if (turnserver && turnserver.exitCode === null && turnserver.signalCode === null) {
    turnserver.kill("SIGTERM");
    await Promise.race([childResult(turnserver), delay(5_000)]);
    if (turnserver.exitCode === null && turnserver.signalCode === null) turnserver.kill("SIGKILL");
  }
  if (firewallRuleInstalled) {
    try {
      command("sudo", ["iptables", ...firewallRuleArguments("-D")]);
    } catch (error) {
      const cleanupFailure = `scoped firewall cleanup failed: ${errorMessage(error)}`;
      failure = failure === undefined
        ? new Error(cleanupFailure)
        : new Error(`${errorMessage(failure)}; ${cleanupFailure}`, { cause: failure });
    }
  }
  command("sudo", ["rm", "-f", installedIcePath], { allowFailure: true });
  await rm(temporaryRoot, { recursive: true, force: true });
}

if (failure) throw failure;

function turnConfiguration() {
  return [
    `listening-ip=${hostIp}`,
    `relay-ip=${hostIp}`,
    `listening-port=${listeningPort}`,
    `min-port=${relayPortStart}`,
    `max-port=${relayPortEnd}`,
    "fingerprint",
    "lt-cred-mech",
    `user=${username}:${password}`,
    "realm=fireball-gate.invalid",
    "stale-nonce=60",
    "max-allocate-lifetime=120",
    "permission-lifetime=60",
    "channel-lifetime=60",
    "total-quota=8",
    "user-quota=8",
    "max-bps=10000000",
    "no-cli",
    "no-tls",
    "no-dtls",
    "no-tcp",
    "no-tcp-relay",
    "no-multicast-peers",
    "no-software-attribute",
    "verbose",
    "simple-log",
    "no-stdout-log",
    `userdb=${turnDatabasePath}`,
    `pidfile=${turnPidPath}`,
    `log-file=${turnLogPath}`,
    "",
  ].join("\n");
}

function sessionIceConfiguration() {
  return {
    schema_version: 1,
    turn_servers: [{
      scheme: "turn",
      host: hostIp,
      port: listeningPort,
      username,
      password,
    }],
    ice_transport_policy: "relay",
  };
}

function browserIceConfiguration() {
  return {
    iceServers: [{
      urls: [`turn:${hostIp}:${listeningPort}?transport=udp`],
      username,
      credential: password,
    }],
    iceTransportPolicy: "relay",
  };
}

function firewallRuleArguments(action) {
  return [
    action,
    "INPUT",
    ...(action === "-I" ? ["1"] : []),
    "-i", "br+",
    "-p", "udp",
    "--dport", String(listeningPort),
    "-m", "comment",
    "--comment", `fireball-turn-gate-${suffix}`,
    "-j", "ACCEPT",
  ];
}

function primaryIPv4Address() {
  const output = command("ip", ["-json", "route", "get", "198.18.0.1"]);
  let routes;
  try {
    routes = JSON.parse(output);
  } catch {
    throw new Error("ip route returned invalid JSON");
  }
  const address = routes?.[0]?.prefsrc;
  if (
    typeof address !== "string"
    || isIP(address) !== 4
    || address.startsWith("127.")
    || address.startsWith("169.254.")
  ) {
    throw new Error("runner has no routable primary IPv4 address for coturn");
  }
  return address;
}

async function reportCoturnLog() {
  try {
    const log = await readFile(turnLogPath, "utf8");
    const redacted = log
      .replaceAll(username, "[redacted-user]")
      .replaceAll(password, "[redacted-password]")
      .slice(-64 * 1024);
    if (redacted) process.stderr.write(`coturn diagnostics (redacted):\n${redacted}\n`);
  } catch {
    // Diagnostics are best effort and must not hide the original failure.
  }
}

function command(commandName, arguments_, { allowFailure = false } = {}) {
  const result = spawnSync(commandName, arguments_, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  const output = [result.stdout, result.stderr].filter(Boolean).join("").trim();
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`${commandName} failed (${result.status}): ${output}`);
  }
  return output;
}

function assertCommand(commandName, arguments_) {
  command(commandName, arguments_);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function childResult(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
}

async function waitFor(probe, timeout, message) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await delay(100);
  }
  throw new Error(message);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
