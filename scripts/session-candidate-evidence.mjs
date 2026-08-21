#!/usr/bin/env node

import assert from "node:assert/strict";
import { constants, closeSync, fstatSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const IMAGE_PATTERN = /^ghcr\.io\/[a-z0-9_.-]+\/[a-z0-9_.\/-]+$/u;
const SAFE_FILE_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,127}$/u;
const PLATFORM_ORDER = ["linux/amd64", "linux/arm64"];
const INDEX_MEDIA_TYPES = new Set([
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
]);
const MANIFEST_MEDIA_TYPES = new Set([
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
]);

function exactKeys(value, expected, label) {
  assert.equal(value !== null && typeof value === "object" && !Array.isArray(value), true, `${label} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${label} has unexpected fields`);
}

function nonEmptyString(value, label, max = 512) {
  assert.equal(typeof value, "string", `${label} must be a string`);
  assert.equal(value.length > 0 && value.length <= max && value.trim() === value, true, `${label} is invalid`);
  assert.doesNotMatch(value, /[\u0000-\u001f\u007f]/u, `${label} contains control characters`);
  return value;
}

function positiveInteger(value, label) {
  assert.equal(Number.isSafeInteger(value) && value > 0, true, `${label} must be a positive integer`);
  return value;
}

function digest(value, label) {
  nonEmptyString(value, label, 71);
  assert.match(value, SHA256_PATTERN, `${label} must be a canonical SHA-256 digest`);
  return value;
}

function stableRead(path, maximumBytes) {
  const resolved = resolve(path);
  const descriptor = openSync(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(descriptor, { bigint: true });
    assert.equal(before.isFile(), true, `${resolved} must be a regular file`);
    assert.equal(before.size > 0n && before.size <= BigInt(maximumBytes), true, `${resolved} has an invalid size`);
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    for (const field of ["dev", "ino", "size", "mtimeNs", "ctimeNs"]) {
      assert.equal(after[field], before[field], `${resolved} changed while it was read`);
    }
    assert.equal(BigInt(bytes.length), before.size, `${resolved} was not read completely`);
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function parseJsonFile(path, maximumBytes) {
  const bytes = stableRead(path, maximumBytes);
  return { bytes, document: JSON.parse(bytes.toString("utf8")) };
}

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function platformParts(platform) {
  assert.equal(PLATFORM_ORDER.includes(platform), true, "unsupported platform");
  const [, architecture] = platform.split("/");
  return { os: "linux", architecture };
}

export function validateSpdxDocument(document) {
  assert.equal(document !== null && typeof document === "object" && !Array.isArray(document), true, "SBOM must be an object");
  assert.match(nonEmptyString(document.spdxVersion, "SBOM spdxVersion", 32), /^SPDX-2\.[0-9]+$/u);
  assert.equal(document.dataLicense, "CC0-1.0", "SBOM dataLicense must be CC0-1.0");
  assert.equal(document.SPDXID, "SPDXRef-DOCUMENT", "SBOM SPDXID is invalid");
  nonEmptyString(document.name, "SBOM name");
  assert.equal(Array.isArray(document.packages) && document.packages.length > 0, true, "SBOM must contain packages");
}

export function validatePlatformManifest(document, expectedPlatform) {
  exactKeys(document, ["schemaVersion", "mediaType", "config", "layers"], "platform manifest");
  assert.equal(document.schemaVersion, 2, "platform manifest schemaVersion must be 2");
  assert.equal(MANIFEST_MEDIA_TYPES.has(document.mediaType), true, "unsupported platform manifest mediaType");
  exactKeys(document.config, ["mediaType", "digest", "size"], "platform manifest config");
  digest(document.config.digest, "platform manifest config digest");
  positiveInteger(document.config.size, "platform manifest config size");
  assert.equal(Array.isArray(document.layers) && document.layers.length > 0, true, "platform manifest must contain layers");
  for (const layer of document.layers) {
    exactKeys(layer, ["mediaType", "digest", "size"], "platform manifest layer");
    digest(layer.digest, "platform manifest layer digest");
    positiveInteger(layer.size, "platform manifest layer size");
  }
  platformParts(expectedPlatform);
}

export function validatePlatformRecord(record) {
  exactKeys(record, ["schema_version", "image", "source_commit", "platform", "digest", "manifest", "sbom"], "platform record");
  assert.equal(record.schema_version, 1);
  assert.match(nonEmptyString(record.image, "image"), IMAGE_PATTERN, "image must be a canonical lowercase GHCR name");
  assert.match(nonEmptyString(record.source_commit, "source_commit", 40), COMMIT_PATTERN);
  platformParts(record.platform);
  digest(record.digest, "platform digest");
  exactKeys(record.manifest, ["file", "sha256", "size"], "manifest identity");
  assert.match(nonEmptyString(record.manifest.file, "manifest file", 128), SAFE_FILE_PATTERN);
  assert.equal(record.manifest.sha256, record.digest, "manifest checksum must equal platform digest");
  positiveInteger(record.manifest.size, "manifest size");
  exactKeys(record.sbom, ["file", "sha256", "size"], "SBOM identity");
  assert.match(nonEmptyString(record.sbom.file, "SBOM file", 128), SAFE_FILE_PATTERN);
  digest(record.sbom.sha256, "SBOM checksum");
  positiveInteger(record.sbom.size, "SBOM size");
  return record;
}

export function createPlatformRecord({ image, sourceCommit, platform, manifestPath, sbomPath, expectedDigest }) {
  assert.match(nonEmptyString(image, "image"), IMAGE_PATTERN);
  assert.match(nonEmptyString(sourceCommit, "source commit", 40), COMMIT_PATTERN);
  digest(expectedDigest, "expected digest");
  const manifest = parseJsonFile(manifestPath, 8 * 1024 * 1024);
  validatePlatformManifest(manifest.document, platform);
  assert.equal(sha256(manifest.bytes), expectedDigest, "registry manifest bytes do not match the expected digest");
  const sbom = parseJsonFile(sbomPath, 16 * 1024 * 1024);
  validateSpdxDocument(sbom.document);
  return validatePlatformRecord({
    schema_version: 1,
    image,
    source_commit: sourceCommit,
    platform,
    digest: expectedDigest,
    manifest: { file: basename(manifestPath), sha256: expectedDigest, size: manifest.bytes.length },
    sbom: { file: basename(sbomPath), sha256: sha256(sbom.bytes), size: sbom.bytes.length },
  });
}

export function validateIndex(document, platformRecords) {
  exactKeys(document, ["schemaVersion", "mediaType", "manifests"], "OCI index");
  assert.equal(document.schemaVersion, 2, "OCI index schemaVersion must be 2");
  assert.equal(INDEX_MEDIA_TYPES.has(document.mediaType), true, "unsupported OCI index mediaType");
  assert.equal(Array.isArray(document.manifests), true, "OCI index manifests must be an array");
  assert.equal(document.manifests.length, PLATFORM_ORDER.length, "OCI index must contain exactly two platform manifests");
  const seen = new Set();
  for (const descriptor of document.manifests) {
    exactKeys(descriptor, ["mediaType", "digest", "size", "platform"], "OCI index descriptor");
    assert.equal(MANIFEST_MEDIA_TYPES.has(descriptor.mediaType), true, "unsupported OCI descriptor mediaType");
    digest(descriptor.digest, "OCI descriptor digest");
    positiveInteger(descriptor.size, "OCI descriptor size");
    exactKeys(descriptor.platform, ["architecture", "os"], "OCI descriptor platform");
    const platform = `${descriptor.platform.os}/${descriptor.platform.architecture}`;
    platformParts(platform);
    assert.equal(seen.has(platform), false, `duplicate OCI platform ${platform}`);
    seen.add(platform);
    const record = platformRecords.find((candidate) => candidate.platform === platform);
    assert.ok(record, `missing platform record for ${platform}`);
    assert.equal(descriptor.digest, record.digest, `OCI descriptor digest mismatch for ${platform}`);
  }
  assert.deepEqual([...seen].sort(), [...PLATFORM_ORDER].sort());
}

function validateWorkflow(workflow, repository, sourceCommit) {
  exactKeys(workflow, ["name", "run_id", "run_attempt", "url"], "workflow");
  assert.equal(workflow.name, "session-candidate");
  positiveInteger(workflow.run_id, "workflow run_id");
  positiveInteger(workflow.run_attempt, "workflow run_attempt");
  const expected = `https://github.com/${repository}/actions/runs/${workflow.run_id}/attempts/${workflow.run_attempt}`;
  assert.equal(workflow.url, expected, "workflow URL is not bound to the repository and run identity");
  assert.match(sourceCommit, COMMIT_PATTERN);
}

export function validateCandidateEvidence(evidence) {
  exactKeys(evidence, ["schema_version", "release_status", "repository", "source_commit", "created_at", "workflow", "image"], "candidate evidence");
  assert.equal(evidence.schema_version, 1);
  assert.equal(evidence.release_status, "candidate");
  assert.match(nonEmptyString(evidence.repository, "repository"), REPOSITORY_PATTERN);
  assert.match(nonEmptyString(evidence.source_commit, "source_commit", 40), COMMIT_PATTERN);
  const createdAt = nonEmptyString(evidence.created_at, "created_at", 32);
  assert.equal(new Date(createdAt).toISOString(), createdAt, "created_at must be canonical ISO-8601 UTC");
  validateWorkflow(evidence.workflow, evidence.repository, evidence.source_commit);
  exactKeys(evidence.image, ["name", "candidate_tag", "index_digest", "index", "platforms"], "candidate image");
  assert.match(nonEmptyString(evidence.image.name, "image name"), IMAGE_PATTERN);
  assert.equal(evidence.image.candidate_tag, `candidate-${evidence.source_commit}`, "candidate tag must be source-bound");
  digest(evidence.image.index_digest, "index digest");
  exactKeys(evidence.image.index, ["file", "sha256", "size"], "index identity");
  assert.match(nonEmptyString(evidence.image.index.file, "index file", 128), SAFE_FILE_PATTERN);
  assert.equal(evidence.image.index.sha256, evidence.image.index_digest, "index checksum must equal index digest");
  positiveInteger(evidence.image.index.size, "index size");
  assert.equal(Array.isArray(evidence.image.platforms) && evidence.image.platforms.length === 2, true, "exactly two platform records are required");
  evidence.image.platforms.forEach(validatePlatformRecord);
  assert.deepEqual(evidence.image.platforms.map(({ platform }) => platform), PLATFORM_ORDER, "platform records must use canonical order");
  for (const record of evidence.image.platforms) {
    assert.equal(record.image, evidence.image.name);
    assert.equal(record.source_commit, evidence.source_commit);
  }
  assert.equal(new Set(evidence.image.platforms.map(({ digest: value }) => value)).size, 2, "platform digests must differ");
  return evidence;
}

export function createCandidateEvidence({ repository, sourceCommit, runId, runAttempt, image, indexPath, platformRecordPaths, createdAt }) {
  assert.equal(platformRecordPaths.length, 2, "exactly two platform record paths are required");
  const records = platformRecordPaths.map((path) => validatePlatformRecord(parseJsonFile(path, 64 * 1024).document));
  records.sort((left, right) => PLATFORM_ORDER.indexOf(left.platform) - PLATFORM_ORDER.indexOf(right.platform));
  const index = parseJsonFile(indexPath, 8 * 1024 * 1024);
  validateIndex(index.document, records);
  const indexDigest = sha256(index.bytes);
  return validateCandidateEvidence({
    schema_version: 1,
    release_status: "candidate",
    repository,
    source_commit: sourceCommit,
    created_at: createdAt ?? new Date().toISOString(),
    workflow: {
      name: "session-candidate",
      run_id: Number(runId),
      run_attempt: Number(runAttempt),
      url: `https://github.com/${repository}/actions/runs/${Number(runId)}/attempts/${Number(runAttempt)}`,
    },
    image: {
      name: image,
      candidate_tag: `candidate-${sourceCommit}`,
      index_digest: indexDigest,
      index: { file: basename(indexPath), sha256: indexDigest, size: index.bytes.length },
      platforms: records,
    },
  });
}

export function validateEvidenceFiles({ evidencePath, indexPath, artifactDirectory }) {
  const evidence = validateCandidateEvidence(parseJsonFile(evidencePath, 256 * 1024).document);
  const index = stableRead(indexPath, 8 * 1024 * 1024);
  assert.equal(sha256(index), evidence.image.index_digest, "evidence does not match OCI index bytes");
  validateIndex(JSON.parse(index.toString("utf8")), evidence.image.platforms);
  for (const record of evidence.image.platforms) {
    const directory = join(resolve(artifactDirectory), record.platform.slice("linux/".length));
    for (const identity of [record.manifest, record.sbom]) {
      const path = join(directory, identity.file);
      assert.equal(dirname(resolve(path)), directory, "artifact path escapes its platform directory");
      const bytes = stableRead(path, identity === record.sbom ? 16 * 1024 * 1024 : 8 * 1024 * 1024);
      assert.equal(bytes.length, identity.size, `artifact size mismatch for ${identity.file}`);
      assert.equal(sha256(bytes), identity.sha256, `artifact checksum mismatch for ${identity.file}`);
    }
  }
  return evidence;
}

function argumentMap(argv) {
  const result = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    assert.match(key ?? "", /^--[a-z0-9-]+$/u, "invalid argument name");
    assert.notEqual(value, undefined, `missing value for ${key}`);
    assert.equal(result.has(key), false, `duplicate argument ${key}`);
    result.set(key, value);
  }
  return result;
}

function required(args, key) {
  const value = args.get(key);
  assert.notEqual(value, undefined, `missing ${key}`);
  return value;
}

function writeJson(path, document) {
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
}

async function main(argv) {
  const [command, ...rest] = argv;
  const args = argumentMap(rest);
  if (command === "platform") {
    const record = createPlatformRecord({
      image: required(args, "--image"),
      sourceCommit: required(args, "--source-commit"),
      platform: required(args, "--platform"),
      manifestPath: required(args, "--manifest"),
      sbomPath: required(args, "--sbom"),
      expectedDigest: required(args, "--expected-digest"),
    });
    writeJson(required(args, "--output"), record);
    return;
  }
  if (command === "candidate") {
    const evidence = createCandidateEvidence({
      repository: required(args, "--repository"),
      sourceCommit: required(args, "--source-commit"),
      runId: required(args, "--run-id"),
      runAttempt: required(args, "--run-attempt"),
      image: required(args, "--image"),
      indexPath: required(args, "--index"),
      platformRecordPaths: [required(args, "--amd64-record"), required(args, "--arm64-record")],
      createdAt: args.get("--created-at"),
    });
    writeJson(required(args, "--output"), evidence);
    return;
  }
  if (command === "validate") {
    validateEvidenceFiles({
      evidencePath: required(args, "--evidence"),
      indexPath: required(args, "--index"),
      artifactDirectory: required(args, "--artifact-directory"),
    });
    return;
  }
  if (command === "digest") {
    const record = validatePlatformRecord(parseJsonFile(required(args, "--record"), 64 * 1024).document);
    process.stdout.write(`${record.digest}\n`);
    return;
  }
  if (command === "index-digest") {
    const evidence = validateCandidateEvidence(parseJsonFile(required(args, "--evidence"), 256 * 1024).document);
    process.stdout.write(`${evidence.image.index_digest}\n`);
    return;
  }
  throw new Error("usage: session-candidate-evidence.mjs platform|candidate|validate|digest|index-digest [options]");
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`session candidate evidence failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
