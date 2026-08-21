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

  const client = new WebSocket(`ws://127.0.0.1:${proxy.port}/internal/v1/signaling`, {
    perMessageDeflate: false,
  });
  await opened(client);
  client.send(JSON.stringify({ type: "authenticate", secret }));
  assert.deepEqual(JSON.parse(await nextMessage(client)), { type: "authenticated" });

  const competingClient = new WebSocket(`ws://127.0.0.1:${proxy.port}/internal/v1/signaling`, {
    perMessageDeflate: false,
  });
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

  const client = new WebSocket(`ws://127.0.0.1:${proxy.port}/internal/v1/signaling`);
  await opened(client);
  client.send(JSON.stringify({ type: "authenticate", secret: "B".repeat(43) }));
  assert.equal((await nextClose(client)).code, 1008);
  assert.equal(upstreamConnections, 0);
});

test("internal tab control requires bearer auth and exposes the bounded tab lifecycle", async (context) => {
  const calls = [];
  const firstTabId = "11111111-1111-4111-8111-111111111111";
  const secondTabId = "22222222-2222-4222-8222-222222222222";
  const state = [{
    id: firstTabId,
    url: "fireball://home",
    createdAt: "2026-08-21T00:00:00.000Z",
    active: true,
  }];
  const tabs = {
    list: () => state.map((tab) => ({ ...tab })),
    create: async (url) => {
      calls.push(["create", url]);
      state[0].active = false;
      const tab = {
        id: secondTabId,
        url: url ?? "fireball://home",
        createdAt: "2026-08-21T00:00:01.000Z",
        active: true,
      };
      state.push(tab);
      return { ...tab };
    },
    activate: async (id) => {
      calls.push(["activate", id]);
      for (const tab of state) tab.active = tab.id === id;
      return { ...state.find((tab) => tab.id === id) };
    },
    navigate: async (id, url) => {
      calls.push(["navigate", id, url]);
      const tab = state.find((candidate) => candidate.id === id);
      tab.url = url;
      return { ...tab };
    },
    remove: async (id) => {
      calls.push(["remove", id]);
      state.splice(state.findIndex((tab) => tab.id === id), 1);
    },
  };
  const proxy = await createSignalingProxy({
    secret,
    tabs,
    host: "127.0.0.1",
    port: 0,
    upstreamUrl: "ws://127.0.0.1:1",
  });
  context.after(() => proxy.close());
  const endpoint = `http://127.0.0.1:${proxy.port}/internal/v1/tabs`;

  const unauthorized = await fetch(endpoint);
  assert.equal(unauthorized.status, 401);
  assert.equal((await unauthorized.json()).error.code, "INTERNAL_AUTH_REQUIRED");

  const list = await internalRequest(endpoint, secret);
  assert.equal(list.status, 200);
  assert.deepEqual((await list.json()).tabs, state);

  const create = await internalRequest(endpoint, secret, {
    method: "POST",
    body: JSON.stringify({ url: "https://example.com/" }),
  });
  assert.equal(create.status, 201);
  assert.equal((await create.json()).tab.id, secondTabId);

  const activate = await internalRequest(`${endpoint}/${firstTabId}/active`, secret, { method: "PUT" });
  assert.equal(activate.status, 200);
  assert.equal((await activate.json()).tab.active, true);

  const navigate = await internalRequest(`${endpoint}/${firstTabId}/navigation`, secret, {
    method: "PUT",
    body: JSON.stringify({ url: "https://example.org/path" }),
  });
  assert.equal(navigate.status, 200);
  assert.equal((await navigate.json()).tab.url, "https://example.org/path");

  const remove = await internalRequest(`${endpoint}/${secondTabId}`, secret, { method: "DELETE" });
  assert.equal(remove.status, 204);
  assert.deepEqual(calls, [
    ["create", "https://example.com/"],
    ["activate", firstTabId],
    ["navigate", firstTabId, "https://example.org/path"],
    ["remove", secondTabId],
  ]);
});

test("internal tab control rejects query strings, extra fields, and bodies on bodyless routes", async (context) => {
  const tabs = {
    list: () => [],
    create: async () => assert.fail("invalid create request reached tab controller"),
    activate: async () => assert.fail("invalid activate request reached tab controller"),
    navigate: async () => assert.fail("invalid navigation request reached tab controller"),
    remove: async () => assert.fail("invalid delete request reached tab controller"),
  };
  const proxy = await createSignalingProxy({
    secret,
    tabs,
    host: "127.0.0.1",
    port: 0,
    upstreamUrl: "ws://127.0.0.1:1",
  });
  context.after(() => proxy.close());
  const endpoint = `http://127.0.0.1:${proxy.port}/internal/v1/tabs`;

  const query = await internalRequest(`${endpoint}?debug=1`, secret);
  assert.equal(query.status, 400);
  const extra = await internalRequest(endpoint, secret, {
    method: "POST",
    body: JSON.stringify({ url: "https://example.com/", tenantId: "alpha" }),
  });
  assert.equal(extra.status, 400);
  const body = await internalRequest(
    `${endpoint}/11111111-1111-4111-8111-111111111111/active`,
    secret,
    {
    method: "PUT",
    body: "{}",
    },
  );
  assert.equal(body.status, 400);
});

function internalRequest(url, token, options = {}) {
  return fetch(url, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
  });
}

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
