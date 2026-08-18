import { createHash, randomBytes, randomUUID } from "node:crypto";

import { OrchestratorError } from "./errors.js";
import type { CreateSessionResult, SessionQuota, SessionRecord, TenantContext } from "./types.js";
import type { RuntimeAdapter } from "../runtime/runtime-adapter.js";

const DEFAULT_QUOTA: SessionQuota = { memoryMiB: 512, cpuShares: 512, pids: 128 };

export class SessionService {
  private readonly sessions = new Map<string, SessionRecord>();

  public constructor(
    private readonly runtime: RuntimeAdapter,
    private readonly maximumSessionsPerTenant = 1,
  ) {}

  public async create(context: TenantContext): Promise<CreateSessionResult> {
    const activeCount = [...this.sessions.values()].filter((session) => session.tenantId === context.tenantId).length;
    if (activeCount >= this.maximumSessionsPerTenant) {
      throw new OrchestratorError("SESSION_LIMIT_REACHED", "tenant session quota reached", 409);
    }

    const id = randomUUID();
    const signalingTicket = randomBytes(32).toString("base64url");
    const runtime = await this.runtime.create({ sessionId: id, tenantId: context.tenantId, quota: DEFAULT_QUOTA });
    const record: SessionRecord = {
      id,
      tenantId: context.tenantId,
      phase: "active",
      createdAt: new Date().toISOString(),
      quota: DEFAULT_QUOTA,
      runtime,
      signalingTicketHash: hashTicket(signalingTicket),
    };
    this.sessions.set(this.key(context.tenantId, id), record);
    return {
      session: publicSession(record),
      signalingTicket,
      ticketExpiresInSeconds: 60,
    };
  }

  public get(context: TenantContext, id: string): Omit<SessionRecord, "signalingTicketHash"> {
    const record = this.sessions.get(this.key(context.tenantId, id));
    if (!record) throw new OrchestratorError("SESSION_NOT_FOUND", "session not found", 404);
    return publicSession(record);
  }

  public async burn(context: TenantContext, id: string): Promise<void> {
    const key = this.key(context.tenantId, id);
    const record = this.sessions.get(key);
    if (!record) throw new OrchestratorError("SESSION_NOT_FOUND", "session not found", 404);
    await this.runtime.destroy(record.runtime);
    this.sessions.delete(key);
  }

  private key(tenantId: string, id: string): string {
    return `${tenantId}:${id}`;
  }
}

function hashTicket(ticket: string): string {
  return createHash("sha256").update(ticket).digest("hex");
}

function publicSession(record: SessionRecord): Omit<SessionRecord, "signalingTicketHash"> {
  const { signalingTicketHash: _secret, ...session } = record;
  return session;
}
