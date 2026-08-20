import { request as httpRequest } from "node:http";
import { isAbsolute } from "node:path";

import { OrchestratorError } from "../domain/errors.js";

export interface DockerEngineResponse {
  readonly Id?: string;
  readonly message?: string;
}

export interface DockerContainerSummary {
  readonly Id?: string;
  readonly Labels?: Record<string, string>;
}

export interface DockerNetworkSummary {
  readonly Id?: string;
  readonly Labels?: Record<string, string>;
}

export interface DockerContainerInspectResponse {
  readonly NetworkSettings?: {
    readonly Ports?: Record<string, ReadonlyArray<{
      readonly HostIp?: string;
      readonly HostPort?: string;
    }> | null>;
  };
}

export interface DockerEngineRequest {
  readonly method: "GET" | "POST" | "DELETE";
  readonly path: string;
  readonly body?: unknown;
  readonly acceptedStatusCodes: readonly number[];
}

export interface DockerEngineTransport {
  call<T>(request: DockerEngineRequest): Promise<T>;
}

export class UnixSocketDockerEngineTransport implements DockerEngineTransport {
  public constructor(
    private readonly socketPath: string,
    private readonly timeoutDuration = 10_000,
  ) {
    if (!isAbsolute(socketPath)) throw new Error("Docker socket path must be absolute");
    if (!Number.isSafeInteger(timeoutDuration) || timeoutDuration <= 0) {
      throw new Error("Docker Engine timeout must be a positive integer");
    }
  }

  public async call<T>(input: DockerEngineRequest): Promise<T> {
    const payload = input.body === undefined ? undefined : JSON.stringify(input.body);
    return await new Promise<T>((resolve, reject) => {
      const request = httpRequest(
        {
          socketPath: this.socketPath,
          method: input.method,
          path: input.path,
          headers: payload
            ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
            : undefined,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let parsed: unknown = {};
            if (text) {
              try {
                parsed = JSON.parse(text) as unknown;
              } catch {
                reject(new OrchestratorError("RUNTIME_FAILURE", "Docker Engine returned invalid JSON", 503));
                return;
              }
            }
            if (!input.acceptedStatusCodes.includes(response.statusCode ?? 500)) {
              reject(new OrchestratorError("RUNTIME_FAILURE", dockerErrorMessage(parsed), 503));
              return;
            }
            resolve(parsed as T);
          });
        },
      );
      request.setTimeout(this.timeoutDuration, () => request.destroy(new Error("Docker Engine request timed out")));
      request.once("error", (error) => reject(new OrchestratorError("RUNTIME_FAILURE", error.message, 503)));
      if (payload) request.write(payload);
      request.end();
    });
  }
}

function dockerErrorMessage(value: unknown): string {
  if (isRecord(value) && typeof value.message === "string" && value.message.length > 0) return value.message;
  return "Docker Engine request failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
