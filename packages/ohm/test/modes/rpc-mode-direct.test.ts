import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { isJsonObject, type JsonObject } from "../../src/core/json.js";
import { optionalProperties } from "../../src/core/optional-properties.js";

interface RpcFixtureResult {
  records: JsonObject[];
  stderr: string;
}

async function runFixture(
  command: JsonObject | readonly JsonObject[],
  environment: NodeJS.ProcessEnv = {},
  options: { imports?: readonly string[]; expectedCode?: number; timeoutMs?: number; inputResponse?: string } = {},
): Promise<RpcFixtureResult> {
  const fixture = fileURLToPath(new URL("../fixtures/rpc-mode-host.mts", import.meta.url));
  const child = spawn(process.execPath, [
    "--import",
    "tsx",
    ...(options.imports ?? []).flatMap((specifier) => ["--import", specifier]),
    fixture,
  ], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, OHM_OFFLINE: "1", ...environment },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const commands = Array.isArray(command) ? command : [command];
  const lines = commands.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  if (options.inputResponse === undefined) child.stdin.end(lines);
  else {
    const reader = createInterface({ input: child.stdout });
    reader.on("line", (line) => {
      const record: unknown = JSON.parse(line);
      if (!isJsonObject(record) || record.type !== "extension_ui_request" || record.method !== "input") return;
      child.stdin.end(`${JSON.stringify({ type: "extension_ui_response", id: record.id, value: options.inputResponse })}\n`);
      reader.close();
    });
    child.stdin.write(lines);
  }
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`RPC fixture timed out: ${stderr}`));
    }, options.timeoutMs ?? 10_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
  assert.deepEqual(result, { code: options.expectedCode ?? 0, signal: null });
  const records = stdout.trim().split("\n").filter(Boolean).map((line) => {
    const record: unknown = JSON.parse(line);
    if (!isJsonObject(record)) throw new TypeError("RPC fixture emitted a non-object record");
    return record;
  });
  return { records, stderr };
}

function dataImport(source: string): string {
  return `data:text/javascript,${encodeURIComponent(source)}`;
}

for (const completion of ["EOF", "response"] as const) {
  test(`public RPC startup accepts ${completion} while commands wait for startup`, async () => {
    const dispatcher = new URL("../../src/interfaces/rpc-runtime.ts", import.meta.url).href;
    const bridge = new URL("../../src/interfaces/rpc-plugin-ui.ts", import.meta.url).href;
    const startupDialog = dataImport(`
      import assert from "node:assert/strict";
      const { RpcRuntimeDispatcher } = await import(${JSON.stringify(dispatcher)});
      const { RpcPluginUiBridge } = await import(${JSON.stringify(bridge)});
      const context = RpcPluginUiBridge.prototype.context;
      let ui;
      RpcPluginUiBridge.prototype.context = function(...args) {
        ui = context.apply(this, args);
        return ui;
      };
      const start = RpcRuntimeDispatcher.prototype.start;
      let ready = false;
      RpcRuntimeDispatcher.prototype.start = async function() {
        await start.call(this);
        assert.equal(await ui.input("Startup input"), ${completion === "response" ? '"accepted"' : "undefined"});
        ready = true;
      };
      const dispatch = RpcRuntimeDispatcher.prototype.dispatch;
      RpcRuntimeDispatcher.prototype.dispatch = async function(command) {
        assert.equal(ready, true, "command ran before startup completed");
        return await dispatch.call(this, command);
      };
    `);
    const { records, stderr } = await runFixture([
      { id: "state", type: "get_state" },
      { id: "abort", type: "abort" },
    ], {}, {
      imports: [startupDialog],
      ...optionalProperties(completion === "response" ? { inputResponse: "accepted" } : undefined),
    });
    assert.equal(stderr, "");
    assert.equal(records.find((record) => record.id === "state")?.success, true);
    assert.equal(records.find((record) => record.id === "abort")?.success, true);
  });
}

test("public RPC mode owns an existing runtime and serves strict JSONL until stdin closes", async () => {
  const { records } = await runFixture({ id: "state", type: "get_state" });
  assert.deepEqual(records, [{
    id: "state",
    type: "response",
    command: "get_state",
    success: true,
    data: {
      thinkingLevel: "off",
      isStreaming: false,
      isCompacting: false,
      steeringMode: "all",
      followUpMode: "all",
      sessionId: "rpc-fixture",
      autoCompactionEnabled: true,
      messageCount: 0,
      pendingMessageCount: 0,
    },
  }]);
});

test("malformed extension UI replies are diagnosed without closing the RPC stream", async () => {
  const { records, stderr } = await runFixture([
    { type: "extension_ui_response", id: "stale" },
    { type: "extension_ui_response", id: 123, cancelled: true },
    { id: "state", type: "get_state" },
  ]);
  assert.equal(stderr, "");
  assert.equal(records.length, 3);
  assert.deepEqual(records.filter((record) => record.command === "parse"), [
    { type: "response", command: "parse", success: false, error: "Failed to parse command: RPC extension UI response has an invalid payload" },
    { type: "response", command: "parse", success: false, error: "Failed to parse command: RPC command ID must be a string" },
  ]);
  assert.equal(records.find((record) => record.id === "state")?.success, true);
});

test("public RPC mode redacts extension errors while preserving structured fields", async () => {
  const secret = "sk-proj-rpc-mode-redaction-1234567890";
  const { records, stderr } = await runFixture(
    { id: "state", type: "get_state" },
    { OHM_RPC_EXTENSION_ERROR_SECRET: secret },
  );
  assert.equal(stderr, "");
  const extensionError = records.find((record) => record.type === "extension_error");
  assert.ok(extensionError);
  assert.equal(extensionError.extensionId, "fixture-extension");
  assert.equal(extensionError.event, "input");
  assert.equal(String(extensionError.extensionPath).includes(secret), false);
  assert.equal(String(extensionError.error).includes(secret), false);
  assert.match(String(extensionError.extensionPath), /\[REDACTED\]/u);
  assert.match(String(extensionError.error), /\[REDACTED\]/u);
});

test("RPC response-size failures preserve the originating command and ID", async () => {
  const { records, stderr } = await runFixture(
    { id: "oversized-state", type: "get_state" },
    { OHM_RPC_OVERSIZE: "1" },
  );
  assert.equal(stderr, "");
  assert.equal(records.length, 1);
  assert.deepEqual(records[0], {
    id: "oversized-state",
    type: "response",
    command: "get_state",
    success: false,
    error: "Failed to send response: RPC line exceeded 16777216 bytes",
  });
});

test("unexpected RPC handler failures preserve the originating command and ID", async () => {
  const dispatcher = new URL("../../src/interfaces/rpc-runtime.ts", import.meta.url).href;
  const failingDispatcher = dataImport(`
    const { RpcRuntimeDispatcher } = await import(${JSON.stringify(dispatcher)});
    RpcRuntimeDispatcher.prototype.dispatch = async function() {
      throw new Error("unexpected dispatcher failure");
    };
  `);

  const { records, stderr } = await runFixture(
    { id: "failed-state", type: "get_state" },
    {},
    { imports: [failingDispatcher] },
  );

  assert.equal(stderr, "");
  assert.deepEqual(records, [{
    id: "failed-state",
    type: "response",
    command: "get_state",
    success: false,
    error: "unexpected dispatcher failure",
  }]);
});

test("public RPC mode correlates and bounds huge dispatcher failures", async () => {
  const dispatcher = new URL("../../src/interfaces/rpc-runtime.ts", import.meta.url).href;
  const failingDispatcher = dataImport(`
    const { RpcRuntimeDispatcher } = await import(${JSON.stringify(dispatcher)});
    RpcRuntimeDispatcher.prototype.dispatch = async function() {
      throw new Error("sk-proj-rpc-public-bounded-1234567890-" + "x".repeat(17 * 1024 * 1024));
    };
  `);

  const { records, stderr } = await runFixture(
    { id: "huge-public-failure", type: "get_state" },
    {},
    { imports: [failingDispatcher] },
  );

  assert.equal(stderr, "");
  assert.equal(records.length, 1);
  assert.equal(records[0]?.id, "huge-public-failure");
  assert.equal(records[0]?.command, "get_state");
  assert.equal(records[0]?.success, false);
  const detail = String(records[0]?.error);
  assert.ok(Buffer.byteLength(detail, "utf8") <= 4_096);
  assert.match(detail, /\[REDACTED\]/u);
  assert.doesNotMatch(detail, /rpc-public-bounded/u);
});

test("public RPC mode backpressures at 64 concurrent command handlers", async () => {
  const dispatcher = new URL("../../src/interfaces/rpc-runtime.ts", import.meta.url).href;
  const delayedDispatcher = dataImport(`
    import { writeSync } from "node:fs";
    const { RpcRuntimeDispatcher } = await import(${JSON.stringify(dispatcher)});
    const dispatch = RpcRuntimeDispatcher.prototype.dispatch;
    let active = 0;
    let maximum = 0;
    RpcRuntimeDispatcher.prototype.dispatch = async function(command) {
      active += 1;
      maximum = Math.max(maximum, active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return await dispatch.call(this, command);
      } finally {
        active -= 1;
      }
    };
    process.once("exit", () => writeSync(2, "maximum-active:" + maximum + "\\n"));
  `);
  const commands = Array.from({ length: 65 }, (_, index) => ({ id: String(index), type: "get_state" }));

  const { records, stderr } = await runFixture(commands, {}, { imports: [delayedDispatcher] });

  assert.equal(records.length, commands.length);
  assert.match(stderr, /maximum-active:64\n/u);
});

test("public RPC mode bounds prompts before session admission", async () => {
  const shortenShutdown = dataImport(`
    const nativeSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = function(callback, delay, ...args) {
      return nativeSetTimeout(callback, delay === 5_000 ? 25 : delay, ...args);
    };
  `);
  const commands = Array.from({ length: 1_089 }, (_, index) => ({
    id: String(index),
    type: "prompt",
    message: `prompt-${index}`,
  }));

  const { records, stderr } = await runFixture(commands, { OHM_RPC_BLOCK_PROMPT: "1" }, {
    imports: [shortenShutdown],
    expectedCode: 1,
    timeoutMs: 3_000,
  });

  assert.deepEqual(records.find((record) => record.id === "1088"), {
    id: "1088",
    type: "response",
    command: "prompt",
    success: false,
    error: "RPC command backlog exceeded 1024",
  });
  assert.equal(stderr, "prompt-calls:64\n");
});

test("public RPC mode lets active commands finish after stdin closes", async () => {
  const dispatcher = new URL("../../src/interfaces/rpc-runtime.ts", import.meta.url).href;
  const delayedDispatcher = dataImport(`
    const nativeSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = function(callback, delay, ...args) {
      return nativeSetTimeout(callback, delay === 5_000 ? 25 : delay, ...args);
    };
    const { RpcRuntimeDispatcher } = await import(${JSON.stringify(dispatcher)});
    const dispatch = RpcRuntimeDispatcher.prototype.dispatch;
    RpcRuntimeDispatcher.prototype.dispatch = async function(command) {
      await new Promise((resolve) => nativeSetTimeout(resolve, 100));
      return await dispatch.call(this, command);
    };
  `);

  const { records } = await runFixture(
    { id: "slow-state", type: "get_state" },
    {},
    { imports: [delayedDispatcher] },
  );

  assert.equal(records.length, 1);
  assert.equal(records[0]?.["id"], "slow-state");
  assert.equal(records[0]?.["success"], true);
});

for (const behavior of ["healthy slow", "stalled"] as const) {
  test(`public RPC clean EOF drains queued notifications through a ${behavior} writer`, async () => {
    const dispatcher = new URL("../../src/interfaces/rpc-runtime.ts", import.meta.url).href;
    const bridgeModule = new URL("../../src/interfaces/rpc-plugin-ui.ts", import.meta.url).href;
    const slowNotifications = dataImport(`
      const nativeSetTimeout = globalThis.setTimeout;
      globalThis.setTimeout = function(callback, delay, ...args) {
        return nativeSetTimeout(callback, delay === 5_000 && ${JSON.stringify(behavior)} === "stalled" ? 100 : delay, ...args);
      };
      const write = process.stdout.write.bind(process.stdout);
      let notifications = 0;
      process.stdout.write = function(chunk, encodingOrCallback, callback) {
        if (!String(chunk).includes('"method":"notify"')) return write(chunk, encodingOrCallback, callback);
        const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
        notifications += 1;
        if (${JSON.stringify(behavior)} === "stalled" && notifications === 2) return write(chunk);
        return write(chunk, (error) => { nativeSetTimeout(() => done?.(error), 25); });
      };
      const { RpcRuntimeDispatcher } = await import(${JSON.stringify(dispatcher)});
      const { RpcPluginUiBridge } = await import(${JSON.stringify(bridgeModule)});
      let ui;
      const context = RpcPluginUiBridge.prototype.context;
      RpcPluginUiBridge.prototype.context = function(...args) {
        ui = context.apply(this, args);
        return ui;
      };
      const dispatch = RpcRuntimeDispatcher.prototype.dispatch;
      RpcRuntimeDispatcher.prototype.dispatch = async function(command) {
        for (let index = 0; index < 8; index += 1) ui.notify("queued-" + index);
        return await dispatch.call(this, command);
      };
    `);
    const { records, stderr } = await runFixture({ id: "state", type: "get_state" }, {}, {
      imports: [slowNotifications],
    });
    assert.equal(stderr, "");
    assert.equal(records.find((record) => record.id === "state")?.success, true);
    assert.deepEqual(records.filter((record) => record.method === "notify").map((record) => record.message),
      Array.from({ length: behavior === "stalled" ? 2 : 8 }, (_, index) => `queued-${index}`));
  });
}

for (const timing of ["pending", "after EOF"] as const) {
  test(`public RPC mode cancels ${timing} dialogs and drains their accepted commands`, async () => {
    const dispatcher = new URL("../../src/interfaces/rpc-runtime.ts", import.meta.url).href;
    const bridgeModule = new URL("../../src/interfaces/rpc-plugin-ui.ts", import.meta.url).href;
    const dialogDispatcher = dataImport(`
      const { RpcRuntimeDispatcher } = await import(${JSON.stringify(dispatcher)});
      const { RpcPluginUiBridge } = await import(${JSON.stringify(bridgeModule)});
      let ui;
      let ended;
      const inputEnded = new Promise((resolve) => { ended = resolve; });
      const context = RpcPluginUiBridge.prototype.context;
      RpcPluginUiBridge.prototype.context = function(...args) {
        ui = context.apply(this, args);
        return ui;
      };
      const endInput = RpcPluginUiBridge.prototype.endInput;
      RpcPluginUiBridge.prototype.endInput = function() { endInput.call(this); ended(); };
      RpcRuntimeDispatcher.prototype.dispatch = async function(command) {
        if (${JSON.stringify(timing)} === "after EOF") await inputEnded;
        const value = await ui.input("No remaining peer");
        ui.notify("Accepted work finished");
        return { id: command.id, type: "response", command: command.type, success: true, data: { cancelled: value === undefined } };
      };
    `);
    const { records, stderr } = await runFixture({ id: "dialog", type: "prompt", message: "ask" }, {}, {
      imports: [dialogDispatcher],
    });
    assert.equal(stderr, "");
    assert.deepEqual(records.filter((record) => record.type === "response"), [{
      id: "dialog", type: "response", command: "prompt", success: true, data: { cancelled: true },
    }]);
    assert.equal(records.filter((record) => record.method === "input").length, timing === "pending" ? 1 : 0);
    assert.equal(records.filter((record) => record.method === "notify").length, 1);
  });
}

test("RPC control responses bypass a saturated ordinary-command lane", async () => {
  const dispatcher = new URL("../../src/interfaces/rpc-runtime.ts", import.meta.url).href;
  const extensionUi = new URL("../../src/interfaces/rpc-plugin-ui.ts", import.meta.url).href;
  const blockedDispatcher = dataImport(`
    const { RpcRuntimeDispatcher } = await import(${JSON.stringify(dispatcher)});
    const { RpcPluginUiBridge } = await import(${JSON.stringify(extensionUi)});
    const dispatch = RpcRuntimeDispatcher.prototype.dispatch;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    RpcRuntimeDispatcher.prototype.dispatch = async function(command) {
      await gate;
      return await dispatch.call(this, command);
    };
    RpcPluginUiBridge.prototype.handle = function() {
      release();
      return true;
    };
  `);
  const commands = [
    ...Array.from({ length: 64 }, (_, index) => ({ id: String(index), type: "get_state" })),
    { id: "release", type: "extension_ui_response", cancelled: true },
  ];

  const { records } = await runFixture(commands, {}, {
    imports: [blockedDispatcher],
    timeoutMs: 3_000,
  });

  assert.equal(records.length, 64);
  assert.equal(records.every((record) => record["success"] === true), true);
});

test("RPC priority commands have a bounded backlog", async () => {
  const dispatcher = new URL("../../src/interfaces/rpc-runtime.ts", import.meta.url).href;
  const blockedDispatcher = dataImport(`
    const nativeSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = function(callback, delay, ...args) {
      return nativeSetTimeout(callback, delay === 5_000 ? 25 : delay, ...args);
    };
    const { RpcRuntimeDispatcher } = await import(${JSON.stringify(dispatcher)});
    RpcRuntimeDispatcher.prototype.dispatch = async function() {
      await new Promise(() => undefined);
    };
  `);
  const commands = Array.from({ length: 1_025 }, (_, index) => ({
    id: String(index),
    type: "abort",
  }));

  const { records } = await runFixture(commands, {}, {
    imports: [blockedDispatcher],
    expectedCode: 1,
    timeoutMs: 3_000,
  });

  assert.deepEqual(records, [{
    id: "1024",
    type: "response",
    command: "abort",
    success: false,
    error: "RPC priority command backlog exceeded 1024",
  }]);
});

test("public RPC mode reports bounded stderr from an abnormal stdin relay exit", async () => {
  const replacement = `
    process.stderr.write("relay-diagnostic:" + "x".repeat(8_192) + ":tail");
    if (process.connected) process.disconnect();
    process.exitCode = 7;
  `;
  const replaceSpawn = dataImport(`
    import { createRequire, syncBuiltinESMExports } from "node:module";
    const require = createRequire(process.cwd() + "/rpc-mode-prepare.cjs");
    const childProcess = require("node:child_process");
    const spawn = childProcess.spawn;
    childProcess.spawn = (_command, _arguments, options) =>
      spawn(process.execPath, ["--eval", ${JSON.stringify(replacement)}], options);
    syncBuiltinESMExports();
  `);

  const { records, stderr } = await runFixture(
    { id: "ignored", type: "get_state" },
    {},
    { imports: [replaceSpawn], expectedCode: 1 },
  );

  assert.equal(stderr, "");
  assert.equal(records.length, 1);
  assert.equal(records[0]?.["command"], "parse");
  assert.equal(records[0]?.["success"], false);
  const error = String(records[0]?.["error"]);
  assert.match(error, /^RPC stdin relay failed with exit 7: relay-diagnostic:/u);
  assert.ok(error.length < 4_200, `relay diagnostic was not bounded: ${error.length}`);
  assert.doesNotMatch(error, /:tail/u);
});

test("public RPC mode reports a stdin relay spawn error", async () => {
  const replaceSpawn = dataImport(`
    import { createRequire, syncBuiltinESMExports } from "node:module";
    const require = createRequire(process.cwd() + "/rpc-mode-prepare.cjs");
    const childProcess = require("node:child_process");
    const spawn = childProcess.spawn;
    childProcess.spawn = (_command, _arguments, options) =>
      spawn(process.platform === "win32" ? "Z:\\\\missing-ohm-relay.exe" : "/missing-ohm-relay", [], options);
    syncBuiltinESMExports();
  `);

  const { records, stderr } = await runFixture(
    { id: "ignored", type: "get_state" },
    {},
    { imports: [replaceSpawn], expectedCode: 1 },
  );

  assert.equal(stderr, "");
  assert.equal(records.length, 1);
  assert.equal(records[0]?.["command"], "parse");
  assert.equal(records[0]?.["success"], false);
  assert.match(String(records[0]?.["error"]), /ENOENT/u);
});
