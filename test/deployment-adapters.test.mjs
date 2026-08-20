import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { renderNginxConfig } from "../scripts/render-nginx-config.mjs";
import { installNginxConfig } from "../scripts/install-nginx-config.mjs";
import { parseIceServerConfiguration } from "../session/supervisor.mjs";

const environment = {
  FIREBALL_PUBLIC_HOST: "browser.example.com",
  FIREBALL_TLS_CERTIFICATE: "/etc/fireball/tls/fullchain.pem",
  FIREBALL_TLS_CERTIFICATE_KEY: "/etc/fireball/tls/privkey.pem",
  FIREBALL_UPSTREAM_PORT: "8787",
};

test("nginx adapter terminates TLS and forwards signaling upgrades to loopback", () => {
  const output = renderNginxConfig(environment);
  assert.match(output, /listen 443 ssl http2;/);
  assert.match(output, /server_name browser\.example\.com;/);
  assert.match(output, /server 127\.0\.0\.1:8787;/);
  assert.match(output, /location = \/orchestrator\/v1\/signaling/);
  assert.match(output, /proxy_set_header Upgrade \$http_upgrade;/);
  assert.match(output, /proxy_set_header Connection \$fireball_connection_upgrade;/);
  assert.match(output, /proxy_buffering off;/);
  assert.match(output, /limit_req zone=fireball_api/);
  assert.match(output, /limit_conn fireball_websocket 4;/);
  assert.doesNotMatch(output, /\{\{[A-Z_]+\}\}/);
  assert.doesNotMatch(output, /0\.0\.0\.0:8787|Authorization \S+|password/i);
});

test("nginx adapter rejects configuration injection and ambiguous TLS paths", () => {
  for (const invalidEnvironment of [
    { ...environment, FIREBALL_PUBLIC_HOST: "browser.example.com; return 200" },
    { ...environment, FIREBALL_PUBLIC_HOST: "LOCALHOST" },
    { ...environment, FIREBALL_TLS_CERTIFICATE: "relative/fullchain.pem" },
    { ...environment, FIREBALL_TLS_CERTIFICATE_KEY: "/etc/fireball/../secret.pem" },
    { ...environment, FIREBALL_TLS_CERTIFICATE_KEY: environment.FIREBALL_TLS_CERTIFICATE },
    { ...environment, FIREBALL_UPSTREAM_PORT: "70000" },
  ]) {
    assert.throws(() => renderNginxConfig(invalidEnvironment), /hostname|required|unsafe|differ|TCP port/);
  }
});

test("nginx installer atomically promotes a checked candidate", () => {
  const directory = mkdtempSync(join(tmpdir(), "fireball-nginx-success-"));
  const candidate = join(directory, "candidate.conf");
  const target = join(directory, "fireball.conf");
  writeFileSync(candidate, "new configuration\n", { mode: 0o600 });
  writeFileSync(target, "old configuration\n", { mode: 0o644 });
  const calls = [];

  const result = installNginxConfig({
    candidatePath: candidate,
    targetPath: target,
    execute: (command, args) => calls.push([command, ...args]),
  });

  assert.deepEqual(result, { target, replaced: true });
  assert.equal(readFileSync(target, "utf8"), "new configuration\n");
  assert.deepEqual(calls, [
    ["nginx", "-t"],
    ["systemctl", "reload", "nginx"],
    ["systemctl", "is-active", "--quiet", "nginx"],
  ]);
});

test("nginx installer restores the previous config when validation or reload fails", () => {
  for (const failingCall of [1, 2, 3]) {
    const directory = mkdtempSync(join(tmpdir(), `fireball-nginx-rollback-${failingCall}-`));
    const candidate = join(directory, "candidate.conf");
    const target = join(directory, "fireball.conf");
    writeFileSync(candidate, "bad configuration\n");
    writeFileSync(target, "known good configuration\n");
    let call = 0;

    assert.throws(
      () => installNginxConfig({
        candidatePath: candidate,
        targetPath: target,
        execute: () => {
          call += 1;
          if (call === failingCall) throw new Error("simulated deployment failure");
        },
      }),
      /nginx target restored to its previous state/,
    );
    assert.equal(readFileSync(target, "utf8"), "known good configuration\n");
    assert.equal(call, failingCall + 3);
  }
});

test("nginx installer removes a new target when its first validation fails", () => {
  const directory = mkdtempSync(join(tmpdir(), "fireball-nginx-new-target-"));
  const candidate = join(directory, "candidate.conf");
  const target = join(directory, "fireball.conf");
  writeFileSync(candidate, "invalid new configuration\n");
  let call = 0;

  assert.throws(
    () => installNginxConfig({
      candidatePath: candidate,
      targetPath: target,
      execute: () => {
        call += 1;
        if (call === 1) throw new Error("simulated validation failure");
      },
    }),
    /nginx target restored to its previous state/,
  );
  assert.equal(existsSync(target), false);
});

test("nginx installer preserves its backup when rollback validation fails", () => {
  const directory = mkdtempSync(join(tmpdir(), "fireball-nginx-incomplete-"));
  const candidate = join(directory, "candidate.conf");
  const target = join(directory, "fireball.conf");
  writeFileSync(candidate, "bad configuration\n");
  writeFileSync(target, "known good configuration\n");
  let call = 0;

  assert.throws(
    () => installNginxConfig({
      candidatePath: candidate,
      targetPath: target,
      execute: () => {
        call += 1;
        if (call === 2) throw new Error("simulated reload failure");
        if (call === 3) throw new Error("simulated rollback validation failure");
      },
    }),
    (error) => {
      assert.match(error.message, /nginx rollback incomplete/);
      const recoveryPath = error.message.match(/recovery files kept at (.+)$/)?.[1];
      assert.ok(recoveryPath);
      assert.equal(readFileSync(join(recoveryPath, "previous"), "utf8"), "known good configuration\n");
      rmSync(recoveryPath, { recursive: true, force: true });
      return true;
    },
  );
  assert.equal(readFileSync(target, "utf8"), "known good configuration\n");
});

test("nginx installer serializes deployments for the same target", () => {
  const directory = mkdtempSync(join(tmpdir(), "fireball-nginx-lock-"));
  const candidate = join(directory, "candidate.conf");
  const target = join(directory, "fireball.conf");
  writeFileSync(candidate, "new configuration\n");
  mkdirSync(`${target}.lock`, { mode: 0o700 });

  assert.throws(
    () => installNginxConfig({ candidatePath: candidate, targetPath: target, execute: () => {} }),
    /deployment already in progress/,
  );
  rmSync(`${target}.lock`, { recursive: true, force: true });
});

test("TURN deployment schema and example are versioned and secret-free placeholders", () => {
  const schema = JSON.parse(readFileSync(
    new URL("../deploy/turn/ice-servers.schema.json", import.meta.url),
    "utf8",
  ));
  const example = JSON.parse(readFileSync(
    new URL("../deploy/turn/ice-servers.json.example", import.meta.url),
    "utf8",
  ));
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["schema_version", "turn_servers", "ice_transport_policy"]);
  assert.equal(example.schema_version, 1);
  assert.equal(example.ice_transport_policy, "relay");
  assert.equal(example.turn_servers[0].username, "TURN_USER");
  assert.equal(example.turn_servers[0].password, "TURN_PASSWORD");
  assert.doesNotThrow(() => parseIceServerConfiguration(JSON.stringify(example)));
});

test("JSON Schema and runtime parser agree on canonical ICE corpus", () => {
  const schema = JSON.parse(readFileSync(
    new URL("../deploy/turn/ice-servers.schema.json", import.meta.url),
    "utf8",
  ));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validateSchema = ajv.compile(schema);
  const base = {
    schema_version: 1,
    turn_servers: [{
      scheme: "turns",
      host: "turn.example.com",
      port: 5349,
      username: "1700000000:tenant",
      password: "temporary/credential",
    }],
    ice_transport_policy: "relay",
  };
  const corpus = [
    { accepted: true, value: base },
    {
      accepted: true,
      value: {
        ...base,
        stun_server: { host: "2001:db8::1", port: 3478 },
        turn_servers: [{ ...base.turn_servers[0], host: "2001:db8::2" }],
      },
    },
    {
      accepted: false,
      value: {
        ...base,
        turn_servers: [{ ...base.turn_servers[0], host: "2001:DB8::1" }],
      },
    },
    {
      accepted: false,
      value: {
        ...base,
        turn_servers: [
          { ...base.turn_servers[0], host: "2001:DB8::1" },
          { ...base.turn_servers[0], host: "2001:db8::1" },
        ],
      },
    },
    { accepted: false, value: { ...base, unexpected: true } },
    { accepted: false, value: { ...base, turn_servers: [{ ...base.turn_servers[0], port: 70_000 }] } },
    { accepted: false, value: { ...base, stun_server: { host: "bad host", port: 3478 } } },
    { accepted: false, value: { ...base, turn_servers: [{ ...base.turn_servers[0], host: "turn.example.com/path" }] } },
    { accepted: false, value: { ...base, turn_servers: [{ ...base.turn_servers[0], password: "line\nbreak" }] } },
    { accepted: false, value: { ...base, turn_servers: [{ ...base.turn_servers[0], extra: true }] } },
  ];
  for (const fixture of corpus) {
    const schemaAccepted = validateSchema(fixture.value);
    let runtimeAccepted = true;
    try {
      parseIceServerConfiguration(JSON.stringify(fixture.value));
    } catch {
      runtimeAccepted = false;
    }
    assert.equal(schemaAccepted, fixture.accepted, JSON.stringify(validateSchema.errors));
    assert.equal(runtimeAccepted, fixture.accepted, JSON.stringify(fixture.value));
  }
});
