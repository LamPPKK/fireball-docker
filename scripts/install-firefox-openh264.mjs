import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const manifestPath = new URL("../config/firefox-openh264-v1.json", import.meta.url);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
validateManifest(manifest);

const command = process.argv[2];
if (command === "check") {
  process.stdout.write("Firefox OpenH264 test manifest is valid\n");
} else if (command === "install") {
  const platform = process.argv[3];
  const outputArgument = process.argv[4];
  if (!Object.hasOwn(manifest.artifacts, platform)) {
    throw new Error("usage: install-firefox-openh264.mjs install <linux/amd64|linux/arm64> <absolute-output-path>");
  }
  if (typeof outputArgument !== "string" || !outputArgument.startsWith("/") || outputArgument.includes("\0")) {
    throw new Error("OpenH264 output must be a safe absolute path");
  }
  const output = resolve(outputArgument);
  if (output !== outputArgument || output === "/" || output === dirname(output)) {
    throw new Error("OpenH264 output path must already be canonical and non-root");
  }
  await assertMissing(output);
  const installed = await installArtifact(manifest.artifacts[platform], output);
  process.stdout.write(`${installed}\n`);
} else {
  throw new Error("usage: install-firefox-openh264.mjs <check|install> [...]");
}

async function installArtifact(artifact, output) {
  const parent = dirname(output);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(parent, ".fireball-openh264-"));
  const archive = join(staging, "openh264.zip");
  const extracted = join(staging, "plugin");
  try {
    const response = await fetch(artifact.url, {
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok || response.url !== artifact.url) {
      throw new Error(`OpenH264 download failed with HTTP ${response.status}`);
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (declaredLength !== artifact.size) {
      throw new Error(`OpenH264 Content-Length mismatch: expected ${artifact.size}, got ${declaredLength}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length !== artifact.size) {
      throw new Error(`OpenH264 size mismatch: expected ${artifact.size}, got ${bytes.length}`);
    }
    const digest = createHash("sha512").update(bytes).digest("hex");
    if (digest !== artifact.sha512) throw new Error("OpenH264 SHA-512 mismatch");
    await writeFile(archive, bytes, { flag: "wx", mode: 0o600 });

    const entries = execFileSync("unzip", ["-Z1", archive], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .sort();
    assert.deepEqual(entries, ["gmpopenh264.info", "libgmpopenh264.so"]);
    await mkdir(extracted, { mode: 0o700 });
    execFileSync("unzip", ["-qq", archive, "-d", extracted], { stdio: "inherit" });
    await validateInstalledFile(join(extracted, "gmpopenh264.info"));
    await validateInstalledFile(join(extracted, "libgmpopenh264.so"));
    await chmod(join(extracted, "gmpopenh264.info"), 0o600);
    await chmod(join(extracted, "libgmpopenh264.so"), 0o700);
    await rename(extracted, output);
    return output;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function validateInstalledFile(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 8 * 1024 * 1024) {
    throw new Error(`unsafe OpenH264 archive member: ${path}`);
  }
}

async function assertMissing(path) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error("OpenH264 output path already exists");
}

function validateManifest(document) {
  assert.deepEqual(Object.keys(document).sort(), ["artifacts", "plugin_version", "schema_version", "source"]);
  assert.equal(document.schema_version, 1);
  assert.match(document.plugin_version, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(Object.keys(document.source).sort(), ["path", "ref", "repository"]);
  assert.equal(document.source.repository, "mozilla-firefox/firefox");
  assert.match(document.source.ref, /^FIREFOX_\d+_\d+_\d+_RELEASE$/);
  assert.equal(document.source.path, "toolkit/content/gmp-sources/openh264.json");
  assert.deepEqual(Object.keys(document.artifacts).sort(), ["linux/amd64", "linux/arm64"]);
  for (const [platform, artifact] of Object.entries(document.artifacts)) {
    assert.deepEqual(Object.keys(artifact).sort(), ["sha512", "size", "url"]);
    assert.match(artifact.url, /^https:\/\/ciscobinary\.openh264\.org\/[A-Za-z0-9.-]+\.zip$/);
    assert.ok(Number.isSafeInteger(artifact.size) && artifact.size > 0 && artifact.size <= 1024 * 1024);
    assert.match(artifact.sha512, /^[a-f0-9]{128}$/);
    if (platform === "linux/amd64") assert.match(artifact.url, /-linux64-/);
    if (platform === "linux/arm64") assert.match(artifact.url, /-linux64-aarch64-/);
  }
}
