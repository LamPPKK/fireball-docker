import { request as httpRequest } from "node:http";

import { OrchestratorError } from "../domain/errors.js";
import type { RuntimeResource } from "../domain/types.js";
import type { CreateRuntimeRequest, RuntimeAdapter } from "./runtime-adapter.js";

interface DockerResponse {
  readonly Id?: string;
  readonly message?: string;
}

export interface DockerEngineOptions {
  readonly socketPath: string;
  readonly apiVersion: string;
  readonly image: string;
}

export class DockerEngineRuntime implements RuntimeAdapter {
  public constructor(private readonly options: DockerEngineOptions) {}

  public async create(input: CreateRuntimeRequest): Promise<RuntimeResource> {
    const containerName = `fireball-${input.sessionId}`;
    const networkNamespace = `fireball-net-${input.sessionId}`;
    await this.call("POST", `/v${this.options.apiVersion}/networks/create`, {
      Name: networkNamespace,
      CheckDuplicate: true,
      Internal: false,
      Labels: isolationLabels(input),
    });

    try {
      const response = await this.call(
        "POST",
        `/v${this.options.apiVersion}/containers/create?name=${encodeURIComponent(containerName)}`,
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
      if (!response.Id) throw new Error("Docker did not return a container id");
      await this.call("POST", `/v${this.options.apiVersion}/containers/${response.Id}/start`);
      return {
        containerId: response.Id,
        containerName,
        networkNamespace,
        storageNamespace: `/run/fireball-session:${response.Id}`,
      };
    } catch (error) {
      await this.call("DELETE", `/v${this.options.apiVersion}/networks/${networkNamespace}`).catch(() => undefined);
      throw error;
    }
  }

  public async destroy(resource: RuntimeResource): Promise<void> {
    const failures: string[] = [];
    await this.call("DELETE", `/v${this.options.apiVersion}/containers/${resource.containerId}?force=true&v=true`).catch(
      (error: unknown) => failures.push(errorMessage(error)),
    );
    await this.call("DELETE", `/v${this.options.apiVersion}/networks/${resource.networkNamespace}`).catch(
      (error: unknown) => failures.push(errorMessage(error)),
    );
    if (failures.length > 0) {
      throw new OrchestratorError("RUNTIME_FAILURE", failures.join("; "), 503);
    }
  }

  private async call(method: string, path: string, body?: unknown): Promise<DockerResponse> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return await new Promise<DockerResponse>((resolve, reject) => {
      const request = httpRequest(
        {
          socketPath: this.options.socketPath,
          method,
          path,
          headers: payload
            ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
            : undefined,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let parsed: DockerResponse;
            try {
              parsed = text ? (JSON.parse(text) as DockerResponse) : {};
            } catch {
              reject(new OrchestratorError("RUNTIME_FAILURE", "Docker Engine returned invalid JSON", 503));
              return;
            }
            if ((response.statusCode ?? 500) >= 400) {
              reject(new OrchestratorError("RUNTIME_FAILURE", parsed.message ?? "Docker Engine request failed", 503));
              return;
            }
            resolve(parsed);
          });
        },
      );
      request.once("error", (error) => reject(new OrchestratorError("RUNTIME_FAILURE", error.message, 503)));
      if (payload) request.write(payload);
      request.end();
    });
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
