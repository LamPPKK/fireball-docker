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

export type RuntimeInspection =
  | { readonly state: "running" }
  | {
    readonly state: "failed";
    readonly failure: "runtime stopped unexpectedly" | "runtime container is missing";
  };

export interface RuntimeAdapter {
  create(request: CreateRuntimeRequest): Promise<RuntimeResource>;
  inspect(resource: RuntimeResource): Promise<RuntimeInspection>;
  destroy(resource: RuntimeResource): Promise<void>;
  reconcile(): Promise<ReconciliationResult>;
  listTabs(resource: RuntimeResource): Promise<readonly TabView[]>;
  createTab(resource: RuntimeResource, url?: string): Promise<TabView>;
  activateTab(resource: RuntimeResource, tabId: string): Promise<TabView>;
  navigateTab(resource: RuntimeResource, tabId: string, url: string): Promise<TabView>;
  deleteTab(resource: RuntimeResource, tabId: string): Promise<void>;
}
