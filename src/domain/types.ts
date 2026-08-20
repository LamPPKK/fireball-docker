export type SessionPhase = "starting" | "active" | "burning" | "failed";

export interface TenantContext {
  readonly tenantId: string;
  readonly subject: string;
}

export interface SessionQuota {
  readonly memoryMiB: number;
  readonly cpuShares: number;
  readonly pids: number;
}

export interface HostCapacity extends SessionQuota {
  readonly maximumSessions: number;
}

export interface RuntimeResource {
  readonly containerId: string;
  readonly containerName: string;
  readonly networkNamespace: string;
  readonly storageNamespace: string;
}

export interface SessionRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly phase: SessionPhase;
  readonly createdAt: string;
  readonly quota: SessionQuota;
  readonly runtime: RuntimeResource;
  readonly failure?: string;
}

export interface CreateSessionResult {
  readonly session: SessionRecord;
  readonly signalingTicket: string;
  readonly ticketExpiresInSeconds: number;
}

export interface SignalingTokenExchangeResult {
  readonly signalingToken: string;
  readonly tokenExpiresInSeconds: number;
}

export interface SignalingAuthorization {
  readonly sessionId: string;
  readonly tenantId: string;
  readonly runtime: RuntimeResource;
}
