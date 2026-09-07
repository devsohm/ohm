import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";

import {
  PLUGIN_WIRE_SERVICE_PROTOCOL_VERSION,
  createPluginWireServiceEndpoint,
  createPluginWireServiceProvider,
  describePluginWireServiceEndpoint,
  definePluginWireService,
  pluginWireServiceRegistryName,
  pluginWireServiceRequest,
  validatePluginWireServiceResponse,
} from "../../src/plugins/wire-services.js";

const CONTRACT = definePluginWireService({
  name: "tasks.lookup",
  version: 2,
  requestSchema: Type.Object({ id: Type.String() }, { additionalProperties: false }),
  responseSchema: Type.Object({ found: Type.Boolean() }, { additionalProperties: false }),
  maxRequestBytes: 1_024,
  maxResponseBytes: 1_024,
});

test("wire services preserve typed versioned JSON envelopes across a process boundary", async () => {
  const endpoint = createPluginWireServiceEndpoint(CONTRACT, ({ id }, context) => {
    assert.equal(context.requestId, "call-1");
    return { found: id === "known" };
  });
  const request = pluginWireServiceRequest(CONTRACT, "call-1", { id: "known" });
  const transported = JSON.parse(JSON.stringify(request));
  assert.deepEqual(await endpoint.request(transported), {
    protocolVersion: PLUGIN_WIRE_SERVICE_PROTOCOL_VERSION,
    service: "tasks.lookup",
    serviceVersion: 2,
    id: "call-1",
    ok: true,
    payload: { found: true },
  });
  assert.equal(pluginWireServiceRegistryName(CONTRACT), "ohm.wire.tasks.lookup.v2");
});

test("wire services reject incompatible versions, unknown fields, and schema-invalid payloads", async () => {
  const endpoint = createPluginWireServiceEndpoint(CONTRACT, () => ({ found: true }));
  const base = pluginWireServiceRequest(CONTRACT, "call-2", { id: "known" });
  const incompatibleProtocol = structuredClone(base);
  Object.defineProperty(incompatibleProtocol, "protocolVersion", { value: 2 });
  const invalidPayload = structuredClone(base);
  Object.defineProperty(invalidPayload.payload, "id", { value: 7 });
  for (const request of [
    incompatibleProtocol,
    { ...base, serviceVersion: 3 },
    invalidPayload,
    { ...base, extra: true },
  ]) {
    const response = await endpoint.request(request);
    assert.equal(response.ok, false);
    if (!response.ok) assert.equal(response.error.code, "invalid_request");
  }
});

test("wire services bound handler failures, validate responses, and stop with their generation", async () => {
  const thrown = createPluginWireServiceEndpoint(CONTRACT, () => {
    throw new Error(`failure ${"x".repeat(8_000)}`);
  });
  const failed = await thrown.request(pluginWireServiceRequest(CONTRACT, "call-3", { id: "known" }));
  assert.equal(failed.ok, false);
  if (!failed.ok) {
    assert.equal(failed.error.code, "handler_failed");
    assert.equal(failed.error.message, "Plugin wire service handler failed");
    assert.doesNotMatch(failed.error.message, /failure/u);
  }

  const invalidResponse = createPluginWireServiceEndpoint(CONTRACT, () => {
    const response = { found: true };
    Object.defineProperty(response, "found", { value: "yes" });
    return response;
  });
  const invalid = await invalidResponse.request(pluginWireServiceRequest(CONTRACT, "call-4", { id: "known" }));
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.error.message, "Plugin wire service handler failed");

  const lifecycle = new AbortController();
  const stopped = createPluginWireServiceEndpoint(CONTRACT, () => ({ found: true }), {
    signal: lifecycle.signal,
  });
  lifecycle.abort(new Error("generation stopped"));
  await assert.rejects(
    stopped.request(pluginWireServiceRequest(CONTRACT, "call-5", { id: "known" })),
    /generation stopped/u,
  );

  const requestCancellation = new AbortController();
  const cancellable = createPluginWireServiceEndpoint(CONTRACT, async (_request, context) => {
    await new Promise<void>((_resolve, reject) => {
      context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true });
    });
    return { found: true };
  });
  const pending = cancellable.request(
    pluginWireServiceRequest(CONTRACT, "call-6", { id: "known" }),
    requestCancellation.signal,
  );
  requestCancellation.abort(new Error("caller cancelled"));
  await assert.rejects(pending, /caller cancelled/u);
});

test("wire service admission is detached from later extension schema mutation", async () => {
  const requestSchema = Type.Object({ count: Type.Integer() }, { additionalProperties: false });
  const responseSchema = Type.Object({ accepted: Type.Boolean() }, { additionalProperties: false });
  const contract = definePluginWireService({
    name: "immutable.contract",
    version: 1,
    requestSchema,
    responseSchema,
  });
  const endpoint = createPluginWireServiceEndpoint(contract, () => ({ accepted: true }));
  Object.defineProperty(requestSchema.properties.count, "type", { value: "string" });
  assert.equal((await endpoint.request(pluginWireServiceRequest(
    contract,
    "immutable-1",
    { count: 1 },
  ))).ok, true);
  const invalidRequest = structuredClone(pluginWireServiceRequest(
    contract,
    "immutable-2",
    { count: 1 },
  ));
  Object.defineProperty(invalidRequest.payload, "count", { value: "one" });
  const rejected = await endpoint.request(invalidRequest);
  assert.equal(rejected.ok, false);
  assert.throws(() => {
    Object.defineProperty(contract.requestSchema, "type", { value: "array" });
  }, /read only|Cannot (?:assign|redefine)/iu);

  const descriptor = describePluginWireServiceEndpoint(endpoint, "immutable.extension");
  assert.equal(descriptor.maxRequestBytes, 1024 * 1024);
  assert.deepEqual(descriptor.requestSchema, contract.requestSchema);
  assert.notEqual(descriptor.requestSchema, endpoint.requestSchema);
  assert.throws(() => {
    Object.defineProperty(descriptor.requestSchema, "type", { value: "array" });
  }, /read only|Cannot (?:assign|redefine)/iu);
});

test("wire providers derive registry ownership from the detached endpoint", () => {
  let nameReads = 0;
  let registeredName: string | undefined;
  const registration = Object.assign(() => undefined, {
    disposed: false,
    dispose() {},
  });
  const lifecycle: Parameters<typeof createPluginWireServiceProvider>[0] = {
    services: {
      register<Service extends object>(name: string, _service: Service) {
        registeredName = name;
        return registration;
      },
      get<Service extends object = object>(_name: string): Service | undefined {
        return undefined;
      },
    },
  };
  const provider = createPluginWireServiceProvider(lifecycle);
  provider.provide({
    get name() {
      nameReads += 1;
      return nameReads === 1 ? "stable.endpoint" : "mutated.endpoint";
    },
    version: 1,
    requestSchema: Type.Object({}, { additionalProperties: false }),
    responseSchema: Type.Object({}, { additionalProperties: false }),
  }, () => ({}));
  assert.equal(nameReads, 1);
  assert.equal(registeredName, "ohm.wire.stable.endpoint.v1");
});

test("wire response admission detaches JSON and never forwards handler details", () => {
  const request = pluginWireServiceRequest(CONTRACT, "response-1", { id: "known" });
  assert.deepEqual(validatePluginWireServiceResponse({
    protocolVersion: 1,
    service: CONTRACT.name,
    serviceVersion: CONTRACT.version,
    id: request.id,
    ok: false,
    error: { code: "handler_failed", message: "secret database token" },
  }, request), {
    protocolVersion: 1,
    service: CONTRACT.name,
    serviceVersion: CONTRACT.version,
    id: request.id,
    ok: false,
    error: { code: "handler_failed", message: "Plugin wire service handler failed" },
  });
  assert.throws(() => validatePluginWireServiceResponse({
    protocolVersion: 1,
    service: CONTRACT.name,
    serviceVersion: CONTRACT.version,
    id: "another-call",
    ok: true,
    payload: { found: true },
  }, request), /identity does not match/u);
});
