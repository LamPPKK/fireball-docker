import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const [artifact, manifest] = await Promise.all([
  readFile(new URL("../contracts/xanhtab/openapi-v1.yaml", import.meta.url)),
  readFile(new URL("../contracts/xanhtab/manifest.json", import.meta.url), "utf8").then(JSON.parse),
]);
const actual = createHash("sha256").update(artifact).digest("hex");
if (actual !== manifest.sha256) throw new Error(`XanhTab contract checksum mismatch: ${actual}`);
if (!manifest.apiVersion) throw new Error("XanhTab contract manifest is missing apiVersion");

const temporary = await mkdtemp(join(tmpdir(), "fireball-contract-"));
try {
  const generated = join(temporary, "xanhtab-v1.ts");
  await new Promise((resolvePromise, reject) => {
    const child = spawn(
      fileURLToPath(new URL("../node_modules/.bin/openapi-typescript", import.meta.url)),
      [fileURLToPath(new URL("../contracts/xanhtab/openapi-v1.yaml", import.meta.url)), "--output", generated],
      { stdio: "ignore" },
    );
    child.once("exit", (code) => (code === 0 ? resolvePromise() : reject(new Error(`openapi-typescript exited ${code}`))));
  });
  const [expected, current] = await Promise.all([
    readFile(generated, "utf8"),
    readFile(new URL("../src/generated/xanhtab-v1.ts", import.meta.url), "utf8"),
  ]);
  if (expected !== current) throw new Error("generated XanhTab TypeScript contract is stale");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
