import type { RuntimeResource, SessionQuota, TabView } from "../domain/types.js";

export interface CreateRuntimeRequest {
  readonly sessionId: string;
  readonly tenantId: string;
  readonly quota: SessionQuota;
}

export interface ReconciliationResult {
  readonly containersRemoved: number;
  readonly networksRemoved: number;
}

export interface RuntimeAdapter {
  create(request: CreateRuntimeRequest): Promise<RuntimeResource>;
  destroy(resource: RuntimeResource): Promise<void>;
  reconcile(): Promise<ReconciliationResult>;
  listTabs(resource: RuntimeResource): Promise<readonly TabView[]>;
  createTab(resource: RuntimeResource, url?: string): Promise<TabView>;
  activateTab(resource: RuntimeResource, tabId: string): Promise<TabView>;
  navigateTab(resource: RuntimeResource, tabId: string, url: string): Promise<TabView>;
  deleteTab(resource: RuntimeResource, tabId: string): Promise<void>;
}
