# Fireball WPE session image

## Status

The `0.1.0-dev.1` session image is an E1 engineering candidate. Its source contract, bootstrap boundary, Docker lifecycle, and two-architecture build/start/smoke gate are implemented and tested. It is not a release until end-to-end media/control tests, tenant isolation, and promotion all pass against the same immutable digest.

Workflow run `32442811942` at commit `2cc0ad6` reproduced the previous **NO-GO** under Docker's built-in seccomp profile: the amd64 image and plugins passed, AppArmor was applied without a denial, then bubblewrap failed its first nested namespace creation. Run `32444451863` at commit `bb40440` proved the checksum-locked policy allowed that namespace setup, but Linux then rejected a fresh procfs below Docker's locked `/proc` paths. Run `32445430523` at commit `a8152cb` proved the tenant-PID/read-only-proc wrapper passed compilation, metadata, namespace creation, and the proc boundary; the next fail-closed boundary was bubblewrap's exact second-level `unshare(CLONE_NEWUSER)` for `/dev/pts`.

Workflow run [`32448127234`](https://github.com/LamPPKK/fireball-docker/actions/runs/32448127234) at commit `6daa3aecde3362fcebfe49da1e5a0e8185fe1b81` is the first **PASS** for the two-architecture build/start/smoke gate. Native Ubuntu 24.04 runners built and loaded the same source revision for `linux/amd64` and `linux/arm64`; both jobs passed plugin and runtime metadata inspection, AppArmor loading, unsafe TURN-secret rejection, Docker health, bootstrap authentication, single-controller enforcement, reconnect, and cleanup. The jobs completed in 55 seconds and 10 minutes 1 second respectively. This result does not yet promote an OCI digest or satisfy real media, TURN, or two-tenant isolation evidence.

## Provenance

- Base: Debian Trixie slim OCI index pinned by digest in `session/image-manifest.json`.
- WPE: `gstreamer1.0-wpe` and `libwpewebkit-2.0-1` from Trixie repositories at image-build time; exact installed versions are written to `/usr/share/fireball-session/component-versions.txt`.
- rswebrtc: upstream `gst-plugins-rs` tag `gstreamer-1.26.2`, pinned to commit `0826007d970a473475b6bf993229ebcde173fdba` and built with `cargo cinstall --locked`.
- Runtime proxy: Node.js from Trixie plus `ws@8.21.3`, locked with an npm integrity hash.
- Container seccomp: Moby's deny-by-default profile at the exact commit and checksum in `deploy/seccomp/fireball-session.provenance.json`, restricted to amd64/arm64 and extended only for the reviewed WPE bubblewrap setup calls.

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

The supervisor removes the bootstrap secret and ICE file path from the GStreamer child environment. The rswebrtc embedded web server and public STUN default are disabled. Port `8443` is loopback-only inside the container; Docker publishes only port `8444`, and only on host `127.0.0.1` with a random port.

An operator may configure TURN through the [deployment adapter](deployment-adapters.md). The Docker API mounts the host file read-only at `/run/fireball-secrets/ice-servers.json`; no TURN URL is placed in the image or container environment. Before starting GStreamer, the non-root supervisor checks the file size, owner, group, mode, schema, URL form, unique-server bound, and ICE policy. GStreamer receives the validated `stun-server`, `turn-servers`, and `ice-transport-policy` properties. Real TURN allocation and media/control relay remain promotion evidence, not an inferred pass from configuration tests.

## Storage and process policy

- UID/GID `10001` runs the supervisor, WPE WebKit children, and GStreamer pipeline.
- The root filesystem is read-only and all capabilities are dropped with `no-new-privileges`.
- Ubuntu 24.04 hosts load the named `fireball-session` AppArmor profile, whose sole purpose is to permit the unprivileged user namespace required by WebKit's bubblewrap child-process sandbox.
- Every production session also receives `deploy/seccomp/fireball-session.json`. It preserves Moby's `SCMP_ACT_ERRNO` default, permits only three exact `clone()` namespace flag sets, the exact `unshare(CLONE_NEWUSER)` needed for bubblewrap's second-level `/dev/pts` setup, and `mount`, `pivot_root`, and `umount2` for its mount phase. It does not allow `clone3`, `setns`, any other `unshare` flag set, add capabilities, or disable seccomp. WebKit installs its own inner filter after setup and blocks namespace/mount operations in the web process.
- Docker's default masked/read-only system paths and private per-tenant PID namespace remain intact. A compiled fail-closed wrapper accepts only WebKit's sealed `--args` launch form, verifies its seccomp/UTS/PID/proc invariants, removes the incompatible second PID namespace, and replaces the fresh procfs request with a read-only bind of the container's already masked `/proc`. It rejects external PID namespaces, nested argument files, capability overrides, or any missing/duplicate invariant. WebKit still creates its inner user, mount, UTS, optional network/IPC namespaces and installs its renderer seccomp filter.
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

The `session-image` GitHub workflow builds and loads each architecture independently under Buildx on GitHub's native Ubuntu 24.04 x86_64 and arm64 runners, then checks `wpesrc`, `webrtcsink`, `openh264enc`, the non-root user, supervisor syntax, and embedded component versions. It rejects an ICE fixture with unsafe permissions, then starts the image with a valid read-only TURN fixture plus the production read-only/capability/tmpfs restrictions. The smoke waits for Docker health, proving the pinned GStreamer build parses the TURN properties, verifies loopback-only signaling, rejects a bad bootstrap secret and a second controller, and proves the controller lease can reconnect before removing the container. It does not prove a real TURN allocation because the fixture deliberately uses the reserved `.invalid` domain.

Install the reviewed host policy without changing its bytes:

```sh
sudo install -d -o root -g root -m 0755 /etc/fireball
sudo install -o root -g root -m 0444 \
  deploy/seccomp/fireball-session.json \
  /etc/fireball/fireball-session-seccomp.json
```

Set `FIREBALL_SESSION_SECCOMP_PROFILE=/etc/fireball/fireball-session-seccomp.json`. The orchestrator opens it without following a final symlink, checks regular-file type, size, ownership, mode, read-time metadata stability, and the exact reviewed SHA-256 before sending compact JSON to Docker Engine. Any mismatch aborts production startup.

Promotion additionally requires:

1. Build `linux/amd64` and `linux/arm64` once and capture their manifest digest, SBOM, and provenance.
2. Run the exact digest on a real Docker Engine and complete WPE load, H.264/Opus offer/answer, input, reconnect, crash, and burn tests.
3. Run two tenants concurrently and prove cookie, storage, process, network namespace, bootstrap secret, and signaling ticket isolation.
4. Test read-only rootfs, tmpfs ownership, memory/PID/CPU quotas, unhealthy startup rollback, daemon restart reconciliation, and no reusable residue after burn.
5. Promote the already-tested digest. Do not rebuild after QA.

The public orchestrator should remain on host loopback behind the rendered Nginx TLS/WebSocket adapter. The adapter source is checked in normal CI, but release evidence must also include `nginx -t` and an external WebSocket handshake against the deployed version.
