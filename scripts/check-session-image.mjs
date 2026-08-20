import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const expectedBaseDigest = "sha256:3a39a0592364683e6bab97937b72cad5a8fa6dcbbee90edb3bb48c7f8e94f258";
const expectedPluginRevision = "0826007d970a473475b6bf993229ebcde173fdba";
const dockerfile = await readFile(new URL("../session/Dockerfile", import.meta.url), "utf8");
const manifest = JSON.parse(await readFile(new URL("../session/image-manifest.json", import.meta.url), "utf8"));
const packageLock = JSON.parse(await readFile(new URL("../session/package-lock.json", import.meta.url), "utf8"));
const supervisor = await readFile(new URL("../session/supervisor.mjs", import.meta.url), "utf8");
const containerSmoke = await readFile(new URL("../session/container-smoke.mjs", import.meta.url), "utf8");
const imageWorkflow = await readFile(new URL("../.github/workflows/session-image.yml", import.meta.url), "utf8");
const appArmorProfile = await readFile(new URL("../deploy/apparmor/fireball-session", import.meta.url), "utf8");
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
  "libwpewebkit-2.0-1",
  "libgstrswebrtc.so",
  "USER 10001:10001",
  "XDG_RUNTIME_DIR=/run/fireball-session/runtime",
  "EXPOSE 8444",
  "HEALTHCHECK",
]) {
  assert.ok(dockerfile.includes(required), `session Dockerfile is missing: ${required}`);
}
assert.doesNotMatch(dockerfile, /(?:FROM|image:)\s+\S+:latest/);
assert.doesNotMatch(dockerfile, /curl|wget|--privileged/);

assert.equal(packageLock.lockfileVersion, 3);
assert.equal(packageLock.packages["node_modules/ws"].version, "8.21.3");
assert.match(packageLock.packages["node_modules/ws"].integrity, /^sha512-/);
assert.match(supervisor, /run-web-server=false/);
assert.match(supervisor, /stun-server=/);
assert.match(supervisor, /turn-servers=/);
assert.match(supervisor, /ice-transport-policy=/);
assert.match(supervisor, /video\/x-raw,format=BGRA/);
assert.doesNotMatch(supervisor, /gldownload/);
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
assert.match(imageWorkflow, /actions\/setup-node@v6/);
assert.match(imageWorkflow, /apparmor_parser -r deploy\/apparmor\/fireball-session/);
assert.match(appArmorProfile, /profile fireball-session flags=\(unconfined\)/);
assert.match(appArmorProfile, /\buserns,/);
assert.doesNotMatch(containerSmoke, /seccomp=unconfined|--privileged/);
assert.match(containerSmoke, /FIREBALL_SMOKE_ICE_SERVERS_FILE/);
assert.match(containerSmoke, /target=\/run\/fireball-secrets\/ice-servers\.json,readonly/);
assert.equal(iceFixture.schema_version, 1);
assert.equal(iceFixture.ice_transport_policy, "relay");
assert.match(imageWorkflow, /Reject unsafe TURN secret permissions/);
assert.match(imageWorkflow, /must be owned by root:10001 with mode 0440/);

process.stdout.write("session image contract is internally consistent\n");
