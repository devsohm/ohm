import assert from "node:assert/strict";

import { defaultSecretRedactor } from "../../src/auth/redaction.js";
import type { RuntimeEvent } from "../../src/core/events.js";
import { MAX_RPC_LINE_BYTES } from "../../src/interfaces/rpc.js";
import { runRpcMode } from "../../src/modes/rpc-mode.js";
import type { AgentSession, ExtensionBindings } from "../../src/service/agent-session.js";
import type { AgentSessionRuntime } from "../../src/service/agent-session-runtime.js";

function rpcSessionFixture<Value>(value: Value): AgentSession {
  // SAFETY: this fixture implements every AgentSession member exercised by RpcRuntimeDispatcher and RPC commands.
  return value as AgentSession;
}

function rpcRuntimeFixture<Value>(value: Value): AgentSessionRuntime {
  // SAFETY: this fixture implements every AgentSessionRuntime member exercised by runRpcMode.
  return value as AgentSessionRuntime;
}

const listeners = new Set<(event: RuntimeEvent) => void>();
const calls: string[] = [];
let checkedBindings = false;
let emittedExtensionError = false;
let blockedPromptCalls = 0;
let releaseBlockedPrompts!: () => void;
const blockedPrompts = new Promise<void>((resolve) => { releaseBlockedPrompts = resolve; });

if (process.env.OHM_RPC_BLOCK_PROMPT === "1") {
  process.once("exit", () => { process.stderr.write(`prompt-calls:${blockedPromptCalls}\n`); });
}

const session = rpcSessionFixture({
  async bindExtensions(bindings?: ExtensionBindings) {
    assert.equal(bindings?.mode, "rpc");
    const extensionErrorSecret = process.env.OHM_RPC_EXTENSION_ERROR_SECRET;
    if (!emittedExtensionError && extensionErrorSecret !== undefined) {
      emittedExtensionError = true;
      defaultSecretRedactor.register(extensionErrorSecret);
      bindings?.onError?.({
        extensionId: "fixture-extension",
        extensionPath: `/extensions/before-${extensionErrorSecret}-after.mjs`,
        event: "input",
        error: `extension-before-${extensionErrorSecret}-after`,
      });
    }
    const actions = bindings?.commandContextActions;
    assert.ok(actions);
    if (checkedBindings) return;
    checkedBindings = true;
    await actions.waitForIdle();
    await actions.newSession({ parentSession: "parent.jsonl" });
    await actions.fork("entry", { position: "at" });
    await actions.navigateTree("target", { summarize: true });
    await actions.switchSession("/tmp/session.jsonl");
    await actions.refresh();
    assert.deepEqual(calls, [
      "session:wait",
      "runtime:new:parent.jsonl",
      "runtime:fork:entry:at",
      "session:navigate:target:true",
      "runtime:switch:/tmp/session.jsonl",
      "session:refresh",
    ]);
  },
  subscribe(listener: (event: RuntimeEvent) => void) { listeners.add(listener); return () => listeners.delete(listener); },
  async prompt(_message: string, options: { preflightResult?: (succeeded: boolean) => void } = {}) {
    if (process.env.OHM_RPC_BLOCK_PROMPT === "1") {
      blockedPromptCalls += 1;
      await blockedPrompts;
      return;
    }
    options.preflightResult?.(true);
  },
  async abort() { releaseBlockedPrompts(); },
  async waitForIdle() { calls.push("session:wait"); },
  async navigateTree(targetId: string, options: { summarize?: boolean }) {
    calls.push(`session:navigate:${targetId}:${options.summarize === true}`);
    return { cancelled: false };
  },
  async refresh() { calls.push("session:refresh"); },
  get model() { return undefined; },
  get modelRegistry() {
    return {
      find() { return undefined; },
      getAvailable() { return []; },
    };
  },
  get thinkingLevel() { return "off"; },
  get isStreaming() { return false; },
  get isIdle() { return true; },
  get isCompacting() { return false; },
  get steeringMode() { return "all"; },
  get followUpMode() { return "all"; },
  get sessionFile() { return undefined; },
  get sessionId() { return "rpc-fixture"; },
  get sessionName() {
    return process.env.OHM_RPC_OVERSIZE === "1" ? "x".repeat(MAX_RPC_LINE_BYTES) : undefined;
  },
  get autoCompactionEnabled() { return true; },
  get messages() { return []; },
  get pendingMessageCount() { return 0; },
});

const runtime = rpcRuntimeFixture({
  session,
  setBeforeSessionInvalidate() {},
  setRebindSession() {},
  async newSession(options: { parentSession?: string } = {}) {
    calls.push(`runtime:new:${options.parentSession ?? ""}`);
    return { cancelled: false };
  },
  async switchSession(path: string) {
    calls.push(`runtime:switch:${path}`);
    return { cancelled: false };
  },
  async fork(entryId: string, options: { position?: string } = {}) {
    calls.push(`runtime:fork:${entryId}:${options.position ?? ""}`);
    return { cancelled: false };
  },
  async refreshSession(
    expectedSession: AgentSession,
    refresh: (signal: AbortSignal) => Promise<AgentSession | void>,
    options: {
      signal?: AbortSignal;
      withSession?: (replacement: AgentSession) => Promise<void>;
    } = {},
  ) {
    assert.equal(expectedSession, session);
    const signal = options.signal ?? new AbortController().signal;
    signal.throwIfAborted();
    const replacement = await refresh(signal);
    signal.throwIfAborted();
    assert.equal(replacement, undefined);
    await options.withSession?.(session);
  },
  async dispose() { releaseBlockedPrompts(); },
});

await runRpcMode(runtime);
