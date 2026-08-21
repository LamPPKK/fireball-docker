import WebSocket, { type RawData } from "ws";

import { OrchestratorError } from "../domain/errors.js";
import type { RuntimeResource } from "../domain/types.js";

const DEFAULT_CONNECT_TIMEOUT_MS = 3_000;
const DEFAULT_MAX_PAYLOAD_BYTES = 64 * 1024;

export interface SignalingConnector {
  connect(runtime: RuntimeResource, signal: AbortSignal): Promise<AuthenticatedSignalingConnection>;
}

export interface SignalingConnectionHandlers {
  readonly onMessage: (data: RawData, isBinary: boolean) => void;
  readonly onClose: () => void;
  readonly onError: () => void;
}

export interface AuthenticatedSignalingConnection {
  readonly socket: WebSocket;
  activate(handlers: SignalingConnectionHandlers): void;
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

  public async connect(runtime: RuntimeResource, signal: AbortSignal): Promise<AuthenticatedSignalingConnection> {
    validateTarget(runtime);
    if (signal.aborted) throw signalingUnavailable();

    return await new Promise<AuthenticatedSignalingConnection>((resolve, reject) => {
      const socket = new WebSocket(runtime.signalingEndpoint, {
        followRedirects: false,
        handshakeTimeout: this.connectTimeoutMs,
        maxPayload: this.maxPayloadBytes,
        perMessageDeflate: false,
      });
      let settled = false;
      let authenticated = false;
      let activated = false;
      let connectionHandlers: SignalingConnectionHandlers | undefined;
      const bufferedEvents: BufferedSignalingEvent[] = [];
      let bufferedBytes = 0;
      const timer = setTimeout(() => fail(), this.connectTimeoutMs);

      const cleanupHandshake = (): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        socket.off("open", onOpen);
        socket.off("unexpected-response", onUnexpectedResponse);
      };
      const fail = (): void => {
        if (settled) return;
        settled = true;
        cleanupHandshake();
        socket.off("message", onMessage);
        socket.off("error", onError);
        socket.off("close", onClose);
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
        if (!authenticated) {
          if (isBinary || !isAuthenticatedFrame(data)) {
            fail();
            return;
          }
          if (settled) return;
          authenticated = true;
          settled = true;
          cleanupHandshake();
          resolve({
            socket,
            activate: (handlers): void => {
              if (activated) throw new Error("signaling connection is already active");
              activated = true;
              connectionHandlers = handlers;
              for (const event of bufferedEvents.splice(0)) dispatchBufferedEvent(handlers, event);
              bufferedBytes = 0;
            },
          });
          return;
        }
        if (activated && connectionHandlers) {
          connectionHandlers.onMessage(data, isBinary);
          return;
        }
        const payload = rawDataToBuffer(data);
        if (bufferedEvents.length >= 16 || bufferedBytes + payload.byteLength > this.maxPayloadBytes * 4) {
          bufferedEvents.push({ type: "error" });
          socket.terminate();
          return;
        }
        bufferedBytes += payload.byteLength;
        bufferedEvents.push({ type: "message", data: Buffer.from(payload), isBinary });
      };
      const onError = (): void => {
        if (!authenticated) {
          fail();
          return;
        }
        if (activated && connectionHandlers) connectionHandlers.onError();
        else bufferedEvents.push({ type: "error" });
      };
      const onClose = (): void => {
        if (!authenticated) {
          fail();
          return;
        }
        if (activated && connectionHandlers) connectionHandlers.onClose();
        else bufferedEvents.push({ type: "close" });
      };
      const onUnexpectedResponse = (_request: unknown, response: NodeJS.ReadableStream): void => {
        response.resume();
        fail();
      };

      signal.addEventListener("abort", onAbort, { once: true });
      socket.once("open", onOpen);
      socket.on("message", onMessage);
      socket.once("error", onError);
      socket.once("close", onClose);
      socket.once("unexpected-response", onUnexpectedResponse);
    });
  }
}

type BufferedSignalingEvent =
  | { readonly type: "message"; readonly data: Buffer; readonly isBinary: boolean }
  | { readonly type: "close" }
  | { readonly type: "error" };

function dispatchBufferedEvent(handlers: SignalingConnectionHandlers, event: BufferedSignalingEvent): void {
  if (event.type === "message") handlers.onMessage(event.data, event.isBinary);
  else if (event.type === "close") handlers.onClose();
  else handlers.onError();
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
