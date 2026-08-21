import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { isAbsolute, normalize } from "node:path";

import { OrchestratorError } from "../domain/errors.js";
import type { ErrorCode } from "../domain/errors.js";
import type { RuntimeResource, TabView } from "../domain/types.js";
import {
  UnixSocketDockerEngineTransport,
  type DockerContainerInspectResponse,
  type DockerContainerSummary,
  type DockerEngineResponse,
  type DockerEngineTransport,
  type DockerNetworkSummary,
} from "./docker-engine-transport.js";
import type { CreateRuntimeRequest, ReconciliationResult, RuntimeAdapter } from "./runtime-adapter.js";
import { validateProfileShape } from "./seccomp-profile.js";

export interface DockerEngineOptions {
  readonly socketPath: string;
  readonly apiVersion: string;
  readonly image: string;
  readonly instanceId: string;
  readonly appArmorProfile?: string;
  readonly seccompProfile?: string;
  readonly iceServersFile?: string;
  readonly requestTimeoutMs?: number;
  readonly startupHealthAttempts?: number;
  readonly startupHealthIntervalMs?: number;
}

const INTERNAL_SIGNALING_PORT = "8444/tcp";
const SIGNALING_HOST = "127.0.0.1";
const ICE_SERVERS_CONTAINER_PATH = "/run/fireball-secrets/ice-servers.json";

export class DockerEngineRuntime implements RuntimeAdapter {
  private readonly transport: DockerEngineTransport;
  private readonly startupHealthAttempts: number;
  private readonly startupHealthIntervalMs: number;
  private readonly controlRequestTimeoutMs: number;

  public constructor(
    private readonly options: DockerEngineOptions,
    transport?: DockerEngineTransport,
  ) {
    if (!/^\d+\.\d+$/.test(options.apiVersion)) throw new Error("Docker API version must be numeric");
    if (!options.image.trim() || options.image.length > 255) throw new Error("session image must be non-empty");
    if (!isSafeLabelValue(options.instanceId)) throw new Error("orchestrator instance id is invalid");
    if (options.appArmorProfile !== undefined && !isSafeSecurityProfile(options.appArmorProfile)) {
      throw new Error("session AppArmor profile is invalid");
    }
    if (options.seccompProfile !== undefined) validateSeccompProfile(options.seccompProfile);
    if (
      options.iceServersFile !== undefined
      && (
        !isAbsolute(options.iceServersFile)
        || normalize(options.iceServersFile) !== options.iceServersFile
        || !/^\/[A-Za-z0-9._/-]+$/.test(options.iceServersFile)
        || options.iceServersFile.length > 4_096
      )
    ) {
      throw new Error("session ICE servers file must be a safe absolute host path");
    }
    this.startupHealthAttempts = positiveInteger(options.startupHealthAttempts ?? 60, "startup health attempts");
    this.startupHealthIntervalMs = positiveInteger(
      options.startupHealthIntervalMs ?? 1_000,
      "startup health interval",
    );
    const requestTimeoutMs = positiveInteger(
      options.requestTimeoutMs ?? 30_000,
      "Docker Engine request timeout",
    );
    this.controlRequestTimeoutMs = requestTimeoutMs;
    this.transport = transport ?? new UnixSocketDockerEngineTransport(options.socketPath, requestTimeoutMs);
  }

  public async create(input: CreateRuntimeRequest): Promise<RuntimeResource> {
    const containerName = `fireball-${input.sessionId}`;
    const networkNamespace = `fireball-net-${input.sessionId}`;
    const signalingSecret = randomBytes(32).toString("base64url");
    let networkCreated = false;
    let containerCreated = false;
    let containerId: string | undefined;
    await this.call("POST", `/v${this.options.apiVersion}/networks/create`, [201], {
      Name: networkNamespace,
      CheckDuplicate: true,
      Internal: false,
      Labels: isolationLabels(input, this.options.instanceId),
    });
    networkCreated = true;

    try {
      const response = await this.call<DockerEngineResponse>(
        "POST",
        `/v${this.options.apiVersion}/containers/create?name=${encodeURIComponent(containerName)}`,
        [201],
        {
          Image: this.options.image,
          Labels: isolationLabels(input, this.options.instanceId),
          Env: [
            `FIREBALL_INTERNAL_SIGNALING_SECRET=${signalingSecret}`,
            ...(this.options.iceServersFile === undefined
              ? []
              : [`FIREBALL_ICE_SERVERS_FILE=${ICE_SERVERS_CONTAINER_PATH}`]),
          ],
          ExposedPorts: { [INTERNAL_SIGNALING_PORT]: {} },
          HostConfig: {
            AutoRemove: false,
            RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
            Memory: input.quota.memoryMiB * 1024 * 1024,
            CpuShares: input.quota.cpuShares,
            PidsLimit: input.quota.pids,
            NetworkMode: networkNamespace,
            ReadonlyRootfs: true,
            CapDrop: ["ALL"],
            SecurityOpt: [
              "no-new-privileges:true",
              ...(this.options.appArmorProfile === undefined
                ? []
                : [`apparmor=${this.options.appArmorProfile}`]),
              ...(this.options.seccompProfile === undefined
                ? []
                : [`seccomp=${this.options.seccompProfile}`]),
            ],
            Tmpfs: {
              "/run/fireball-session": "rw,noexec,nosuid,nodev,size=256m,mode=0700,uid=10001,gid=10001",
            },
            Mounts: this.options.iceServersFile === undefined
              ? []
              : [{
                Type: "bind",
                Source: this.options.iceServersFile,
                Target: ICE_SERVERS_CONTAINER_PATH,
                ReadOnly: true,
                BindOptions: { Propagation: "rprivate" },
              }],
            PortBindings: {
              [INTERNAL_SIGNALING_PORT]: [{ HostIp: "127.0.0.1", HostPort: "" }],
            },
          },
        },
      );
      containerCreated = true;
      if (!response.Id) throw new Error("Docker did not return a container id");
      containerId = response.Id;
      await this.call("POST", `/v${this.options.apiVersion}/containers/${containerId}/start`, [204]);
      const inspect = await this.waitForHealthy(containerId);
      const signalingPort = publishedSignalingPort(inspect);
      return {
        containerId,
        containerName,
        networkNamespace,
        storageNamespace: `/run/fireball-session:${response.Id}`,
        signalingEndpoint: `ws://${SIGNALING_HOST}:${signalingPort}/internal/v1/signaling`,
        signalingSecret,
        tabControlEndpoint: `http://${SIGNALING_HOST}:${signalingPort}/internal/v1/tabs`,
      };
    } catch (error) {
      const rollbackFailures: string[] = [];
      if (containerCreated) {
        const containerReference = containerId ?? containerName;
        await this.call(
          "DELETE",
          `/v${this.options.apiVersion}/containers/${encodeURIComponent(containerReference)}?force=true&v=true`,
          [204, 404],
        ).catch((rollbackError: unknown) => rollbackFailures.push(errorMessage(rollbackError)));
      }
      if (networkCreated) {
        await this.call("DELETE", `/v${this.options.apiVersion}/networks/${networkNamespace}`, [204, 404]).catch(
          (rollbackError: unknown) => rollbackFailures.push(errorMessage(rollbackError)),
        );
      }
      if (rollbackFailures.length > 0) {
        throw new OrchestratorError(
          "RUNTIME_FAILURE",
          `${errorMessage(error)}; rollback failed: ${rollbackFailures.join("; ")}`,
          503,
        );
      }
      if (error instanceof OrchestratorError) throw error;
      throw new OrchestratorError("RUNTIME_FAILURE", errorMessage(error), 503);
    }
  }

  public async destroy(resource: RuntimeResource): Promise<void> {
    const failures: string[] = [];
    await this.call(
      "DELETE",
      `/v${this.options.apiVersion}/containers/${resource.containerId}?force=true&v=true`,
      [204, 404],
    ).catch((error: unknown) => failures.push(errorMessage(error)));
    await this.call(
      "DELETE",
      `/v${this.options.apiVersion}/networks/${resource.networkNamespace}`,
      [204, 404],
    ).catch((error: unknown) => failures.push(errorMessage(error)));
    if (failures.length > 0) {
      throw new OrchestratorError("RUNTIME_FAILURE", failures.join("; "), 503);
    }
  }

  public async reconcile(): Promise<ReconciliationResult> {
    const failures: string[] = [];
    let containersRemoved = 0;
    let networksRemoved = 0;
    const containers = await this.listManagedContainers();
    for (const container of containers) {
      const id = managedResourceId(container, this.options.instanceId);
      if (!id) continue;
      await this.call(
        "DELETE",
        `/v${this.options.apiVersion}/containers/${encodeURIComponent(id)}?force=true&v=true`,
        [204, 404],
      )
        .then(() => {
          containersRemoved += 1;
        })
        .catch((error: unknown) => failures.push(`container ${id}: ${errorMessage(error)}`));
    }

    const networks = await this.listManagedNetworks();
    for (const network of networks) {
      const id = managedResourceId(network, this.options.instanceId);
      if (!id) continue;
      await this.call("DELETE", `/v${this.options.apiVersion}/networks/${encodeURIComponent(id)}`, [204, 404])
        .then(() => {
          networksRemoved += 1;
        })
        .catch((error: unknown) => failures.push(`network ${id}: ${errorMessage(error)}`));
    }
    if (failures.length > 0) {
      throw new OrchestratorError("RUNTIME_FAILURE", `runtime reconciliation failed: ${failures.join("; ")}`, 503);
    }
    return { containersRemoved, networksRemoved };
  }

  public async listTabs(resource: RuntimeResource): Promise<readonly TabView[]> {
    const body = await this.controlRequest(resource, "GET", "", undefined, 200);
    if (!isObject(body) || !Array.isArray(body.tabs)) throw invalidTabRuntimeResponse();
    const tabs = body.tabs.map((value) => parseTabView(value));
    if (
      tabs.length < 1
      || tabs.length > 4
      || new Set(tabs.map((tab) => tab.id)).size !== tabs.length
      || tabs.filter((tab) => tab.active).length !== 1
    ) {
      throw invalidTabRuntimeResponse();
    }
    return tabs;
  }

  public async createTab(resource: RuntimeResource, url?: string): Promise<TabView> {
    const body = await this.controlRequest(resource, "POST", "", url === undefined ? {} : { url }, 201);
    if (!isObject(body)) throw invalidTabRuntimeResponse();
    return parseTabView(body.tab);
  }

  public async activateTab(resource: RuntimeResource, tabId: string): Promise<TabView> {
    const body = await this.controlRequest(resource, "PUT", `/${encodeURIComponent(tabId)}/active`, undefined, 200);
    if (!isObject(body)) throw invalidTabRuntimeResponse();
    return parseTabView(body.tab);
  }

  public async navigateTab(resource: RuntimeResource, tabId: string, url: string): Promise<TabView> {
    const body = await this.controlRequest(
      resource,
      "PUT",
      `/${encodeURIComponent(tabId)}/navigation`,
      { url },
      200,
    );
    if (!isObject(body)) throw invalidTabRuntimeResponse();
    return parseTabView(body.tab);
  }

  public async deleteTab(resource: RuntimeResource, tabId: string): Promise<void> {
    await this.controlRequest(resource, "DELETE", `/${encodeURIComponent(tabId)}`, undefined, 204);
  }

  private async listManagedContainers(): Promise<readonly unknown[]> {
    const response = await this.call<unknown>(
      "GET",
      `/v${this.options.apiVersion}/containers/json?all=true&filters=${ownershipFilter(this.options.instanceId)}`,
      [200],
    );
    if (!Array.isArray(response)) {
      throw new OrchestratorError("RUNTIME_FAILURE", "Docker Engine returned an invalid container list", 503);
    }
    return response;
  }

  private async controlRequest(
    resource: RuntimeResource,
    method: "GET" | "POST" | "PUT" | "DELETE",
    suffix: string,
    body: unknown,
    expectedStatus: number,
  ): Promise<unknown> {
    const endpoint = validateTabControlResource(resource);
    const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    return await new Promise<unknown>((resolve, reject) => {
      const request = httpRequest({
        protocol: "http:",
        hostname: endpoint.hostname,
        port: endpoint.port,
        method,
        path: `${endpoint.pathname}${suffix}`,
        headers: {
          authorization: `Bearer ${resource.signalingSecret}`,
          connection: "close",
          ...(encoded === undefined ? {} : {
            "content-type": "application/json",
            "content-length": String(encoded.length),
          }),
        },
      });
      const timeout = setTimeout(() => request.destroy(new Error("tab runtime request timed out")), this.controlRequestTimeoutMs);
      timeout.unref();
      request.once("response", (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 64 * 1024) response.destroy(new Error("tab runtime response is too large"));
          else chunks.push(chunk);
        });
        response.once("error", (error) => {
          clearTimeout(timeout);
          reject(tabRuntimeUnavailable(error));
        });
        response.once("end", () => {
          clearTimeout(timeout);
          const source = Buffer.concat(chunks).toString("utf8");
          if (response.statusCode === expectedStatus) {
            if (expectedStatus === 204) {
              if (source !== "") reject(invalidTabRuntimeResponse());
              else resolve(undefined);
              return;
            }
            try {
              resolve(JSON.parse(source));
            } catch {
              reject(invalidTabRuntimeResponse());
            }
            return;
          }
          reject(parseTabRuntimeError(response.statusCode, source));
        });
      });
      request.once("error", (error) => {
        clearTimeout(timeout);
        reject(tabRuntimeUnavailable(error));
      });
      if (encoded) request.end(encoded);
      else request.end();
    });
  }

  private async waitForHealthy(containerId: string): Promise<DockerContainerInspectResponse> {
    for (let attempt = 1; attempt <= this.startupHealthAttempts; attempt += 1) {
      const inspect = await this.call<DockerContainerInspectResponse>(
        "GET",
        `/v${this.options.apiVersion}/containers/${encodeURIComponent(containerId)}/json`,
        [200],
      );
      const status = inspect.State?.Health?.Status;
      if (status === "healthy") return inspect;
      if (status !== "starting") {
        throw new Error(status === "unhealthy"
          ? "session container failed its startup health check"
          : "session image does not expose a Docker health check");
      }
      if (attempt < this.startupHealthAttempts) await delay(this.startupHealthIntervalMs);
    }
    throw new Error("session container startup health check timed out");
  }

  private async listManagedNetworks(): Promise<readonly unknown[]> {
    const response = await this.call<unknown>(
      "GET",
      `/v${this.options.apiVersion}/networks?filters=${ownershipFilter(this.options.instanceId)}`,
      [200],
    );
    if (!Array.isArray(response)) {
      throw new OrchestratorError("RUNTIME_FAILURE", "Docker Engine returned an invalid network list", 503);
    }
    return response;
  }

  private async call<T = DockerEngineResponse>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    acceptedStatusCodes: readonly number[],
    body?: unknown,
  ): Promise<T> {
    return await this.transport.call<T>({
      method,
      path,
      acceptedStatusCodes,
      ...(body === undefined ? {} : { body }),
    });
  }
}

function isolationLabels(input: CreateRuntimeRequest, instanceId: string): Record<string, string> {
  return {
    "dev.fireball.managed": "true",
    "dev.fireball.instance": instanceId,
    "dev.fireball.session": input.sessionId,
    "dev.fireball.tenant": input.tenantId,
  };
}

function ownershipFilter(instanceId: string): string {
  return encodeURIComponent(JSON.stringify({
    label: ["dev.fireball.managed=true", `dev.fireball.instance=${instanceId}`],
  }));
}

function managedResourceId(
  resource: unknown,
  instanceId: string,
): string | undefined {
  if (typeof resource !== "object" || resource === null || Array.isArray(resource)) return undefined;
  const summary = resource as DockerContainerSummary | DockerNetworkSummary;
  const labels = summary.Labels;
  const id = summary.Id;
  if (
    labels?.["dev.fireball.managed"] !== "true"
    || labels["dev.fireball.instance"] !== instanceId
    || typeof id !== "string"
    || !/^[A-Za-z0-9_.:-]{1,128}$/.test(id)
  ) {
    return undefined;
  }
  return id;
}

function isSafeLabelValue(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(value);
}

function isSafeSecurityProfile(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value);
}

function validateSeccompProfile(value: string): void {
  if (value.length === 0 || value.length > 128 * 1024 || value.includes("\0")) {
    throw new Error("session seccomp profile is invalid");
  }
  let document: unknown;
  try {
    document = JSON.parse(value);
  } catch {
    throw new Error("session seccomp profile is invalid");
  }
  try {
    validateProfileShape(document);
  } catch {
    throw new Error("session seccomp profile is invalid");
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function publishedSignalingPort(inspect: DockerContainerInspectResponse): number {
  const bindings = inspect.NetworkSettings?.Ports?.[INTERNAL_SIGNALING_PORT];
  const binding = bindings?.[0];
  const raw = binding?.HostPort;
  if (
    binding?.HostIp !== "127.0.0.1"
    || typeof raw !== "string"
    || !/^[1-9][0-9]{0,4}$/.test(raw)
  ) {
    throw new Error("Docker did not publish the internal signaling port");
  }
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port > 65_535) {
    throw new Error("Docker returned an invalid signaling port");
  }
  return port;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown runtime failure";
}

function validateTabControlResource(resource: RuntimeResource): URL {
  let endpoint: URL;
  let signaling: URL;
  try {
    endpoint = new URL(resource.tabControlEndpoint);
    signaling = new URL(resource.signalingEndpoint);
  } catch {
    throw invalidTabRuntimeResponse();
  }
  if (
    endpoint.protocol !== "http:"
    || endpoint.hostname !== SIGNALING_HOST
    || endpoint.username !== ""
    || endpoint.password !== ""
    || endpoint.pathname !== "/internal/v1/tabs"
    || endpoint.search !== ""
    || endpoint.hash !== ""
    || !/^[1-9][0-9]{0,4}$/.test(endpoint.port)
    || Number(endpoint.port) > 65_535
    || signaling.protocol !== "ws:"
    || signaling.hostname !== endpoint.hostname
    || signaling.port !== endpoint.port
    || signaling.username !== ""
    || signaling.password !== ""
    || signaling.pathname !== "/internal/v1/signaling"
    || signaling.search !== ""
    || signaling.hash !== ""
    || !/^[A-Za-z0-9_-]{43}$/.test(resource.signalingSecret)
  ) {
    throw invalidTabRuntimeResponse();
  }
  return endpoint;
}

function parseTabView(value: unknown): TabView {
  if (
    !isObject(value)
    || Object.keys(value).sort().join(",") !== "active,createdAt,id,url"
    || typeof value.id !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.id)
    || typeof value.url !== "string"
    || !isPublicTabUrl(value.url)
    || typeof value.createdAt !== "string"
    || !isCanonicalTimestamp(value.createdAt)
    || typeof value.active !== "boolean"
  ) {
    throw invalidTabRuntimeResponse();
  }
  return { id: value.id, url: value.url, createdAt: value.createdAt, active: value.active };
}

function parseTabRuntimeError(status: number | undefined, source: string): OrchestratorError {
  let document: unknown;
  try {
    document = JSON.parse(source);
  } catch {
    return invalidTabRuntimeResponse();
  }
  if (
    !isObject(document)
    || Object.keys(document).join(",") !== "error"
    || !isObject(document.error)
    || Object.keys(document.error).sort().join(",") !== "code,message"
  ) {
    return invalidTabRuntimeResponse();
  }
  const code = document.error.code;
  const expected = new Map<string, { readonly status: number; readonly code: ErrorCode; readonly message: string }>([
    ["TAB_NOT_FOUND", { status: 404, code: "TAB_NOT_FOUND", message: "tab not found" }],
    ["TAB_LIMIT_REACHED", { status: 409, code: "TAB_LIMIT_REACHED", message: "session tab limit reached" }],
    ["TAB_MINIMUM_REACHED", { status: 409, code: "TAB_MINIMUM_REACHED", message: "a session must retain one tab" }],
    ["TAB_URL_INVALID", { status: 400, code: "TAB_URL_INVALID", message: "tab URL is invalid" }],
  ]);
  const binding = typeof code === "string" ? expected.get(code) : undefined;
  if (!binding || binding.status !== status || typeof document.error.message !== "string") {
    return invalidTabRuntimeResponse();
  }
  return new OrchestratorError(binding.code, binding.message, binding.status);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCanonicalTimestamp(value: string): boolean {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function isPublicTabUrl(value: string): boolean {
  if (value === "fireball://home") return true;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol)
      && url.username === ""
      && url.password === ""
      && url.hostname !== ""
      && url.href === value;
  } catch {
    return false;
  }
}

function invalidTabRuntimeResponse(): OrchestratorError {
  return new OrchestratorError("TAB_RUNTIME_UNAVAILABLE", "tab runtime returned an invalid response", 503);
}

function tabRuntimeUnavailable(_error: unknown): OrchestratorError {
  return new OrchestratorError("TAB_RUNTIME_UNAVAILABLE", "tab runtime is unavailable", 503);
}
