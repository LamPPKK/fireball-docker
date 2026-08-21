import { createHash, randomBytes, randomUUID } from "node:crypto";

import { OrchestratorError } from "./errors.js";
import type {
  CreateSessionResult,
  HostCapacity,
  SessionQuota,
  SessionRecord,
  SessionView,
  SignalingAuthorization,
  SignalingTicketIssueResult,
  SignalingTokenExchangeResult,
  TabView,
  TenantContext,
} from "./types.js";
import type { RuntimeAdapter } from "../runtime/runtime-adapter.js";

const DEFAULT_QUOTA: SessionQuota = { memoryMiB: 512, cpuShares: 512, pids: 128 };
const DEFAULT_PAIRING_TICKET_TTL_SECONDS = 60;
const DEFAULT_SIGNALING_TOKEN_TTL_SECONDS = 30;
const DEFAULT_HOST_CAPACITY: HostCapacity = {
  maximumSessions: 8,
  memoryMiB: 4_096,
  cpuShares: 4_096,
  pids: 1_024,
};

interface CredentialBinding {
  readonly sessionKey: string;
  readonly expiresAt: number;
}

interface SessionCredentials {
  pairingTicketHash: string | null;
  readonly signalingTokenHashes: Set<string>;
}

interface SessionReservation {
  readonly tenantId: string;
  readonly quota: SessionQuota;
}

export interface SessionServiceOptions {
  readonly maximumSessionsPerTenant?: number;
  readonly quota?: SessionQuota;
  readonly hostCapacity?: HostCapacity;
  readonly pairingTicketTTLSeconds?: number;
  readonly signalingTokenTTLSeconds?: number;
  readonly now?: () => number;
  readonly revokeSignalingConnections?: (sessionId: string) => void;
}

export class SessionService {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly pairingTickets = new Map<string, CredentialBinding>();
  private readonly signalingTokens = new Map<string, CredentialBinding>();
  private readonly credentialsBySession = new Map<string, SessionCredentials>();
  private readonly reservations = new Map<string, SessionReservation>();
  private readonly maximumSessionsPerTenant: number;
  private readonly quota: SessionQuota;
  private readonly hostCapacity: HostCapacity;
  private readonly pairingTicketTTLSeconds: number;
  private readonly signalingTokenTTLSeconds: number;
  private readonly now: () => number;
  private readonly revokeSignalingConnections: (sessionId: string) => void;

  public constructor(
    private readonly runtime: RuntimeAdapter,
    options: SessionServiceOptions = {},
  ) {
    this.maximumSessionsPerTenant = positiveInteger(options.maximumSessionsPerTenant ?? 1, "session limit");
    this.quota = validateQuota(options.quota ?? DEFAULT_QUOTA);
    this.hostCapacity = validateHostCapacity(options.hostCapacity ?? DEFAULT_HOST_CAPACITY);
    if (!fitsWithin(this.quota, this.hostCapacity)) {
      throw new Error("per-session quota exceeds host capacity");
    }
    this.pairingTicketTTLSeconds = positiveInteger(
      options.pairingTicketTTLSeconds ?? DEFAULT_PAIRING_TICKET_TTL_SECONDS,
      "pairing ticket TTL",
    );
    this.signalingTokenTTLSeconds = positiveInteger(
      options.signalingTokenTTLSeconds ?? DEFAULT_SIGNALING_TOKEN_TTL_SECONDS,
      "signaling token TTL",
    );
    this.now = options.now ?? Date.now;
    this.revokeSignalingConnections = options.revokeSignalingConnections ?? (() => {});
  }

  public async create(context: TenantContext): Promise<CreateSessionResult> {
    const id = randomUUID();
    this.reserve(id, context.tenantId);
    try {
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
      this.sessions.set(sessionKey, record);
      this.credentialsBySession.set(sessionKey, {
        pairingTicketHash: null,
        signalingTokenHashes: new Set<string>(),
      });
      const ticket = this.rotateSignalingTicket(sessionKey);
      return {
        session: toSessionView(record),
        ...ticket,
      };
    } finally {
      this.reservations.delete(id);
    }
  }

  public get(context: TenantContext, id: string): SessionView {
    const record = this.sessions.get(this.key(context.tenantId, id));
    if (!record) throw new OrchestratorError("SESSION_NOT_FOUND", "session not found", 404);
    return toSessionView(record);
  }

  public issueSignalingTicket(context: TenantContext, id: string): SignalingTicketIssueResult {
    const sessionKey = this.key(context.tenantId, id);
    const record = this.sessions.get(sessionKey);
    if (!record) throw new OrchestratorError("SESSION_NOT_FOUND", "session not found", 404);
    if (record.phase !== "active") {
      throw new OrchestratorError("SIGNALING_UNAVAILABLE", "session is not active", 409);
    }
    return this.rotateSignalingTicket(sessionKey);
  }

  public async listTabs(context: TenantContext, id: string): Promise<readonly TabView[]> {
    return await this.runtime.listTabs(this.activeRuntime(context, id));
  }

  public async createTab(context: TenantContext, id: string, url?: string): Promise<TabView> {
    return await this.runtime.createTab(this.activeRuntime(context, id), url);
  }

  public async activateTab(context: TenantContext, id: string, tabId: string): Promise<TabView> {
    return await this.runtime.activateTab(this.activeRuntime(context, id), tabId);
  }

  public async navigateTab(context: TenantContext, id: string, tabId: string, url: string): Promise<TabView> {
    return await this.runtime.navigateTab(this.activeRuntime(context, id), tabId, url);
  }

  public async deleteTab(context: TenantContext, id: string, tabId: string): Promise<void> {
    await this.runtime.deleteTab(this.activeRuntime(context, id), tabId);
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
    this.revokeSignalingConnections(record.id);
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

  private activeRuntime(context: TenantContext, id: string): SessionRecord["runtime"] {
    const record = this.sessions.get(this.key(context.tenantId, id));
    if (!record) throw new OrchestratorError("SESSION_NOT_FOUND", "session not found", 404);
    if (record.phase !== "active") {
      throw new OrchestratorError("TAB_RUNTIME_UNAVAILABLE", "session tab runtime is not active", 409);
    }
    return record.runtime;
  }

  private reserve(id: string, tenantId: string): void {
    const tenantSessions = [...this.sessions.values()].filter((session) => session.tenantId === tenantId).length;
    const tenantReservations = [...this.reservations.values()].filter(
      (reservation) => reservation.tenantId === tenantId,
    ).length;
    if (tenantSessions + tenantReservations >= this.maximumSessionsPerTenant) {
      throw new OrchestratorError("SESSION_LIMIT_REACHED", "tenant session quota reached", 409);
    }

    const allocation = this.currentAllocation();
    if (
      allocation.maximumSessions + 1 > this.hostCapacity.maximumSessions
      || allocation.memoryMiB + this.quota.memoryMiB > this.hostCapacity.memoryMiB
      || allocation.cpuShares + this.quota.cpuShares > this.hostCapacity.cpuShares
      || allocation.pids + this.quota.pids > this.hostCapacity.pids
    ) {
      throw new OrchestratorError("SESSION_LIMIT_REACHED", "host session capacity reached", 409);
    }
    this.reservations.set(id, { tenantId, quota: this.quota });
  }

  private currentAllocation(): HostCapacity {
    const quotas = [
      ...[...this.sessions.values()].map((session) => session.quota),
      ...[...this.reservations.values()].map((reservation) => reservation.quota),
    ];
    return quotas.reduce<HostCapacity>(
      (total, quota) => ({
        maximumSessions: total.maximumSessions + 1,
        memoryMiB: total.memoryMiB + quota.memoryMiB,
        cpuShares: total.cpuShares + quota.cpuShares,
        pids: total.pids + quota.pids,
      }),
      { maximumSessions: 0, memoryMiB: 0, cpuShares: 0, pids: 0 },
    );
  }

  private revokeCredentials(sessionKey: string): void {
    const credentials = this.credentialsBySession.get(sessionKey);
    if (!credentials) return;
    if (credentials.pairingTicketHash) this.pairingTickets.delete(credentials.pairingTicketHash);
    for (const tokenHash of credentials.signalingTokenHashes) this.signalingTokens.delete(tokenHash);
    this.credentialsBySession.delete(sessionKey);
  }

  private rotateSignalingTicket(sessionKey: string): SignalingTicketIssueResult {
    const credentials = this.credentialsBySession.get(sessionKey);
    if (!credentials) {
      throw new OrchestratorError("SIGNALING_UNAVAILABLE", "session credentials are unavailable", 409);
    }
    if (credentials.pairingTicketHash) this.pairingTickets.delete(credentials.pairingTicketHash);
    for (const tokenHash of credentials.signalingTokenHashes) this.signalingTokens.delete(tokenHash);
    credentials.signalingTokenHashes.clear();

    const signalingTicket = randomBytes(32).toString("base64url");
    const ticketHash = hashCredential(signalingTicket);
    credentials.pairingTicketHash = ticketHash;
    this.pairingTickets.set(ticketHash, {
      sessionKey,
      expiresAt: this.now() + this.pairingTicketTTLSeconds * 1_000,
    });
    return { signalingTicket, ticketExpiresInSeconds: this.pairingTicketTTLSeconds };
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

function validateHostCapacity(capacity: HostCapacity): HostCapacity {
  return {
    maximumSessions: positiveInteger(capacity.maximumSessions, "host session capacity"),
    ...validateQuota(capacity),
  };
}

function fitsWithin(quota: SessionQuota, capacity: HostCapacity): boolean {
  return quota.memoryMiB <= capacity.memoryMiB
    && quota.cpuShares <= capacity.cpuShares
    && quota.pids <= capacity.pids;
}

function toSessionView(record: SessionRecord): SessionView {
  return {
    id: record.id,
    phase: record.phase,
    createdAt: record.createdAt,
    quota: record.quota,
    ...(record.failure === undefined ? {} : { failure: record.failure }),
  };
}
