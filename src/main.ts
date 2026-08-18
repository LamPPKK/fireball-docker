import { DevelopmentAuthenticator } from "./auth/authenticator.js";
import { buildApp } from "./app.js";
import { SessionService } from "./domain/session-service.js";
import { DockerEngineRuntime } from "./runtime/docker-engine-runtime.js";

const environment = process.env.NODE_ENV ?? "development";
const host = process.env.FIREBALL_HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.FIREBALL_PORT ?? "8787", 10);

if (environment !== "development") {
  throw new Error("F0 ships only the loopback development authenticator; configure OIDC/JWT before production");
}
if (!isLoopback(host)) {
  throw new Error("development authenticator may only bind to loopback");
}

const runtime = new DockerEngineRuntime({
  socketPath: process.env.DOCKER_SOCKET ?? "/var/run/docker.sock",
  apiVersion: process.env.DOCKER_API_VERSION ?? "1.47",
  image: process.env.FIREBALL_SESSION_IMAGE ?? "fireball/session-wpe:0.1.0-dev.1",
});
const app = buildApp({
  authenticator: new DevelopmentAuthenticator(environment),
  sessions: new SessionService(runtime),
  logger: true,
});

await app.listen({ host, port });

function isLoopback(value: string): boolean {
  return value === "127.0.0.1" || value === "::1" || value === "localhost";
}
