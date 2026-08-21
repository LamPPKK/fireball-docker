# TURN and reverse-proxy deployment adapters

These adapters keep deployment credentials outside both Fireball OCI images. They do not make the current session-image candidate a release: the source-revision media/control, relay-only TURN, and two-tenant gates pass, but they must be repeated against the exact candidate digest, which also still needs browser-state isolation evidence before promotion.

## TURN secret file

The orchestrator can bind-mount one operator-managed ICE configuration into each new session container. The image contains only an empty `/run/fireball-secrets` mount point. The host path is not copied into an image, and TURN URLs are not placed in Docker environment variables.

Start from [`deploy/turn/ice-servers.json.example`](../deploy/turn/ice-servers.json.example) and validate against [`deploy/turn/ice-servers.schema.json`](../deploy/turn/ice-servers.schema.json). Host, port, scheme, username, and password are separate fields; the supervisor percent-encodes credentials when it creates the GStreamer URI. `turns` is preferred when the TURN service supports TLS.

Install the populated file on the Docker host with the exact ownership and mode required by the non-root session runtime:

```sh
sudo install -d -o root -g root -m 0750 /etc/fireball
sudo install -o root -g 10001 -m 0440 ./ice-servers.json /etc/fireball/ice-servers.json
```

Set only its host path on the orchestrator:

```sh
FIREBALL_ICE_SERVERS_FILE=/etc/fireball/ice-servers.json
```

At container startup the supervisor opens the mounted file without following a final symlink, requires a regular file no larger than 16 KiB, checks `root:10001` and mode `0440`, rejects unknown JSON fields, and accepts one to four explicit `turn://` or `turns://` URLs. The default remains `stun-server=` with no TURN server and ICE policy `all`. When a file is configured, `ice_transport_policy` can be `all` or relay-only `relay`.

Use short-lived TURN REST credentials where the TURN deployment supports them. The coturn shared secret belongs only on the credential issuer; put the derived, time-limited username/password in this file, never the coturn shared secret itself. Existing containers keep the credential material mounted when they started, so rotate through a new file before creating new sessions and burn sessions before their credential expiry. GStreamer's command-line property contains the derived TURN URI, so a host administrator or Docker-socket principal can inspect it and is already inside the documented host-control trust boundary. Do not enable verbose `GST_DEBUG` in production; collect diagnostic logs only on an opted-in test session with short-lived credentials.

## Nginx TLS/WebSocket proxy

The orchestrator should listen on host loopback while Nginx owns the public TLS socket. Render the checked template:

```sh
candidate="$(mktemp "${TMPDIR:-/tmp}/fireball-nginx.XXXXXX")"
trap 'rm -f "$candidate"' EXIT

FIREBALL_PUBLIC_HOST=browser.example.com \
FIREBALL_TLS_CERTIFICATE=/etc/letsencrypt/live/browser.example.com/fullchain.pem \
FIREBALL_TLS_CERTIFICATE_KEY=/etc/letsencrypt/live/browser.example.com/privkey.pem \
FIREBALL_UPSTREAM_PORT=8787 \
node scripts/render-nginx-config.mjs > "$candidate"

sudo node scripts/install-nginx-config.mjs "$candidate"
```

The renderer accepts a lowercase DNS hostname, absolute certificate paths, and a numeric upstream port only. The generated config:

- terminates TLS 1.2/1.3 and adds HSTS;
- proxies only to `127.0.0.1`;
- forwards the WebSocket `Upgrade`, `Connection`, and `Origin` headers on the exact signaling route;
- disables WebSocket buffering and applies bounded timeouts;
- limits request size, request rate, and concurrent WebSockets per source address;
- contains certificate file references but no certificate, private key, OIDC token, or TURN credential.

The installer acquires a target-specific lock, stages the candidate beside the target, saves the previous regular file, atomically replaces the target, runs `nginx -t`, reloads Nginx, and verifies the service is active. A validation, reload, or health failure restores and reloads the previous configuration; an incomplete rollback keeps the recovery directory and reports its exact path. The template is an Nginx `http`-context include. On the usual Debian/Ubuntu package layout, `/etc/nginx/conf.d/*.conf` is included from that context. Configure the orchestrator consistently:

```sh
FIREBALL_HOST=127.0.0.1
FIREBALL_PORT=8787
FIREBALL_PUBLIC_ORIGINS=https://browser.example.com
```

If another trusted load balancer sits in front of Nginx, define trusted proxy addresses explicitly before changing source-IP handling. Do not trust arbitrary incoming `X-Forwarded-For` values.
