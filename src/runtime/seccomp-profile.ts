import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";

const EXPECTED_PROFILE_SHA256 = "a5252acc5179db57b17f3153742027f0627c887c04757e5e92a1088c45cdf435";
const MAXIMUM_PROFILE_BYTES = 128 * 1024;

interface ProfileFileOptions {
  readonly requireRootOwner?: boolean;
}

export async function readSessionSeccompProfile(
  path: string,
  options: ProfileFileOptions = {},
): Promise<string> {
  if (
    !isAbsolute(path)
    || normalize(path) !== path
    || !/^\/[A-Za-z0-9._/-]+$/.test(path)
    || path.length > 4_096
  ) {
    throw new Error("session seccomp profile must be a safe absolute host path");
  }

  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size <= 0 || before.size > MAXIMUM_PROFILE_BYTES) {
      throw new Error("session seccomp profile must be a bounded regular file");
    }
    if ((options.requireRootOwner ?? false) && before.uid !== 0) {
      throw new Error("session seccomp profile must be owned by root");
    }
    if ((before.mode & 0o022) !== 0) {
      throw new Error("session seccomp profile must not be group/world writable");
    }

    const raw = await handle.readFile();
    const after = await handle.stat();
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
    ) {
      throw new Error("session seccomp profile changed while it was read");
    }
    const digest = createHash("sha256").update(raw).digest("hex");
    if (digest !== EXPECTED_PROFILE_SHA256) {
      throw new Error("session seccomp profile checksum does not match the reviewed Fireball policy");
    }
    const document: unknown = JSON.parse(raw.toString("utf8"));
    validateProfileShape(document);
    return JSON.stringify(document);
  } finally {
    await handle.close();
  }
}

export function validateProfileShape(document: unknown): void {
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    throw new Error("session seccomp profile is not an object");
  }
  const profile = document as Record<string, unknown>;
  if (profile.defaultAction !== "SCMP_ACT_ERRNO" || profile.defaultErrnoRet !== 1) {
    throw new Error("session seccomp profile is not deny-by-default");
  }
  if (!Array.isArray(profile.syscalls) || profile.syscalls.length < 30) {
    throw new Error("session seccomp profile syscall policy is incomplete");
  }
  if (JSON.stringify(profile.archMap) !== JSON.stringify([
    { architecture: "SCMP_ARCH_X86_64", subArchitectures: null },
    { architecture: "SCMP_ARCH_AARCH64", subArchitectures: null },
  ])) {
    throw new Error("session seccomp profile architecture policy is invalid");
  }
}
