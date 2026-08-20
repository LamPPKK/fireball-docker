import assert from "node:assert/strict";
import { test } from "node:test";

import { DevelopmentAuthenticator } from "../src/auth/authenticator.js";
import { buildApp } from "../src/app.js";
import { SessionService } from "../src/domain/session-service.js";
import { InMemoryRuntime } from "../src/runtime/in-memory-runtime.js";

test("two tenants receive isolated runtime, storage, network and tickets", async (context) => {
  const runtime = new InMemoryRuntime();
  const app = buildApp({
    authenticator: new DevelopmentAuthenticator("test"),
    sessions: new SessionService(runtime),
  });
  context.after(() => app.close());

  const alpha = await create(app, "alpha", "alice");
  const beta = await create(app, "beta", "bob");
  const alphaRuntime = [...runtime.resources.values()].find(
    (resource) => resource.containerName === `fireball-${alpha.session.id}`,
  );
  const betaRuntime = [...runtime.resources.values()].find(
    (resource) => resource.containerName === `fireball-${beta.session.id}`,
  );
  assert.ok(alphaRuntime);
  assert.ok(betaRuntime);

  assert.notEqual(alpha.session.id, beta.session.id);
  assert.equal("runtime" in alpha.session, false);
  assert.notEqual(alphaRuntime.containerId, betaRuntime.containerId);
  assert.notEqual(alphaRuntime.networkNamespace, betaRuntime.networkNamespace);
  assert.notEqual(alphaRuntime.storageNamespace, betaRuntime.storageNamespace);
  assert.notEqual(alphaRuntime.signalingSecret, betaRuntime.signalingSecret);
  assert.notEqual(alpha.signalingTicket, beta.signalingTicket);
  assert.equal(runtime.resources.size, 2);
});

test("tenant identity comes from verified context and blocks cross-tenant access", async (context) => {
  const runtime = new InMemoryRuntime();
  const app = buildApp({
    authenticator: new DevelopmentAuthenticator("test"),
    sessions: new SessionService(runtime),
  });
  context.after(() => app.close());
  const alpha = await create(app, "alpha", "alice");

  const read = await app.inject({
    method: "GET",
    url: `/orchestrator/v1/sessions/${alpha.session.id}`,
    headers: authorization("beta", "bob"),
  });
  assert.equal(read.statusCode, 404);
  assert.equal(read.json().error.code, "SESSION_NOT_FOUND");

  const burn = await app.inject({
    method: "DELETE",
    url: `/orchestrator/v1/sessions/${alpha.session.id}`,
    headers: authorization("beta", "bob"),
  });
  assert.equal(burn.statusCode, 404);

  const reconnect = await app.inject({
    method: "POST",
    url: `/orchestrator/v1/sessions/${alpha.session.id}/signaling/tickets`,
    headers: authorization("beta", "bob"),
  });
  assert.equal(reconnect.statusCode, 404);
  assert.equal(reconnect.json().error.code, "SESSION_NOT_FOUND");
  assert.equal(runtime.resources.size, 1);
});

test("burn removes tenant runtime and reusable signaling secret", async (context) => {
  const runtime = new InMemoryRuntime();
  const app = buildApp({
    authenticator: new DevelopmentAuthenticator("test"),
    sessions: new SessionService(runtime),
  });
  context.after(() => app.close());
  const alpha = await create(app, "alpha", "alice");

  const response = await app.inject({
    method: "DELETE",
    url: `/orchestrator/v1/sessions/${alpha.session.id}`,
    headers: authorization("alpha", "alice"),
  });
  assert.equal(response.statusCode, 204);
  assert.equal(runtime.resources.size, 0);

  const read = await app.inject({
    method: "GET",
    url: `/orchestrator/v1/sessions/${alpha.session.id}`,
    headers: authorization("alpha", "alice"),
  });
  assert.equal(read.statusCode, 404);
});

async function create(app: ReturnType<typeof buildApp>, tenant: string, subject: string) {
  const response = await app.inject({
    method: "POST",
    url: "/orchestrator/v1/sessions",
    headers: authorization(tenant, subject),
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json();
}

function authorization(tenant: string, subject: string): { authorization: string } {
  return { authorization: `Bearer dev:${tenant}:${subject}` };
}
