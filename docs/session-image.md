# Fireball WPE session image

## Status

The `0.1.0-dev.1` session image is an E1 engineering candidate. Its source contract, bootstrap boundary, and Docker lifecycle are implemented and tested. It is not a release until both architecture builds, end-to-end media/control tests, and the tenant-isolation gate pass against the same immutable digest.

## Provenance

- Base: Debian Trixie slim OCI index pinned by digest in `session/image-manifest.json`.
- WPE: `gstreamer1.0-wpe` and `libwpewebkit-2.0-1` from Trixie repositories at image-build time; exact installed versions are written to `/usr/share/fireball-session/component-versions.txt`.
- rswebrtc: upstream `gst-plugins-rs` tag `gstreamer-1.26.2`, pinned to commit `0826007d970a473475b6bf993229ebcde173fdba` and built with `cargo cinstall --locked`.
- Runtime proxy: Node.js from Trixie plus `ws@8.21.3`, locked with an npm integrity hash.

The development build still resolves Debian security packages during the build. Release promotion must record the resulting OCI digest and attached SBOM/provenance; a production orchestrator rejects mutable image references.

## Runtime boundary

```text
public controller
  -> orchestrator /orchestrator/v1/signaling
  -> loopback-published random host port
  -> container :8444 bootstrap proxy
  -> 127.0.0.1:8443 rswebrtc signaller
  -> one wpesrc + H.264 video + Opus audio
```

The public one-use signaling token is consumed by the orchestrator and never reaches the container. The container receives a different 256-bit bootstrap secret through its environment. Port `8444` accepts exactly one text authentication frame, compares the secret in constant time, reserves one controller lease, and only then opens the rswebrtc hop. It enforces a 64 KiB frame limit, a 1 MiB backpressure ceiling, a five-second authentication deadline, and no per-message compression.

The supervisor removes the bootstrap secret from the GStreamer child environment. The rswebrtc embedded web server and public STUN default are disabled. Port `8443` is loopback-only inside the container; Docker publishes only port `8444`, and only on host `127.0.0.1` with a random port.

## Storage and process policy

- UID/GID `10001` runs the supervisor, WPE WebKit children, and GStreamer pipeline.
- The root filesystem is read-only and all capabilities are dropped with `no-new-privileges`.
- Ubuntu 24.04 hosts load the named `fireball-session` AppArmor profile, whose sole purpose is to permit the unprivileged user namespace required by WebKit's bubblewrap child-process sandbox. The image does not disable that sandbox or request an unconfined seccomp profile.
- Cookie, cache, configuration, GStreamer registry, and runtime state are rooted below `/run/fireball-session`.
- The portable Docker profile negotiates WPE's system-memory BGRA output before color conversion, avoiding a mandatory EGL/GPU dependency. Hardware/zero-copy profiles remain benchmark-gated deployment variants.
- Docker mounts that path as a `256 MiB` tmpfs owned by UID/GID `10001`, with `noexec`, `nosuid`, and `nodev`.
- Burn closes active/pending relays before force-removing the container and its private network.

Container isolation is defense-in-depth. It does not prove immunity to browser zero-days or container escapes.

## Stream profiles

| Profile | Video | Target bitrate | Role |
| --- | --- | ---: | --- |
| `1080p30` | H.264 constrained baseline | 6 Mbps | Preferred after host benchmark |
| `720p15` | H.264 constrained baseline | 3 Mbps | Default candidate |
| `480p10` | H.264 constrained baseline | 1.2 Mbps | Emergency fallback only |

All profiles use 64 kbps Opus audio and enable rswebrtc's navigation DataChannel. OpenH264 is the portable baseline encoder; VA-API or another hardware path may replace it only behind a measured, platform-specific profile.

## Verification and promotion

Run source gates locally:

```sh
npm ci
npm ci --prefix session --ignore-scripts
npm run check
```

The `session-image` GitHub workflow builds and loads each architecture independently under Buildx/QEMU, then checks `wpesrc`, `webrtcsink`, `openh264enc`, the non-root user, supervisor syntax, and embedded component versions. It also starts the image with the production read-only/capability/tmpfs restrictions, waits for Docker health, verifies loopback-only signaling, rejects a bad bootstrap secret and a second controller, and proves the controller lease can reconnect before removing the container.

Promotion additionally requires:

1. Build `linux/amd64` and `linux/arm64` once and capture their manifest digest, SBOM, and provenance.
2. Run the exact digest on a real Docker Engine and complete WPE load, H.264/Opus offer/answer, input, reconnect, crash, and burn tests.
3. Run two tenants concurrently and prove cookie, storage, process, network namespace, bootstrap secret, and signaling ticket isolation.
4. Test read-only rootfs, tmpfs ownership, memory/PID/CPU quotas, unhealthy startup rollback, daemon restart reconciliation, and no reusable residue after burn.
5. Promote the already-tested digest. Do not rebuild after QA.
