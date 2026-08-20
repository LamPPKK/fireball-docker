import { randomUUID } from "node:crypto";

import type { RuntimeResource } from "../domain/types.js";
import type { CreateRuntimeRequest, ReconciliationResult, RuntimeAdapter } from "./runtime-adapter.js";

export class InMemoryRuntime implements RuntimeAdapter {
  public readonly resources = new Map<string, RuntimeResource>();

  public async create(request: CreateRuntimeRequest): Promise<RuntimeResource> {
    const nonce = randomUUID();
    const resource: RuntimeResource = {
      containerId: `mock-${nonce}`,
      containerName: `fireball-${request.sessionId}`,
      networkNamespace: `net-${nonce}`,
      storageNamespace: `tmpfs-${nonce}`,
    };
    this.resources.set(resource.containerId, resource);
    return resource;
  }

  public async destroy(resource: RuntimeResource): Promise<void> {
    this.resources.delete(resource.containerId);
  }

  public async reconcile(): Promise<ReconciliationResult> {
    const containersRemoved = this.resources.size;
    this.resources.clear();
    return { containersRemoved, networksRemoved: containersRemoved };
  }
}
