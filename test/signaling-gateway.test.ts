import assert from "node:assert/strict";
import { test } from "node:test";
import WebSocket, { WebSocketServer, type RawData } from "ws";

import { DevelopmentAuthenticator } from "../src/auth/authenticator.js";
import { buildApp } from "../src/app.js";
import { SessionService } from "../src/domain/session-service.js";
import type { RuntimeResource } from "../src/domain/types.js";
import type {
  CreateRuntimeRequest,
  ReconciliationResult,
  RuntimeAdapter,
} from "../src/runtime/runtime-adapter.js";
import { SignalingConnectionRegistry } from "../src/signaling/connection-registry.js";
import { SignalingGateway } from "../src/signaling/signaling-gateway.js";
import { WebSocketSignalingConnector } from "../src/signaling/upstream-connector.js";

const origin = "https://browser.example";
const internalSecret = "S".repeat(43);

test("signaling relay authenticates both hops, relays frames, and burn closes the socket", async (context) => {
  const upstream = await startUpstream(context);
  const runtime = new FixedRuntime(upstream.endpoint);
  const registry = new SignalingConnectionRegistry();
  const sessions = new SessionService(runtime, {
    revokeSignalingConnections: (sessionId) => registry.revoke(sessionId),
  });
  const app = buildApp({
    authenticator: new DevelopmentAuthenticator("test"),
    sessions,
    signaling: new SignalingGateway(sessions, new WebSocketSignalingConnector(), registry),
    signalingAllowedOrigins: new Set([origin]),
  });
  await app.ready();

  const created = await sessions.create({ tenantId: "alpha", subject: "alice" });
  const exchanged = sessions.exchangeSignalingTicket(created.signalingTicket);
  const client = await app.injectWS("/orchestrator/v1/signaling", { headers: { origin } });
  context.after(async () => {
    client.terminate();
    for (const socket of app.websocketServer.clients) socket.terminate();
    await app.close();
  });

  const ready = nextMessage(client);
  client.send(JSON.stringify({ type: "authenticate", token: exchanged.signalingToken }));
  assert.deepEqual(JSON.parse((await ready).text), { type: "ready", sessionId: created.session.id });
  assert.equal(await upstream.authentication, internalSecret);
  assert.equal(registry.count(created.session.id), 1);

  const echoed = nextMessage(client);
  client.send(JSON.stringify({ type: "offer", sdp: "fixture" }));
  assert.deepEqual(JSON.parse((await echoed).text), { type: "offer", sdp: "fixture" });

  const closed = nextClose(client);
  await sessions.burn({ tenantId: "alpha", subject: "alice" }, created.session.id);
  assert.equal((await closed).code, 1008);
  assert.equal(registry.count(created.session.id), 0);
  assert.equal(runtime.destroyed, true);
});

test("signaling relay preserves an upstream frame sent during authenticated handoff", async (context) => {
  const welcome = { type: "welcome", peerId: "producer-fixture" };
  const upstream = await startUpstream(context, { eagerFrames: [welcome] });
  const runtime = new FixedRuntime(upstream.endpoint);
  const sessions = new SessionService(runtime);
  const app = buildApp({
    authenticator: new DevelopmentAuthenticator("test"),
    sessions,
    signaling: new SignalingGateway(
      sessions,
      new WebSocketSignalingConnector(),
      new SignalingConnectionRegistry(),
    ),
    signalingAllowedOrigins: new Set([origin]),
  });
  await app.ready();
  const created = await sessions.create({ tenantId: "alpha", subject: "alice" });
  const exchanged = sessions.exchangeSignalingTicket(created.signalingTicket);
  const client = await app.injectWS("/orchestrator/v1/signaling", { headers: { origin } });
  context.after(async () => {
    client.terminate();
    for (const socket of app.websocketServer.clients) socket.terminate();
    await app.close();
  });

  const messages = nextMessages(client, 2);
  client.send(JSON.stringify({ type: "authenticate", token: exchanged.signalingToken }));
  assert.deepEqual((await messages).map(({ text }) => JSON.parse(text)), [
    { type: "ready", sessionId: created.session.id },
    welcome,
  ]);
});

test("signaling upgrade rejects an origin outside the exact allowlist", async (context) => {
  const runtime = new FixedRuntime("ws://127.0.0.1:1/internal/v1/signaling");
  const sessions = new SessionService(runtime);
  const app = buildApp({
    authenticator: new DevelopmentAuthenticator("test"),
    sessions,
    signaling: new SignalingGateway(
      sessions,
      new WebSocketSignalingConnector(),
      new SignalingConnectionRegistry(),
    ),
    signalingAllowedOrigins: new Set([origin]),
  });
  context.after(() => app.close());
  await app.ready();

  await assert.rejects(
    app.injectWS("/orchestrator/v1/signaling", { headers: { origin: "https://evil.example" } }),
    /Unexpected server response: 403/,
  );
});

test("signaling connection closes when the client does not authenticate before the deadline", async (context) => {
  const runtime = new FixedRuntime("ws://127.0.0.1:1/internal/v1/signaling");
  const sessions = new SessionService(runtime);
  const app = buildApp({
    authenticator: new DevelopmentAuthenticator("test"),
    sessions,
    signaling: new SignalingGateway(
      sessions,
      new WebSocketSignalingConnector(),
      new SignalingConnectionRegistry(),
      { authenticationTimeoutMs: 200 },
    ),
    signalingAllowedOrigins: new Set([origin]),
  });
  await app.ready();
  const client = await app.injectWS("/orchestrator/v1/signaling", { headers: { origin } });
  context.after(async () => {
    client.terminate();
    for (const socket of app.websocketServer.clients) socket.terminate();
    await app.close();
  });

  assert.equal((await nextClose(client)).code, 1008);
});

test("signaling relay rejects a frame that would exceed its backpressure budget", async (context) => {
  const upstream = await startUpstream(context);
  const runtime = new FixedRuntime(upstream.endpoint);
  const sessions = new SessionService(runtime);
  const app = buildApp({
    authenticator: new DevelopmentAuthenticator("test"),
    sessions,
    signaling: new SignalingGateway(
      sessions,
      new WebSocketSignalingConnector(),
      new SignalingConnectionRegistry(),
      { maximumBufferedBytes: 96 },
    ),
    signalingAllowedOrigins: new Set([origin]),
  });
  await app.ready();
  const created = await sessions.create({ tenantId: "alpha", subject: "alice" });
  const exchanged = sessions.exchangeSignalingTicket(created.signalingTicket);
  const client = await app.injectWS("/orchestrator/v1/signaling", { headers: { origin } });
  context.after(async () => {
    client.terminate();
    for (const socket of app.websocketServer.clients) socket.terminate();
    await app.close();
  });

  const ready = nextMessage(client);
  client.send(JSON.stringify({ type: "authenticate", token: exchanged.signalingToken }));
  assert.equal(JSON.parse((await ready).text).type, "ready");

  const closed = nextClose(client);
  client.send(Buffer.alloc(97), { binary: true });
  assert.equal((await closed).code, 1013);
});

interface UpstreamFixture {
  readonly endpoint: string;
  readonly authentication: Promise<string>;
}

async function startUpstream(
  context: { after: (hook: () => void | Promise<void>) => void },
  options: { readonly eagerFrames?: readonly unknown[] } = {},
): Promise<UpstreamFixture> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, maxPayload: 64 * 1024 });
  context.after(() => new Promise<void>((resolve) => {
    for (const client of server.clients) client.terminate();
    server.close(() => resolve());
  }));
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("upstream fixture did not bind TCP");

  let resolveAuthentication: (secret: string) => void = () => {};
  const authentication = new Promise<string>((resolve) => {
    resolveAuthentication = resolve;
  });
  server.on("connection", (socket, request) => {
    assert.equal(request.url, "/internal/v1/signaling");
    let authenticated = false;
    socket.on("message", (data, isBinary) => {
      if (!authenticated) {
        assert.equal(isBinary, false);
        const frame = JSON.parse(rawDataToBuffer(data).toString("utf8")) as { type: string; secret: string };
        assert.deepEqual(Object.keys(frame).sort(), ["secret", "type"]);
        assert.equal(frame.type, "authenticate");
        authenticated = true;
        resolveAuthentication(frame.secret);
        socket.send(JSON.stringify({ type: "authenticated" }));
        for (const eagerFrame of options.eagerFrames ?? []) socket.send(JSON.stringify(eagerFrame));
        return;
      }
      socket.send(data, { binary: isBinary, compress: false });
    });
  });
  return {
    endpoint: `ws://127.0.0.1:${address.port}/internal/v1/signaling`,
    authentication,
  };
}

class FixedRuntime implements RuntimeAdapter {
  public destroyed = false;

  public constructor(private readonly signalingEndpoint: string) {}

  public async create(request: CreateRuntimeRequest): Promise<RuntimeResource> {
    return {
      containerId: `container-${request.sessionId}`,
      containerName: `fireball-${request.sessionId}`,
      networkNamespace: `fireball-net-${request.sessionId}`,
      storageNamespace: `tmpfs-${request.sessionId}`,
      signalingEndpoint: this.signalingEndpoint,
      signalingSecret: internalSecret,
    };
  }

  public async destroy(_resource: RuntimeResource): Promise<void> {
    this.destroyed = true;
  }

  public async reconcile(): Promise<ReconciliationResult> {
    return { containersRemoved: 0, networksRemoved: 0 };
  }
}

function nextMessage(socket: WebSocket): Promise<{ text: string; isBinary: boolean }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for WebSocket message")), 2_000);
    socket.once("message", (data, isBinary) => {
      clearTimeout(timer);
      resolve({ text: rawDataToBuffer(data).toString("utf8"), isBinary });
    });
  });
}

function nextMessages(socket: WebSocket, count: number): Promise<Array<{ text: string; isBinary: boolean }>> {
  return new Promise((resolve, reject) => {
    const messages: Array<{ text: string; isBinary: boolean }> = [];
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error("timed out waiting for WebSocket messages"));
    }, 2_000);
    const onMessage = (data: RawData, isBinary: boolean): void => {
      messages.push({ text: rawDataToBuffer(data).toString("utf8"), isBinary });
      if (messages.length !== count) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(messages);
    };
    socket.on("message", onMessage);
  });
}

function nextClose(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for WebSocket close")), 2_000);
    socket.once("close", (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString("utf8") });
    });
  });
}

function rawDataToBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(data);
}
