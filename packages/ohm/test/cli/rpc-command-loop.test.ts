import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  runRpcCommandLoop,
  selectRpcConfiguredModel,
  type RpcModelSelectionRuntime,
} from "../../src/cli/rpc.js";
import { parseArgs } from "../../src/cli/args.js";
import { RpcRuntimeDispatcher, type RpcSessionRuntime } from "../../src/interfaces/rpc-runtime.js";
import { loadRuntime } from "../../src/cli/runtime.js";
import { isJsonObject, type JsonObject } from "../../src/core/json.js";
import type { RpcCommand, RpcExtensionUiResponse } from "../../src/interfaces/rpc-protocol.js";
import type { AgentSessionModel } from "../../src/service/agent-session.js";
import { InMemoryCredentialStore } from "../helpers/credential-store.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function* records(values: readonly object[]): AsyncGenerator<string> {
  for (const value of values) yield JSON.stringify(value);
}

test("RPC model selection does not apply the previous model's thinking level to a new model", async () => {
  const resolutions: Array<{ reference: string; options: { provider?: string; reasoningEffort?: string } }> = [];
  const selected: AgentSessionModel[] = [];
  const thinking: string[] = [];
  const runtime = {
    session: {
      model: { provider: "openai-codex", id: "gpt-5.6-sol" },
      async resolveModel(reference: string, options: { provider?: string; reasoningEffort?: string }) {
        resolutions.push({ reference, options });
        return { provider: options.provider ?? "openai-codex", api: "openai-responses" as const, id: reference };
      },
      async setModel(model: AgentSessionModel) { selected.push(model); },
      setThinkingLevel(level: string) { thinking.push(level); },
    },
    settings: {
      getDefaultModel: () => undefined,
      getDefaultProvider: () => undefined,
    },
  } satisfies RpcModelSelectionRuntime;
  const args = parseArgs([
    "--provider", "openai-codex",
    "--model", "caller-supplied-model",
  ]);

  await selectRpcConfiguredModel(runtime, args);
  assert.deepEqual(resolutions, [{
    reference: "caller-supplied-model",
    options: { provider: "openai-codex" },
  }]);
  assert.deepEqual(selected, [{
    provider: "openai-codex",
    api: "openai-responses",
    id: "caller-supplied-model",
  }]);
  assert.deepEqual(thinking, []);

  await selectRpcConfiguredModel(runtime, parseArgs([
    "--provider", "openai-codex",
    "--model", "caller-supplied-model",
    "--thinking", "high",
  ]));
  assert.deepEqual(resolutions.at(-1), {
    reference: "caller-supplied-model",
    options: { provider: "openai-codex", reasoningEffort: "high" },
  });
  assert.deepEqual(thinking, ["high"]);
});

test("the installed RPC loop correlates and bounds huge dispatcher failures", async () => {
  const sent: JsonObject[] = [];
  const secret = "sk-proj-rpc-cli-bounded-1234567890";
  await runRpcCommandLoop({
    lines: records([{ id: "huge-cli-failure", type: "get_state" }]),
    writer: {
      async send<Value>(value: Value) {
        if (!isJsonObject(value)) throw new Error("RPC test writer received a non-object value");
        sent.push(value);
      },
    },
    bridge: { handle() { return false; } },
    dispatcher: {
      async dispatch() { throw new Error(`${secret}-${"x".repeat(17 * 1024 * 1024)}`); },
    },
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.id, "huge-cli-failure");
  assert.equal(sent[0]?.command, "get_state");
  assert.equal(sent[0]?.success, false);
  const detail = String(sent[0]?.error);
  assert.ok(Buffer.byteLength(detail, "utf8") <= 4_096);
  assert.match(detail, /\[REDACTED\]/u);
  assert.doesNotMatch(detail, /rpc-cli-bounded/u);
});

test("the installed RPC loop lets UI responses bypass saturated commands", async () => {
  const gate = deferred();
  let active = 0;
  let maximumActive = 0;
  let uiResponses = 0;
  let dispatched = 0;

  await runRpcCommandLoop({
    lines: records([
      ...Array.from({ length: 64 }, (_, index) => ({ id: String(index), type: "get_state" })),
      { id: "release", type: "extension_ui_response", cancelled: true },
    ]),
    writer: { async send() {} },
    bridge: {
      handle(_response: RpcExtensionUiResponse) {
        uiResponses += 1;
        gate.resolve();
        return true;
      },
    },
    dispatcher: {
      async dispatch(_command: RpcCommand) {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await gate.promise;
        active -= 1;
        dispatched += 1;
        return undefined;
      },
    },
  });

  assert.equal(uiResponses, 1);
  assert.equal(maximumActive, 64);
  assert.equal(dispatched, 64);
});

test("the installed RPC loop lets abort commands bypass saturated ordinary commands", async () => {
  const gate = deferred();
  let aborts = 0;
  let ordinary = 0;

  await runRpcCommandLoop({
    lines: records([
      ...Array.from({ length: 64 }, (_, index) => ({ id: String(index), type: "get_state" })),
      { id: "cancel", type: "abort" },
    ]),
    writer: { async send() {} },
    bridge: { handle() { return true; } },
    dispatcher: {
      async dispatch(command: RpcCommand) {
        if (command.type === "abort") {
          aborts += 1;
          gate.resolve();
          return undefined;
        }
        await gate.promise;
        ordinary += 1;
        return undefined;
      },
    },
  });

  assert.equal(aborts, 1);
  assert.equal(ordinary, 64);
});

test("the installed RPC loop waits for admitted work after clean EOF", async () => {
  const gate = deferred();
  let completed = false;
  const operation = runRpcCommandLoop({
    lines: records([{ id: "state", type: "get_state" }]),
    writer: { async send() {} },
    bridge: { handle() { return true; } },
    dispatcher: {
      async dispatch() {
        await gate.promise;
        completed = true;
        return undefined;
      },
    },
  });

  await new Promise<void>((done) => setImmediate(done));
  assert.equal(completed, false);
  gate.resolve();
  await operation;
  assert.equal(completed, true);
});

test("the installed RPC loop rejects an excessive ordinary-command backlog", async () => {
  const gate = deferred();
  let dispatched = 0;
  async function* overloaded(): AsyncGenerator<string> {
    try {
      for (let index = 0; index < 1_089; index += 1) {
        yield JSON.stringify({ id: String(index), type: "get_state" });
      }
    } finally {
      gate.resolve();
    }
  }

  await assert.rejects(runRpcCommandLoop({
    lines: overloaded(),
    writer: { async send() {} },
    bridge: { handle() { return true; } },
    dispatcher: {
      async dispatch() {
        dispatched += 1;
        await gate.promise;
        return undefined;
      },
    },
  }), /RPC command backlog exceeded 1024/u);

  assert.equal(dispatched, 64);
});

test("the installed RPC loop bounds prompts before session admission", async (context) => {
  const gate = deferred();
  let promptCalls = 0;
  const root = await mkdtemp(join(tmpdir(), "ohm-rpc-loop-prompt-admission-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const agentDirectory = join(root, "agent");
  await mkdir(workspace);
  const loaded = await loadRuntime({
    workspace,
    agentDirectory,
    credentialStore: new InMemoryCredentialStore(),
    projectTrusted: false,
    ephemeral: true,
    extensions: false,
    extensionRuntime: false,
    skills: false,
    promptTemplates: false,
    themes: false,
    offline: true,
  });
  context.after(async () => await loaded.close());
  context.mock.method(loaded.session, "prompt", async () => {
      promptCalls += 1;
      await gate.promise;
      throw new Error("prompt released after backlog rejection");
  });
  const runtime: RpcSessionRuntime = {
    session: loaded.session,
    newSession(): never { throw new Error("newSession is not used by this fixture"); },
    switchSession(): never { throw new Error("switchSession is not used by this fixture"); },
    fork(): never { throw new Error("fork is not used by this fixture"); },
    setBeforeSessionInvalidate() {},
    setRebindSession() {},
  };
  const dispatcher = new RpcRuntimeDispatcher({ runtime, async output() {} });
  await dispatcher.start();
  async function* overloadedPrompts(): AsyncGenerator<string> {
    try {
      for (let index = 0; index < 1_089; index += 1) {
        yield JSON.stringify({ id: String(index), type: "prompt", message: `prompt-${index}` });
      }
    } finally {
      gate.resolve();
    }
  }

  await assert.rejects(runRpcCommandLoop({
    lines: overloadedPrompts(),
    writer: { async send() {} },
    bridge: { handle() { return true; } },
    dispatcher,
  }), /RPC command backlog exceeded 1024/u);

  assert.equal(promptCalls, 64);
  await dispatcher.close();
});
