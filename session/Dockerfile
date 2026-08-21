# syntax=docker/dockerfile:1.18

ARG DEBIAN_IMAGE=docker.io/library/debian:trixie-slim@sha256:3a39a0592364683e6bab97937b72cad5a8fa6dcbbee90edb3bb48c7f8e94f258

FROM ${DEBIAN_IMAGE} AS rswebrtc-builder
ARG GST_PLUGINS_RS_REV=0826007d970a473475b6bf993229ebcde173fdba
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      cargo \
      cargo-c \
      git \
      libgstreamer-plugins-bad1.0-dev \
      libgstreamer-plugins-base1.0-dev \
      libgstreamer1.0-dev \
      libssl-dev \
      pkg-config \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src/gst-plugins-rs
RUN git init \
    && git remote add origin https://gitlab.freedesktop.org/gstreamer/gst-plugins-rs.git \
    && git fetch --depth 1 origin "${GST_PLUGINS_RS_REV}" \
    && git checkout --detach FETCH_HEAD \
    && test "$(git rev-parse HEAD)" = "${GST_PLUGINS_RS_REV}"
RUN cargo cinstall \
      --locked \
      --release \
      --package gst-plugin-webrtc \
      --no-default-features \
      --features web_server \
      --prefix=/opt/fireball \
      --libdir=lib

FROM ${DEBIAN_IMAGE} AS node-dependencies
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates nodejs npm \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /work
COPY session/package.json session/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM ${DEBIAN_IMAGE} AS bwrap-wrapper-builder
RUN apt-get update \
    && apt-get install -y --no-install-recommends gcc libc6-dev \
    && rm -rf /var/lib/apt/lists/*
COPY session/fireball-bwrap-wrapper.c /src/fireball-bwrap-wrapper.c
RUN cc -std=c11 -O2 -Wall -Wextra -Werror \
      /src/fireball-bwrap-wrapper.c \
      -o /fireball-bwrap

FROM ${DEBIAN_IMAGE}
ARG GST_PLUGINS_RS_REV=0826007d970a473475b6bf993229ebcde173fdba
ARG FIREBALL_SESSION_VERSION=0.1.0-dev.1
LABEL org.opencontainers.image.title="Fireball WPE session" \
      org.opencontainers.image.description="One-tenant WPE WebKit and GStreamer WebRTC session runtime" \
      org.opencontainers.image.source="https://github.com/LamPPKK/fireball-docker" \
      org.opencontainers.image.version="${FIREBALL_SESSION_VERSION}" \
      dev.fireball.gst-plugins-rs.revision="${GST_PLUGINS_RS_REV}"

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      fonts-dejavu-core \
      gstreamer1.0-gl \
      gstreamer1.0-plugins-bad \
      gstreamer1.0-plugins-base \
      gstreamer1.0-plugins-good \
      gstreamer1.0-tools \
      gstreamer1.0-wpe \
      libegl1 \
      libgl1-mesa-dri \
      libgles2 \
      libopenh264-8 \
      libwpewebkit-2.0-1 \
      nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 fireball-session \
    && useradd --system --uid 10001 --gid 10001 --home-dir /run/fireball-session/home fireball-session \
    && install -d -o 10001 -g 10001 -m 0755 /run/fireball-session /usr/lib/fireball/gstreamer-1.0 /usr/share/fireball-session /opt/fireball-session/node_modules \
    && install -d -o root -g 10001 -m 0750 /run/fireball-secrets \
    && test -x /usr/bin/bwrap \
    && mv /usr/bin/bwrap /usr/lib/fireball/bwrap.real

COPY --from=rswebrtc-builder /opt/fireball/lib/gstreamer-1.0/libgstrswebrtc.so /usr/lib/fireball/gstreamer-1.0/libgstrswebrtc.so
COPY --from=rswebrtc-builder /src/gst-plugins-rs/net/webrtc/LICENSE-MPL-2.0 /usr/share/fireball-session/LICENSE-rswebrtc-MPL-2.0
COPY --from=node-dependencies /work/node_modules /opt/fireball-session/node_modules
COPY --from=bwrap-wrapper-builder --chmod=0755 /fireball-bwrap /usr/bin/bwrap
COPY --chown=10001:10001 session/supervisor.mjs session/healthcheck.mjs /opt/fireball-session/
COPY --chown=10001:10001 session/home.html /usr/share/fireball-session/home.html

ENV HOME=/run/fireball-session/home \
    XDG_RUNTIME_DIR=/run/fireball-session/runtime \
    XDG_CACHE_HOME=/run/fireball-session/cache \
    XDG_CONFIG_HOME=/run/fireball-session/config \
    XDG_DATA_HOME=/run/fireball-session/data \
    GST_PLUGIN_PATH_1_0=/usr/lib/fireball/gstreamer-1.0 \
    GST_REGISTRY=/run/fireball-session/gstreamer-registry.bin \
    GST_REGISTRY_UPDATE=no \
    WPE_BACKEND=fdo \
    FIREBALL_STREAM_PROFILE=720p15

RUN GST_PLUGIN_PATH_1_0=/usr/lib/fireball/gstreamer-1.0 gst-inspect-1.0 wpesrc >/dev/null \
    && GST_PLUGIN_PATH_1_0=/usr/lib/fireball/gstreamer-1.0 gst-inspect-1.0 webrtcsink >/dev/null \
    && GST_PLUGIN_PATH_1_0=/usr/lib/fireball/gstreamer-1.0 gst-inspect-1.0 openh264enc >/dev/null \
    && ldconfig -p | grep -F 'libGLESv2.so.2' >/dev/null \
    && { \
      dpkg-query -W -f='${Package}=${Version}\n' gstreamer1.0-wpe libwpewebkit-2.0-1 gstreamer1.0-tools libegl1 libgles2 nodejs; \
      printf 'gst-plugins-rs=%s\n' "${GST_PLUGINS_RS_REV}"; \
    } > /usr/share/fireball-session/component-versions.txt

USER 10001:10001
EXPOSE 8444
HEALTHCHECK --interval=5s --timeout=2s --start-period=30s --retries=6 \
  CMD ["/usr/bin/node", "/opt/fireball-session/healthcheck.mjs"]
ENTRYPOINT ["/usr/bin/node", "/opt/fireball-session/supervisor.mjs"]
