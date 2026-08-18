import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, process.env.XANHTAB_OPENAPI ?? "../XanhTab/schemas/openapi-v1.yaml");
const artifact = resolve(root, "contracts/xanhtab/openapi-v1.yaml");
const output = resolve(root, "src/generated/xanhtab-v1.ts");
await mkdir(dirname(output), { recursive: true });
await copyFile(source, artifact);
const content = await readFile(artifact);
const sha256 = createHash("sha256").update(content).digest("hex");
const apiVersion = content.toString("utf8").match(/^  version: (.+)$/m)?.[1];
if (!apiVersion) throw new Error("XanhTab OpenAPI artifact has no info.version");
await writeFile(
  resolve(root, "contracts/xanhtab/manifest.json"),
  `${JSON.stringify({ schemaVersion: 1, apiVersion, source: "XanhTab/schemas/openapi-v1.yaml", sha256 }, null, 2)}\n`,
);

await new Promise((resolvePromise, reject) => {
  const child = spawn(resolve(root, "node_modules/.bin/openapi-typescript"), [artifact, "--output", output], {
    stdio: "inherit",
  });
  child.once("exit", (code) => (code === 0 ? resolvePromise() : reject(new Error(`openapi-typescript exited ${code}`))));
});
