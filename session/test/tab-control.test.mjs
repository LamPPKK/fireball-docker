import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import {
  NativeTabDriver,
  TabControlError,
  TabController,
  encodeUrl,
  normalizeTabUrl,
} from "../tab-control.mjs";

const initial = {
  id: "00000000-0000-4000-8000-000000000001",
  url: "file:///usr/share/fireball-session/home.html",
};

test("tab controller creates, activates, navigates, and removes real runtime tabs transactionally", async () => {
  const driver = new RecordingDriver();
  const ids = [
    "00000000-0000-4000-8000-000000000002",
    "00000000-0000-4000-8000-000000000003",
  ];
  const controller = new TabController(driver, initial, {
    now: () => Date.parse("2026-08-21T00:00:00.000Z"),
    uuid: () => ids.shift(),
  });

  assert.deepEqual(controller.list(), [{
    id: initial.id,
    url: "fireball://home",
    createdAt: "2026-08-21T00:00:00.000Z",
    active: true,
  }]);

  const second = await controller.create("https://example.com/path");
  assert.equal(second.id, "00000000-0000-4000-8000-000000000002");
  assert.equal(second.active, true);
  assert.deepEqual(driver.calls[0], ["create", second.id, "https://example.com/path"]);

  const activated = await controller.activate(initial.id);
  assert.equal(activated.active, true);
  assert.deepEqual(driver.calls[1], ["activate", initial.id]);

  const navigated = await controller.navigate(initial.id, "https://example.org/a?q=1");
  assert.equal(navigated.url, "https://example.org/a?q=1");
  assert.deepEqual(driver.calls[2], ["navigate", initial.id, "https://example.org/a?q=1"]);

  await controller.remove(initial.id);
  assert.deepEqual(driver.calls.slice(3), [["remove", initial.id, second.id]]);
  assert.deepEqual(controller.list().map(({ id, active }) => ({ id, active })), [{ id: second.id, active: true }]);
});

test("tab controller keeps state unchanged when a native create fails", async () => {
  const driver = new RecordingDriver();
  driver.failure = new Error("native failure");
  const controller = new TabController(driver, initial, {
    uuid: () => "00000000-0000-4000-8000-000000000002",
  });

  await assert.rejects(controller.create("https://example.com"), /native failure/);
  assert.equal(controller.list().length, 1);
  assert.equal(controller.list()[0].id, initial.id);
});

test("tab controller keeps the active tab unchanged when atomic native deletion fails", async () => {
  const driver = new RecordingDriver();
  const controller = new TabController(driver, initial, {
    uuid: () => "00000000-0000-4000-8000-000000000002",
  });
  const second = await controller.create("https://example.com/");
  await controller.activate(initial.id);
  driver.failure = new Error("native delete failed");

  await assert.rejects(controller.remove(initial.id), /native delete failed/);
  assert.deepEqual(controller.list().map(({ id, active }) => ({ id, active })), [
    { id: initial.id, active: true },
    { id: second.id, active: false },
  ]);
  assert.deepEqual(driver.calls.at(-1), ["remove", initial.id, second.id]);
});

test("tab controller enforces the bounded session and retains one tab", async () => {
  const driver = new RecordingDriver();
  const controller = new TabController(driver, initial, { maximumTabs: 1 });
  await assert.rejects(
    controller.create("https://example.com"),
    (error) => error instanceof TabControlError && error.code === "TAB_LIMIT_REACHED",
  );
  await assert.rejects(
    controller.remove(initial.id),
    (error) => error instanceof TabControlError && error.code === "TAB_MINIMUM_REACHED",
  );
  assert.deepEqual(driver.calls, []);
});

test("tab URL policy accepts only HTTP, HTTPS, and the native home alias", () => {
  assert.equal(normalizeTabUrl("fireball://home"), "file:///usr/share/fireball-session/home.html");
  assert.equal(normalizeTabUrl("https://example.com/a b"), "https://example.com/a%20b");
  assert.equal(
    encodeUrl("https://example.com"),
    Buffer.from("https://example.com/", "utf8").toString("hex"),
  );
  for (const value of [
    "javascript:alert(1)",
    "data:text/html,hello",
    "file:///etc/passwd",
    "https://user:secret@example.com",
    "https://",
  ]) {
    assert.throws(
      () => normalizeTabUrl(value),
      (error) => error instanceof TabControlError && error.code === "TAB_URL_INVALID",
    );
  }
});

test("native protocol driver binds readiness and commands to request IDs", async () => {
  const child = fakeChild();
  const driver = new NativeTabDriver(child, initial.id, { timeoutMilliseconds: 500 });
  child.stdout.write(`READY ${initial.id}\n`);
  await driver.waitUntilReady();

  const operation = driver.create(
    "00000000-0000-4000-8000-000000000002",
    "https://example.com/",
  );
  const command = child.stdin.read().toString("utf8");
  assert.match(command, /^CREATE 1 00000000-0000-4000-8000-000000000002 [0-9a-f]+\n$/);
  child.stdout.write("OK 1\n");
  await operation;

  const deletion = driver.remove(
    "00000000-0000-4000-8000-000000000002",
    initial.id,
  );
  assert.equal(
    child.stdin.read().toString("utf8"),
    `DELETE 2 00000000-0000-4000-8000-000000000002 ${initial.id}\n`,
  );
  child.stdout.write("OK 2\n");
  await deletion;
});

test("native protocol driver fails closed on malformed runtime output", async () => {
  const child = fakeChild();
  const driver = new NativeTabDriver(child, initial.id, { timeoutMilliseconds: 500 });
  child.stdout.write(`READY ${initial.id}\n`);
  await driver.waitUntilReady();
  const operation = driver.activate(initial.id);
  child.stdin.read();
  child.stdout.write("not-a-protocol-frame\n");
  await assert.rejects(
    operation,
    (error) => error instanceof TabControlError && error.code === "TAB_RUNTIME_UNAVAILABLE",
  );
});

class RecordingDriver {
  calls = [];
  failure;

  async create(id, url) {
    this.calls.push(["create", id, url]);
    if (this.failure) throw this.failure;
  }

  async activate(id) {
    this.calls.push(["activate", id]);
    if (this.failure) throw this.failure;
  }

  async navigate(id, url) {
    this.calls.push(["navigate", id, url]);
    if (this.failure) throw this.failure;
  }

  async remove(id, fallbackId) {
    this.calls.push(["remove", id, fallbackId]);
    if (this.failure) throw this.failure;
  }
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stdin = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  return child;
}
