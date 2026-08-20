import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_TARGET = "/etc/nginx/conf.d/fireball.conf";

export function installNginxConfig({
  candidatePath,
  targetPath = DEFAULT_TARGET,
  execute = executeCommand,
}) {
  const candidate = validateCandidate(candidatePath);
  const target = validateTarget(targetPath);
  if (resolve(candidate) === resolve(target)) throw new Error("candidate and target paths must differ");
  const lockPath = `${target}.lock`;
  acquireDeploymentLock(lockPath);
  try {
    return installNginxConfigLocked({ candidate, target, execute });
  } finally {
    rmdirSync(lockPath);
  }
}

function installNginxConfigLocked({ candidate, target, execute }) {
  const targetDirectory = dirname(target);
  const transactionDirectory = mkdtempSync(join(targetDirectory, `.${basename(target)}.txn-`));
  const stagedPath = join(transactionDirectory, "candidate");
  const backupPath = join(transactionDirectory, "previous");
  const hadPrevious = existsSync(target);
  let previousMode = 0o644;
  let mutated = false;

  try {
    if (hadPrevious) {
      const targetMetadata = lstatSync(target);
      if (targetMetadata.isSymbolicLink() || !targetMetadata.isFile()) {
        throw new Error("nginx target must be a regular file when it exists");
      }
      previousMode = targetMetadata.mode & 0o777;
      copyFileSync(target, backupPath);
    }
    copyFileSync(candidate, stagedPath);
    chmodSync(stagedPath, 0o644);
    renameSync(stagedPath, target);
    mutated = true;

    validateAndReload(execute);
    cleanupTransaction(transactionDirectory, backupPath, stagedPath);
    return Object.freeze({ target, replaced: hadPrevious });
  } catch (error) {
    if (!mutated) {
      cleanupTransaction(transactionDirectory, backupPath, stagedPath);
      throw error;
    }

    try {
      if (hadPrevious) {
        copyFileSync(backupPath, target);
        chmodSync(target, previousMode);
      }
      else if (existsSync(target)) unlinkSync(target);
      validateAndReload(execute);
      cleanupTransaction(transactionDirectory, backupPath, stagedPath);
    } catch (rollbackError) {
      throw new Error(
        `${errorMessage(error)}; nginx rollback incomplete: ${errorMessage(rollbackError)}; recovery files kept at ${transactionDirectory}`,
      );
    }
    throw new Error(`${errorMessage(error)}; nginx target restored to its previous state`);
  }
}

function acquireDeploymentLock(lockPath) {
  try {
    mkdirSync(lockPath, { mode: 0o700 });
  } catch (error) {
    if (error && typeof error === "object" && error.code === "EEXIST") {
      throw new Error(`nginx deployment already in progress for ${lockPath.slice(0, -5)}`);
    }
    throw error;
  }
}

function validateCandidate(value) {
  if (typeof value !== "string" || value.trim() === "") throw new Error("candidate path is required");
  const candidate = resolve(value);
  const metadata = lstatSync(candidate);
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error("candidate must be a regular file");
  return candidate;
}

function validateTarget(value) {
  if (
    typeof value !== "string"
    || !isAbsolute(value)
    || value === "/"
    || normalize(value) !== value
    || !/^\/[A-Za-z0-9._/-]+$/.test(value)
    || basename(value) === "."
    || basename(value) === ".."
  ) {
    throw new Error("nginx target must be a safe absolute path");
  }
  return value;
}

function validateAndReload(execute) {
  execute("nginx", ["-t"]);
  execute("systemctl", ["reload", "nginx"]);
  execute("systemctl", ["is-active", "--quiet", "nginx"]);
}

function executeCommand(command, args) {
  execFileSync(command, args, { stdio: "inherit" });
}

function cleanupTransaction(transactionDirectory, backupPath, stagedPath) {
  for (const path of [backupPath, stagedPath]) {
    if (existsSync(path)) unlinkSync(path);
  }
  rmdirSync(transactionDirectory);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const candidatePath = process.argv[2];
    if (!candidatePath || process.argv.length > 4) {
      throw new Error("usage: install-nginx-config.mjs <candidate> [absolute-target]");
    }
    const result = installNginxConfig({
      candidatePath,
      ...(process.argv[3] === undefined ? {} : { targetPath: process.argv[3] }),
    });
    process.stdout.write(`fireball nginx config installed at ${result.target}\n`);
  } catch (error) {
    process.stderr.write(`fireball nginx install: ${error.message}\n`);
    process.exitCode = 1;
  }
}
