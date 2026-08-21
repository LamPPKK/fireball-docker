import { spawn } from "node:child_process";
import { createServer } from "node:http";

const LISTEN_HOST = "127.0.0.1";
const LISTEN_PORT = 18_080;
const MAX_DOCUMENT_BYTES = 8 * 1024;
const MARKER_PATTERN = /^[a-z]+-[a-f0-9]{24}$/;
const SUPERVISOR = "/opt/fireball-session/supervisor.mjs";

let command = Object.freeze({ sequence: 0, action: "observe" });
let report;

const page = Buffer.from(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Fireball browser state gate</title>
  </head>
  <body>
    <main id="status">Running browser-state isolation gate…</main>
    <script>
      "use strict";
      const cookieName = "fireball_state_marker";
      const storageName = "fireball.state.marker";
      let handledSequence = -1;

      const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

      async function workerMarker(registration) {
        const worker = registration?.active;
        if (!worker) return "";
        return await new Promise((resolve, reject) => {
          const channel = new MessageChannel();
          const timer = setTimeout(() => reject(new Error("service worker marker timed out")), 3000);
          channel.port1.onmessage = (event) => {
            clearTimeout(timer);
            resolve(typeof event.data?.marker === "string" ? event.data.marker : "");
          };
          worker.postMessage({ type: "fireball-state-marker" }, [channel.port2]);
        });
      }

      async function snapshot(sequence) {
        const cookies = Object.fromEntries(document.cookie.split(";").map((entry) => {
          const separator = entry.indexOf("=");
          return separator < 0
            ? [entry.trim(), ""]
            : [entry.slice(0, separator).trim(), decodeURIComponent(entry.slice(separator + 1))];
        }).filter(([name]) => name));
        const supported = "serviceWorker" in navigator;
        const registration = supported ? await navigator.serviceWorker.getRegistration("/") : undefined;
        return {
          schemaVersion: 1,
          sequence,
          cookieMarker: cookies[cookieName] ?? "",
          localStorageMarker: localStorage.getItem(storageName) ?? "",
          serviceWorkerSupported: supported,
          serviceWorkerRegistered: Boolean(registration),
          serviceWorkerMarker: await workerMarker(registration),
          error: "",
        };
      }

      async function seed(marker) {
        document.cookie = cookieName + "=" + encodeURIComponent(marker) + "; Path=/; SameSite=Strict";
        localStorage.setItem(storageName, marker);
        const registration = await navigator.serviceWorker.register(
          "/state-worker.js?marker=" + encodeURIComponent(marker),
          { scope: "/" },
        );
        if (!registration.active) await navigator.serviceWorker.ready;
      }

      async function publish(document) {
        await fetch("/report", {
          method: "POST",
          cache: "no-store",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(document),
        });
        window.__fireballBrowserState = document;
      }

      async function execute(next) {
        if (next.action === "seed") await seed(next.marker);
        await publish(await snapshot(next.sequence));
      }

      async function loop() {
        for (;;) {
          try {
            const next = await fetch("/command", { cache: "no-store" }).then((response) => response.json());
            if (next.sequence > handledSequence) {
              handledSequence = next.sequence;
              try {
                await execute(next);
              } catch (error) {
                await publish({
                  schemaVersion: 1,
                  sequence: next.sequence,
                  cookieMarker: "",
                  localStorageMarker: "",
                  serviceWorkerSupported: "serviceWorker" in navigator,
                  serviceWorkerRegistered: false,
                  serviceWorkerMarker: "",
                  error: error instanceof Error ? error.message.slice(0, 256) : "unknown browser error",
                });
              }
            }
          } catch {
            // A transient local request failure is retried; the outer gate has a hard deadline.
          }
          await delay(200);
        }
      }
      void loop();
    </script>
  </body>
</html>`, "utf8");

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "", `http://${LISTEN_HOST}:${LISTEN_PORT}`);
    if (request.method === "GET" && url.pathname === "/") {
      respond(response, 200, "text/html; charset=utf-8", page, {
        "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; worker-src 'self';",
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/state-worker.js") {
      const marker = url.searchParams.get("marker") ?? "";
      if (!MARKER_PATTERN.test(marker)) throw new RequestError(400, "invalid worker marker");
      const source = Buffer.from(
        `"use strict";const marker=${JSON.stringify(marker)};self.addEventListener("message",(event)=>{if(event.data?.type==="fireball-state-marker"&&event.ports[0])event.ports[0].postMessage({marker});});`,
        "utf8",
      );
      respond(response, 200, "text/javascript; charset=utf-8", source, {
        "service-worker-allowed": "/",
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/command") {
      respondJson(response, 200, command);
      return;
    }
    if (request.method === "POST" && url.pathname === "/command") {
      const nextCommand = validateCommand(await readJson(request));
      if (nextCommand.sequence <= command.sequence) throw new RequestError(409, "command sequence must advance");
      command = nextCommand;
      report = undefined;
      respondJson(response, 200, command);
      return;
    }
    if (request.method === "GET" && url.pathname === "/report") {
      if (report === undefined) throw new RequestError(404, "report unavailable");
      respondJson(response, 200, report);
      return;
    }
    if (request.method === "POST" && url.pathname === "/report") {
      const nextReport = validateReport(await readJson(request));
      if (nextReport.sequence !== command.sequence) throw new RequestError(409, "report sequence is stale");
      report = nextReport;
      response.writeHead(204, securityHeaders());
      response.end();
      return;
    }
    throw new RequestError(404, "not found");
  } catch (error) {
    const status = error instanceof RequestError ? error.status : 500;
    const message = error instanceof Error ? error.message : "request failed";
    respond(response, status, "text/plain; charset=utf-8", Buffer.from(`${message}\n`, "utf8"));
  }
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(LISTEN_PORT, LISTEN_HOST, () => {
    server.off("error", reject);
    resolve();
  });
});

const supervisor = spawn(process.execPath, [SUPERVISOR], {
  env: process.env,
  stdio: ["ignore", "inherit", "inherit"],
});

let shuttingDown = false;
const shutdown = (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  if (supervisor.exitCode === null && supervisor.signalCode === null) supervisor.kill(signal);
  server.close();
};
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
supervisor.once("error", (error) => {
  process.stderr.write(`fireball browser-state fixture failed to start supervisor: ${error.message}\n`);
  shutdown("SIGKILL");
  process.exitCode = 1;
});
supervisor.once("exit", (code, signal) => {
  server.close();
  process.exitCode = code ?? (signal ? 1 : 0);
});

function validateCommand(value) {
  if (!isRecord(value) || !Number.isSafeInteger(value.sequence) || value.sequence < 0) {
    throw new RequestError(400, "invalid command sequence");
  }
  if (value.action === "observe" && Object.keys(value).sort().join(",") === "action,sequence") {
    return Object.freeze({ sequence: value.sequence, action: "observe" });
  }
  if (
    value.action === "seed"
    && Object.keys(value).sort().join(",") === "action,marker,sequence"
    && typeof value.marker === "string"
    && MARKER_PATTERN.test(value.marker)
  ) {
    return Object.freeze({ sequence: value.sequence, action: "seed", marker: value.marker });
  }
  throw new RequestError(400, "invalid browser-state command");
}

function validateReport(value) {
  const keys = [
    "cookieMarker",
    "error",
    "localStorageMarker",
    "schemaVersion",
    "sequence",
    "serviceWorkerMarker",
    "serviceWorkerRegistered",
    "serviceWorkerSupported",
  ];
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== keys.sort().join(",")) {
    throw new RequestError(400, "invalid browser-state report shape");
  }
  if (
    value.schemaVersion !== 1
    || !Number.isSafeInteger(value.sequence)
    || value.sequence < 0
    || typeof value.cookieMarker !== "string"
    || typeof value.localStorageMarker !== "string"
    || typeof value.serviceWorkerMarker !== "string"
    || typeof value.serviceWorkerSupported !== "boolean"
    || typeof value.serviceWorkerRegistered !== "boolean"
    || typeof value.error !== "string"
    || value.error.length > 256
  ) {
    throw new RequestError(400, "invalid browser-state report values");
  }
  for (const marker of [value.cookieMarker, value.localStorageMarker, value.serviceWorkerMarker]) {
    if (marker !== "" && !MARKER_PATTERN.test(marker)) {
      throw new RequestError(400, "invalid browser-state report marker");
    }
  }
  return Object.freeze({ ...value });
}

async function readJson(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_DOCUMENT_BYTES) throw new RequestError(413, "request body too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
  } catch {
    throw new RequestError(400, "request body must be valid JSON");
  }
}

function respondJson(response, status, value) {
  respond(response, status, "application/json; charset=utf-8", Buffer.from(JSON.stringify(value), "utf8"));
}

function respond(response, status, contentType, body, extraHeaders = {}) {
  response.writeHead(status, {
    ...securityHeaders(),
    ...extraHeaders,
    "content-length": body.byteLength,
    "content-type": contentType,
  });
  response.end(body);
}

function securityHeaders() {
  return {
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  };
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
