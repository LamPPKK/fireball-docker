# syntax=docker/dockerfile:1.18

ARG BASE_IMAGE
FROM ${BASE_IMAGE}
COPY --chown=10001:10001 scripts/fixtures/browser-state-server.mjs /opt/fireball-state-gate/server.mjs
ENV FIREBALL_START_URL=http://127.0.0.1:18080/
ENTRYPOINT ["/usr/bin/node", "/opt/fireball-state-gate/server.mjs"]
