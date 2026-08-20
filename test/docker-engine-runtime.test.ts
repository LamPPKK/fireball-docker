import assert from "node:assert/strict";
import { test } from "node:test";

import { OrchestratorError } from "../src/domain/errors.js";
import { DockerEngineRuntime } from "../src/runtime/docker-engine-runtime.js";
import type {
  DockerEngineRequest,
  DockerEngineTransport,
} from "../src/runtime/docker-engine-transport.js";

const request = {
  sessionId: "d34c2e46-ff85-45f1-b3c4-28dbb1993ed7",
  tenantId: "alpha",
  quota: { memoryMiB: 512, cpuShares: 512, pids: 128 },
} as const;

test("Docker runtime applies the tenant isolation contract", async () => {
  const transport = new RecordingTransport([{}, { Id: "container-1" }, {}, signalingInspect("49152")]);
  const runtime = makeRuntime(transport);

  const resource = await runtime.create(request);

  assert.equal(resource.containerId, "container-1");
  assert.deepEqual(transport.calls.map((call) => call.acceptedStatusCodes), [[201], [201], [204], [200]]);
  const createNetwork = transport.calls[0];
  assert.ok(createNetwork);
  const networkBody = createNetwork.body as { Labels: Record<string, string> };
  assert.equal(networkBody.Labels["dev.fireball.instance"], "test-instance");
  const createContainer = transport.calls[1];
  assert.ok(createContainer);
  const body = createContainer.body as {
    Labels: Record<string, string>;
    Env: string[];
    ExposedPorts: Record<string, unknown>;
    HostConfig: {
      ReadonlyRootfs: boolean;
      CapDrop: string[];
      SecurityOpt: string[];
      Memory: number;
      PidsLimit: number;
      NetworkMode: string;
      Tmpfs: Record<string, string>;
      Mounts: Array<{
        Type: string;
        Source: string;
        Target: string;
        ReadOnly: boolean;
        BindOptions: { Propagation: string };
      }>;
      PortBindings: Record<string, Array<{ HostIp: string; HostPort: string }>>;
    };
  };
  assert.equal(body.Labels["dev.fireball.tenant"], "alpha");
  assert.equal(body.Labels["dev.fireball.instance"], "test-instance");
  assert.equal(body.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(body.HostConfig.CapDrop, ["ALL"]);
  assert.deepEqual(body.HostConfig.SecurityOpt, [
    "no-new-privileges:true",
    "apparmor=fireball-session",
  ]);
  assert.equal(body.HostConfig.Memory, 512 * 1024 * 1024);
  assert.equal(body.HostConfig.PidsLimit, 128);
  assert.equal(body.HostConfig.NetworkMode, `fireball-net-${request.sessionId}`);
  assert.match(body.HostConfig.Tmpfs["/run/fireball-session"] ?? "", /noexec,nosuid,nodev/);
  assert.match(body.HostConfig.Tmpfs["/run/fireball-session"] ?? "", /uid=10001,gid=10001/);
  assert.deepEqual(body.HostConfig.Mounts, []);
  assert.deepEqual(body.ExposedPorts, { "8444/tcp": {} });
  assert.deepEqual(body.HostConfig.PortBindings["8444/tcp"], [{ HostIp: "127.0.0.1", HostPort: "" }]);
  assert.match(resource.signalingSecret, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(body.Env.includes(`FIREBALL_INTERNAL_SIGNALING_SECRET=${resource.signalingSecret}`));
  assert.equal(resource.signalingEndpoint, "ws://127.0.0.1:49152/internal/v1/signaling");
});

test("Docker runtime bind-mounts TURN credentials read-only without exposing them in Env", async () => {
  const transport = new RecordingTransport([{}, { Id: "container-1" }, {}, signalingInspect("49152")]);
  const runtime = makeRuntime(transport, { iceServersFile: "/etc/fireball/ice-servers.json" });

  await runtime.create(request);

  const createContainer = transport.calls[1];
  assert.ok(createContainer);
  const body = createContainer.body as {
    Env: string[];
    HostConfig: { Mounts: unknown[] };
  };
  assert.deepEqual(body.Env.filter((entry) => entry.startsWith("FIREBALL_ICE")), [
    "FIREBALL_ICE_SERVERS_FILE=/run/fireball-secrets/ice-servers.json",
  ]);
  assert.equal(body.Env.some((entry) => entry.includes("turn:") || entry.includes("turns:")), false);
  assert.deepEqual(body.HostConfig.Mounts, [{
    Type: "bind",
    Source: "/etc/fireball/ice-servers.json",
    Target: "/run/fireball-secrets/ice-servers.json",
    ReadOnly: true,
    BindOptions: { Propagation: "rprivate" },
  }]);
});

test("Docker runtime rejects relative TURN secret paths", () => {
  const transport = new RecordingTransport([]);
  for (const iceServersFile of [
    "secrets/ice-servers.json",
    "/etc/fireball/../shadow",
    "/etc/fireball/ice servers.json",
    "/etc/fireball/ice-servers.json\n",
  ]) {
    assert.throws(
      () => makeRuntime(transport, { iceServersFile }),
      /absolute host path/,
    );
  }
});

test("Docker runtime removes both container and network when start fails", async () => {
  const transport = new RecordingTransport([
    {},
    { Id: "container-1" },
    new Error("simulated start failure"),
    {},
    {},
  ]);
  const runtime = makeRuntime(transport);

  await assert.rejects(
    runtime.create(request),
    (error: unknown) => error instanceof OrchestratorError && error.code === "RUNTIME_FAILURE",
  );

  assert.deepEqual(
    transport.calls.map((call) => `${call.method} ${call.path}`),
    [
      `POST /v1.47/networks/create`,
      `POST /v1.47/containers/create?name=fireball-${request.sessionId}`,
      `POST /v1.47/containers/container-1/start`,
      `DELETE /v1.47/containers/container-1?force=true&v=true`,
      `DELETE /v1.47/networks/fireball-net-${request.sessionId}`,
    ],
  );
  assert.deepEqual(transport.calls[3]?.acceptedStatusCodes, [204, 404]);
  assert.deepEqual(transport.calls[4]?.acceptedStatusCodes, [204, 404]);
});

test("Docker runtime waits for a healthy session image before exposing the session", async () => {
  const transport = new RecordingTransport([
    {},
    { Id: "container-1" },
    {},
    signalingInspect("49152", "starting"),
    signalingInspect("49152", "healthy"),
  ]);
  const runtime = makeRuntime(transport);

  const resource = await runtime.create(request);

  assert.equal(resource.signalingEndpoint, "ws://127.0.0.1:49152/internal/v1/signaling");
  assert.equal(transport.calls.filter((call) => call.method === "GET").length, 2);
});

test("Docker runtime rolls back an unhealthy session image", async () => {
  const transport = new RecordingTransport([
    {},
    { Id: "container-1" },
    {},
    signalingInspect("49152", "unhealthy"),
    {},
    {},
  ]);
  const runtime = makeRuntime(transport);

  await assert.rejects(
    runtime.create(request),
    (error: unknown) => error instanceof OrchestratorError
      && error.code === "RUNTIME_FAILURE"
      && error.message.includes("health check"),
  );
  assert.deepEqual(
    transport.calls.slice(-2).map((call) => call.method),
    ["DELETE", "DELETE"],
  );
});

test("Docker runtime rolls back when signaling is not published on loopback", async () => {
  const transport = new RecordingTransport([
    {},
    { Id: "container-1" },
    {},
    {
      State: { Health: { Status: "healthy" } },
      NetworkSettings: {
        Ports: { "8444/tcp": [{ HostIp: "0.0.0.0", HostPort: "49152" }] },
      },
    },
    {},
    {},
  ]);
  const runtime = makeRuntime(transport);

  await assert.rejects(
    runtime.create(request),
    (error: unknown) => error instanceof OrchestratorError && error.code === "RUNTIME_FAILURE",
  );

  assert.deepEqual(
    transport.calls.slice(-2).map((call) => `${call.method} ${call.path}`),
    [
      "DELETE /v1.47/containers/container-1?force=true&v=true",
      `DELETE /v1.47/networks/fireball-net-${request.sessionId}`,
    ],
  );
});

test("Docker runtime rolls back by container name when create omits its id", async () => {
  const transport = new RecordingTransport([{}, {}, {}, {}]);
  const runtime = makeRuntime(transport);

  await assert.rejects(runtime.create(request), /Docker did not return a container id/);

  assert.equal(
    transport.calls[2]?.path,
    `/v1.47/containers/fireball-${request.sessionId}?force=true&v=true`,
  );
  assert.equal(transport.calls[3]?.path, `/v1.47/networks/fireball-net-${request.sessionId}`);
});

test("Docker runtime cleanup is idempotent when resources are already absent", async () => {
  const transport = new RecordingTransport([{}, {}]);
  const runtime = makeRuntime(transport);

  await runtime.destroy({
    containerId: "missing-container",
    containerName: "fireball-missing",
    networkNamespace: "missing-network",
    storageNamespace: "missing-storage",
    signalingEndpoint: "ws://127.0.0.1:49152/internal/v1/signaling",
    signalingSecret: "A".repeat(43),
  });

  assert.deepEqual(transport.calls[0]?.acceptedStatusCodes, [204, 404]);
  assert.deepEqual(transport.calls[1]?.acceptedStatusCodes, [204, 404]);
});

test("startup reconciliation removes only resources owned by this orchestrator instance", async () => {
  const transport = new RecordingTransport([
    [
      { Id: "owned-container", Labels: ownershipLabels("test-instance") },
      { Id: "foreign-container", Labels: ownershipLabels("another-instance") },
      { Id: "unsafe/container", Labels: ownershipLabels("test-instance") },
    ],
    {},
    [
      { Id: "owned-network", Labels: ownershipLabels("test-instance") },
      { Id: "foreign-network", Labels: ownershipLabels("another-instance") },
    ],
    {},
  ]);
  const runtime = makeRuntime(transport);

  const result = await runtime.reconcile();

  assert.deepEqual(result, { containersRemoved: 1, networksRemoved: 1 });
  assert.deepEqual(
    transport.calls.map((call) => `${call.method} ${call.path}`),
    [
      `GET /v1.47/containers/json?all=true&filters=${ownershipFilter("test-instance")}`,
      "DELETE /v1.47/containers/owned-container?force=true&v=true",
      `GET /v1.47/networks?filters=${ownershipFilter("test-instance")}`,
      "DELETE /v1.47/networks/owned-network",
    ],
  );
});

test("startup reconciliation attempts every cleanup and reports aggregate failure", async () => {
  const transport = new RecordingTransport([
    [
      { Id: "container-one", Labels: ownershipLabels("test-instance") },
      { Id: "container-two", Labels: ownershipLabels("test-instance") },
    ],
    new Error("container one failed"),
    {},
    [{ Id: "network-one", Labels: ownershipLabels("test-instance") }],
    new Error("network one failed"),
  ]);
  const runtime = makeRuntime(transport);

  await assert.rejects(
    runtime.reconcile(),
    (error: unknown) => error instanceof OrchestratorError
      && error.code === "RUNTIME_FAILURE"
      && error.message.includes("container one failed")
      && error.message.includes("network one failed"),
  );
  assert.equal(transport.calls.length, 5);
});

test("startup reconciliation fails closed on an invalid Docker list response", async () => {
  const runtime = makeRuntime(new RecordingTransport([null]));

  await assert.rejects(
    runtime.reconcile(),
    (error: unknown) => error instanceof OrchestratorError
      && error.code === "RUNTIME_FAILURE"
      && error.message.includes("invalid container list"),
  );
});

function makeRuntime(
  transport: DockerEngineTransport,
  overrides: { readonly iceServersFile?: string } = {},
): DockerEngineRuntime {
  return new DockerEngineRuntime(
    {
      socketPath: "/var/run/docker.sock",
      apiVersion: "1.47",
      image: "fireball/session-wpe:test",
      instanceId: "test-instance",
      appArmorProfile: "fireball-session",
      startupHealthAttempts: 3,
      startupHealthIntervalMs: 1,
      ...overrides,
    },
    transport,
  );
}

class RecordingTransport implements DockerEngineTransport {
  public readonly calls: DockerEngineRequest[] = [];

  public constructor(private readonly results: Array<unknown | Error>) {}

  public async call<T>(request: DockerEngineRequest): Promise<T> {
    this.calls.push(request);
    const result = this.results.shift();
    if (result === undefined) throw new Error("missing transport fixture");
    if (result instanceof Error) throw result;
    return result as T;
  }
}

function ownershipLabels(instanceId: string): Record<string, string> {
  return {
    "dev.fireball.managed": "true",
    "dev.fireball.instance": instanceId,
  };
}

function ownershipFilter(instanceId: string): string {
  return encodeURIComponent(JSON.stringify({
    label: ["dev.fireball.managed=true", `dev.fireball.instance=${instanceId}`],
  }));
}

function signalingInspect(hostPort: string, healthStatus = "healthy"): unknown {
  return {
    State: { Health: { Status: healthStatus } },
    NetworkSettings: {
      Ports: { "8444/tcp": [{ HostIp: "127.0.0.1", HostPort: hostPort }] },
    },
  };
}
