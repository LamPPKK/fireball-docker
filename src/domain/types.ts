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
  readonly signalingTicketHash: string;
  readonly failure?: string;
}

export interface CreateSessionResult {
  readonly session: Omit<SessionRecord, "signalingTicketHash">;
  readonly signalingTicket: string;
  readonly ticketExpiresInSeconds: number;
}
