import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

const INTERNAL_HOME = "file:///usr/share/fireball-session/home.html";
const PUBLIC_HOME = "fireball://home";
const MAXIMUM_URL_BYTES = 4_096;

export class TabControlError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TabControlError";
    this.code = code;
  }
}

export class TabController {
  #operation = Promise.resolve();

  constructor(driver, initialTab, { maximumTabs = 4, now = Date.now, uuid = randomUUID } = {}) {
    if (!Number.isSafeInteger(maximumTabs) || maximumTabs < 1 || maximumTabs > 8) {
      throw new Error("maximum tabs must be between 1 and 8");
    }
    this.driver = driver;
    this.maximumTabs = maximumTabs;
    this.now = now;
    this.uuid = uuid;
    this.tabs = new Map([[initialTab.id, Object.freeze({
      id: initialTab.id,
      url: publicTabUrl(initialTab.url),
      createdAt: new Date(now()).toISOString(),
    })]]);
    this.activeTabId = initialTab.id;
  }

  list() {
    return [...this.tabs.values()].map((tab) => ({ ...tab, active: tab.id === this.activeTabId }));
  }

  create(url = PUBLIC_HOME) {
    return this.#serialize(async () => {
      if (this.tabs.size >= this.maximumTabs) {
        throw new TabControlError("TAB_LIMIT_REACHED", "session tab limit reached");
      }
      const runtimeUrl = normalizeTabUrl(url);
      const id = this.uuid();
      await this.driver.create(id, runtimeUrl);
      const tab = Object.freeze({
        id,
        url: publicTabUrl(runtimeUrl),
        createdAt: new Date(this.now()).toISOString(),
      });
      this.tabs.set(id, tab);
      this.activeTabId = id;
      return { ...tab, active: true };
    });
  }

  activate(id) {
    return this.#serialize(async () => {
      const tab = this.#tab(id);
      if (id !== this.activeTabId) {
        await this.driver.activate(id);
        this.activeTabId = id;
      }
      return { ...tab, active: true };
    });
  }

  navigate(id, url) {
    return this.#serialize(async () => {
      const previous = this.#tab(id);
      const runtimeUrl = normalizeTabUrl(url);
      await this.driver.navigate(id, runtimeUrl);
      const tab = Object.freeze({ ...previous, url: publicTabUrl(runtimeUrl) });
      this.tabs.set(id, tab);
      return { ...tab, active: id === this.activeTabId };
    });
  }

  remove(id) {
    return this.#serialize(async () => {
      this.#tab(id);
      if (this.tabs.size === 1) {
        throw new TabControlError("TAB_MINIMUM_REACHED", "a session must retain one tab");
      }
      const fallback = id === this.activeTabId
        ? [...this.tabs.keys()].find((candidate) => candidate !== id)
        : this.activeTabId;
      await this.driver.remove(id, fallback);
      if (id === this.activeTabId) this.activeTabId = fallback;
      this.tabs.delete(id);
    });
  }

  #tab(id) {
    const tab = this.tabs.get(id);
    if (!tab) throw new TabControlError("TAB_NOT_FOUND", "tab not found");
    return tab;
  }

  #serialize(operation) {
    const result = this.#operation.then(operation, operation);
    this.#operation = result.catch(() => {});
    return result;
  }
}

export class NativeTabDriver {
  constructor(child, expectedInitialTabId, {
    controlOutput = child.stdout,
    timeoutMilliseconds = 5_000,
  } = {}) {
    this.child = child;
    this.expectedInitialTabId = expectedInitialTabId;
    this.timeoutMilliseconds = timeoutMilliseconds;
    this.pending = new Map();
    this.nextRequest = 1;
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    if (!controlOutput) throw new Error("native tab runtime control output is unavailable");
    this.lines = createInterface({ input: controlOutput, crlfDelay: Infinity });
    this.lines.on("line", (line) => this.#handleLine(line));
    child.once("error", (error) => this.#fail(error));
    child.once("exit", (code, signal) => this.#fail(new Error(
      `native tab runtime exited (${code ?? signal ?? "unknown"})`,
    )));
  }

  async waitUntilReady() {
    const timer = setTimeout(
      () => this.rejectReady(new Error("native tab runtime readiness timed out")),
      this.timeoutMilliseconds,
    );
    timer.unref();
    try {
      await this.ready;
    } finally {
      clearTimeout(timer);
    }
  }

  create(id, url) {
    return this.#command("CREATE", id, encodeUrl(url));
  }

  activate(id) {
    return this.#command("ACTIVATE", id);
  }

  navigate(id, url) {
    return this.#command("NAVIGATE", id, encodeUrl(url));
  }

  remove(id, fallbackId) {
    return this.#command("DELETE", id, fallbackId);
  }

  shutdown() {
    if (!this.child.stdin.destroyed) this.child.stdin.end("SHUTDOWN 1\n");
  }

  #command(type, ...arguments_) {
    if (this.child.exitCode !== null || this.child.signalCode !== null || this.child.stdin.destroyed) {
      return Promise.reject(new TabControlError("TAB_RUNTIME_UNAVAILABLE", "tab runtime is unavailable"));
    }
    const request = String(this.nextRequest++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request);
        reject(new TabControlError("TAB_RUNTIME_UNAVAILABLE", "tab runtime command timed out"));
      }, this.timeoutMilliseconds);
      timer.unref();
      this.pending.set(request, { resolve, reject, timer });
      this.child.stdin.write(`${type} ${request} ${arguments_.join(" ")}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(request);
        reject(new TabControlError("TAB_RUNTIME_UNAVAILABLE", "tab runtime command failed"));
      });
    });
  }

  #handleLine(line) {
    const ready = /^READY ([0-9a-f-]{36})$/.exec(line);
    if (ready) {
      if (ready[1] === this.expectedInitialTabId) this.resolveReady();
      else this.rejectReady(new Error("native tab runtime returned an unexpected initial tab"));
      return;
    }
    const response = /^(OK|ERR) ([1-9][0-9]{0,15})(?: ([A-Z_]{3,64}))?$/.exec(line);
    if (!response) {
      this.#fail(new Error("native tab runtime returned malformed output"));
      return;
    }
    const pending = this.pending.get(response[2]);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(response[2]);
    if (response[1] === "OK") pending.resolve();
    else pending.reject(new TabControlError("TAB_RUNTIME_FAILURE", "tab runtime rejected the operation"));
  }

  #fail(error) {
    this.rejectReady(error);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new TabControlError("TAB_RUNTIME_UNAVAILABLE", "tab runtime is unavailable"));
    }
    this.pending.clear();
    if (typeof this.child.kill === "function" && this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill("SIGTERM");
    }
  }
}

export function normalizeTabUrl(value) {
  if (value === undefined || value === PUBLIC_HOME || value === INTERNAL_HOME) return INTERNAL_HOME;
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAXIMUM_URL_BYTES) {
    throw new TabControlError("TAB_URL_INVALID", "tab URL is invalid");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TabControlError("TAB_URL_INVALID", "tab URL is invalid");
  }
  if (
    !["http:", "https:"].includes(parsed.protocol)
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.hostname === ""
  ) {
    throw new TabControlError("TAB_URL_INVALID", "tab URL is invalid");
  }
  return parsed.href;
}

export function encodeUrl(url) {
  return Buffer.from(normalizeTabUrl(url), "utf8").toString("hex");
}

function publicTabUrl(url) {
  return url === INTERNAL_HOME ? PUBLIC_HOME : url;
}
