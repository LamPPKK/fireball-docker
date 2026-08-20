import { OrchestratorError } from "../domain/errors.js";
import type { RuntimeResource } from "../domain/types.js";
import {
  UnixSocketDockerEngineTransport,
  type DockerContainerSummary,
  type DockerEngineResponse,
  type DockerEngineTransport,
  type DockerNetworkSummary,
} from "./docker-engine-transport.js";
import type { CreateRuntimeRequest, ReconciliationResult, RuntimeAdapter } from "./runtime-adapter.js";

export interface DockerEngineOptions {
  readonly socketPath: string;
  readonly apiVersion: string;
  readonly image: string;
  readonly instanceId: string;
}

export class DockerEngineRuntime implements RuntimeAdapter {
  private readonly transport: DockerEngineTransport;

  public constructor(
    private readonly options: DockerEngineOptions,
    transport?: DockerEngineTransport,
  ) {
    if (!/^\d+\.\d+$/.test(options.apiVersion)) throw new Error("Docker API version must be numeric");
    if (!options.image.trim() || options.image.length > 255) throw new Error("session image must be non-empty");
    if (!isSafeLabelValue(options.instanceId)) throw new Error("orchestrator instance id is invalid");
    this.transport = transport ?? new UnixSocketDockerEngineTransport(options.socketPath);
  }

  public async create(input: CreateRuntimeRequest): Promise<RuntimeResource> {
    const containerName = `fireball-${input.sessionId}`;
    const networkNamespace = `fireball-net-${input.sessionId}`;
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
          HostConfig: {
            AutoRemove: false,
            Memory: input.quota.memoryMiB * 1024 * 1024,
            CpuShares: input.quota.cpuShares,
            PidsLimit: input.quota.pids,
            NetworkMode: networkNamespace,
            ReadonlyRootfs: true,
            CapDrop: ["ALL"],
            SecurityOpt: ["no-new-privileges:true"],
            Tmpfs: { "/run/fireball-session": "rw,noexec,nosuid,nodev,size=256m,mode=0700" },
          },
        },
      );
      containerCreated = true;
      if (!response.Id) throw new Error("Docker did not return a container id");
      containerId = response.Id;
      await this.call("POST", `/v${this.options.apiVersion}/containers/${containerId}/start`, [204]);
      return {
        containerId,
        containerName,
        networkNamespace,
        storageNamespace: `/run/fireball-session:${response.Id}`,
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown runtime failure";
}
