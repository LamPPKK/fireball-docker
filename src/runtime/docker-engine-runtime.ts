import { randomBytes } from "node:crypto";
import { isAbsolute, normalize } from "node:path";

import { OrchestratorError } from "../domain/errors.js";
import type { RuntimeResource } from "../domain/types.js";
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
  readonly iceDiagnostics?: boolean;
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
    if (options.iceDiagnostics !== undefined && typeof options.iceDiagnostics !== "boolean") {
      throw new Error("session ICE diagnostics flag must be boolean");
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
            ...(this.options.iceDiagnostics === true ? ["FIREBALL_GST_ICE_DIAGNOSTICS=1"] : []),
          ],
          ExposedPorts: { [INTERNAL_SIGNALING_PORT]: {} },
          HostConfig: {
            AutoRemove: false,
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
