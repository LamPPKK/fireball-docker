import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import {
  createCandidateEvidence,
  createPlatformRecord,
  validateCandidateEvidence,
  validateEvidenceFiles,
  validateIndex,
  validatePlatformRecord,
} from "../scripts/session-candidate-evidence.mjs";

const repository = "LamPPKK/fireball-docker";
const sourceCommit = "a".repeat(40);
const image = "ghcr.io/lamppkk/fireball-session";
const createdAt = "2026-08-21T08:00:00.000Z";

function digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function writeJson(path, value) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  writeFileSync(path, bytes);
  return bytes;
}

function platformManifest(seed) {
  return {
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: {
      mediaType: "application/vnd.oci.image.config.v1+json",
      digest: `sha256:${seed.repeat(64)}`,
      size: 512,
    },
    layers: [{
      mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
      digest: `sha256:${(seed === "1" ? "3" : "4").repeat(64)}`,
      size: 4096,
    }],
  };
}

function sbom(platform) {
  return {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `fireball-session-${platform}`,
    documentNamespace: `https://fireball.dev/sbom/${platform}/${sourceCommit}`,
    packages: [{ name: "fireball-session", SPDXID: "SPDXRef-Package-fireball-session" }],
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "fireball-candidate-evidence-"));
  const records = [];
  for (const [platform, suffix, seed] of [
    ["linux/amd64", "amd64", "1"],
    ["linux/arm64", "arm64", "2"],
  ]) {
    const directory = join(root, suffix);
    mkdirSync(directory);
    const manifestPath = join(directory, `manifest-${suffix}.json`);
    const sbomPath = join(directory, `sbom-${suffix}.spdx.json`);
    const manifestBytes = writeJson(manifestPath, platformManifest(seed));
    writeJson(sbomPath, sbom(platform));
    const record = createPlatformRecord({
      image,
      sourceCommit,
      platform,
      manifestPath,
      sbomPath,
      expectedDigest: digest(manifestBytes),
    });
    const recordPath = join(directory, `platform-${suffix}.json`);
    writeJson(recordPath, record);
    records.push({ record, recordPath });
  }
  const indexPath = join(root, "index.json");
  writeJson(indexPath, {
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: records.map(({ record }) => ({
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      digest: record.digest,
      size: record.manifest.size,
      platform: { architecture: record.platform.slice("linux/".length), os: "linux" },
    })),
  });
  const evidence = createCandidateEvidence({
    repository,
    sourceCommit,
    runId: 1234,
    runAttempt: 2,
    image,
    indexPath,
    platformRecordPaths: records.map(({ recordPath }) => recordPath),
    createdAt,
  });
  const evidencePath = join(root, "candidate-evidence.json");
  writeJson(evidencePath, evidence);
  return { root, records, indexPath, evidence, evidencePath };
}

test("candidate evidence binds exact index, platform manifests, SBOMs, and workflow identity", () => {
  const value = fixture();
  try {
    assert.deepEqual(validateEvidenceFiles({
      evidencePath: value.evidencePath,
      indexPath: value.indexPath,
      artifactDirectory: value.root,
    }), value.evidence);
    assert.equal(value.evidence.workflow.url, "https://github.com/LamPPKK/fireball-docker/actions/runs/1234/attempts/2");
    assert.equal(value.evidence.image.candidate_tag, `candidate-${sourceCommit}`);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("strict JSON Schema compiles and accepts evidence produced by the normative validator", () => {
  const value = fixture();
  try {
    const schema = JSON.parse(readFileSync(
      new URL("../schemas/session-candidate-evidence-v1.schema.json", import.meta.url),
      "utf8",
    ));
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    assert.equal(validate(value.evidence), true, JSON.stringify(validate.errors));
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("candidate semantic validator rejects forged identity and ambiguous platform records", () => {
  const value = fixture();
  try {
    for (const mutate of [
      (candidate) => { candidate.schema_version = true; },
      (candidate) => { candidate.workflow.url = "https://github.com/other/repo/actions/runs/1234/attempts/2"; },
      (candidate) => { candidate.image.candidate_tag = "candidate-latest"; },
      (candidate) => { candidate.image.index.sha256 = `sha256:${"0".repeat(64)}`; },
      (candidate) => { candidate.image.platforms.reverse(); },
      (candidate) => { candidate.image.platforms[1].digest = candidate.image.platforms[0].digest; candidate.image.platforms[1].manifest.sha256 = candidate.image.platforms[0].digest; },
    ]) {
      const candidate = structuredClone(value.evidence);
      mutate(candidate);
      assert.throws(() => validateCandidateEvidence(candidate));
    }
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("OCI index rejects extra descriptors, duplicate platforms, and digest drift", () => {
  const value = fixture();
  try {
    const index = JSON.parse(readFileSync(value.indexPath, "utf8"));
    const records = value.records.map(({ record }) => record);
    const extra = structuredClone(index);
    extra.manifests.push(structuredClone(extra.manifests[0]));
    assert.throws(() => validateIndex(extra, records), /exactly two/);
    const duplicate = structuredClone(index);
    duplicate.manifests[1].platform = { architecture: "amd64", os: "linux" };
    assert.throws(() => validateIndex(duplicate, records), /duplicate/);
    const drift = structuredClone(index);
    drift.manifests[0].digest = `sha256:${"9".repeat(64)}`;
    assert.throws(() => validateIndex(drift, records), /digest mismatch/);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("artifact validation rejects tampering and symbolic-link substitution", () => {
  const value = fixture();
  try {
    const sbomPath = join(value.root, "amd64", value.records[0].record.sbom.file);
    writeFileSync(sbomPath, "{}\n");
    assert.throws(() => validateEvidenceFiles({
      evidencePath: value.evidencePath,
      indexPath: value.indexPath,
      artifactDirectory: value.root,
    }), /size mismatch/);

    const symlinkPath = join(value.root, "record-link.json");
    symlinkSync(value.records[0].recordPath, symlinkPath);
    assert.throws(
      () => createCandidateEvidence({
        repository,
        sourceCommit,
        runId: 1234,
        runAttempt: 2,
        image,
        indexPath: value.indexPath,
        platformRecordPaths: [symlinkPath, value.records[1].recordPath],
        createdAt,
      }),
      /ELOOP|symbolic|regular file/,
    );
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("platform records reject unexpected fields and mismatched manifest identity", () => {
  const value = fixture();
  try {
    const record = structuredClone(value.records[0].record);
    record.extra = true;
    assert.throws(() => validatePlatformRecord(record), /unexpected fields/);
    delete record.extra;
    record.manifest.sha256 = `sha256:${"f".repeat(64)}`;
    assert.throws(() => validatePlatformRecord(record), /must equal platform digest/);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});
