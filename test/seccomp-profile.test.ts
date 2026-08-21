import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  readSessionSeccompProfile,
  validateProfileShape,
} from "../src/runtime/seccomp-profile.js";

const reviewedProfilePath = join(process.cwd(), "deploy/seccomp/fireball-session.json");

test("reviewed seccomp profile loads as compact deny-by-default JSON", async () => {
  const loaded = await readSessionSeccompProfile(reviewedProfilePath);
  const document = JSON.parse(loaded);

  assert.equal(document.defaultAction, "SCMP_ACT_ERRNO");
  assert.equal(loaded.includes("\n"), false);
  assert.doesNotThrow(() => validateProfileShape(document));
});

test("seccomp loader rejects checksum drift and writable policy files", async () => {
  const directory = mkdtempSync(join(tmpdir(), "fireball-seccomp-"));
  const changed = join(directory, "changed.json");
  const writable = join(directory, "writable.json");
  const original = readFileSync(reviewedProfilePath);
  writeFileSync(changed, Buffer.concat([original, Buffer.from(" ")]));
  writeFileSync(writable, original, { mode: 0o666 });
  chmodSync(writable, 0o666);

  await assert.rejects(readSessionSeccompProfile(changed), /checksum/);
  await assert.rejects(readSessionSeccompProfile(writable), /group\/world writable/);
});

test("seccomp loader refuses symlinks", async () => {
  const directory = mkdtempSync(join(tmpdir(), "fireball-seccomp-link-"));
  const link = join(directory, "profile.json");
  symlinkSync(reviewedProfilePath, link);

  await assert.rejects(readSessionSeccompProfile(link));
});

test("seccomp shape validator rejects permissive and unsupported profiles", () => {
  const profile = JSON.parse(readFileSync(reviewedProfilePath, "utf8"));
  assert.throws(
    () => validateProfileShape({ ...profile, defaultAction: "SCMP_ACT_ALLOW" }),
    /deny-by-default/,
  );
  assert.throws(
    () => validateProfileShape({ ...profile, archMap: [] }),
    /architecture policy/,
  );
});
