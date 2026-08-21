import { randomBytes, randomUUID } from "node:crypto";

import { OrchestratorError } from "../domain/errors.js";
import type { RuntimeResource, TabView } from "../domain/types.js";
import type {
  CreateRuntimeRequest,
  ReconciliationResult,
  RuntimeAdapter,
  RuntimeInspection,
} from "./runtime-adapter.js";

export class InMemoryRuntime implements RuntimeAdapter {
  public readonly resources = new Map<string, RuntimeResource>();
  private readonly tabs = new Map<string, Map<string, TabView>>();

  public async create(request: CreateRuntimeRequest): Promise<RuntimeResource> {
    const nonce = randomUUID();
    const resource: RuntimeResource = {
      containerId: `mock-${nonce}`,
      containerName: `fireball-${request.sessionId}`,
      networkNamespace: `net-${nonce}`,
      storageNamespace: `tmpfs-${nonce}`,
      signalingEndpoint: "ws://127.0.0.1:1/internal/v1/signaling",
      signalingSecret: randomBytes(32).toString("base64url"),
      tabControlEndpoint: "http://127.0.0.1:1/internal/v1/tabs",
    };
    this.resources.set(resource.containerId, resource);
    const tabId = randomUUID();
    this.tabs.set(resource.containerId, new Map([[tabId, {
      id: tabId,
      url: "fireball://home",
      createdAt: new Date().toISOString(),
      active: true,
    }]]));
    return resource;
  }

  public async destroy(resource: RuntimeResource): Promise<void> {
    this.resources.delete(resource.containerId);
    this.tabs.delete(resource.containerId);
  }

  public async inspect(resource: RuntimeResource): Promise<RuntimeInspection> {
    return this.resources.has(resource.containerId)
      ? { state: "running" }
      : { state: "failed", failure: "runtime container is missing" };
  }

  public async reconcile(): Promise<ReconciliationResult> {
    const containersRemoved = this.resources.size;
    this.resources.clear();
    this.tabs.clear();
    return { containersRemoved, networksRemoved: containersRemoved };
  }

  public async listTabs(resource: RuntimeResource): Promise<readonly TabView[]> {
    return [...this.runtimeTabs(resource).values()];
  }

  public async createTab(resource: RuntimeResource, url = "fireball://home"): Promise<TabView> {
    const tabs = this.runtimeTabs(resource);
    if (tabs.size >= 4) throw new OrchestratorError("TAB_LIMIT_REACHED", "session tab limit reached", 409);
    for (const [id, tab] of tabs) tabs.set(id, { ...tab, active: false });
    const id = randomUUID();
    const tab = { id, url: validateTabUrl(url), createdAt: new Date().toISOString(), active: true };
    tabs.set(id, tab);
    return tab;
  }

  public async activateTab(resource: RuntimeResource, tabId: string): Promise<TabView> {
    const tabs = this.runtimeTabs(resource);
    const selected = tabs.get(tabId);
    if (!selected) throw tabNotFound();
    for (const [id, tab] of tabs) tabs.set(id, { ...tab, active: id === tabId });
    return { ...selected, active: true };
  }

  public async navigateTab(resource: RuntimeResource, tabId: string, url: string): Promise<TabView> {
    const tabs = this.runtimeTabs(resource);
    const previous = tabs.get(tabId);
    if (!previous) throw tabNotFound();
    const tab = { ...previous, url: validateTabUrl(url) };
    tabs.set(tabId, tab);
    return tab;
  }

  public async deleteTab(resource: RuntimeResource, tabId: string): Promise<void> {
    const tabs = this.runtimeTabs(resource);
    const selected = tabs.get(tabId);
    if (!selected) throw tabNotFound();
    if (tabs.size === 1) {
      throw new OrchestratorError("TAB_MINIMUM_REACHED", "a session must retain one tab", 409);
    }
    tabs.delete(tabId);
    if (selected.active) {
      const [fallbackId, fallback] = tabs.entries().next().value as [string, TabView];
      tabs.set(fallbackId, { ...fallback, active: true });
    }
  }

  private runtimeTabs(resource: RuntimeResource): Map<string, TabView> {
    const tabs = this.tabs.get(resource.containerId);
    if (!tabs) throw new OrchestratorError("TAB_RUNTIME_UNAVAILABLE", "tab runtime is unavailable", 503);
    return tabs;
  }
}

function validateTabUrl(value: string): string {
  if (value === "fireball://home") return value;
  if (Buffer.byteLength(value, "utf8") > 4_096) throw invalidTabUrl();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidTabUrl();
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || !url.hostname) {
    throw invalidTabUrl();
  }
  return url.href;
}

function tabNotFound(): OrchestratorError {
  return new OrchestratorError("TAB_NOT_FOUND", "tab not found", 404);
}

function invalidTabUrl(): OrchestratorError {
  return new OrchestratorError("TAB_URL_INVALID", "tab URL is invalid", 400);
}
