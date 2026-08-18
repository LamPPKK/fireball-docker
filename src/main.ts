import { DevelopmentAuthenticator } from "./auth/authenticator.js";
import { OidcAuthenticator } from "./auth/oidc-authenticator.js";
import type { Authenticator } from "./auth/authenticator.js";
import { buildApp } from "./app.js";
import { SessionService } from "./domain/session-service.js";
import { DockerEngineRuntime } from "./runtime/docker-engine-runtime.js";

const environment = process.env.NODE_ENV ?? "development";
const host = process.env.FIREBALL_HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.FIREBALL_PORT ?? "8787", 10);

if (environment === "development" && !isLoopback(host)) {
  throw new Error("development authenticator may only bind to loopback");
}
if (environment !== "development" && environment !== "production") {
  throw new Error("NODE_ENV must be development or production");
}

const runtime = new DockerEngineRuntime({
  socketPath: process.env.DOCKER_SOCKET ?? "/var/run/docker.sock",
  apiVersion: process.env.DOCKER_API_VERSION ?? "1.47",
  image: process.env.FIREBALL_SESSION_IMAGE ?? "fireball/session-wpe:0.1.0-dev.1",
});
const app = buildApp({
  authenticator: createAuthenticator(environment),
  sessions: new SessionService(runtime),
  logger: true,
});

await app.listen({ host, port });

function createAuthenticator(nodeEnvironment: string): Authenticator {
  if (nodeEnvironment === "development") return new DevelopmentAuthenticator(nodeEnvironment);
  return new OidcAuthenticator({
    issuer: requiredEnvironment("FIREBALL_OIDC_ISSUER"),
    audience: requiredEnvironment("FIREBALL_OIDC_AUDIENCE"),
    jwksUrl: requiredEnvironment("FIREBALL_OIDC_JWKS_URL"),
    tenantClaim: process.env.FIREBALL_OIDC_TENANT_CLAIM ?? "tenant_id",
  });
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required in production`);
  return value;
}

function isLoopback(value: string): boolean {
  return value === "127.0.0.1" || value === "::1" || value === "localhost";
}
