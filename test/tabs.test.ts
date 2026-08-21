import assert from "node:assert/strict";
import { test } from "node:test";

import { DevelopmentAuthenticator } from "../src/auth/authenticator.js";
import { buildApp } from "../src/app.js";
import { SessionService } from "../src/domain/session-service.js";
import type { TabView } from "../src/domain/types.js";
import { InMemoryRuntime } from "../src/runtime/in-memory-runtime.js";

test("tenant tab API creates, lists, activates, navigates, and deletes tabs inside one session", async (context) => {
  const runtime = new InMemoryRuntime();
  const app = buildApp({
    authenticator: new DevelopmentAuthenticator("test"),
    sessions: new SessionService(runtime),
  });
  context.after(() => app.close());
  const sessionId = await createSession(app, "alpha", "alice");

  const initial = await listTabs(app, sessionId, "alpha", "alice");
  assert.equal(initial.length, 1);
  const initialTab = initial[0];
  assert.ok(initialTab);
  assert.equal(initialTab.url, "fireball://home");
  assert.equal(initialTab.active, true);

  const create = await app.inject({
    method: "POST",
    url: `/orchestrator/v1/sessions/${sessionId}/tabs`,
    headers: authorization("alpha", "alice"),
    payload: { url: "https://example.com/path" },
  });
  assert.equal(create.statusCode, 201, create.body);
  const second = create.json().tab;
  assert.equal(second.url, "https://example.com/path");
  assert.equal(second.active, true);
  assert.equal(runtime.resources.size, 1, "tabs must not create another tenant container");

  const activate = await app.inject({
    method: "PUT",
    url: `/orchestrator/v1/sessions/${sessionId}/tabs/${initialTab.id}/active`,
    headers: authorization("alpha", "alice"),
  });
  assert.equal(activate.statusCode, 200, activate.body);
  assert.equal(activate.json().tab.active, true);

  const navigate = await app.inject({
    method: "PUT",
    url: `/orchestrator/v1/sessions/${sessionId}/tabs/${initialTab.id}/navigation`,
    headers: authorization("alpha", "alice"),
    payload: { url: "https://example.org/a?q=1" },
  });
  assert.equal(navigate.statusCode, 200, navigate.body);
  assert.equal(navigate.json().tab.url, "https://example.org/a?q=1");

  const remove = await app.inject({
    method: "DELETE",
    url: `/orchestrator/v1/sessions/${sessionId}/tabs/${initialTab.id}`,
    headers: authorization("alpha", "alice"),
  });
  assert.equal(remove.statusCode, 204, remove.body);
  const remaining = await listTabs(app, sessionId, "alpha", "alice");
  assert.deepEqual(remaining.map((tab) => ({ id: tab.id, active: tab.active })), [{ id: second.id, active: true }]);

  const last = await app.inject({
    method: "DELETE",
    url: `/orchestrator/v1/sessions/${sessionId}/tabs/${second.id}`,
    headers: authorization("alpha", "alice"),
  });
  assert.equal(last.statusCode, 409, last.body);
  assert.equal(last.json().error.code, "TAB_MINIMUM_REACHED");
});

test("tab API enforces tenant ownership, URL policy, and the four-tab runtime bound", async (context) => {
  const runtime = new InMemoryRuntime();
  const app = buildApp({
    authenticator: new DevelopmentAuthenticator("test"),
    sessions: new SessionService(runtime),
  });
  context.after(() => app.close());
  const sessionId = await createSession(app, "alpha", "alice");

  const crossTenant = await app.inject({
    method: "GET",
    url: `/orchestrator/v1/sessions/${sessionId}/tabs`,
    headers: authorization("beta", "bob"),
  });
  assert.equal(crossTenant.statusCode, 404);
  assert.equal(crossTenant.json().error.code, "SESSION_NOT_FOUND");

  for (const url of ["javascript:alert(1)", "file:///etc/passwd", "https://user:secret@example.com"]) {
    const invalid = await app.inject({
      method: "POST",
      url: `/orchestrator/v1/sessions/${sessionId}/tabs`,
      headers: authorization("alpha", "alice"),
      payload: { url },
    });
    assert.equal(invalid.statusCode, 400, invalid.body);
    assert.equal(invalid.json().error.code, "TAB_URL_INVALID");
  }

  for (let index = 0; index < 3; index += 1) {
    const response = await app.inject({
      method: "POST",
      url: `/orchestrator/v1/sessions/${sessionId}/tabs`,
      headers: authorization("alpha", "alice"),
      payload: {},
    });
    assert.equal(response.statusCode, 201, response.body);
  }
  const limited = await app.inject({
    method: "POST",
    url: `/orchestrator/v1/sessions/${sessionId}/tabs`,
    headers: authorization("alpha", "alice"),
    payload: {},
  });
  assert.equal(limited.statusCode, 409, limited.body);
  assert.equal(limited.json().error.code, "TAB_LIMIT_REACHED");
  assert.equal(runtime.resources.size, 1);
});

async function createSession(app: ReturnType<typeof buildApp>, tenant: string, subject: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/orchestrator/v1/sessions",
    headers: authorization(tenant, subject),
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json().session.id;
}

async function listTabs(
  app: ReturnType<typeof buildApp>,
  sessionId: string,
  tenant: string,
  subject: string,
): Promise<TabView[]> {
  const response = await app.inject({
    method: "GET",
    url: `/orchestrator/v1/sessions/${sessionId}/tabs`,
    headers: authorization(tenant, subject),
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json().tabs;
}

function authorization(tenant: string, subject: string): { authorization: string } {
  return { authorization: `Bearer dev:${tenant}:${subject}` };
}
