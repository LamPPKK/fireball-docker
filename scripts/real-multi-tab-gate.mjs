import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";

import { DevelopmentAuthenticator } from "../dist/src/auth/authenticator.js";
import { buildApp } from "../dist/src/app.js";
import { SessionService } from "../dist/src/domain/session-service.js";
import { DockerEngineRuntime } from "../dist/src/runtime/docker-engine-runtime.js";
import { readSessionSeccompProfile } from "../dist/src/runtime/seccomp-profile.js";

const image = process.argv[2];
const platform = process.argv[3];
const appArmorProfile = process.env.FIREBALL_SMOKE_APPARMOR_PROFILE;
const seccompProfilePath = process.env.FIREBALL_SMOKE_SECCOMP_PROFILE;
const iceServersFile = process.env.FIREBALL_SMOKE_ICE_SERVERS_FILE;

if (typeof image !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/@:-]{0,254}$/.test(image)) {
  throw new Error("usage: node real-multi-tab-gate.mjs <image> <linux/amd64|linux/arm64>");
}
if (!["linux/amd64", "linux/arm64"].includes(platform)) {
  throw new Error("real multi-tab gate platform is unsupported");
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
const instanceId = `multi-tab-${suffix}`;
const tenant = "multi-tab";
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
const sessions = new SessionService(runtime, {
  maximumSessionsPerTenant: 1,
  hostCapacity: { maximumSessions: 1, memoryMiB: 512, cpuShares: 512, pids: 256 },
});
const app = buildApp({
  authenticator: new DevelopmentAuthenticator("test"),
  sessions,
});
let baseUrl;

try {
  assert.deepEqual(await runtime.reconcile(), { containersRemoved: 0, networksRemoved: 0 });
  baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  const created = await createSession();
  const sessionId = created.session.id;
  const container = onlyManagedContainer();
  const containerId = container.Id;
  const runtimePid = nativeRuntimePid(containerId);

  let tabs = await listTabs(sessionId);
  assert.equal(tabs.length, 1);
  assert.equal(tabs[0].url, "fireball://home");
  assert.equal(tabs[0].active, true);
  const initialTabId = tabs[0].id;

  await expectTenantDenied(sessionId);
  const createdTabs = [];
  for (const url of [
    "fireball://home",
    "https://example.com/?fireball-tab=2",
    "https://example.org/?fireball-tab=3",
  ]) {
    createdTabs.push(await createTab(sessionId, url));
    assertRuntimeIdentity(containerId, runtimePid);
  }
  tabs = await listTabs(sessionId);
  assert.equal(tabs.length, 4);
  assert.equal(new Set(tabs.map((tab) => tab.id)).size, 4);
  assert.equal(tabs.filter((tab) => tab.active).length, 1);
  assert.equal(tabs.find((tab) => tab.active)?.id, createdTabs.at(-1).id);

  const limited = await request(`/orchestrator/v1/sessions/${sessionId}/tabs`, {
    method: "POST",
    headers: jsonAuthorization(tenant, subject),
    body: "{}",
  });
  await assertError(limited, 409, "TAB_LIMIT_REACHED");
  assertRuntimeIdentity(containerId, runtimePid);

  const activated = await mutateTab(sessionId, initialTabId, "active");
  assert.equal(activated.id, initialTabId);
  assert.equal(activated.active, true);
  const navigated = await mutateTab(sessionId, initialTabId, "navigation", {
    url: "https://example.net/fireball-active",
  });
  assert.equal(navigated.url, "https://example.net/fireball-active");
  assertRuntimeIdentity(containerId, runtimePid);

  for (const tab of createdTabs) {
    const response = await request(`/orchestrator/v1/sessions/${sessionId}/tabs/${tab.id}`, {
      method: "DELETE",
      headers: authorization(tenant, subject),
    });
    await assertResponseStatus(response, 204);
    assertRuntimeIdentity(containerId, runtimePid);
  }
  tabs = await listTabs(sessionId);
  assert.deepEqual(tabs.map((tab) => tab.id), [initialTabId]);
  assert.equal(tabs[0].active, true);

  const minimum = await request(`/orchestrator/v1/sessions/${sessionId}/tabs/${initialTabId}`, {
    method: "DELETE",
    headers: authorization(tenant, subject),
  });
  await assertError(minimum, 409, "TAB_MINIMUM_REACHED");
  assertRuntimeIdentity(containerId, runtimePid);

  await burnSession(sessionId);
  assert.equal(managedContainers().length, 0, "container remains after multi-tab burn");
  assert.equal(managedNetworks().length, 0, "network remains after multi-tab burn");
  process.stdout.write(`real one-container four-tab lifecycle gate passed for ${platform}\n`);
} catch (error) {
  reportManagedContainerLogs();
  throw error;
} finally {
  await app.close().catch(() => {});
  await runtime.reconcile().catch(() => {});
}

async function createSession() {
  const response = await request("/orchestrator/v1/sessions", {
    method: "POST",
    headers: authorization(tenant, subject),
  });
  await assertResponseStatus(response, 201);
  return await response.json();
}

async function listTabs(sessionId) {
  const response = await request(`/orchestrator/v1/sessions/${sessionId}/tabs`, {
    headers: authorization(tenant, subject),
  });
  await assertResponseStatus(response, 200);
  return (await response.json()).tabs;
}

async function createTab(sessionId, url) {
  const response = await request(`/orchestrator/v1/sessions/${sessionId}/tabs`, {
    method: "POST",
    headers: jsonAuthorization(tenant, subject),
    body: JSON.stringify({ url }),
  });
  await assertResponseStatus(response, 201);
  return (await response.json()).tab;
}

async function mutateTab(sessionId, tabId, action, body) {
  const response = await request(`/orchestrator/v1/sessions/${sessionId}/tabs/${tabId}/${action}`, {
    method: "PUT",
    headers: body === undefined ? authorization(tenant, subject) : jsonAuthorization(tenant, subject),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  await assertResponseStatus(response, 200);
  return (await response.json()).tab;
}

async function burnSession(sessionId) {
  const response = await request(`/orchestrator/v1/sessions/${sessionId}`, {
    method: "DELETE",
    headers: authorization(tenant, subject),
  });
  await assertResponseStatus(response, 204);
}

async function expectTenantDenied(sessionId) {
  for (const method of ["GET", "POST"]) {
    const response = await request(`/orchestrator/v1/sessions/${sessionId}/tabs`, {
      method,
      headers: method === "POST" ? jsonAuthorization("foreign", "mallory") : authorization("foreign", "mallory"),
      body: method === "POST" ? "{}" : undefined,
    });
    await assertError(response, 404, "SESSION_NOT_FOUND");
  }
}

async function request(path, options) {
  assert.ok(baseUrl);
  return await fetch(new URL(path, baseUrl), { ...options, signal: AbortSignal.timeout(180_000) });
}

async function assertResponseStatus(response, expectedStatus) {
  if (response.status === expectedStatus) return;
  assert.equal(response.status, expectedStatus, await response.text());
}

async function assertError(response, status, code) {
  assert.equal(response.status, status, await response.clone().text());
  assert.equal((await response.json()).error.code, code);
}

function authorization(targetTenant, targetSubject) {
  return { authorization: `Bearer dev:${targetTenant}:${targetSubject}` };
}

function jsonAuthorization(targetTenant, targetSubject) {
  return { ...authorization(targetTenant, targetSubject), "content-type": "application/json" };
}

function onlyManagedContainer() {
  const containers = managedContainers();
  assert.equal(containers.length, 1, "multi-tab gate must retain exactly one tenant container");
  assert.equal(containers[0].State?.Health?.Status, "healthy");
  return containers[0];
}

function assertRuntimeIdentity(containerId, expectedPid) {
  const container = onlyManagedContainer();
  assert.equal(container.Id, containerId, "tab mutation replaced the tenant container");
  assert.equal(nativeRuntimePid(containerId), expectedPid, "tab mutation replaced the native runtime process");
}

function nativeRuntimePid(containerId) {
  const lines = docker(["top", containerId, "-eo", "pid,args"]).split("\n");
  const matches = lines.filter((line) => line.includes("/usr/bin/fireball-session-runtime"));
  assert.equal(matches.length, 1, "expected exactly one native tab runtime process");
  const match = /^\s*([1-9][0-9]*)\s+/.exec(matches[0]);
  assert.ok(match, "native tab runtime PID is missing");
  return match[1];
}

function managedContainers() {
  const ids = docker([
    "ps", "--all", "--quiet",
    "--filter", "label=dev.fireball.managed=true",
    "--filter", `label=dev.fireball.instance=${instanceId}`,
  ]).split("\n").filter(Boolean);
  return ids.length === 0 ? [] : JSON.parse(docker(["inspect", ...ids]));
}

function managedNetworks() {
  return docker([
    "network", "ls", "--quiet",
    "--filter", "label=dev.fireball.managed=true",
    "--filter", `label=dev.fireball.instance=${instanceId}`,
  ]).split("\n").filter(Boolean);
}

function reportManagedContainerLogs() {
  try {
    for (const container of managedContainers()) {
      const logs = docker(["logs", container.Id], { allowFailure: true });
      if (logs) process.stderr.write(`--- ${container.Name} multi-tab logs ---\n${logs.slice(-32 * 1024)}\n`);
    }
  } catch (error) {
    process.stderr.write(`unable to collect multi-tab logs: ${errorMessage(error)}\n`);
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

function errorMessage(error) {
  return error instanceof Error ? error.message : "unknown failure";
}
