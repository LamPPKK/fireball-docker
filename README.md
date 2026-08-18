# fireball-docker

Fireball's multi-tenant remote-browser orchestrator. The repository is now at the first E1 security slice: production OIDC authentication, one-session-per-tenant isolation, short-lived signaling credentials, and transactional Docker Engine lifecycle management.

## Implemented boundary

- Node.js 24 LTS, strict TypeScript and Fastify 5.
- Tenant identity comes only from a verified authentication context; request bodies cannot choose a tenant.
- Production JWT verification requires an exact issuer, audience, JWKS URL, asymmetric algorithm allowlist, expiry, subject, and a validated tenant claim.
- Development bearer authentication remains loopback-only and cannot start in production.
- One container, Docker network, tmpfs namespace, quota, and credential set per browser session.
- Pairing tickets and signaling tokens use 256-bit CSPRNG values, are stored only as SHA-256 hashes, expire quickly, and can be used once.
- Burn revokes all outstanding credentials before runtime cleanup. Cleanup failure remains observable as a `failed` session and can be retried.
- Container creation is transactional: a failed start removes both the partially-created container and its network.
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
DOCKER_SOCKET=/var/run/docker.sock
DOCKER_API_VERSION=1.47
FIREBALL_SESSION_IMAGE=fireball/session-wpe:0.1.0-dev.1
```

OIDC issuer matching is exact. The default JWT allowlist is `RS256`, `PS256`, and `ES256`; symmetric JWT algorithms are rejected. Reverse proxy TLS and rate limiting remain deployment requirements.

## Verify

```sh
npm ci
npm run check
docker build -f deploy/Dockerfile -t fireball/orchestrator:dev .
```

The test suite covers cross-tenant denial, pairing/signaling replay and expiry, burn revocation, failed cleanup state, real asymmetric JWT signing/verification, Docker isolation options, idempotent cleanup, and create rollback.

## E1 work still open

- Build and pin the WPE WebKit + GStreamer H.264 session image for `linux/amd64` and `linux/arm64`.
- Add the authenticated WebSocket signaling relay and TURN/reverse-proxy deployment adapters.
- Reconcile managed containers after orchestrator restart and enforce host-wide quota accounting.
- Run the isolation gate against a real Docker Engine and prove two tenants cannot observe cookie, storage, process, network namespace, or signaling state.
- Open multi-tab APIs only after that isolation gate passes.

The versioned XanhTab API snapshot remains frozen. Regenerate it only after an explicitly promoted upstream artifact.
