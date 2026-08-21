# Fireball WPE session image

## Status

The `0.1.0-dev.1` session image is an E1 engineering candidate. Its source contract, bootstrap boundary, Docker lifecycle, two-architecture build/start/smoke gate, real two-tenant infrastructure gate, browser-state isolation, source-revision H.264/Opus/control gate, and relay-only TURN gate are implemented and tested. The manual exact-digest candidate workflow is implemented but has not yet produced accepted release evidence. It is not a release until that workflow passes and the remaining deployment gates use the same immutable digest.

Workflow run `32442811942` at commit `2cc0ad6` reproduced the previous **NO-GO** under Docker's built-in seccomp profile: the amd64 image and plugins passed, AppArmor was applied without a denial, then bubblewrap failed its first nested namespace creation. Run `32444451863` at commit `bb40440` proved the checksum-locked policy allowed that namespace setup, but Linux then rejected a fresh procfs below Docker's locked `/proc` paths. Run `32445430523` at commit `a8152cb` proved the tenant-PID/read-only-proc wrapper passed compilation, metadata, namespace creation, and the proc boundary; the next fail-closed boundary was bubblewrap's exact second-level `unshare(CLONE_NEWUSER)` for `/dev/pts`.

Workflow run [`32448127234`](https://github.com/LamPPKK/fireball-docker/actions/runs/32448127234) at commit `6daa3aecde3362fcebfe49da1e5a0e8185fe1b81` is the first **PASS** for the two-architecture build/start/smoke gate. Native Ubuntu 24.04 runners built and loaded the same source revision for `linux/amd64` and `linux/arm64`; both jobs passed plugin and runtime metadata inspection, AppArmor loading, unsafe TURN-secret rejection, Docker health, bootstrap authentication, single-controller enforcement, reconnect, and cleanup. The jobs completed in 55 seconds and 10 minutes 1 second respectively. This result does not yet promote an OCI digest or satisfy real media, TURN, or two-tenant isolation evidence.

Workflow run [`32449711590`](https://github.com/LamPPKK/fireball-docker/actions/runs/32449711590) at commit `e713d2b5d72e559aea2251544f055374d4187c39` is the first **PASS** for the real Docker two-tenant infrastructure gate on both architectures. The native amd64 and arm64 jobs completed in 2 minutes 44 seconds and 2 minutes 45 seconds. Each job ran two WPE sessions concurrently through the actual orchestrator, denied cross-tenant read/ticket/burn operations, mapped two public tokens to their exact sessions, rejected each peer's internal bootstrap secret, and revoked outstanding tickets at burn. Docker inspection and in-container probes proved distinct container, PID, network, mount, and tmpfs boundaries; tenant process markers were not visible to the peer; each private bridge rejected direct access to the peer; read-only rootfs, dropped capabilities, AppArmor, seccomp, memory/CPU/PID quota, and cleanup assertions passed. This source-revision gate does not inspect WebKit cookie/local-storage/service-worker semantics, negotiate media through a real TURN service, or promote an immutable OCI digest.

Workflow run [`32454792346`](https://github.com/LamPPKK/fireball-docker/actions/runs/32454792346) at commit `2e3514b79b53e0b8a689b727ca54bbd490b0382d` is the first **PASS** for the complete rswebrtc browser media gate on both native architectures. The arm64 and amd64 jobs completed in 1 minute 58 seconds and 2 minutes 30 seconds. A headless Firefox receiver with the checksum-locked Mozilla OpenH264 test plugin connected through the public orchestrator rather than the internal port. On each architecture, two independent page loads exchanged fresh one-use credentials, accepted an offer containing H.264 and Opus, received the exact H.264/Opus tracks, observed inbound RTP packets and decoded video frames, opened the navigation DataChannel, and received a control response. Burn closed the authenticated relay, revoked an unexchanged ticket, and left no managed container or network. The gate is functional evidence, not a stream-quality, latency, CPU, memory, or thermal benchmark. It does not use a TURN server and does not promote an OCI digest.

Workflow run [`32458359428`](https://github.com/LamPPKK/fireball-docker/actions/runs/32458359428) at commit `dac00edaffca1a6f43065ca41f84507f2b5dd28f` is the first clean **PASS** for the real relay-only TURN gate on both native architectures. The arm64 and amd64 jobs completed in 3 minutes 4 seconds and 3 minutes 28 seconds. Each job started an ephemeral coturn service with short-lived credentials, rejected an unsafe secret-file mode, loaded the strict root-owned configuration inside the exact tenant container, and proved UDP reachability from that network namespace before opening the browser. Two independent Firefox connections then required the selected local and remote ICE candidates to both be `relay`, while still requiring H.264 and Opus, inbound RTP, decoded video frames, a navigation DataChannel acknowledgement, fresh reconnect credentials, burn-time revocation, and zero managed Docker residue. The same workflow also repeated the Direct media/control gate and two-tenant infrastructure gate. This remains source-revision evidence; it does not promote an immutable OCI digest or prove browser cookie/storage isolation.

Workflow run [`32459386522`](https://github.com/LamPPKK/fireball-docker/actions/runs/32459386522) at commit `38918f8fd792bb9c410f4d7ae75b1ff1845535ae` is the first **PASS** for the real WPE browser-state isolation gate on both native architectures. The arm64 and amd64 jobs completed in 2 minutes 58 seconds and 3 minutes 6 seconds, including every earlier infrastructure, Direct-media, and TURN gate. Two simultaneous WPE sessions loaded the same loopback origin, started empty, then stored independent random markers in cookies, localStorage, and active service-worker registrations. Each tenant retained only its own marker while the peer remained empty; after both sessions were burned, a newly created session for the original tenant again had no cookie, localStorage value, or service-worker registration. The CI-only `browser-state-gate` stage inherits the exact runtime stage and adds only the loopback fixture/entrypoint; it is excluded from the final `release` stage. This is source-revision engine evidence and must still be repeated against the exact candidate digest without rebuilding the promoted artifact.

## Provenance

- Base: Debian Trixie slim OCI index pinned by digest in `session/image-manifest.json`.
- WPE: `gstreamer1.0-wpe`, `libwpewebkit-2.0-1`, `libegl1`, and `libgles2` from Trixie repositories at image-build time; exact installed versions are written to `/usr/share/fireball-session/component-versions.txt`, and the build verifies that `libGLESv2.so.2` is loadable.
- rswebrtc: upstream `gst-plugins-rs` tag `gstreamer-1.26.2`, pinned to commit `0826007d970a473475b6bf993229ebcde173fdba` and built with `cargo cinstall --locked`.
- Browser media gate: Firefox receives H.264 through Cisco OpenH264 `2.6.0` artifacts selected by Mozilla's pinned Firefox manifest. `config/firefox-openh264-v1.json` locks each architecture's URL, size, and SHA-512; the installer rejects redirects, unexpected archive entries, unsafe file types, size drift, and checksum drift. This codec is CI receiver tooling and is not copied into the Fireball session image.
- Runtime proxy: Node.js from Trixie plus `ws@8.21.3`, locked with an npm integrity hash.
- Container seccomp: Moby's deny-by-default profile at the exact commit and checksum in `deploy/seccomp/fireball-session.provenance.json`, restricted to amd64/arm64 and extended only for the reviewed WPE bubblewrap setup calls.

The development build still resolves Debian security packages during the build. Release promotion must record the resulting OCI digest and attached SBOM/provenance; a production orchestrator rejects mutable image references.

### Exact-digest candidate lane

`.github/workflows/session-candidate.yml` is manual, runs only from `main`, and does not publish `latest`. It uses native Ubuntu 24.04 amd64 and arm64 runners. Each matrix job builds the `release` target once, pushes a commit-scoped QA tag, locks the raw registry manifest by SHA-256, and aliases only that pulled digest for testing. A separate browser-state fixture layer uses `FROM <exact digest>` and is never part of the promoted image. The complete single-container, two-tenant, browser-state, Direct-media, relay-only TURN, reconnect, burn, ticket-revocation, and residue suite therefore evaluates the same platform manifest later placed in the multi-platform index.

After QA, Syft produces one SPDX JSON document per platform. The workflow records the exact manifest bytes, SBOM checksum/size, source commit, and platform in a strict record; it then attaches GitHub build-provenance and SBOM attestations to that platform digest. Only after both matrix jobs succeed may the merge job run `imagetools create` over the two recorded digests. The validator requires exactly `linux/amd64` and `linux/arm64`, rejects extra descriptors and digest drift, hashes the raw OCI index, and binds that digest to repository, commit, workflow run/attempt, candidate tag, platform manifests, and SBOMs in `candidate-evidence.json`.

[`schemas/session-candidate-evidence-v1.schema.json`](../schemas/session-candidate-evidence-v1.schema.json) is the structural contract. [`scripts/session-candidate-evidence.mjs`](../scripts/session-candidate-evidence.mjs) is the normative semantic validator: it also enforces canonical ordering, cross-file digests, workflow URL identity, source equality, distinct platform manifests, regular bounded files, no final symlinks, and stable metadata while reading. The merge job validates the complete downloaded bundle before attaching index provenance and the Fireball evidence predicate, then keylessly signs and verifies `image@index-digest` with the exact `session-candidate.yml@refs/heads/main` certificate identity. Every external action in this workflow is pinned to an immutable commit.

The `candidate-<commit>` tag is only a discovery pointer and can be replaced by an explicit rerun. Consumers must deploy the exact index digest from the evidence. QA platform tags are intentionally retained as forensic inputs if a later merge/sign step fails; they are not releases.

After a successful run, verify both GitHub attestations and the independent Cosign signature:

```sh
candidate="ghcr.io/lamppkk/fireball-session@sha256:<INDEX_DIGEST>"

gh attestation verify "oci://$candidate" \
  --repo LamPPKK/fireball-docker

cosign verify "$candidate" \
  --certificate-identity \
    "https://github.com/LamPPKK/fireball-docker/.github/workflows/session-candidate.yml@refs/heads/main" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com"
```

GitHub/Sigstore verification proves the workflow identity and signed digest. It does not prove Apple-style human review, production deployment health, or that a mutable tag still resolves to the same digest.

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

An operator may configure TURN through the [deployment adapter](deployment-adapters.md). The Docker API mounts the host file read-only at `/run/fireball-secrets/ice-servers.json`; no TURN URL is placed in the image or container environment. Before starting GStreamer, the non-root supervisor checks the file size, owner, group, mode, schema, URL form, unique-server bound, and ICE policy. GStreamer receives the validated `stun-server`, `turn-servers`, and `ice-transport-policy` properties. The source-revision workflow now proves real coturn allocation and relay-only media/control; repeating that gate against the exact candidate digest remains a promotion requirement.

## Storage and process policy

- UID/GID `10001` runs the supervisor, WPE WebKit children, and GStreamer pipeline.
- The root filesystem is read-only and all capabilities are dropped with `no-new-privileges`.
- Ubuntu 24.04 hosts load the named `fireball-session` AppArmor profile, whose sole purpose is to permit the unprivileged user namespace required by WebKit's bubblewrap child-process sandbox.
- Every production session also receives `deploy/seccomp/fireball-session.json`. It preserves Moby's `SCMP_ACT_ERRNO` default, permits only three exact `clone()` namespace flag sets, the exact `unshare(CLONE_NEWUSER)` needed for bubblewrap's second-level `/dev/pts` setup, and `mount`, `pivot_root`, and `umount2` for its mount phase. It does not allow `clone3`, `setns`, any other `unshare` flag set, add capabilities, or disable seccomp. WebKit installs its own inner filter after setup and blocks namespace/mount operations in the web process.
- Docker's default masked/read-only system paths and private per-tenant PID namespace remain intact. A compiled fail-closed wrapper accepts only WebKit's sealed `--args` launch form, verifies its seccomp/UTS/PID/proc invariants, removes the incompatible second PID namespace, and replaces the fresh procfs request with a read-only bind of the container's already masked `/proc`. It rejects external PID namespaces, nested argument files, capability overrides, or any missing/duplicate invariant. WebKit still creates its inner user, mount, UTS, optional network/IPC namespaces and installs its renderer seccomp filter.
- Cookie, cache, configuration, GStreamer registry, and runtime state are rooted below `/run/fireball-session`.
- The portable Docker profile negotiates WPE's system-memory BGRA output before color conversion, avoiding a mandatory GPU-backed/zero-copy buffer path. WPE still receives its required EGL/GLES runtime libraries. Hardware/zero-copy profiles remain benchmark-gated deployment variants.
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

The `session-image` GitHub workflow builds and loads each architecture independently under Buildx on GitHub's native Ubuntu 24.04 x86_64 and arm64 runners, then checks `wpesrc`, `webrtcsink`, `openh264enc`, GLES runtime resolution, the non-root user, supervisor syntax, and embedded component versions. It rejects an ICE fixture with unsafe permissions, then starts the image with a valid read-only TURN fixture plus the production read-only/capability/tmpfs restrictions. The single-container smoke waits for Docker health, proving the pinned GStreamer build parses the TURN properties, verifies loopback-only signaling, rejects a bad bootstrap secret and a second controller, and proves the controller lease can reconnect before removing the container. The two-tenant smoke then uses the compiled orchestrator and real Docker Engine to verify ownership denial, credential/session binding, container and namespace separation, process/tmpfs/network probes, confinement, quotas, revocation, and cleanup. A CI-only stage derived from the same runtime adds a loopback origin; two concurrent WPE instances prove cookie, localStorage, and service-worker separation, then burn/recreate proves no browser-state residue. The Direct browser media smoke performs two authenticated Firefox page loads and requires H.264 and Opus negotiation, RTP packets, decoded video frames, a navigation DataChannel response, reconnect credential rotation, burn revocation, and zero managed Docker residue. A separate gate starts an ephemeral coturn service, installs short-lived root-owned credentials, verifies the parsed relay-only policy and UDP reachability from the exact tenant namespace, and repeats the complete media/control sequence twice while requiring the selected candidate pair to be relay-to-relay. Failure diagnostics redact TURN credentials, rswebrtc peer signaling frames, and ICE/DTLS material.

Install the reviewed host policy without changing its bytes:

```sh
sudo install -d -o root -g root -m 0755 /etc/fireball
sudo install -o root -g root -m 0444 \
  deploy/seccomp/fireball-session.json \
  /etc/fireball/fireball-session-seccomp.json
```

Set `FIREBALL_SESSION_SECCOMP_PROFILE=/etc/fireball/fireball-session-seccomp.json`. The orchestrator opens it without following a final symlink, checks regular-file type, size, ownership, mode, read-time metadata stability, and the exact reviewed SHA-256 before sending compact JSON to Docker Engine. Any mismatch aborts production startup.

Promotion additionally requires:

1. Run `session-candidate` from protected `main`; both native platform jobs and the no-rebuild index merge/sign job must pass.
2. Preserve the emitted exact index digest, platform manifests, SPDX SBOMs, candidate evidence, GitHub attestations, and Cosign identity. Never substitute a tag for that digest.
3. Add browser/encoder crash recovery and daemon restart reconciliation against the same immutable digest; the current gate already covers WPE load, H.264/Opus, DataChannel input, reconnect, burn, credential revocation, two-tenant/browser-state isolation, TURN relay, quotas, and Docker residue cleanup.
4. Run `nginx -t` and an external TLS/WebSocket handshake against the deployed candidate through the checked adapter.
5. Promote only that tested digest. Do not rebuild after QA.

The public orchestrator should remain on host loopback behind the rendered Nginx TLS/WebSocket adapter. The adapter source is checked in normal CI, but release evidence must also include `nginx -t` and an external WebSocket handshake against the deployed version.
