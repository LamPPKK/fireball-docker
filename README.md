# fireball-docker

Fireball's multi-tenant remote-browser orchestrator. The repository is now at the first E1 security slice: production OIDC authentication, one-session-per-tenant isolation, short-lived signaling credentials, transactional Docker Engine lifecycle management, and fail-closed restart reconciliation.

## Implemented boundary

- Node.js 24 LTS, strict TypeScript and Fastify 5.
- Tenant identity comes only from a verified authentication context; request bodies cannot choose a tenant.
- Production JWT verification requires an exact issuer, audience, JWKS URL, asymmetric algorithm allowlist, expiry, subject, and a validated tenant claim.
- Development bearer authentication remains loopback-only and cannot start in production.
- One container, Docker network, tmpfs namespace, quota, and credential set per browser session.
- Pairing tickets and signaling tokens use 256-bit CSPRNG values, are stored only as SHA-256 hashes, expire quickly, and can be used once.
- Burn revokes all outstanding credentials before runtime cleanup. Cleanup failure remains observable as a `failed` session and can be retried.
- Container creation is transactional: a failed start removes both the partially-created container and its network.
- A synchronous reservation closes concurrent-create quota races. Per-tenant and host-wide session, memory, CPU-share, and PID limits include starts that are still pending.
- Before listening, the orchestrator removes orphan containers and networks carrying both its managed label and exact instance label. A cleanup error aborts startup instead of accepting traffic with unknown residual state.
- The Docker adapter uses only a Unix socket, a request timeout, read-only rootfs, dropped capabilities, `no-new-privileges`, PID/CPU/memory limits, and a private session tmpfs.

Container isolation is defense-in-depth, not a guarantee against every container escape or browser zero-day.

## API slice

| Method | Route | Authentication | Purpose |
| --- | --- | --- | --- |
| `GET` | `/healthz` | none | Process health only. |
| `POST` | `/orchestrator/v1/sessions` | Bearer JWT or development token | Create one tenant-bound session and pairing ticket. |
| `GET` | `/orchestrator/v1/sessions/:id` | Bearer JWT or development token | Read a session owned by the authenticated tenant. |
| `DELETE` | `/orchestrator/v1/sessions/:id` | Bearer JWT or development token | Revoke credentials and burn the tenant session. |
| `POST` | `/orchestrator/v1/signaling/tickets/exchange` | One-time pairing ticket in JSON body | Exchange for a 30-second, one-use signaling token. |

Tickets are never accepted in query strings. The signaling gateway will consume the resulting token directly through `SessionService.authorizeSignalingToken`; the WebSocket relay itself is the next E1 slice.

## Production configuration

```sh
NODE_ENV=production
FIREBALL_HOST=0.0.0.0
FIREBALL_PORT=8787
FIREBALL_OIDC_ISSUER=https://identity.example.com/
FIREBALL_OIDC_AUDIENCE=fireball-docker
FIREBALL_OIDC_JWKS_URL=https://identity.example.com/.well-known/jwks.json
FIREBALL_OIDC_TENANT_CLAIM=tenant_id
FIREBALL_INSTANCE_ID=primary
FIREBALL_MAX_SESSIONS_PER_TENANT=1
FIREBALL_MAX_SESSIONS=8
FIREBALL_MAX_MEMORY_MIB=4096
FIREBALL_MAX_CPU_SHARES=4096
FIREBALL_MAX_PIDS=1024
DOCKER_SOCKET=/var/run/docker.sock
DOCKER_API_VERSION=1.47
FIREBALL_SESSION_IMAGE=fireball/session-wpe:0.1.0-dev.1
```

`FIREBALL_INSTANCE_ID` is required in production and scopes restart cleanup. Two simultaneously running orchestrators must never share it because either process may reap resources owned by that instance during startup. OIDC issuer matching is exact. The default JWT allowlist is `RS256`, `PS256`, and `ES256`; symmetric JWT algorithms are rejected. Reverse proxy TLS and rate limiting remain deployment requirements.

Access to the Docker Engine socket is effectively host-control authority. Run the orchestrator on a dedicated host, restrict socket access to its service identity, and never expose the socket through the public API container network. When the image runs as its non-root `fireball` user, the deployment must grant only that process the host Docker socket group ID.

## Verify

```sh
npm ci
npm run check
docker build -f deploy/Dockerfile -t fireball/orchestrator:dev .
```

The test suite covers cross-tenant denial, pairing/signaling replay and expiry, burn revocation, failed cleanup state, real asymmetric JWT signing/verification, Docker isolation options, idempotent cleanup, create rollback, restart reconciliation ownership, aggregate cleanup failure, and concurrent quota reservations.

### Docker Desktop on macOS

The orchestrator image is Linux-based even when it is built from macOS. On an
Intel Mac, the reproducible host build lane is:

```sh
docker build --platform linux/amd64 \
  -f deploy/Dockerfile \
  -t fireball/orchestrator:macos-smoke .
```

The normal container command uses `NODE_ENV=production` and therefore fails
closed until the required OIDC issuer, audience, and JWKS settings are present.
For an internal health smoke, override `NODE_ENV=development`, keep the daemon
on its container loopback address, and query `/healthz` from inside that
container. Development authentication is intentionally forbidden on a
non-loopback listener.

There is no user-facing Docker dashboard in this repository yet, so API output
or Docker Desktop screenshots are not presented as product UI.

## E1 work still open

- Build and pin the WPE WebKit + GStreamer H.264 session image for `linux/amd64` and `linux/arm64`.
- Add the authenticated WebSocket signaling relay and TURN/reverse-proxy deployment adapters.
- Run the isolation gate against a real Docker Engine and prove two tenants cannot observe cookie, storage, process, network namespace, or signaling state.
- Open multi-tab APIs only after that isolation gate passes.

The versioned XanhTab API snapshot remains frozen. Regenerate it only after an explicitly promoted upstream artifact.
