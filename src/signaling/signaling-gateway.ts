import WebSocket, { type RawData } from "ws";

import { OrchestratorError } from "../domain/errors.js";
import { SessionService } from "../domain/session-service.js";
import { SignalingConnectionRegistry } from "./connection-registry.js";
import type { SignalingConnector } from "./upstream-connector.js";

const DEFAULT_AUTH_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BUFFERED_BYTES = 1024 * 1024;

type RelayPhase = "authenticating" | "connecting" | "relaying" | "closed";

export interface SignalingGatewayOptions {
  readonly authenticationTimeoutMs?: number;
  readonly maximumBufferedBytes?: number;
}

export class SignalingGateway {
  private readonly authenticationTimeoutMs: number;
  private readonly maximumBufferedBytes: number;

  public constructor(
    private readonly sessions: SessionService,
    private readonly connector: SignalingConnector,
    private readonly registry: SignalingConnectionRegistry,
    options: SignalingGatewayOptions = {},
  ) {
    this.authenticationTimeoutMs = positiveInteger(
      options.authenticationTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS,
      "authentication timeout",
    );
    this.maximumBufferedBytes = positiveInteger(
      options.maximumBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES,
      "maximum buffered bytes",
    );
  }

  public handle(client: WebSocket): void {
    let phase: RelayPhase = "authenticating";
    let upstream: WebSocket | undefined;
    let unregister = (): void => {};
    const abortController = new AbortController();
    const authenticationTimer = setTimeout(
      () => shutdown(1008, "authentication timeout"),
      this.authenticationTimeoutMs,
    );
    authenticationTimer.unref();

    const shutdown = (code: number, reason: string): void => {
      if (phase === "closed") return;
      phase = "closed";
      clearTimeout(authenticationTimer);
      abortController.abort();
      unregister();
      closeSocket(client, code, reason);
      if (upstream) closeSocket(upstream, code, reason);
    };

    const forward = (destination: WebSocket, data: RawData, isBinary: boolean): void => {
      if (destination.readyState !== WebSocket.OPEN) {
        shutdown(1011, "relay peer unavailable");
        return;
      }
      if (destination.bufferedAmount + rawDataByteLength(data) > this.maximumBufferedBytes) {
        shutdown(1013, "relay backpressure limit");
        return;
      }
      destination.send(data, { binary: isBinary, compress: false }, (error) => {
        if (error) shutdown(1011, "relay write failed");
      });
    };

    const connectUpstream = async (token: string): Promise<void> => {
      let authorization;
      try {
        authorization = this.sessions.authorizeSignalingToken(token);
      } catch (error) {
        if (error instanceof OrchestratorError) {
          shutdown(1008, "authentication failed");
          return;
        }
        shutdown(1011, "authentication unavailable");
        return;
      }

      phase = "connecting";
      clearTimeout(authenticationTimer);
      unregister = this.registry.register(authorization.sessionId, () => {
        shutdown(1008, "session ended");
      });

      try {
        const connected = await this.connector.connect(authorization.runtime, abortController.signal);
        if (abortController.signal.aborted) {
          connected.socket.terminate();
          return;
        }
        upstream = connected.socket;
        phase = "relaying";
        forward(
          client,
          Buffer.from(JSON.stringify({ type: "ready", sessionId: authorization.sessionId })),
          false,
        );
        connected.activate({
          onMessage: (data, isBinary) => forward(client, data, isBinary),
          onClose: () => shutdown(1011, "upstream closed"),
          onError: () => shutdown(1011, "upstream failed"),
        });
      } catch {
        shutdown(1011, "upstream unavailable");
      }
    };

    client.on("message", (data, isBinary) => {
      if (phase === "authenticating") {
        const token = parseAuthenticationFrame(data, isBinary);
        if (!token) {
          shutdown(1008, "authentication failed");
          return;
        }
        void connectUpstream(token);
        return;
      }
      if (phase === "connecting") {
        shutdown(1008, "wait for relay readiness");
        return;
      }
      if (phase === "relaying" && upstream) forward(upstream, data, isBinary);
    });
    client.once("close", () => shutdown(1000, "client disconnected"));
    client.once("error", () => shutdown(1011, "client connection failed"));
  }
}

function parseAuthenticationFrame(data: RawData, isBinary: boolean): string | undefined {
  if (isBinary) return undefined;
  try {
    const value = JSON.parse(rawDataToBuffer(data).toString("utf8")) as unknown;
    if (
      !isRecord(value)
      || Object.keys(value).sort().join(",") !== "token,type"
      || value.type !== "authenticate"
      || typeof value.token !== "string"
      || !/^[A-Za-z0-9_-]{43}$/.test(value.token)
    ) {
      return undefined;
    }
    return value.token;
  } catch {
    return undefined;
  }
}

function rawDataToBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(data);
}

function rawDataByteLength(data: RawData): number {
  if (Array.isArray(data)) {
    return data.reduce((total, chunk) => total + chunk.byteLength, 0);
  }
  return data.byteLength;
}

function closeSocket(socket: WebSocket, code: number, reason: string): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.close(code, reason);
  } else if (socket.readyState === WebSocket.CONNECTING) {
    socket.terminate();
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
