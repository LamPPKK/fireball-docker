import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

const upstreamPath = new URL("../deploy/seccomp/moby-default.json", import.meta.url);
const profilePath = new URL("../deploy/seccomp/fireball-session.json", import.meta.url);
const provenancePath = new URL("../deploy/seccomp/fireball-session.provenance.json", import.meta.url);
const licensePath = new URL("../deploy/seccomp/LICENSE-MOBY-PROFILES-APACHE-2.0", import.meta.url);

export const upstream = Object.freeze({
  repository: "https://github.com/moby/profiles",
  raw_url: "https://raw.githubusercontent.com/moby/profiles/f9bc03ec19b2dc4c091449b08e88f85c0caa9f0b/seccomp/default.json",
  commit: "f9bc03ec19b2dc4c091449b08e88f85c0caa9f0b",
  path: "seccomp/default.json",
  sha256: "536529b665dd0972c37bfb569f5d4ac8a53592e7b00752bc39ff063ca9864c74",
  license: {
    spdx: "Apache-2.0",
    path: "LICENSE",
    raw_url: "https://raw.githubusercontent.com/moby/profiles/f9bc03ec19b2dc4c091449b08e88f85c0caa9f0b/LICENSE",
    sha256: "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30",
  },
});

const supportedArchMap = [
  { architecture: "SCMP_ARCH_X86_64", subArchitectures: null },
  { architecture: "SCMP_ARCH_AARCH64", subArchitectures: null },
];

// WPE WebKit's GLib bubblewrap launcher creates NEWNS, NEWUSER and NEWUTS.
// Fireball's fail-closed wrapper retains the tenant container's private PID
// namespace instead of requesting nested NEWPID. Web/GPU processes may add
// NEWNET, while other process types may add NEWIPC. Signal bits are SIGCHLD.
const bubblewrapCloneFlags = [
  0x54020011,
  0x5c020011,
  0x1c020011,
];

const namespaceSetupRules = [
  {
    names: ["mount", "pivot_root", "umount2"],
    action: "SCMP_ACT_ALLOW",
    comment: "Fireball: permit bubblewrap to construct the nested WebKit mount namespace",
  },
  ...bubblewrapCloneFlags.map((value) => ({
    names: ["clone"],
    action: "SCMP_ACT_ALLOW",
    args: [{ index: 0, value, op: "SCMP_CMP_EQ" }],
    comment: "Fireball: permit one exact WPE bubblewrap namespace flag set",
    includes: { arches: ["amd64", "arm64"] },
  })),
];

export function buildProfile(baseDocument) {
  validateBase(baseDocument);
  const profile = structuredClone(baseDocument);
  profile.archMap = supportedArchMap;
  profile.syscalls = [...namespaceSetupRules, ...profile.syscalls];
  validateDerivative(profile, baseDocument);
  return profile;
}

export function validateBase(document) {
  assert.equal(document.defaultAction, "SCMP_ACT_ERRNO");
  assert.equal(document.defaultErrnoRet, 1);
  assert.ok(Array.isArray(document.syscalls));
  assert.ok(document.syscalls.length >= 30);
  assert.ok(document.syscalls.some((rule) =>
    rule.action === "SCMP_ACT_ERRNO"
    && rule.errnoRet === 38
    && rule.names?.includes("clone3")));
  assert.equal(hasUnconditionalAllow(document, "clone"), false);
  for (const syscall of ["mount", "pivot_root", "umount2", "unshare", "setns"]) {
    assert.equal(hasUnconditionalAllow(document, syscall), false);
  }
}

export function validateDerivative(profile, baseDocument) {
  assert.equal(profile.defaultAction, "SCMP_ACT_ERRNO");
  assert.deepEqual(profile.archMap, supportedArchMap);
  assert.deepEqual(profile.syscalls.slice(0, namespaceSetupRules.length), namespaceSetupRules);
  assert.deepEqual(profile.syscalls.slice(namespaceSetupRules.length), baseDocument.syscalls);
  assert.equal(hasUnconditionalAllow(profile, "clone"), false);
  assert.equal(hasUnconditionalAllow(profile, "clone3"), false);
  assert.equal(hasUnconditionalAllow(profile, "unshare"), false);
  assert.equal(hasUnconditionalAllow(profile, "setns"), false);
  assert.deepEqual(
    profile.syscalls
      .filter((rule) => rule.action === "SCMP_ACT_ALLOW" && rule.names?.includes("clone") && rule.args)
      .filter((rule) => rule.args[0]?.op === "SCMP_CMP_EQ")
      .map((rule) => rule.args[0].value),
    bubblewrapCloneFlags,
  );
}

export function serialized(document) {
  return `${JSON.stringify(document, null, 2)}\n`;
}

function hasUnconditionalAllow(document, syscall) {
  return document.syscalls.some((rule) =>
    rule.action === "SCMP_ACT_ALLOW"
    && rule.names?.includes(syscall)
    && !rule.args
    && !rule.includes);
}

function digest(content) {
  return createHash("sha256").update(content).digest("hex");
}

async function generate() {
  const [response, licenseResponse] = await Promise.all([
    fetch(upstream.raw_url, { redirect: "error" }),
    fetch(upstream.license.raw_url, { redirect: "error" }),
  ]);
  if (!response.ok) throw new Error(`failed to download pinned Moby profile (${response.status})`);
  if (!licenseResponse.ok) {
    throw new Error(`failed to download pinned Moby license (${licenseResponse.status})`);
  }
  const raw = Buffer.from(await response.arrayBuffer());
  const rawLicense = Buffer.from(await licenseResponse.arrayBuffer());
  if (digest(raw) !== upstream.sha256) throw new Error("pinned Moby profile checksum mismatch");
  if (digest(rawLicense) !== upstream.license.sha256) {
    throw new Error("pinned Moby license checksum mismatch");
  }
  const baseDocument = JSON.parse(raw.toString("utf8"));
  const profile = buildProfile(baseDocument);
  const profileContent = serialized(profile);
  const provenance = {
    schema_version: 1,
    upstream,
    supported_platforms: ["linux/amd64", "linux/arm64"],
    policy: {
      default_action: "SCMP_ACT_ERRNO",
      exact_clone_flag_sets: bubblewrapCloneFlags,
      namespace_setup_syscalls: ["mount", "pivot_root", "umount2"],
      explicitly_not_allowed: ["clone3", "unshare", "setns"],
      pid_namespace: "tenant-container",
      proc_mount: "read-only bind of container procfs",
    },
    generated_profile_sha256: digest(profileContent),
  };

  await atomicWrite(upstreamPath, raw);
  await atomicWrite(profilePath, profileContent);
  await atomicWrite(provenancePath, serialized(provenance));
  await atomicWrite(licensePath, rawLicense);
  process.stdout.write(`generated ${new URL(profilePath).pathname}\n`);
}

async function check() {
  const [rawBase, rawProfile, rawProvenance, rawLicense] = await Promise.all([
    readFile(upstreamPath),
    readFile(profilePath),
    readFile(provenancePath, "utf8"),
    readFile(licensePath),
  ]);
  assert.equal(digest(rawBase), upstream.sha256, "vendored Moby profile checksum changed");
  assert.equal(
    digest(rawLicense),
    upstream.license.sha256,
    "vendored Moby license checksum changed",
  );
  const baseDocument = JSON.parse(rawBase.toString("utf8"));
  const expectedProfile = buildProfile(baseDocument);
  const expectedContent = serialized(expectedProfile);
  assert.equal(rawProfile.toString("utf8"), expectedContent, "generated seccomp profile is stale");

  const provenance = JSON.parse(rawProvenance);
  assert.deepEqual(Object.keys(provenance).sort(), [
    "generated_profile_sha256",
    "policy",
    "schema_version",
    "supported_platforms",
    "upstream",
  ]);
  assert.equal(provenance.schema_version, 1);
  assert.deepEqual(provenance.upstream, upstream);
  assert.deepEqual(provenance.supported_platforms, ["linux/amd64", "linux/arm64"]);
  assert.equal(provenance.generated_profile_sha256, digest(expectedContent));
  assert.deepEqual(provenance.policy.exact_clone_flag_sets, bubblewrapCloneFlags);
  assert.deepEqual(provenance.policy.namespace_setup_syscalls, ["mount", "pivot_root", "umount2"]);
  assert.deepEqual(provenance.policy.explicitly_not_allowed, ["clone3", "unshare", "setns"]);
  assert.equal(provenance.policy.pid_namespace, "tenant-container");
  assert.equal(provenance.policy.proc_mount, "read-only bind of container procfs");
  process.stdout.write("seccomp profile provenance and policy are valid\n");
}

async function atomicWrite(url, content) {
  await mkdir(new URL("../deploy/seccomp/", import.meta.url), { recursive: true });
  const temporary = new URL(`${url.href}.tmp`);
  await writeFile(temporary, content, { mode: 0o644 });
  await rename(temporary, url);
}

const command = process.argv[2];
if (command === "generate") await generate();
else if (command === "check") await check();
else throw new Error("usage: node scripts/seccomp-profile.mjs <generate|check>");
