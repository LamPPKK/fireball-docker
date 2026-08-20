import WebSocket, { type RawData } from "ws";

import { OrchestratorError } from "../domain/errors.js";
import type { RuntimeResource } from "../domain/types.js";

const DEFAULT_CONNECT_TIMEOUT_MS = 3_000;
const DEFAULT_MAX_PAYLOAD_BYTES = 64 * 1024;

export interface SignalingConnector {
  connect(runtime: RuntimeResource, signal: AbortSignal): Promise<WebSocket>;
}

export interface WebSocketSignalingConnectorOptions {
  readonly connectTimeoutMs?: number;
  readonly maxPayloadBytes?: number;
}

export class WebSocketSignalingConnector implements SignalingConnector {
  private readonly connectTimeoutMs: number;
  private readonly maxPayloadBytes: number;

  public constructor(options: WebSocketSignalingConnectorOptions = {}) {
    this.connectTimeoutMs = positiveInteger(options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS, "connect timeout");
    this.maxPayloadBytes = positiveInteger(options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES, "maximum payload");
  }

  public async connect(runtime: RuntimeResource, signal: AbortSignal): Promise<WebSocket> {
    validateTarget(runtime);
    if (signal.aborted) throw signalingUnavailable();

    return await new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(runtime.signalingEndpoint, {
        followRedirects: false,
        handshakeTimeout: this.connectTimeoutMs,
        maxPayload: this.maxPayloadBytes,
        perMessageDeflate: false,
      });
      let settled = false;
      const timer = setTimeout(() => fail(), this.connectTimeoutMs);

      const cleanup = (): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        socket.off("open", onOpen);
        socket.off("message", onMessage);
        socket.off("error", onError);
        socket.off("close", onClose);
        socket.off("unexpected-response", onUnexpectedResponse);
      };
      const fail = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        socket.terminate();
        reject(signalingUnavailable());
      };
      const onAbort = (): void => fail();
      const onOpen = (): void => {
        socket.send(
          JSON.stringify({ type: "authenticate", secret: runtime.signalingSecret }),
          { binary: false, compress: false },
          (error) => {
            if (error) fail();
          },
        );
      };
      const onMessage = (data: RawData, isBinary: boolean): void => {
        if (isBinary || !isAuthenticatedFrame(data)) {
          fail();
          return;
        }
        if (settled) return;
        settled = true;
        cleanup();
        resolve(socket);
      };
      const onError = (): void => fail();
      const onClose = (): void => fail();
      const onUnexpectedResponse = (_request: unknown, response: NodeJS.ReadableStream): void => {
        response.resume();
        fail();
      };

      signal.addEventListener("abort", onAbort, { once: true });
      socket.once("open", onOpen);
      socket.once("message", onMessage);
      socket.once("error", onError);
      socket.once("close", onClose);
      socket.once("unexpected-response", onUnexpectedResponse);
    });
  }
}

function validateTarget(runtime: RuntimeResource): void {
  let endpoint: URL;
  try {
    endpoint = new URL(runtime.signalingEndpoint);
  } catch {
    throw signalingUnavailable();
  }
  if (
    endpoint.protocol !== "ws:"
    || endpoint.username !== ""
    || endpoint.password !== ""
    || endpoint.pathname !== "/internal/v1/signaling"
    || endpoint.search !== ""
    || endpoint.hash !== ""
    || !/^[A-Za-z0-9_-]{43}$/.test(runtime.signalingSecret)
  ) {
    throw signalingUnavailable();
  }
}

function isAuthenticatedFrame(data: RawData): boolean {
  try {
    const value = JSON.parse(rawDataToBuffer(data).toString("utf8")) as unknown;
    return isRecord(value)
      && Object.keys(value).length === 1
      && value.type === "authenticated";
  } catch {
    return false;
  }
}

function rawDataToBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(data);
}

function signalingUnavailable(): OrchestratorError {
  return new OrchestratorError("SIGNALING_UNAVAILABLE", "internal signaling channel is unavailable", 503);
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
