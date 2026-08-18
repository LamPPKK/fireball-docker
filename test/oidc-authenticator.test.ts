import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
} from "jose";

import { OidcAuthenticator } from "../src/auth/oidc-authenticator.js";
import { OrchestratorError } from "../src/domain/errors.js";

const issuer = "https://issuer.example/";
const audience = "fireball-docker";

test("OIDC authenticator verifies signature, issuer, audience and tenant claim", async () => {
  const fixture = await createSigner();
  const authenticator = new OidcAuthenticator(
    { issuer, audience, jwksUrl: "https://issuer.example/jwks.json" },
    fixture.keyResolver,
  );
  const token = await fixture.sign({ tenant_id: "alpha" }, audience);

  const context = await authenticator.authenticate({ authorization: `Bearer ${token}` });

  assert.deepEqual(context, { tenantId: "alpha", subject: "alice@example.com" });
});

test("OIDC authenticator rejects a token issued for another audience", async () => {
  const fixture = await createSigner();
  const authenticator = new OidcAuthenticator(
    { issuer, audience, jwksUrl: "https://issuer.example/jwks.json" },
    fixture.keyResolver,
  );
  const token = await fixture.sign({ tenant_id: "alpha" }, "another-service");

  await assert.rejects(
    authenticator.authenticate({ authorization: `Bearer ${token}` }),
    (error: unknown) => error instanceof OrchestratorError && error.code === "AUTH_INVALID",
  );
});

test("OIDC authenticator fails closed for missing or unsafe tenant identity", async () => {
  const fixture = await createSigner();
  const authenticator = new OidcAuthenticator(
    { issuer, audience, jwksUrl: "https://issuer.example/jwks.json" },
    fixture.keyResolver,
  );
  const token = await fixture.sign({ tenant_id: "../../host" }, audience);

  await assert.rejects(
    authenticator.authenticate({ authorization: `Bearer ${token}` }),
    (error: unknown) => error instanceof OrchestratorError && error.code === "AUTH_INVALID",
  );
  await assert.rejects(
    authenticator.authenticate({}),
    (error: unknown) => error instanceof OrchestratorError && error.code === "AUTH_REQUIRED",
  );
});

test("OIDC authenticator refuses symmetric or unapproved JWT algorithms", () => {
  assert.throws(
    () => new OidcAuthenticator({
      issuer,
      audience,
      jwksUrl: "https://issuer.example/jwks.json",
      algorithms: ["HS256"],
    }),
    /algorithms/,
  );
});

async function createSigner() {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const publicJWK = {
    ...await exportJWK(publicKey),
    alg: "RS256",
    kid: "test-key",
    use: "sig",
  };
  const keyResolver = createLocalJWKSet({ keys: [publicJWK] });
  return {
    keyResolver,
    async sign(claims: Record<string, unknown>, tokenAudience: string): Promise<string> {
      return await new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .setIssuer(issuer)
        .setAudience(tokenAudience)
        .setSubject("alice@example.com")
        .setIssuedAt()
        .setExpirationTime("2m")
        .sign(privateKey);
    },
  };
}
