import assert from "node:assert/strict";
import { test } from "node:test";

import {
  childEnvironment,
  parseAuthenticationFrame,
  parseConfiguration,
  parseIceServerConfiguration,
  pipelineArguments,
  validateIceServerFileMetadata,
} from "../supervisor.mjs";

const secret = "A".repeat(43);

test("configuration validates secret, profile, and navigation scheme", () => {
  const configuration = parseConfiguration({
    FIREBALL_INTERNAL_SIGNALING_SECRET: secret,
    FIREBALL_STREAM_PROFILE: "1080p30",
    FIREBALL_START_URL: "https://example.com/path",
  });
  assert.equal(configuration.profile.width, 1920);
  assert.equal(configuration.profile.fps, 30);
  assert.equal(configuration.startUrl, "https://example.com/path");

  assert.throws(
    () => parseConfiguration({ FIREBALL_INTERNAL_SIGNALING_SECRET: "short" }),
    /256 bits/,
  );
  assert.throws(
    () => parseConfiguration({
      FIREBALL_INTERNAL_SIGNALING_SECRET: secret,
      FIREBALL_STREAM_PROFILE: "4k120",
    }),
    /unsupported/,
  );
  assert.throws(
    () => parseConfiguration({
      FIREBALL_INTERNAL_SIGNALING_SECRET: secret,
      FIREBALL_START_URL: "javascript:alert(1)",
    }),
    /scheme/,
  );
  assert.throws(
    () => parseConfiguration({
      FIREBALL_INTERNAL_SIGNALING_SECRET: secret,
      FIREBALL_START_URL: "file:///etc/passwd",
    }),
    /packaged file route/,
  );
});

test("pipeline is one WPE source with explicit H264, Opus, control, and no public STUN", () => {
  const configuration = parseConfiguration({ FIREBALL_INTERNAL_SIGNALING_SECRET: secret });
  const argumentsList = pipelineArguments(configuration);
  const command = argumentsList.join(" ");

  assert.equal(argumentsList.filter((argument) => argument === "wpesrc").length, 1);
  assert.match(command, /video\/x-raw,format=BGRA/);
  assert.doesNotMatch(command, /gldownload/);
  assert.match(command, /openh264enc/);
  assert.match(command, /video\/x-h264,profile=constrained-baseline/);
  assert.match(command, /opusenc bitrate=64000/);
  assert.match(command, /audiotestsrc wave=silence is-live=true do-timestamp=true/);
  assert.match(command, /audiomixer name=audio_mix/);
  assert.match(command, /audio\/x-raw,format=S16LE,rate=48000,channels=2/);
  assert.match(command, /web\.audio_0 .* audio_mix\./);
  assert.equal(argumentsList.filter((argument) => argument === "opusenc").length, 1);
  assert.match(command, /enable-control-data-channel=true/);
  assert.match(command, /run-web-server=false/);
  assert.match(command, /signalling-server-host=127\.0\.0\.1/);
  assert.ok(argumentsList.includes('stun-server=""'));
  assert.equal(argumentsList.indexOf('stun-server=""') + 1, argumentsList.indexOf("ice-transport-policy=all"));
  assert.doesNotMatch(command, /stun\.l\.google\.com/);
  assert.doesNotMatch(command, new RegExp(secret));
});

test("TURN configuration is strict and becomes explicit GStreamer ICE policy", () => {
  const source = JSON.stringify({
    schema_version: 1,
    stun_server: { host: "stun.example.com", port: 3478 },
    turn_servers: [
      {
        scheme: "turns",
        host: "turn.example.com",
        port: 5349,
        username: "tenant:alpha",
        password: "temporary/credential",
      },
      {
        scheme: "turn",
        host: "2001:db8::2",
        port: 3478,
        username: "tenant",
        password: "credential",
      },
    ],
    ice_transport_policy: "relay",
  });
  const configuration = parseConfiguration(
    {
      FIREBALL_INTERNAL_SIGNALING_SECRET: secret,
      FIREBALL_ICE_SERVERS_FILE: "/run/fireball-secrets/ice-servers.json",
    },
    () => parseIceServerConfiguration(source),
  );
  const argumentsList = pipelineArguments(configuration);
  assert.ok(argumentsList.includes("stun-server=stun://stun.example.com:3478"));
  assert.ok(argumentsList.includes(
    "turn-servers=<\"turns://tenant%3Aalpha:temporary%2Fcredential@turn.example.com:5349\",\"turn://tenant:credential@[2001:db8::2]:3478\">",
  ));
  assert.ok(argumentsList.includes("ice-transport-policy=relay"));

  const relayOnly = parseConfiguration(
    {
      FIREBALL_INTERNAL_SIGNALING_SECRET: secret,
      FIREBALL_ICE_SERVERS_FILE: "/run/fireball-secrets/ice-servers.json",
    },
    () => parseIceServerConfiguration(JSON.stringify({
      schema_version: 1,
      turn_servers: [{
        scheme: "turn",
        host: "turn.example.com",
        port: 3478,
        username: "tenant",
        password: "credential",
      }],
      ice_transport_policy: "relay",
    })),
  );
  const relayOnlyArguments = pipelineArguments(relayOnly);
  const stunIndex = relayOnlyArguments.indexOf('stun-server=""');
  assert.notEqual(stunIndex, -1);
  assert.deepEqual(relayOnlyArguments.slice(stunIndex, stunIndex + 3), [
    'stun-server=""',
    'turn-servers=<"turn://tenant:credential@turn.example.com:3478">',
    "ice-transport-policy=relay",
  ]);
});

test("TURN configuration rejects ambiguous, credential-free, duplicate, and unsafe input", () => {
  const valid = {
    schema_version: 1,
    turn_servers: [{
      scheme: "turns",
      host: "turn.example.com",
      port: 5349,
      username: "tenant",
      password: "credential",
    }],
    ice_transport_policy: "all",
  };
  assert.throws(
    () => parseIceServerConfiguration(JSON.stringify({ ...valid, unexpected: true })),
    /unsupported fields/,
  );
  assert.throws(
    () => parseIceServerConfiguration(JSON.stringify({
      ...valid,
      turn_servers: [{ ...valid.turn_servers[0], password: "" }],
    })),
    /password/,
  );
  assert.throws(
    () => parseIceServerConfiguration(JSON.stringify({
      ...valid,
      turn_servers: [valid.turn_servers[0], valid.turn_servers[0]],
    })),
    /unique/,
  );
  assert.throws(
    () => parseIceServerConfiguration(JSON.stringify({ ...valid, ice_transport_policy: "none" })),
    /all or relay/,
  );
  assert.throws(
    () => parseIceServerConfiguration(JSON.stringify({
      ...valid,
      stun_server: { host: "2001:db8::1", port: 70_000 },
    })),
    /between 1 and 65535/,
  );
  assert.throws(
    () => parseIceServerConfiguration(JSON.stringify({
      ...valid,
      turn_servers: [{ ...valid.turn_servers[0], host: "turn.example.com/path" }],
    })),
    /host is invalid/,
  );
  assert.throws(
    () => parseConfiguration({
      FIREBALL_INTERNAL_SIGNALING_SECRET: secret,
      FIREBALL_ICE_SERVERS_FILE: "/tmp/ice-servers.json",
    }),
    /must be \/run\/fireball-secrets/,
  );
});

test("TURN secret file metadata is fail-closed", () => {
  assert.doesNotThrow(() => validateIceServerFileMetadata({
    isFile: true,
    size: 256,
    uid: 0,
    gid: 10001,
    mode: 0o100440,
  }));
  for (const metadata of [
    { isFile: false, size: 256, uid: 0, gid: 10001, mode: 0o100440 },
    { isFile: true, size: 0, uid: 0, gid: 10001, mode: 0o100440 },
    { isFile: true, size: 256, uid: 10001, gid: 10001, mode: 0o100440 },
    { isFile: true, size: 256, uid: 0, gid: 10001, mode: 0o100640 },
    { isFile: true, size: 256, uid: 0, gid: 10001, mode: 0o100444 },
  ]) {
    assert.throws(() => validateIceServerFileMetadata(metadata), /regular file|unsafe size|root:10001/);
  }
});

test("bootstrap authentication is exact, text-only, and constant-length", () => {
  const valid = Buffer.from(JSON.stringify({ type: "authenticate", secret }));
  assert.equal(parseAuthenticationFrame(valid, false, secret), true);
  assert.equal(parseAuthenticationFrame(valid, true, secret), false);
  assert.equal(
    parseAuthenticationFrame(
      Buffer.from(JSON.stringify({ type: "authenticate", secret, extra: true })),
      false,
      secret,
    ),
    false,
  );
  assert.equal(
    parseAuthenticationFrame(Buffer.from(JSON.stringify({ type: "authenticate", secret: "B".repeat(43) })), false, secret),
    false,
  );
});

test("bootstrap secret is removed from the GStreamer child environment", () => {
  const environment = childEnvironment({
    FIREBALL_INTERNAL_SIGNALING_SECRET: secret,
    FIREBALL_ICE_SERVERS_FILE: "/run/fireball-secrets/ice-servers.json",
    FIREBALL_GST_ICE_DIAGNOSTICS: "1",
    GST_DEBUG: "2",
  });
  assert.deepEqual(environment, { GST_DEBUG: "2" });
});

test("ICE diagnostics is an exact opt-in and never reaches the child unchanged", () => {
  const configuration = parseConfiguration({
    FIREBALL_INTERNAL_SIGNALING_SECRET: secret,
    FIREBALL_GST_ICE_DIAGNOSTICS: "1",
  });
  assert.equal(configuration.iceDiagnostics, true);
  assert.throws(
    () => parseConfiguration({
      FIREBALL_INTERNAL_SIGNALING_SECRET: secret,
      FIREBALL_GST_ICE_DIAGNOSTICS: "true",
    }),
    /must be 1/,
  );
});
