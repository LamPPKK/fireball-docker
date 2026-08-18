# fireball-docker

Buildable F0 foundation for the Fireball multi-tenant remote-browser orchestrator.

## Current boundary

- Node.js 24 LTS, strict TypeScript and Fastify 5.
- Tenant identity is derived only from the authenticator.
- One isolated container, network namespace, tmpfs namespace and signaling ticket per session.
- Docker Engine is reached through its Unix socket; no Docker socket is exposed over TCP.
- The development bearer authenticator is loopback-only and deliberately refuses production mode.
- The first production session image remains WPE WebKit + GStreamer H.264; it is not part of F0.

Container isolation is defense-in-depth, not a guarantee against every container escape or browser zero-day.

## Verify

```sh
npm ci
npm run check
```

The isolation test creates two mock tenants and verifies distinct container, network, storage and signaling identities plus cross-tenant denial. Regenerate the versioned XanhTab API contract with `npm run contracts:generate` after promoting a XanhTab artifact.

Production OIDC/JWT, quota reconciliation, authenticated signaling and the WPE image belong to Gate E1. Multi-tab APIs remain closed until the tenant isolation gate passes.
