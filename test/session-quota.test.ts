import assert from "node:assert/strict";
import { test } from "node:test";

import { OrchestratorError } from "../src/domain/errors.js";
import { SessionService } from "../src/domain/session-service.js";
import type { RuntimeResource } from "../src/domain/types.js";
import type {
  CreateRuntimeRequest,
  ReconciliationResult,
  RuntimeAdapter,
} from "../src/runtime/runtime-adapter.js";

const alpha = { tenantId: "alpha", subject: "alice" } as const;
const beta = { tenantId: "beta", subject: "bob" } as const;

test("a pending create reserves the per-tenant slot before runtime startup completes", async () => {
  const runtime = new GatedRuntime();
  const sessions = new SessionService(runtime);

  const first = sessions.create(alpha);
  await assert.rejects(sessions.create(alpha), isSessionLimit);

  runtime.resolveNext();
  await first;
});

test("host capacity includes pending sessions from other tenants", async () => {
  const runtime = new GatedRuntime();
  const sessions = new SessionService(runtime, {
    maximumSessionsPerTenant: 2,
    hostCapacity: { maximumSessions: 4, memoryMiB: 512, cpuShares: 512, pids: 128 },
  });

  const first = sessions.create(alpha);
  await assert.rejects(sessions.create(beta), isSessionLimit);

  runtime.resolveNext();
  await first;
});

test("a failed runtime create releases its host and tenant reservation", async () => {
  const runtime = new GatedRuntime();
  const sessions = new SessionService(runtime);

  const failed = sessions.create(alpha);
  runtime.rejectNext();
  await assert.rejects(failed, /simulated runtime failure/);

  const retry = sessions.create(alpha);
  runtime.resolveNext();
  const created = await retry;
  assert.equal(created.session.tenantId, "alpha");
});

test("per-session quota must fit within configured host capacity", () => {
  assert.throws(
    () => new SessionService(new GatedRuntime(), {
      quota: { memoryMiB: 513, cpuShares: 512, pids: 128 },
      hostCapacity: { maximumSessions: 1, memoryMiB: 512, cpuShares: 512, pids: 128 },
    }),
    /per-session quota exceeds host capacity/,
  );
});

function isSessionLimit(error: unknown): boolean {
  return error instanceof OrchestratorError
    && error.code === "SESSION_LIMIT_REACHED"
    && error.statusCode === 409;
}

interface PendingCreate {
  readonly request: CreateRuntimeRequest;
  readonly resolve: (resource: RuntimeResource) => void;
  readonly reject: (error: Error) => void;
}

class GatedRuntime implements RuntimeAdapter {
  private readonly pending: PendingCreate[] = [];

  public async create(request: CreateRuntimeRequest): Promise<RuntimeResource> {
    return await new Promise<RuntimeResource>((resolve, reject) => {
      this.pending.push({ request, resolve, reject });
    });
  }

  public async destroy(_resource: RuntimeResource): Promise<void> {}

  public async reconcile(): Promise<ReconciliationResult> {
    return { containersRemoved: 0, networksRemoved: 0 };
  }

  public resolveNext(): void {
    const pending = this.shiftPending();
    pending.resolve({
      containerId: `container-${pending.request.sessionId}`,
      containerName: `fireball-${pending.request.sessionId}`,
      networkNamespace: `fireball-net-${pending.request.sessionId}`,
      storageNamespace: `tmpfs-${pending.request.sessionId}`,
    });
  }

  public rejectNext(): void {
    this.shiftPending().reject(new Error("simulated runtime failure"));
  }

  private shiftPending(): PendingCreate {
    const pending = this.pending.shift();
    if (!pending) throw new Error("no pending runtime create");
    return pending;
  }
}
