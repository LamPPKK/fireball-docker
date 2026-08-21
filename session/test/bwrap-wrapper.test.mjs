import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("bubblewrap wrapper rewrites only the reviewed WebKit PID/proc contract", () => {
  const directory = mkdtempSync(join(tmpdir(), "fireball-bwrap-policy-"));
  const binary = join(directory, "policy-test");
  const source = join(process.cwd(), "fireball-bwrap-wrapper.c");
  const compiler = process.env.CC?.trim() || "cc";
  const compile = spawnSync(compiler, [
    "-std=c11",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-DFIREBALL_BWRAP_POLICY_TEST",
    source,
    "-o",
    binary,
  ], { encoding: "utf8" });
  assert.equal(compile.status, 0, compile.stderr || compile.stdout);

  const execution = spawnSync(binary, [], { encoding: "utf8" });
  assert.equal(execution.status, 0, execution.stderr || execution.stdout);
  assert.match(execution.stdout, /argument policy passed/);
});
