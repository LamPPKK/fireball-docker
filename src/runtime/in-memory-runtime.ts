import { randomBytes, randomUUID } from "node:crypto";

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
      signalingEndpoint: "ws://127.0.0.1:1/internal/v1/signaling",
      signalingSecret: randomBytes(32).toString("base64url"),
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
