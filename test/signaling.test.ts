import assert from "node:assert/strict";
import { test } from "node:test";

import { DevelopmentAuthenticator } from "../src/auth/authenticator.js";
import { buildApp } from "../src/app.js";
import { OrchestratorError } from "../src/domain/errors.js";
import { SessionService } from "../src/domain/session-service.js";
import type { RuntimeResource } from "../src/domain/types.js";
import { InMemoryRuntime } from "../src/runtime/in-memory-runtime.js";

test("pairing ticket exchanges once for a one-use signaling token", async (context) => {
  const runtime = new InMemoryRuntime();
  const sessions = new SessionService(runtime);
  const app = buildApp({ authenticator: new DevelopmentAuthenticator("test"), sessions });
  context.after(() => app.close());
  const created = await sessions.create({ tenantId: "alpha", subject: "alice" });

  const exchange = await app.inject({
    method: "POST",
    url: "/orchestrator/v1/signaling/tickets/exchange",
    payload: { ticket: created.signalingTicket },
  });
  assert.equal(exchange.statusCode, 200, exchange.body);
  const result = exchange.json();
  assert.equal(result.tokenExpiresInSeconds, 30);
  assert.match(result.signalingToken, /^[A-Za-z0-9_-]{43}$/);

  const replay = await app.inject({
    method: "POST",
    url: "/orchestrator/v1/signaling/tickets/exchange",
    payload: { ticket: created.signalingTicket },
  });
  assert.equal(replay.statusCode, 401);
  assert.equal(replay.json().error.code, "SIGNALING_CREDENTIAL_INVALID");

  const authorization = sessions.authorizeSignalingToken(result.signalingToken);
  const resource = [...runtime.resources.values()][0];
  assert.ok(resource);
  assert.equal(authorization.sessionId, created.session.id);
  assert.equal(authorization.tenantId, "alpha");
  assert.equal(authorization.runtime.containerId, resource.containerId);
  assert.throws(
    () => sessions.authorizeSignalingToken(result.signalingToken),
    isInvalidSignalingCredential,
  );
});

test("ticket expiry and burn revoke every signaling credential", async () => {
  let now = 1_000;
  const sessions = new SessionService(new InMemoryRuntime(), {
    pairingTicketTTLSeconds: 2,
    signalingTokenTTLSeconds: 2,
    now: () => now,
  });
  const expired = await sessions.create({ tenantId: "alpha", subject: "alice" });
  now += 2_001;
  assert.throws(() => sessions.exchangeSignalingTicket(expired.signalingTicket), isInvalidSignalingCredential);

  const active = await sessions.create({ tenantId: "beta", subject: "bob" });
  const exchanged = sessions.exchangeSignalingTicket(active.signalingTicket);
  await sessions.burn({ tenantId: "beta", subject: "bob" }, active.session.id);
  assert.throws(() => sessions.authorizeSignalingToken(exchanged.signalingToken), isInvalidSignalingCredential);
});

test("failed burn remains observable while credentials stay revoked", async () => {
  const runtime = new FailingDestroyRuntime();
  const sessions = new SessionService(runtime);
  const context = { tenantId: "alpha", subject: "alice" };
  const created = await sessions.create(context);
  const exchanged = sessions.exchangeSignalingTicket(created.signalingTicket);

  await assert.rejects(
    sessions.burn(context, created.session.id),
    (error: unknown) => error instanceof OrchestratorError && error.code === "RUNTIME_FAILURE",
  );
  assert.equal(sessions.get(context, created.session.id).phase, "failed");
  assert.equal(sessions.get(context, created.session.id).failure, "runtime cleanup failed");
  assert.throws(() => sessions.authorizeSignalingToken(exchanged.signalingToken), isInvalidSignalingCredential);
});

function isInvalidSignalingCredential(error: unknown): boolean {
  return error instanceof OrchestratorError && error.code === "SIGNALING_CREDENTIAL_INVALID";
}

class FailingDestroyRuntime extends InMemoryRuntime {
  public override async destroy(_resource: RuntimeResource): Promise<void> {
    throw new Error("simulated cleanup failure");
  }
}
