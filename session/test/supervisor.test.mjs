import assert from "node:assert/strict";
import { test } from "node:test";

import {
  childEnvironment,
  parseAuthenticationFrame,
  parseConfiguration,
  pipelineArguments,
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
  assert.match(command, /enable-control-data-channel=true/);
  assert.match(command, /run-web-server=false/);
  assert.match(command, /signalling-server-host=127\.0\.0\.1/);
  assert.match(command, /stun-server=(?: |$)/);
  assert.doesNotMatch(command, /stun\.l\.google\.com/);
  assert.doesNotMatch(command, new RegExp(secret));
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
    GST_DEBUG: "2",
  });
  assert.deepEqual(environment, { GST_DEBUG: "2" });
});
