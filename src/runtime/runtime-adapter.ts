import type { RuntimeResource, SessionQuota } from "../domain/types.js";

export interface CreateRuntimeRequest {
  readonly sessionId: string;
  readonly tenantId: string;
  readonly quota: SessionQuota;
}

export interface RuntimeAdapter {
  create(request: CreateRuntimeRequest): Promise<RuntimeResource>;
  destroy(resource: RuntimeResource): Promise<void>;
}
