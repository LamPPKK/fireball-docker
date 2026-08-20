import assert from "node:assert/strict";
import { test } from "node:test";

import WebSocket, { WebSocketServer } from "ws";

import { createSignalingProxy } from "../supervisor.mjs";

const secret = "A".repeat(43);

test("proxy authenticates one controller, hides the bootstrap frame, and relays data", async (context) => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0, perMessageDeflate: false });
  await listening(upstream);
  const upstreamAddress = upstream.address();
  assert.equal(typeof upstreamAddress, "object");
  assert.ok(upstreamAddress);
  const upstreamFrames = [];
  upstream.on("connection", (socket) => {
    socket.on("message", (data, isBinary) => {
      upstreamFrames.push(Buffer.from(data).toString("utf8"));
      socket.send(data, { binary: isBinary, compress: false });
    });
  });

  const proxy = await createSignalingProxy({
    secret,
    host: "127.0.0.1",
    port: 0,
    upstreamUrl: `ws://127.0.0.1:${upstreamAddress.port}`,
  });
  context.after(async () => {
    await proxy.close();
    for (const socket of upstream.clients) socket.terminate();
    await closeServer(upstream);
  });

  const client = new WebSocket(`ws://127.0.0.1:${proxy.port}`, { perMessageDeflate: false });
  await opened(client);
  client.send(JSON.stringify({ type: "authenticate", secret }));
  assert.deepEqual(JSON.parse(await nextMessage(client)), { type: "authenticated" });

  const competingClient = new WebSocket(`ws://127.0.0.1:${proxy.port}`, { perMessageDeflate: false });
  await opened(competingClient);
  assert.equal((await nextClose(competingClient)).code, 1008);

  const offer = JSON.stringify({ type: "offer", sdp: "fixture" });
  client.send(offer);
  assert.equal(await nextMessage(client), offer);
  assert.deepEqual(upstreamFrames, [offer]);
  client.terminate();
});

test("proxy rejects malformed bootstrap authentication before opening upstream", async (context) => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await listening(upstream);
  const upstreamAddress = upstream.address();
  assert.equal(typeof upstreamAddress, "object");
  assert.ok(upstreamAddress);
  let upstreamConnections = 0;
  upstream.on("connection", () => { upstreamConnections += 1; });

  const proxy = await createSignalingProxy({
    secret,
    host: "127.0.0.1",
    port: 0,
    upstreamUrl: `ws://127.0.0.1:${upstreamAddress.port}`,
  });
  context.after(async () => {
    await proxy.close();
    for (const socket of upstream.clients) socket.terminate();
    await closeServer(upstream);
  });

  const client = new WebSocket(`ws://127.0.0.1:${proxy.port}`);
  await opened(client);
  client.send(JSON.stringify({ type: "authenticate", secret: "B".repeat(43) }));
  assert.equal((await nextClose(client)).code, 1008);
  assert.equal(upstreamConnections, 0);
});

function listening(server) {
  return new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
}

function opened(socket) {
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

function nextMessage(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for WebSocket message")), 2_000);
    socket.once("message", (data) => {
      clearTimeout(timer);
      resolve(Buffer.from(data).toString("utf8"));
    });
  });
}

function nextClose(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for WebSocket close")), 2_000);
    socket.once("close", (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString("utf8") });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}
