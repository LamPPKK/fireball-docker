import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const expectedBaseDigest = "sha256:3a39a0592364683e6bab97937b72cad5a8fa6dcbbee90edb3bb48c7f8e94f258";
const expectedPluginRevision = "0826007d970a473475b6bf993229ebcde173fdba";
const dockerfile = await readFile(new URL("../session/Dockerfile", import.meta.url), "utf8");
const manifest = JSON.parse(await readFile(new URL("../session/image-manifest.json", import.meta.url), "utf8"));
const packageLock = JSON.parse(await readFile(new URL("../session/package-lock.json", import.meta.url), "utf8"));
const supervisor = await readFile(new URL("../session/supervisor.mjs", import.meta.url), "utf8");
const tabControl = await readFile(new URL("../session/tab-control.mjs", import.meta.url), "utf8");
const nativeRuntime = await readFile(new URL("../session/fireball-session-runtime.cc", import.meta.url), "utf8");
const bwrapWrapper = await readFile(new URL("../session/fireball-bwrap-wrapper.c", import.meta.url), "utf8");
const containerSmoke = await readFile(new URL("../session/container-smoke.mjs", import.meta.url), "utf8");
const isolationGate = await readFile(new URL("./real-isolation-gate.mjs", import.meta.url), "utf8");
const browserStateGate = await readFile(new URL("./real-browser-state-gate.mjs", import.meta.url), "utf8");
const restartCrashGate = await readFile(new URL("./real-restart-crash-gate.mjs", import.meta.url), "utf8");
const multiTabGate = await readFile(new URL("./real-multi-tab-gate.mjs", import.meta.url), "utf8");
const nginxTlsGate = await readFile(new URL("./real-nginx-tls-gate.mjs", import.meta.url), "utf8");
const browserStateServer = await readFile(new URL("./fixtures/browser-state-server.mjs", import.meta.url), "utf8");
const mediaGate = await readFile(new URL("./real-media-gate.mjs", import.meta.url), "utf8");
const turnGate = await readFile(new URL("./real-turn-gate.mjs", import.meta.url), "utf8");
const mediaFixture = await readFile(
  new URL("./fixtures/rswebrtc-media-smoke.html", import.meta.url),
  "utf8",
);
const imageWorkflow = await readFile(new URL("../.github/workflows/session-image.yml", import.meta.url), "utf8");
const candidateWorkflow = await readFile(new URL("../.github/workflows/session-candidate.yml", import.meta.url), "utf8");
const candidateEvidence = await readFile(new URL("./session-candidate-evidence.mjs", import.meta.url), "utf8");
const candidateEvidenceSchema = JSON.parse(await readFile(
  new URL("../schemas/session-candidate-evidence-v1.schema.json", import.meta.url),
  "utf8",
));
const candidateBrowserStateDockerfile = await readFile(
  new URL("./fixtures/browser-state-candidate.Dockerfile", import.meta.url),
  "utf8",
);
const openh264Manifest = JSON.parse(await readFile(
  new URL("../config/firefox-openh264-v1.json", import.meta.url),
  "utf8",
));
const openh264Installer = await readFile(
  new URL("./install-firefox-openh264.mjs", import.meta.url),
  "utf8",
);
const appArmorProfile = await readFile(new URL("../deploy/apparmor/fireball-session", import.meta.url), "utf8");
const seccompLoader = await readFile(new URL("../src/runtime/seccomp-profile.ts", import.meta.url), "utf8");
const seccompProfile = JSON.parse(await readFile(
  new URL("../deploy/seccomp/fireball-session.json", import.meta.url),
  "utf8",
));
const seccompProvenance = JSON.parse(await readFile(
  new URL("../deploy/seccomp/fireball-session.provenance.json", import.meta.url),
  "utf8",
));
const seccompLicense = await readFile(
  new URL("../deploy/seccomp/LICENSE-MOBY-PROFILES-APACHE-2.0", import.meta.url),
  "utf8",
);
const iceFixture = JSON.parse(await readFile(
  new URL("../session/test/fixtures/ice-servers.json", import.meta.url),
  "utf8",
));

assert.deepEqual(Object.keys(manifest).sort(), [
  "base_image",
  "gst_plugins_rs",
  "internal_signaling_port",
  "platforms",
  "runtime_contract",
  "schema_version",
  "session_uid",
  "version",
]);
assert.equal(manifest.schema_version, 1);
assert.equal(manifest.base_image.digest, expectedBaseDigest);
assert.equal(manifest.gst_plugins_rs.revision, expectedPluginRevision);
assert.deepEqual(manifest.platforms, ["linux/amd64", "linux/arm64"]);
assert.equal(manifest.internal_signaling_port, 8444);
assert.equal(manifest.session_uid, 10001);
assert.equal(manifest.runtime_contract.pid_namespace, "tenant-container");
assert.equal(manifest.runtime_contract.proc_mount, "read-only bind of container procfs");
assert.equal(manifest.runtime_contract.public_stun_default, false);
assert.equal(manifest.runtime_contract.ice_configuration_path, "/run/fireball-secrets/ice-servers.json");
assert.equal(manifest.runtime_contract.ice_configuration_schema_version, 1);
assert.equal(manifest.runtime_contract.ice_credentials_in_environment, false);

for (const required of [
  `debian:trixie-slim@${expectedBaseDigest}`,
  `GST_PLUGINS_RS_REV=${expectedPluginRevision}`,
  "cargo cinstall",
  "--locked",
  "--no-default-features",
  "--features web_server",
  "gstreamer1.0-wpe",
  "gstreamer1.0-nice",
  "libegl1",
  "libgles2",
  "libwpewebkit-2.0-1",
  "libgstrswebrtc.so",
  "gst-inspect-1.0 audiotestsrc",
  "gst-inspect-1.0 audiomixer",
  "gst-inspect-1.0 nicesrc",
  "bwrap-wrapper-builder",
  "session-runtime-builder",
  "libgstreamer1.0-dev",
  "/fireball-session-runtime /usr/bin/fireball-session-runtime",
  "mv /usr/bin/bwrap /usr/lib/fireball/bwrap.real",
  "/fireball-bwrap /usr/bin/bwrap",
  "USER 10001:10001",
  "XDG_RUNTIME_DIR=/run/fireball-session/runtime",
  "EXPOSE 8444",
  "HEALTHCHECK",
]) {
  assert.ok(dockerfile.includes(required), `session Dockerfile is missing: ${required}`);
}
assert.doesNotMatch(dockerfile, /(?:FROM|image:)\s+\S+:latest/);
assert.doesNotMatch(dockerfile, /curl|wget|--privileged/);
assert.match(bwrapWrapper, /--unshare-pid/);
assert.match(bwrapWrapper, /--ro-bind/);
assert.match(bwrapWrapper, /argument descriptor is not the sealed WebKit memfd/);
assert.match(bwrapWrapper, /capability or non-boundary overrides are forbidden/);
assert.doesNotMatch(bwrapWrapper, /system\s*\(|popen\s*\(|seccomp=unconfined/);

assert.equal(packageLock.lockfileVersion, 3);
assert.equal(packageLock.packages["node_modules/ws"].version, "8.21.3");
assert.match(packageLock.packages["node_modules/ws"].integrity, /^sha512-/);
assert.match(nativeRuntime, /run-web-server=false/);
assert.match(supervisor, /--stun-server/);
assert.match(supervisor, /--turn-servers/);
assert.match(supervisor, /--ice-policy/);
assert.match(nativeRuntime, /video\/x-raw,format=BGRA/);
assert.match(nativeRuntime, /audiotestsrc/);
assert.match(nativeRuntime, /audiomixer/);
assert.match(nativeRuntime, /input-selector name=video_selector/);
assert.match(nativeRuntime, /input-selector name=audio_selector/);
assert.match(nativeRuntime, /constexpr std::size_t kMaximumTabs = 4/);
assert.match(nativeRuntime, /g_signal_connect\(tab->source, "pad-added"/);
assert.match(nativeRuntime, /g_object_set\(video_selector_, "active-pad"/);
assert.match(tabControl, /class TabController/);
assert.match(tabControl, /class NativeTabDriver/);
assert.match(supervisor, /\/internal\/v1\/tabs/);
assert.doesNotMatch(nativeRuntime, /gldownload/);
assert.doesNotMatch(supervisor, /stun\.l\.google\.com/);
assert.match(dockerfile, /install -d -o root -g 10001 -m 0750 \/run\/fireball-secrets/);
for (const required of [
  "--read-only",
  "--cap-drop=ALL",
  "--security-opt=no-new-privileges:true",
  "127.0.0.1::8444",
  "expectAuthenticationRejected",
  "expectControllerRejected",
  "await waitForHealthy()",
]) {
  assert.ok(containerSmoke.includes(required), `container smoke is missing: ${required}`);
}
assert.match(imageWorkflow, /npm run container:smoke --prefix session/);
assert.match(imageWorkflow, /npm run session:isolation:smoke/);
assert.match(imageWorkflow, /npm run session:multi-tab:smoke/);
assert.match(imageWorkflow, /npm run session:media:smoke/);
assert.match(imageWorkflow, /npm run session:turn:smoke/);
assert.match(imageWorkflow, /Smoke rswebrtc H\.264, Opus, control, reconnect, and burn/);
assert.match(imageWorkflow, /Smoke relay-only TURN media and control twice/);
assert.match(imageWorkflow, /apt-get install -y --no-install-recommends coturn/);
assert.match(imageWorkflow, /Install pinned Firefox OpenH264 test codec/);
assert.match(imageWorkflow, /MOZ_GMP_PATH/);
assert.match(imageWorkflow, /MOZ_LOG: GMP:5/);
for (const required of [
  'firewallRuleArguments("-I")',
  'firewallRuleArguments("-D")',
  '"-i", "br+"',
  '"--dport", String(listeningPort)',
  '`fireball-turn-gate-${suffix}`',
]) {
  assert.ok(turnGate.includes(required), `TURN gate is missing scoped firewall lifecycle: ${required}`);
}
assert.doesNotMatch(turnGate, /firewallRuleArguments\("-D"\)\], \{ allowFailure: true \}/);
assert.match(imageWorkflow, /npm ci --ignore-scripts/);
assert.match(imageWorkflow, /npm run build/);
assert.match(imageWorkflow, /ldconfig -p \| grep -F libGLESv2\.so\.2/);
assert.match(imageWorkflow, /actions\/setup-node@v6/);
assert.match(imageWorkflow, /runner: ubuntu-24\.04\n/);
assert.match(imageWorkflow, /runner: ubuntu-24\.04-arm\n/);
assert.doesNotMatch(imageWorkflow, /setup-qemu-action/);
assert.match(imageWorkflow, /apparmor_parser -r deploy\/apparmor\/fireball-session/);
assert.match(imageWorkflow, /FIREBALL_SMOKE_SECCOMP_PROFILE/);
assert.match(appArmorProfile, /profile fireball-session flags=\(unconfined\)/);
assert.match(appArmorProfile, /\buserns,/);
assert.doesNotMatch(containerSmoke, /seccomp=unconfined|--privileged/);
assert.doesNotMatch(containerSmoke, /systempaths=unconfined/);
assert.match(containerSmoke, /seccomp=\$\{seccompProfile\}/);
assert.equal(seccompProfile.defaultAction, "SCMP_ACT_ERRNO");
assert.equal(seccompProfile.defaultErrnoRet, 1);
assert.deepEqual(seccompProfile.archMap, [
  { architecture: "SCMP_ARCH_X86_64", subArchitectures: null },
  { architecture: "SCMP_ARCH_AARCH64", subArchitectures: null },
]);
assert.equal(seccompProvenance.schema_version, 1);
assert.equal(seccompProvenance.upstream.license.spdx, "Apache-2.0");
assert.deepEqual(seccompProvenance.policy.exact_unshare_flag_sets, [0x10000000]);
assert.deepEqual(seccompProvenance.policy.explicitly_not_allowed, ["clone3", "setns"]);
assert.equal(seccompProvenance.policy.pid_namespace, "tenant-container");
assert.equal(seccompProvenance.policy.proc_mount, "read-only bind of container procfs");
assert.match(seccompLoader, new RegExp(seccompProvenance.generated_profile_sha256));
assert.match(seccompLicense, /Apache License\s+Version 2\.0/);
assert.match(containerSmoke, /FIREBALL_SMOKE_ICE_SERVERS_FILE/);
assert.match(containerSmoke, /target=\/run\/fireball-secrets\/ice-servers\.json,readonly/);
assert.equal(iceFixture.schema_version, 1);
assert.equal(iceFixture.ice_transport_policy, "relay");
assert.match(imageWorkflow, /Reject unsafe TURN secret permissions/);
assert.match(imageWorkflow, /must be owned by root:10001 with mode 0440/);
for (const required of [
  "maximumSessions: 2",
  "expectTenantDenied",
  "namespaceIdentity",
  "assertOwnNetworkMarker",
  "assertNetworkPeerIsUnreachable",
  "expectInternalAuthenticationRejected",
  "expectTicketRevoked",
  "managedContainers(instanceId).length, 0",
  "managedNetworks(instanceId).length, 0",
]) {
  assert.ok(isolationGate.includes(required), `real isolation gate is missing: ${required}`);
}
assert.doesNotMatch(isolationGate, /--privileged|seccomp=unconfined|systempaths=unconfined/);
for (const required of [
  "assertEmptyState(initialAlpha)",
  "assertEmptyState(initialBeta)",
  "assertMarkerState(await waitForReport(alphaContainer.Id, 1), alphaMarker)",
  "assertEmptyState(await waitForReport(betaContainer.Id, 1))",
  "assertMarkerState(await waitForReport(betaContainer.Id, 2), betaMarker)",
  "assertMarkerState(await waitForReport(alphaContainer.Id, 2), alphaMarker)",
  "assertEmptyState(await waitForReport(replacementContainer.Id, 0))",
  "serviceWorkerRegistered",
  "managedContainers(instanceId).length, 0",
  "managedNetworks(instanceId).length, 0",
]) {
  assert.ok(browserStateGate.includes(required), `browser-state gate is missing: ${required}`);
}
assert.doesNotMatch(browserStateGate, /--privileged|seccomp=unconfined|systempaths=unconfined/);
for (const required of [
  "orchestrator restart did not reconcile the abandoned session",
  "expectSessionMissing",
  "expectTicketRevoked(abandoned.signalingTicket)",
  "killPipeline(crashContainer.Id)",
  "stopped.RestartCount, 0",
  "expectTicketRevoked(staleTicket.signalingTicket)",
  "assertNoResidue(\"crash replacement burn\")",
]) {
  assert.ok(restartCrashGate.includes(required), `restart/crash gate is missing: ${required}`);
}
assert.doesNotMatch(restartCrashGate, /--privileged|seccomp=unconfined|systempaths=unconfined/);
for (const required of [
  "tabs.length, 4",
  "TAB_LIMIT_REACHED",
  "TAB_MINIMUM_REACHED",
  "expectTenantDenied",
  "assertRuntimeIdentity",
  "/usr/bin/fireball-session-runtime",
  "managedContainers().length, 0",
  "managedNetworks().length, 0",
]) {
  assert.ok(multiTabGate.includes(required), `multi-tab gate is missing: ${required}`);
}
assert.doesNotMatch(multiTabGate, /--privileged|seccomp=unconfined|systempaths=unconfined/);
for (const required of [
  "renderNginxConfig",
  'sudoNginx(["-t"])',
  'assert.equal(health.headers["strict-transport-security"]',
  "health.tls.authorized, true",
  "/^TLSv1\\.[23]$/",
  "expectWrongOriginRejected",
  "wss://${publicHost}/orchestrator/v1/signaling",
  "await burnSession(certificate, created.session.id)",
  "expectTicketRevoked(certificate, staleTicket.signalingTicket)",
  'managedContainers().length, 0',
  'managedNetworks().length, 0',
]) {
  assert.ok(nginxTlsGate.includes(required), `Nginx/TLS gate is missing: ${required}`);
}
assert.doesNotMatch(nginxTlsGate, /rejectUnauthorized:\s*false|NODE_TLS_REJECT_UNAUTHORIZED|--privileged/);
for (const required of [
  'listen(LISTEN_PORT, LISTEN_HOST',
  'navigator.serviceWorker.register(',
  'localStorage.setItem(storageName, marker)',
  'document.cookie = cookieName',
  'navigator.serviceWorker.getRegistration("/")',
  'spawn(process.execPath, [SUPERVISOR]',
  '"content-security-policy"',
  '"cache-control": "no-store"',
]) {
  assert.ok(browserStateServer.includes(required), `browser-state fixture server is missing: ${required}`);
}
assert.match(dockerfile, /FROM runtime AS browser-state-gate/);
assert.match(dockerfile, /FIREBALL_START_URL=http:\/\/127\.0\.0\.1:18080\//);
assert.match(dockerfile, /ENTRYPOINT \["\/usr\/bin\/node", "\/opt\/fireball-state-gate\/server\.mjs"\]/);
assert.match(dockerfile, /FROM runtime AS release\s*$/);
for (const required of [
  "Build browser-state fixture layer",
  "target: browser-state-gate",
  "Smoke browser cookie, localStorage, service-worker, and burn isolation",
  "session:browser-state:smoke",
  "Smoke restart reconciliation and pipeline crash containment",
  "session:restart-crash:smoke",
  "Smoke one-container four-tab lifecycle",
  "session:multi-tab:smoke",
  "Smoke nginx -t and external TLS/WebSocket deployment",
  "session:nginx-tls:smoke",
]) {
  assert.ok(imageWorkflow.includes(required), `session-image workflow is missing: ${required}`);
}
for (const required of [
  "Build and push the platform image exactly once",
  "target: release",
  "push: true",
  "provenance: false",
  "sbom: false",
  "qa-${{ github.sha }}-${{ matrix.suffix }}",
  "docker buildx imagetools inspect --raw \"$candidate_reference\"",
  "actual_digest=\"sha256:$(sha256sum",
  "Smoke the exact running session image",
  "Prove exact-digest two-tenant isolation",
  "Prove exact-digest browser-state isolation and burn cleanup",
  "Prove exact-digest restart reconciliation and pipeline crash containment",
  "Prove exact-digest one-container four-tab lifecycle",
  "Prove exact-digest nginx -t and external TLS/WebSocket deployment",
  "Prove exact-digest H.264, Opus, control, reconnect, and burn",
  "Prove exact-digest relay-only TURN twice",
  "session-candidate-evidence.mjs platform",
  "session-candidate-evidence.mjs candidate",
  "session-candidate-evidence.mjs validate",
  "candidate-platform-amd64",
  "candidate-platform-arm64",
  "docker buildx imagetools create",
  "actions/attest@",
  "sbom-path:",
  "predicate-type: https://fireball.dev/attestations/session-candidate/v1",
  "cosign sign --yes",
  "cosign verify",
]) {
  assert.ok(candidateWorkflow.includes(required), `session-candidate workflow is missing: ${required}`);
}
assert.equal((candidateWorkflow.match(/docker\/build-push-action@/gu) ?? []).length, 1);
assert.doesNotMatch(candidateWorkflow, /setup-qemu-action|:latest\b|find\s+.*(?:artifact|manifest)/);
for (const line of candidateWorkflow.split("\n").filter((candidate) => /^\s+uses:\s+[^.]/u.test(candidate))) {
  assert.match(line, /@[0-9a-f]{40}(?:\s+#.*)?$/u, `candidate action is not pinned by commit: ${line}`);
}
for (const required of [
  "ARG BASE_IMAGE",
  "FROM ${BASE_IMAGE}",
  "COPY --chown=10001:10001 scripts/fixtures/browser-state-server.mjs",
  "FIREBALL_START_URL=http://127.0.0.1:18080/",
]) {
  assert.ok(candidateBrowserStateDockerfile.includes(required), `candidate browser-state layer is missing: ${required}`);
}
assert.equal(candidateEvidenceSchema.$schema, "https://json-schema.org/draft/2020-12/schema");
assert.equal(candidateEvidenceSchema.additionalProperties, false);
assert.equal(candidateEvidenceSchema.properties.release_status.const, "candidate");
for (const required of [
  "O_NOFOLLOW",
  "changed while it was read",
  "OCI index must contain exactly two platform manifests",
  "candidate tag must be source-bound",
  "workflow URL is not bound to the repository and run identity",
  "platform digests must differ",
]) {
  assert.ok(candidateEvidence.includes(required), `candidate evidence validator is missing: ${required}`);
}
for (const required of [
  "__FIREBALL_ICE_CONFIGURATION__",
  "new RTCPeerConnection(iceConfiguration)",
  'state.localCandidateType.toLowerCase() === "relay"',
  'state.remoteCandidateType.toLowerCase() === "relay"',
  "video/h264",
  "audio/opus",
  "browserH264Capable",
  "browserOpusCapable",
  "framesDecoded",
  "ControlResponseMessage",
  "navigationEvent",
  "window.__fireballStop",
  "window.__fireballMarkBurned",
]) {
  assert.ok(mediaFixture.includes(required), `rswebrtc browser fixture is missing: ${required}`);
}
for (const required of [
  "assertContainerTurnPreflight(instanceId)",
  "configuration.ice.iceTransportPolicy",
  "configuration.ice.turnServers.length",
  "TURN STUN binding timed out",
  "TURN STUN binding response was invalid",
  "FIREBALL_SMOKE_TURN_PROBE_HOST",
  "FIREBALL_SMOKE_TURN_PROBE_PORT",
  "credentialSecrets",
]) {
  assert.ok(mediaGate.includes(required), `real media gate is missing TURN preflight: ${required}`);
}
assert.match(turnGate, /FIREBALL_SMOKE_TURN_PROBE_HOST: hostIp/);
assert.match(turnGate, /FIREBALL_SMOKE_TURN_PROBE_PORT: String\(listeningPort\)/);
for (const required of [
  'assertCommand("geckodriver"',
  'assertCommand("firefox"',
  '"media.gmp-gmpopenh264.enabled": true',
  "FIREBALL_SMOKE_EXPECT_RELAY",
  "parseBrowserIceConfiguration",
  "reportWebDriverDiagnostics()",
  'index.html?pass=${encodeURIComponent(passId)}',
  "redactContainerLogs(logs)",
  "new WebSocketSignalingConnector",
  "signalingAllowedOrigins: new Set([pageOrigin])",
  "assertMediaEvidence(first)",
  "assertMediaEvidence(second)",
  "expectTicketRevoked",
  "managedContainers(instanceId).length, 0",
  "managedNetworks(instanceId).length, 0",
]) {
  assert.ok(mediaGate.includes(required), `real media gate is missing: ${required}`);
}
assert.doesNotMatch(mediaGate, /--privileged|seccomp=unconfined|systempaths=unconfined/);
assert.doesNotMatch(mediaGate, /\/#pass=/);
assert.doesNotMatch(mediaFixture, /signalingToken|signalingTicket|[?&](?:token|ticket)=/);
for (const required of [
  'command("sudo", [',
  '"install", "-o", "root", "-g", "10001", "-m", "0440"',
  'spawn("turnserver"',
  'command("turnutils_uclient"',
  'ice_transport_policy: "relay"',
  'iceTransportPolicy: "relay"',
  'FIREBALL_SMOKE_EXPECT_RELAY: "1"',
  'new URL("./real-media-gate.mjs"',
]) {
  assert.ok(turnGate.includes(required), `real TURN gate is missing: ${required}`);
}
assert.doesNotMatch(turnGate, /FIREBALL_SMOKE_TURN_(?:USERNAME|PASSWORD)|--privileged|seccomp=unconfined/);
assert.equal(openh264Manifest.schema_version, 1);
assert.equal(openh264Manifest.plugin_version, "2.6.0");
assert.equal(openh264Manifest.source.repository, "mozilla-firefox/firefox");
assert.deepEqual(Object.keys(openh264Manifest.artifacts).sort(), ["linux/amd64", "linux/arm64"]);
assert.match(openh264Installer, /redirect: "error"/);
assert.match(openh264Installer, /createHash\("sha512"\)/);
assert.match(openh264Installer, /Content-Length mismatch/);
assert.match(openh264Installer, /gmpopenh264\.info/);
assert.match(openh264Installer, /libgmpopenh264\.so/);
assert.match(openh264Installer, /"gmp-gmpopenh264", manifest\.plugin_version/);

process.stdout.write("session image contract is internally consistent\n");
