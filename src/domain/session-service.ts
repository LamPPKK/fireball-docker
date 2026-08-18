import { createHash, randomBytes, randomUUID } from "node:crypto";

import { OrchestratorError } from "./errors.js";
import type {
  CreateSessionResult,
  SessionQuota,
  SessionRecord,
  SignalingAuthorization,
  SignalingTokenExchangeResult,
  TenantContext,
} from "./types.js";
import type { RuntimeAdapter } from "../runtime/runtime-adapter.js";

const DEFAULT_QUOTA: SessionQuota = { memoryMiB: 512, cpuShares: 512, pids: 128 };
const DEFAULT_PAIRING_TICKET_TTL_SECONDS = 60;
const DEFAULT_SIGNALING_TOKEN_TTL_SECONDS = 30;

interface CredentialBinding {
  readonly sessionKey: string;
  readonly expiresAt: number;
}

interface SessionCredentials {
  pairingTicketHash: string | null;
  readonly signalingTokenHashes: Set<string>;
}

export interface SessionServiceOptions {
  readonly maximumSessionsPerTenant?: number;
  readonly quota?: SessionQuota;
  readonly pairingTicketTTLSeconds?: number;
  readonly signalingTokenTTLSeconds?: number;
  readonly now?: () => number;
}

export class SessionService {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly pairingTickets = new Map<string, CredentialBinding>();
  private readonly signalingTokens = new Map<string, CredentialBinding>();
  private readonly credentialsBySession = new Map<string, SessionCredentials>();
  private readonly maximumSessionsPerTenant: number;
  private readonly quota: SessionQuota;
  private readonly pairingTicketTTLSeconds: number;
  private readonly signalingTokenTTLSeconds: number;
  private readonly now: () => number;

  public constructor(
    private readonly runtime: RuntimeAdapter,
    options: SessionServiceOptions = {},
  ) {
    this.maximumSessionsPerTenant = positiveInteger(options.maximumSessionsPerTenant ?? 1, "session limit");
    this.quota = validateQuota(options.quota ?? DEFAULT_QUOTA);
    this.pairingTicketTTLSeconds = positiveInteger(
      options.pairingTicketTTLSeconds ?? DEFAULT_PAIRING_TICKET_TTL_SECONDS,
      "pairing ticket TTL",
    );
    this.signalingTokenTTLSeconds = positiveInteger(
      options.signalingTokenTTLSeconds ?? DEFAULT_SIGNALING_TOKEN_TTL_SECONDS,
      "signaling token TTL",
    );
    this.now = options.now ?? Date.now;
  }

  public async create(context: TenantContext): Promise<CreateSessionResult> {
    const activeCount = [...this.sessions.values()].filter((session) => session.tenantId === context.tenantId).length;
    if (activeCount >= this.maximumSessionsPerTenant) {
      throw new OrchestratorError("SESSION_LIMIT_REACHED", "tenant session quota reached", 409);
    }

    const id = randomUUID();
    const signalingTicket = randomBytes(32).toString("base64url");
    const runtime = await this.runtime.create({ sessionId: id, tenantId: context.tenantId, quota: this.quota });
    const record: SessionRecord = {
      id,
      tenantId: context.tenantId,
      phase: "active",
      createdAt: new Date().toISOString(),
      quota: this.quota,
      runtime,
    };
    const sessionKey = this.key(context.tenantId, id);
    const ticketHash = hashCredential(signalingTicket);
    this.sessions.set(sessionKey, record);
    this.pairingTickets.set(ticketHash, {
      sessionKey,
      expiresAt: this.now() + this.pairingTicketTTLSeconds * 1_000,
    });
    this.credentialsBySession.set(sessionKey, {
      pairingTicketHash: ticketHash,
      signalingTokenHashes: new Set<string>(),
    });
    return {
      session: record,
      signalingTicket,
      ticketExpiresInSeconds: this.pairingTicketTTLSeconds,
    };
  }

  public get(context: TenantContext, id: string): SessionRecord {
    const record = this.sessions.get(this.key(context.tenantId, id));
    if (!record) throw new OrchestratorError("SESSION_NOT_FOUND", "session not found", 404);
    return record;
  }

  public exchangeSignalingTicket(ticket: string): SignalingTokenExchangeResult {
    const ticketHash = hashPresentedCredential(ticket);
    const binding = this.pairingTickets.get(ticketHash);
    this.pairingTickets.delete(ticketHash);
    if (!binding) throw invalidSignalingCredential();

    const credentials = this.credentialsBySession.get(binding.sessionKey);
    if (credentials?.pairingTicketHash === ticketHash) credentials.pairingTicketHash = null;
    const record = this.sessions.get(binding.sessionKey);
    if (binding.expiresAt <= this.now() || record?.phase !== "active" || !credentials) {
      throw invalidSignalingCredential();
    }

    const signalingToken = randomBytes(32).toString("base64url");
    const tokenHash = hashCredential(signalingToken);
    credentials.signalingTokenHashes.add(tokenHash);
    this.signalingTokens.set(tokenHash, {
      sessionKey: binding.sessionKey,
      expiresAt: this.now() + this.signalingTokenTTLSeconds * 1_000,
    });
    return {
      signalingToken,
      tokenExpiresInSeconds: this.signalingTokenTTLSeconds,
    };
  }

  public authorizeSignalingToken(token: string): SignalingAuthorization {
    const tokenHash = hashPresentedCredential(token);
    const binding = this.signalingTokens.get(tokenHash);
    this.signalingTokens.delete(tokenHash);
    if (!binding) throw invalidSignalingCredential();

    this.credentialsBySession.get(binding.sessionKey)?.signalingTokenHashes.delete(tokenHash);
    const record = this.sessions.get(binding.sessionKey);
    if (binding.expiresAt <= this.now() || record?.phase !== "active") {
      throw invalidSignalingCredential();
    }
    return {
      sessionId: record.id,
      tenantId: record.tenantId,
      runtime: record.runtime,
    };
  }

  public async burn(context: TenantContext, id: string): Promise<void> {
    const key = this.key(context.tenantId, id);
    const record = this.sessions.get(key);
    if (!record) throw new OrchestratorError("SESSION_NOT_FOUND", "session not found", 404);
    this.revokeCredentials(key);
    const { failure: _previousFailure, ...cleanRecord } = record;
    this.sessions.set(key, { ...cleanRecord, phase: "burning" });
    try {
      await this.runtime.destroy(record.runtime);
      this.sessions.delete(key);
    } catch {
      this.sessions.set(key, { ...record, phase: "failed", failure: "runtime cleanup failed" });
      throw new OrchestratorError("RUNTIME_FAILURE", "session cleanup failed", 503);
    }
  }

  private key(tenantId: string, id: string): string {
    return `${tenantId}:${id}`;
  }

  private revokeCredentials(sessionKey: string): void {
    const credentials = this.credentialsBySession.get(sessionKey);
    if (!credentials) return;
    if (credentials.pairingTicketHash) this.pairingTickets.delete(credentials.pairingTicketHash);
    for (const tokenHash of credentials.signalingTokenHashes) this.signalingTokens.delete(tokenHash);
    this.credentialsBySession.delete(sessionKey);
  }
}

function hashCredential(ticket: string): string {
  return createHash("sha256").update(ticket).digest("hex");
}

function hashPresentedCredential(value: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw invalidSignalingCredential();
  return hashCredential(value);
}

function invalidSignalingCredential(): OrchestratorError {
  return new OrchestratorError("SIGNALING_CREDENTIAL_INVALID", "signaling credential is invalid or expired", 401);
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function validateQuota(quota: SessionQuota): SessionQuota {
  return {
    memoryMiB: positiveInteger(quota.memoryMiB, "memory quota"),
    cpuShares: positiveInteger(quota.cpuShares, "CPU shares"),
    pids: positiveInteger(quota.pids, "PID quota"),
  };
}
