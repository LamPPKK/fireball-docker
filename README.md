# fireball-docker

Fireball's multi-tenant remote-browser orchestrator. The repository has completed the one-session-per-tenant E1 candidate gate: production OIDC authentication, authenticated WebSocket signaling, WPE/GStreamer media and control, transactional Docker Engine lifecycle, fail-closed restart reconciliation, exact-digest multi-architecture promotion, and a real Nginx TLS/WebSocket deployment check. Multi-tab support inside a tenant container is the next E1 slice.

## Implemented boundary

- Node.js 24 LTS, strict TypeScript and Fastify 5.
- Tenant identity comes only from a verified authentication context; request bodies cannot choose a tenant.
- Production JWT verification requires an exact issuer, audience, JWKS URL, asymmetric algorithm allowlist, expiry, subject, and a validated tenant claim.
- Development bearer authentication remains loopback-only and cannot start in production.
- One container, Docker network, tmpfs namespace, quota, and credential set per browser session.
- Pairing tickets and signaling tokens use 256-bit CSPRNG values, are stored only as SHA-256 hashes, expire quickly, and can be used once.
- Public session responses exclude tenant identity, container details, internal signaling endpoints, and bootstrap secrets.
- The signaling gateway requires an exact allowed `Origin`, consumes the one-use token in the first frame, limits payloads and buffered bytes, and authenticates the separate runtime hop with a per-session bootstrap secret.
- The session-image candidate uses one WPE source, explicit H.264/Opus branches, GStreamer navigation over the control DataChannel, no public STUN default, and a separate one-controller bootstrap proxy. Each tenant keeps Docker's private PID namespace; a fail-closed bubblewrap argument wrapper reuses that boundary while retaining WebKit's mount/user/network/IPC/UTS and seccomp sandbox layers. Debian and `gst-plugins-rs` provenance are immutable inputs.
- Optional TURN traversal is supplied through a read-only, root-owned host secret file; credentials are neither copied into the session image nor exposed in Docker environment variables. The default remains no public STUN and no TURN.
- The checked Nginx adapter terminates TLS, forwards the exact signaling WebSocket upgrade to an orchestrator bound on loopback, and applies request/body/connection limits without storing TLS or OIDC credentials in either image.
- Burn revokes all outstanding credentials and active or pending signaling relays before runtime cleanup. Cleanup failure remains observable as a `failed` session and can be retried.
- Container creation is transactional: a failed start or failed Docker health check removes both the partially-created container and its network. A session is not returned to the API while its WPE/signaling runtime is still starting.
- A synchronous reservation closes concurrent-create quota races. Per-tenant and host-wide session, memory, CPU-share, and PID limits include starts that are still pending.
- Before listening, the orchestrator removes orphan containers and networks carrying both its managed label and exact instance label. A cleanup error aborts startup instead of accepting traffic with unknown residual state.
- Session containers explicitly use Docker's `no` restart policy. If the GStreamer/WPE pipeline exits unexpectedly, the internal and public signaling paths close; the failed container remains stopped until the authenticated owner burns the session, after which a fresh session receives a new identity and credential set.
- The Docker adapter uses only a Unix socket, a request timeout, read-only rootfs, dropped capabilities, `no-new-privileges`, a reviewed deny-by-default seccomp policy, PID/CPU/memory limits, and a private session tmpfs. Its random signaling port must remain bound to host loopback.

Container isolation is defense-in-depth, not a guarantee against every container escape or browser zero-day.

## API slice

| Method | Route | Authentication | Purpose |
| --- | --- | --- | --- |
| `GET` | `/healthz` | none | Process health only. |
| `POST` | `/orchestrator/v1/sessions` | Bearer JWT or development token | Create one tenant-bound session and pairing ticket. |
| `GET` | `/orchestrator/v1/sessions/:id` | Bearer JWT or development token | Read a session owned by the authenticated tenant. |
| `POST` | `/orchestrator/v1/sessions/:id/signaling/tickets` | Bearer JWT or development token | Rotate pending signaling credentials and issue a reconnect ticket. |
| `DELETE` | `/orchestrator/v1/sessions/:id` | Bearer JWT or development token | Revoke credentials and burn the tenant session. |
| `POST` | `/orchestrator/v1/signaling/tickets/exchange` | One-time pairing ticket in JSON body | Exchange for a 30-second, one-use signaling token. |
| `GET` (WebSocket) | `/orchestrator/v1/signaling` | Exact allowed `Origin`, then one-use token | Relay signaling frames to the session runtime. |

Tickets and tokens are never accepted in query strings. A reconnect ticket can only be issued by the authenticated tenant owner; issuing one invalidates every older unexchanged ticket and unused signaling token for that session. After the WebSocket upgrade, the first text frame must be `{"type":"authenticate","token":"<token>"}`. The gateway replies with `{"type":"ready","sessionId":"<uuid>"}` only after the runtime has accepted its distinct bootstrap secret. Additional client frames sent before `ready` close the relay. Inside the container, the orchestrator's bootstrap frame is consumed at port `8444`; it is never forwarded to rswebrtc on loopback port `8443`.

## Session image candidate

[`session/Dockerfile`](session/Dockerfile) builds for `linux/amd64` and `linux/arm64` from a Debian Trixie multi-platform digest. It compiles only the `gst-plugin-webrtc` package from the exact GStreamer `1.26.2` source revision, with Cargo's lockfile enforced. The runtime is non-root UID/GID `10001`, uses a read-only root filesystem plus `/run/fireball-session` tmpfs, and records installed component versions inside the artifact.

This is an engineering candidate, not a promoted release. The normal CI validates source, contracts, authentication behavior, deployment-adapter configuration, and image provenance. [`session-image` run 32459386522](https://github.com/LamPPKK/fireball-docker/actions/runs/32459386522) passed the complete source-revision gate on native `linux/amd64` and `linux/arm64` runners at commit `38918f8fd792bb9c410f4d7ae75b1ff1845535ae`. Both jobs built and inspected the image, passed the real two-tenant infrastructure gate, proved cookie/localStorage/service-worker separation and burn cleanup in real WPE, and completed two authenticated Direct connections plus two relay-only connections through an ephemeral coturn service. Every browser connection required H.264 video, Opus audio, decoded frames, and a control DataChannel response; the TURN gate additionally required the selected local and remote ICE candidates to both be `relay`. Reconnect used newly issued one-use credentials; burn then closed signaling, revoked a remaining ticket, and left no managed container or network. The gate proves source-revision isolation, media/control, and TURN behavior, but it is not a bitrate/latency/thermal benchmark and does not promote an exact OCI digest.

The manual `session-candidate` workflow implements the immutable promotion lane without rebuilding after QA. Each native runner pushes one commit-scoped platform image, resolves its registry manifest digest, pulls and tests that exact digest through every current image/isolation/browser-state/restart-crash/Nginx-TLS/Direct/TURN gate, emits an SPDX SBOM, and attaches platform provenance plus SBOM attestations. Only after both jobs pass does the merge job create `ghcr.io/lamppkk/fireball-session:candidate-<commit>` from those two digests, validate the raw two-platform OCI index, emit strict candidate evidence, attach index provenance and evidence attestations, and sign the index digest with GitHub OIDC/Cosign. All third-party actions are pinned by commit. [`session-candidate` run 32464998826](https://github.com/LamPPKK/fireball-docker/actions/runs/32464998826) passed this lane at commit `1fd15b3343cd5505ce2b92da99e2f0fb467ebfc1`; the resulting index is `ghcr.io/lamppkk/fireball-session@sha256:70b3836ac5d5802224859b7e8b618bc5c8ab1718f6a9c483511829bcf6d7c364`. The tag is a discovery aid; deployment must use this recorded digest identity. See [the session-image architecture and promotion gates](docs/session-image.md).

## Production configuration

```sh
NODE_ENV=production
FIREBALL_HOST=127.0.0.1
FIREBALL_PORT=8787
FIREBALL_OIDC_ISSUER=https://identity.example.com/
FIREBALL_OIDC_AUDIENCE=fireball-docker
FIREBALL_OIDC_JWKS_URL=https://identity.example.com/.well-known/jwks.json
FIREBALL_OIDC_TENANT_CLAIM=tenant_id
FIREBALL_INSTANCE_ID=primary
FIREBALL_PUBLIC_ORIGINS=https://browser.example.com
FIREBALL_MAX_SESSIONS_PER_TENANT=1
FIREBALL_MAX_SESSIONS=8
FIREBALL_MAX_MEMORY_MIB=4096
FIREBALL_MAX_CPU_SHARES=4096
FIREBALL_MAX_PIDS=1024
FIREBALL_SESSION_HEALTH_ATTEMPTS=60
FIREBALL_SESSION_HEALTH_INTERVAL_MS=1000
FIREBALL_DOCKER_REQUEST_TIMEOUT_MS=30000
FIREBALL_SESSION_APPARMOR_PROFILE=fireball-session
FIREBALL_SESSION_SECCOMP_PROFILE=/etc/fireball/fireball-session-seccomp.json
FIREBALL_ICE_SERVERS_FILE=/etc/fireball/ice-servers.json
DOCKER_SOCKET=/var/run/docker.sock
DOCKER_API_VERSION=1.47
FIREBALL_SESSION_IMAGE=ghcr.io/lamppkk/fireball-session@sha256:<promoted-64-hex-digest>
```

`FIREBALL_INSTANCE_ID` is required in production and scopes restart cleanup. Two simultaneously running orchestrators must never share it because either process may reap resources owned by that instance during startup. `FIREBALL_PUBLIC_ORIGINS` accepts one to eight comma-separated exact HTTPS origins. `FIREBALL_DOCKER_REQUEST_TIMEOUT_MS` bounds each Docker Engine call and defaults to 30 seconds; session health has its own attempt/interval budget. `FIREBALL_SESSION_IMAGE` is also required in production and must end in an immutable `sha256` digest; a mutable tag is rejected before startup. Production also requires the exact reviewed [`deploy/seccomp/fireball-session.json`](deploy/seccomp/fireball-session.json), installed as a root-owned file that is not group/world writable and selected through `FIREBALL_SESSION_SECCOMP_PROFILE`. Its Moby source commit, source checksum, generated checksum, architectures, and narrow namespace-policy delta are locked in [`fireball-session.provenance.json`](deploy/seccomp/fireball-session.provenance.json). On Ubuntu 24.04 hosts, also load [`deploy/apparmor/fireball-session`](deploy/apparmor/fireball-session) and set `FIREBALL_SESSION_APPARMOR_PROFILE=fireball-session`; omit only that AppArmor setting on hosts without AppArmor. The image retains Docker's default `/proc` masks and private per-tenant PID namespace; its sealed-argument wrapper removes only WebKit's incompatible nested PID namespace and binds the already masked procfs read-only. Do not disable the WebKit sandbox, use `seccomp=unconfined`, add `CAP_SYS_ADMIN`, remove Docker system-path masks, or run a privileged container. The current signaling slice requires the orchestrator process to share the Docker host network namespace so it can reach a random port bound strictly to `127.0.0.1`; a container-to-container private-network adapter remains future work. OIDC issuer matching is exact. The default JWT allowlist is `RS256`, `PS256`, and `ES256`; symmetric JWT algorithms are rejected. The optional `FIREBALL_ICE_SERVERS_FILE` must be an absolute Docker-host path and is mounted read-only into new session containers. See the checked [session-image runbook](docs/session-image.md) and [TURN/Nginx deployment adapter runbook](docs/deployment-adapters.md) before enabling it or exposing the API.

Access to the Docker Engine socket is effectively host-control authority. Run the orchestrator on a dedicated host, restrict socket access to its service identity, and never expose the socket through the public API container network. When the image runs as its non-root `fireball` user, the deployment must grant only that process the host Docker socket group ID.

## Verify

```sh
npm ci
npm ci --prefix session --ignore-scripts
npm run check
docker build -f deploy/Dockerfile -t fireball/orchestrator:dev .
```

The test suite covers cross-tenant denial, public session redaction, pairing/signaling replay and expiry, exact-origin WebSocket upgrades, dual-hop authentication, frame relay, burn-time socket revocation, session bootstrap isolation, one-controller enforcement, failed cleanup state, real asymmetric JWT signing/verification, Docker isolation options, real WPE cookie/localStorage/service-worker and burn/recreate separation, loopback-only signaling publication, read-only TURN secret mounts, strict ICE configuration, injection-safe Nginx rendering, startup health gating, idempotent cleanup, create rollback, restart reconciliation ownership, pipeline-crash containment, aggregate cleanup failure, and concurrent quota reservations.

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

## Next E1 slice

- Add real create/list/activate/delete tab operations inside one tenant container without weakening the one-container-per-tenant boundary.
- Surface a stopped or crashed runtime as an explicit session failure instead of reporting the last in-memory `active` snapshot until Burn.
- Keep production certificate issuance, public DNS, firewall policy, and operator-host soak testing as deployment gates; CI validates the checked Nginx path with an explicitly trusted short-lived test certificate, not a public CA.

The versioned XanhTab API snapshot remains frozen. Regenerate it only after an explicitly promoted upstream artifact.
