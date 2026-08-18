import assert from "node:assert/strict";
import { test } from "node:test";

import { OrchestratorError } from "../src/domain/errors.js";
import { DockerEngineRuntime } from "../src/runtime/docker-engine-runtime.js";
import type {
  DockerEngineRequest,
  DockerEngineResponse,
  DockerEngineTransport,
} from "../src/runtime/docker-engine-transport.js";

const request = {
  sessionId: "d34c2e46-ff85-45f1-b3c4-28dbb1993ed7",
  tenantId: "alpha",
  quota: { memoryMiB: 512, cpuShares: 512, pids: 128 },
} as const;

test("Docker runtime applies the tenant isolation contract", async () => {
  const transport = new RecordingTransport([{}, { Id: "container-1" }, {}]);
  const runtime = makeRuntime(transport);

  const resource = await runtime.create(request);

  assert.equal(resource.containerId, "container-1");
  assert.deepEqual(transport.calls.map((call) => call.acceptedStatusCodes), [[201], [201], [204]]);
  const createContainer = transport.calls[1];
  assert.ok(createContainer);
  const body = createContainer.body as {
    Labels: Record<string, string>;
    HostConfig: {
      ReadonlyRootfs: boolean;
      CapDrop: string[];
      SecurityOpt: string[];
      Memory: number;
      PidsLimit: number;
      NetworkMode: string;
      Tmpfs: Record<string, string>;
    };
  };
  assert.equal(body.Labels["dev.fireball.tenant"], "alpha");
  assert.equal(body.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(body.HostConfig.CapDrop, ["ALL"]);
  assert.deepEqual(body.HostConfig.SecurityOpt, ["no-new-privileges:true"]);
  assert.equal(body.HostConfig.Memory, 512 * 1024 * 1024);
  assert.equal(body.HostConfig.PidsLimit, 128);
  assert.equal(body.HostConfig.NetworkMode, `fireball-net-${request.sessionId}`);
  assert.match(body.HostConfig.Tmpfs["/run/fireball-session"] ?? "", /noexec,nosuid,nodev/);
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
  });

  assert.deepEqual(transport.calls[0]?.acceptedStatusCodes, [204, 404]);
  assert.deepEqual(transport.calls[1]?.acceptedStatusCodes, [204, 404]);
});

function makeRuntime(transport: DockerEngineTransport): DockerEngineRuntime {
  return new DockerEngineRuntime(
    { socketPath: "/var/run/docker.sock", apiVersion: "1.47", image: "fireball/session-wpe:test" },
    transport,
  );
}

class RecordingTransport implements DockerEngineTransport {
  public readonly calls: DockerEngineRequest[] = [];

  public constructor(private readonly results: Array<DockerEngineResponse | Error>) {}

  public async call(request: DockerEngineRequest): Promise<DockerEngineResponse> {
    this.calls.push(request);
    const result = this.results.shift();
    if (!result) throw new Error("missing transport fixture");
    if (result instanceof Error) throw result;
    return result;
  }
}
