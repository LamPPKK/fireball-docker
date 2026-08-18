import { OrchestratorError } from "../domain/errors.js";
import type { RuntimeResource } from "../domain/types.js";
import {
  UnixSocketDockerEngineTransport,
  type DockerEngineResponse,
  type DockerEngineTransport,
} from "./docker-engine-transport.js";
import type { CreateRuntimeRequest, RuntimeAdapter } from "./runtime-adapter.js";

export interface DockerEngineOptions {
  readonly socketPath: string;
  readonly apiVersion: string;
  readonly image: string;
}

export class DockerEngineRuntime implements RuntimeAdapter {
  private readonly transport: DockerEngineTransport;

  public constructor(
    private readonly options: DockerEngineOptions,
    transport?: DockerEngineTransport,
  ) {
    if (!/^\d+\.\d+$/.test(options.apiVersion)) throw new Error("Docker API version must be numeric");
    if (!options.image.trim() || options.image.length > 255) throw new Error("session image must be non-empty");
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
      Labels: isolationLabels(input),
    });
    networkCreated = true;

    try {
      const response = await this.call(
        "POST",
        `/v${this.options.apiVersion}/containers/create?name=${encodeURIComponent(containerName)}`,
        [201],
        {
          Image: this.options.image,
          Labels: isolationLabels(input),
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

  private async call(
    method: "POST" | "DELETE",
    path: string,
    acceptedStatusCodes: readonly number[],
    body?: unknown,
  ): Promise<DockerEngineResponse> {
    return await this.transport.call({ method, path, acceptedStatusCodes, ...(body === undefined ? {} : { body }) });
  }
}

function isolationLabels(input: CreateRuntimeRequest): Record<string, string> {
  return {
    "dev.fireball.managed": "true",
    "dev.fireball.session": input.sessionId,
    "dev.fireball.tenant": input.tenantId,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown runtime failure";
}
