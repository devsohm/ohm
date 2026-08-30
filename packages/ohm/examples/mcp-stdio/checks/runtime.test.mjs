import assert from "node:assert/strict";
import test from "node:test";

import activate, { createMcpExtension } from "../extensions/index.mjs";
import { createFixtureProtocol } from "../fixture/protocol.mjs";
import server from "../extensions/server.mjs";

class FixtureProcessService {
  records = new Map();
  nextId = 1;

  spawn(spec) {
    const id = `fixture-process-${this.nextId++}`;
    let resolveCompletion;
    const completion = new Promise((resolve) => { resolveCompletion = resolve; });
    const versionIndex = spec.argv.indexOf("--protocol-version");
    const record = {
      id,
      spec,
      state: "running",
      output: Buffer.alloc(0),
      eof: false,
      messages: [],
      pendingRead: undefined,
      completion,
      resolveCompletion,
      protocol: undefined,
    };
    record.protocol = createFixtureProtocol({
      exit: (code) => this.finish(record, "failed", code),
      processId: this.nextId + 10_000,
      protocolVersion: versionIndex < 0 ? "2025-06-18" : spec.argv[versionIndex + 1],
      send: (message) => this.enqueue(record, `${JSON.stringify(message)}\n`),
      sendRaw: (frame) => this.enqueue(record, frame),
    });
    this.records.set(id, record);
    if (spec.signal !== undefined) {
      const cancel = () => { void this.cancel(id); };
      spec.signal.addEventListener("abort", cancel, { once: true });
      if (spec.signal.aborted) cancel();
    }
    return id;
  }

  status(id) {
    const record = this.record(id);
    return { id, state: record.state };
  }

  subscribe(id, listener) {
    listener(this.status(id));
    return () => undefined;
  }

  async read(id, _stream, options = {}) {
    const record = this.record(id);
    const maximum = options.maxBytes ?? 64 * 1024;
    if (record.output.length > 0 || record.eof) return this.readNow(record, maximum);
    assert.equal(record.pendingRead, undefined);
    return await new Promise((resolve) => { record.pendingRead = { maximum, resolve }; });
  }

  async write(id, data) {
    const record = this.record(id);
    if (record.state !== "running") throw new Error("Fixture process has finished");
    for (const frame of Buffer.from(data).toString("utf8").split("\n")) {
      if (frame !== "") {
        const message = JSON.parse(frame);
        record.messages.push(message);
        record.protocol.handle(message);
      }
    }
  }

  async closeInput(id) {
    this.finish(this.record(id), "succeeded", 0);
  }

  async wait(id) {
    return await this.record(id).completion;
  }

  async cancel(id) {
    const record = this.record(id);
    if (record.state === "running") this.finish(record, "cancelled", null);
    return await record.completion;
  }

  record(id) {
    const record = this.records.get(id);
    if (record === undefined) throw new Error(`Unknown fixture process ${id}`);
    return record;
  }

  enqueue(record, frame) {
    if (record.state !== "running") return;
    record.output = Buffer.concat([record.output, Buffer.from(frame)]);
    this.flush(record);
  }

  readNow(record, maximum) {
    const data = record.output.subarray(0, maximum);
    record.output = record.output.subarray(data.length);
    return { data: new Uint8Array(data), eof: record.eof && record.output.length === 0 };
  }

  flush(record) {
    const pending = record.pendingRead;
    if (pending === undefined || (record.output.length === 0 && !record.eof)) return;
    record.pendingRead = undefined;
    pending.resolve(this.readNow(record, pending.maximum));
  }

  finish(record, state, exitCode) {
    if (record.state !== "running") return;
    record.state = state;
    record.eof = true;
    record.protocol.close();
    this.flush(record);
    record.resolveCompletion({
      id: record.id,
      state,
      exitCode,
      signal: null,
      stdout: new Uint8Array(),
      stderr: new Uint8Array(),
    });
  }
}

function registrationHandle(dispose = () => undefined) {
  let disposed = false;
  const handle = async () => {
    if (disposed) return;
    disposed = true;
    await dispose();
  };
  Object.defineProperties(handle, {
    dispose: { value: handle, enumerable: true },
    disposed: { get: () => disposed, enumerable: true },
  });
  return Object.freeze(handle);
}

async function extensionHarness(context, selectedActivate = activate, toolOverride) {
  const ownerAbort = new AbortController();
  const processes = new FixtureProcessService();
  const tools = [];
  const liveTools = new Map();
  const disposers = [];
  const registrations = [];
  const spawned = [];
  let sessionStart;
  selectedActivate({
    processes: {
      spawn(spec) {
        const id = processes.spawn(spec);
        spawned.push(id);
        return id;
      },
      status: (...args) => processes.status(...args),
      subscribe: (...args) => processes.subscribe(...args),
      read: (...args) => processes.read(...args),
      write: (...args) => processes.write(...args),
      closeInput: (...args) => processes.closeInput(...args),
      wait: (...args) => processes.wait(...args),
      cancel: (...args) => processes.cancel(...args),
    },
    registerTool(tool) {
      const token = Symbol(tool.name);
      const previous = liveTools.get(tool.name)?.tool;
      toolOverride?.({ previous, tool });
      liveTools.set(tool.name, { token, tool });
      tools.splice(0, tools.length, ...Array.from(liveTools.values(), (entry) => entry.tool));
      const handle = registrationHandle(() => {
        if (liveTools.get(tool.name)?.token !== token) return;
        liveTools.delete(tool.name);
        tools.splice(0, tools.length, ...Array.from(liveTools.values(), (entry) => entry.tool));
      });
      registrations.push(handle);
      return handle;
    },
    on(name, listener) {
      assert.equal(name, "session_start");
      sessionStart = listener;
      return registrationHandle();
    },
    onDispose(dispose) {
      disposers.push(dispose);
      return registrationHandle();
    },
  });
  assert.ok(sessionStart);
  context.after(async () => {
    for (const registration of registrations.reverse()) await registration.dispose();
    for (const dispose of disposers.reverse()) await dispose();
    ownerAbort.abort(new Error("MCP test generation disposed"));
    for (const id of spawned) await processes.cancel(id);
  });
  return {
    ownerAbort,
    processes,
    spawned,
    tools,
    async start(signal = ownerAbort.signal) {
      await sessionStart({ reason: "startup", threadId: "mcp-check" }, { signal });
    },
  };
}

async function runningExtension(context) {
  const harness = await extensionHarness(context);
  await harness.start();
  return harness.tools;
}

async function call(tools, name, input, signal = new AbortController().signal) {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `missing ${name}`);
  return await tool.execute(`call-${name}`, input, signal);
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Condition was not met within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("initialization follows pagination and registers only the explicit allowlist", async (context) => {
  const tools = await runningExtension(context);
  const names = tools.map((tool) => tool.name).sort();
  assert.equal(names.length, 11);
  assert.equal(names.includes("fixture.hidden"), false);
  assert.deepEqual(await call(tools, "example_mcp_echo", { text: "hello" }), {
    content: [{ type: "text", text: "hello" }],
    details: { server: "fixture", remoteTool: "fixture.echo" },
  });
  assert.deepEqual(await call(tools, "example_mcp_add", { left: 20, right: 22 }), {
    content: [{ type: "text", text: "42" }],
    details: {
      server: "fixture",
      remoteTool: "fixture.add",
      structuredContent: { sum: 42 },
    },
  });
  const state = await call(tools, "example_mcp_state", {});
  assert.match(state.content[0].text, /"initialized":true/u);
  assert.match(state.content[0].text, /"listCalls":2/u);
});

test("the managed server receives only its explicit bounded environment", async (context) => {
  const harness = await extensionHarness(context);
  await harness.start();

  const spec = harness.processes.record(harness.spawned[0]).spec;
  assert.equal(spec.inheritEnv, false);
  assert.deepEqual(spec.env, {});
});

test("server environment configuration is bounded before activation", () => {
  const env = Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`MCP_FIXTURE_${index}`, "fixture"]));
  assert.throws(() => createMcpExtension({ ...server, env }), /MCP server env exceeds 32 entries/u);
});

test("the session_start deadline does not own the initialized server lifetime", async (context) => {
  const harness = await extensionHarness(context);
  const callbackSignal = AbortSignal.timeout(50);
  await harness.start(callbackSignal);
  await new Promise((resolve) => {
    if (callbackSignal.aborted) resolve();
    else callbackSignal.addEventListener("abort", resolve, { once: true });
  });

  const record = harness.processes.record(harness.spawned[0]);
  assert.equal(record.state, "running");
  assert.equal(Object.hasOwn(record.spec, "signal"), false);
  assert.equal(Object.hasOwn(record.spec, "timeoutMs"), false);
  assert.deepEqual(await call(harness.tools, "example_mcp_echo", { text: "after callback timeout" }), {
    content: [{ type: "text", text: "after callback timeout" }],
    details: { server: "fixture", remoteTool: "fixture.echo" },
  });
});

test("initialization rejects a protocol version the adapter does not implement", async (context) => {
  const harness = await extensionHarness(context, createMcpExtension({
    ...server,
    argv: [...server.argv, "--protocol-version", "2099-01-01"],
  }));
  await assert.rejects(harness.start(), /Unsupported MCP protocol version 2099-01-01; expected 2025-06-18/u);
  assert.deepEqual(harness.tools, []);
  assert.equal(harness.spawned.length, 1);
  assert.deepEqual(
    harness.processes.record(harness.spawned[0]).messages.map((message) => message.method),
    ["initialize"],
  );
  assert.equal((await harness.processes.wait(harness.spawned[0])).state, "cancelled");
});

test("a tool registration rejection leaves no tools, stops its server, and can retry cleanly", async (context) => {
  let shouldFail = true;
  const harness = await extensionHarness(context, activate, () => {
    if (shouldFail) {
      shouldFail = false;
      throw new Error("reject MCP tool registration");
    }
  });

  await assert.rejects(harness.start(), /reject MCP tool registration/u);
  assert.deepEqual(harness.tools, []);
  assert.equal(harness.spawned.length, 1);
  assert.equal((await harness.processes.wait(harness.spawned[0])).state, "cancelled");

  await harness.start();
  assert.equal(harness.spawned.length, 2);
  assert.equal(harness.tools.length, 11);
  assert.deepEqual(await call(harness.tools, "example_mcp_echo", { text: "clean retry" }), {
    content: [{ type: "text", text: "clean retry" }],
    details: { server: "fixture", remoteTool: "fixture.echo" },
  });
});

test("tools/list_changed replaces the extension-owned tool registrations", async (context) => {
  const harness = await extensionHarness(context);
  await harness.start();
  const originalTools = new Map(harness.tools.map((tool) => [tool.name, tool]));
  const originalEcho = harness.tools.find((tool) => tool.name === "example_mcp_echo");
  assert.ok(originalEcho);

  await call(harness.tools, "example_mcp_catalog_change", {});
  await waitFor(() => harness.tools.find((tool) => tool.name === "example_mcp_echo")?.description.includes("catalog revision 1"));

  const replacementEcho = harness.tools.find((tool) => tool.name === "example_mcp_echo");
  assert.ok(replacementEcho);
  assert.notEqual(replacementEcho, originalEcho);
  assert.match(replacementEcho.description, /catalog revision 1/u);
  assert.equal(harness.tools.length, 11);
  for (const tool of harness.tools) assert.notEqual(tool, originalTools.get(tool.name));
});

test("a rejected catalog refresh removes the complete bridge tool set", async (context) => {
  const harness = await extensionHarness(context, activate, ({ tool }) => {
    if (tool.name === "example_mcp_echo" && tool.description.includes("catalog revision 1")) {
      throw new Error("reject refreshed MCP tool");
    }
  });
  await harness.start();
  assert.equal(harness.tools.length, 11);

  await call(harness.tools, "example_mcp_catalog_change", {});
  await waitFor(() => harness.tools.length === 0);
  assert.equal((await harness.processes.wait(harness.spawned[0])).state, "cancelled");
});

test("server requests are rejected and caller cancellation reaches the server", async (context) => {
  const tools = await runningExtension(context);
  assert.deepEqual(await call(tools, "example_mcp_client_request", {}), {
    content: [{ type: "text", text: "rejected:-32601" }],
    details: { server: "fixture", remoteTool: "fixture.client-request" },
  });

  const controller = new AbortController();
  const pending = call(tools, "example_mcp_slow", { delayMs: 10_000 }, controller.signal);
  controller.abort(new Error("cancel slow fixture"));
  await assert.rejects(pending, /cancel slow fixture/u);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const observed = await call(tools, "example_mcp_cancelled", {});
  assert.deepEqual(observed.content, [{ type: "text", text: "1" }]);
});

for (const [name, pattern] of [
  ["example_mcp_malformed", /malformed JSON/u],
  ["example_mcp_oversized", /frame exceeds/u],
  ["example_mcp_die", /closed stdout|exit code 17|ended in state/u],
]) {
  test(`${name} fails closed and leaves the generation unavailable`, async (context) => {
    const tools = await runningExtension(context);
    await assert.rejects(call(tools, name, {}), pattern);
    await assert.rejects(call(tools, "example_mcp_echo", { text: "after failure" }), /unavailable|process|frame|JSON/u);
  });
}
