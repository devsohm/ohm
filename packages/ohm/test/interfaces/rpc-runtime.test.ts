import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { defaultSecretRedactor } from "../../src/auth/redaction.js";
import { SettingsManager } from "../../src/core/settings-manager.js";
import { isJsonObject, type JsonObject, type JsonValue } from "../../src/core/json.js";
import { boundedRpcErrorMessage } from "../../src/interfaces/rpc-error.js";
import {
  RpcRuntimeDispatcher,
  type RpcRuntimeDispatcherOptions,
  type RpcSessionRuntime,
} from "../../src/interfaces/rpc-runtime.js";
import type {
  RpcBashExecutionUpdate,
  RpcCommand,
} from "../../src/interfaces/rpc-protocol.js";
import type { RpcUnknownCommand } from "../../src/interfaces/rpc.js";
import { ProviderRegistry } from "../../src/providers/registry.js";
import type { ProviderModel } from "../../src/providers/models.js";
import {
  extensionMessages,
  extensionSessionEntries,
  type SessionTreeNode as PublicSessionTreeNode,
} from "../../src/extensions/session-contract.js";
import type { RuntimeExtensionEventMap } from "../../src/extensions/runtime.js";
import { AgentSession, type AgentSessionEvent } from "../../src/service/agent-session.js";
import type {
  AgentSessionBashResult,
  AgentSessionPromptOptions,
  AgentSessionRecoveryResult,
  AgentSessionRun,
  AgentSessionSuspendedRun,
} from "../../src/service/agent-session.js";
import { SessionManager } from "../../src/storage/session-manager.js";
import type { PersistedSessionMessage, SessionContextMessage, SessionEntry, SessionTreeNode } from "../../src/storage/types.js";

type Listener = (event: AgentSessionEvent) => void | Promise<void>;
type RpcTestOutput = Parameters<RpcRuntimeDispatcherOptions["output"]>[0];

interface ForkRecord {
  entryId: string;
  position?: "before" | "at";
}

interface Fixture {
  runtime: RpcSessionRuntime;
  outputs: RpcTestOutput[];
  prompts: Array<{ message: string; options: AgentSessionPromptOptions }>;
  calls: Array<{ method: string; args: unknown[] }>;
  historyMaterializations: { messages: number };
  emit(event: AgentSessionEvent): Promise<void>;
  setPrompt(handler: (message: string, options: AgentSessionPromptOptions) => Promise<AgentSessionRun>): void;
  setBash(
    handler: (
      command: string,
      onChunk: ((chunk: string) => void) | undefined,
      options: { excludeFromContext?: boolean; timeoutMs?: number },
    ) => Promise<AgentSessionBashResult>,
  ): void;
  setRecoveryStatus(status: AgentSessionSuspendedRun | undefined): void;
  setRecovery(
    handler: AgentSession["recoverInterruptedRun"],
  ): void;
  setQueueHandlers(handlers: {
    steer?: (message: string, images?: unknown[]) => Promise<void>;
    followUp?: (message: string, images?: unknown[]) => Promise<void>;
  }): void;
  setAbort(handler: () => Promise<void>): void;
  setTreeRevision(revision: number): void;
  setSessionSnapshot(sessionId: string, messages: SessionContextMessage[], sessionFile?: string): void;
  forks: ForkRecord[];
}

const MODEL: ProviderModel = {
  id: "model",
  name: "Model",
  api: "openai-responses",
  provider: "provider",
  baseUrl: "https://provider.invalid/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.75 },
  contextWindow: 32_000,
  maxTokens: 4_096,
};

function agentSessionFixture(value: Pick<AgentSession, "subscribe">): AgentSession {
  // SAFETY: dispatcher fixtures implement the subscription seam statically;
  // each scenario then exercises every additional member it provides.
  return value as AgentSession;
}

const ENTRIES: SessionEntry[] = [
  {
    type: "thinking_level_change",
    id: "entry-1",
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    thinkingLevel: "off",
  },
  {
    type: "thinking_level_change",
    id: "entry-2",
    parentId: "entry-1",
    timestamp: "2026-01-01T00:00:01.000Z",
    thinkingLevel: "high",
  },
];

const TREE: SessionTreeNode[] = [{ entry: ENTRIES[0]!, children: [{ entry: ENTRIES[1]!, children: [] }] }];

function fixture(
  entries: SessionEntry[] = ENTRIES,
  tree: SessionTreeNode[] = TREE,
  messages: SessionContextMessage[] = [],
): Fixture {
  const listeners = new Set<Listener>();
  const outputs: RpcTestOutput[] = [];
  const prompts: Array<{ message: string; options: AgentSessionPromptOptions }> = [];
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const historyMaterializations = { messages: 0 };
  const forks: ForkRecord[] = [];
  const record = (method: string, ...args: unknown[]): void => { calls.push({ method, args }); };
  let promptHandler = async (_message: string, options: AgentSessionPromptOptions): Promise<AgentSessionRun> => {
    options.preflightResult?.(true);
    return { sessionId: "session", results: [] };
  };
  let bashHandler: (
    command: string,
    onChunk: ((chunk: string) => void) | undefined,
    options: { excludeFromContext?: boolean; timeoutMs?: number },
  ) => Promise<AgentSessionBashResult> = async () => ({
    output: "done",
    exitCode: 0,
    cancelled: false,
    truncated: false,
  });
  let recoveryStatus: AgentSessionSuspendedRun | undefined;
  let recoveryHandler: AgentSession["recoverInterruptedRun"] = async (): Promise<AgentSessionRecoveryResult> => ({
    recovered: false,
    blocked: [],
  });
  let steerHandler = async (_message: string, _images?: unknown[]): Promise<void> => undefined;
  let followUpHandler = async (_message: string, _images?: unknown[]): Promise<void> => undefined;
  let abortHandler = async (): Promise<void> => undefined;
  let treeRevision = 0;
  let currentSessionId = "session";
  let currentSessionFile = "/tmp/session.jsonl";
  let currentMessages = messages;
  let rebind: ((session: AgentSession) => Promise<void>) | undefined;
  const treeEntries: SessionTreeNode[] = [];
  const collectTree = (nodes: readonly SessionTreeNode[]): void => {
    for (const node of nodes) {
      treeEntries.push({ ...structuredClone(node), children: [] });
      collectTree(node.children);
    }
  };
  collectTree(tree);
  const nativeManager = {
    getEntryCount() { return entries.length; },
    getTreeRevision() { return treeRevision; },
    getEntrySequence(id: string) {
      const sequence = entries.findIndex((entry) => entry.id === id);
      return sequence < 0 ? undefined : sequence;
    },
    getEntries() { return structuredClone(entries); },
  } satisfies Pick<SessionManager, "getEntries" | "getEntryCount" | "getEntrySequence" | "getTreeRevision">;
  const publicManager = {
    getSessionFile() { return currentSessionFile; },
    getLeafId() { return extensionSessionEntries(entries).at(-1)?.id ?? null; },
    getEntries() { return extensionSessionEntries(entries); },
    getEntriesPage(offset: number, limit: number) {
      const projected = extensionSessionEntries(entries);
      return {
        entries: projected.slice(offset, offset + limit),
        totalEntries: projected.length,
      };
    },
    getLabel(id: string) { return treeEntries.find((node) => node.entry.id === id)?.label; },
    buildSessionContext() {
      return {
        model: null,
        thinkingLevel: "off",
        messages: currentMessages.flatMap((message) => {
          if (message.role === "branchSummary" || message.role === "compactionSummary") {
            return [structuredClone(message)];
          }
          return extensionMessages(message);
        }),
      };
    },
  } satisfies Pick<
    AgentSession["sessionManager"],
    "buildSessionContext" | "getEntries" | "getEntriesPage" | "getLabel" | "getLeafId" | "getSessionFile"
  >;
  const sessionFixture = {
    prompt(message: string, options: AgentSessionPromptOptions) {
      prompts.push({ message, options });
      return promptHandler(message, options);
    },
    subscribe(listener: Listener) { listeners.add(listener); return () => listeners.delete(listener); },
    onEvent(listener: Listener) { listeners.add(listener); return () => listeners.delete(listener); },
    get sessionManager() { return publicManager; },
    get nativeSessionManager() { return nativeManager; },
    get sessionId() { return currentSessionId; },
    get messages() {
      historyMaterializations.messages += 1;
      return structuredClone(currentMessages);
    },
    get model() { return { provider: MODEL.provider, api: MODEL.api, id: MODEL.id }; },
    get modelRegistry() {
      return {
        find(provider: string, id: string) { return provider === MODEL.provider && id === MODEL.id ? MODEL : undefined; },
        async getAvailable() { return [MODEL]; },
      };
    },
    get modelRuntime() {
      return {
        getModel(provider: string, id: string) {
          return provider === MODEL.provider && id === MODEL.id ? MODEL : undefined;
        },
        async getAvailable() { return [MODEL]; },
      };
    },
    hasExtensionHandlers() { return false; },
    get extensionRunner() {
      return {
        getRegisteredCommands() {
          return [{
            name: "extension-command",
            invocationName: "extension-command",
            description: "Extension command",
            sourceInfo: {
              path: "/tmp/extension.mjs",
              source: "extension",
              scope: "temporary",
              origin: "package",
            },
          }];
        },
      };
    },
    get promptTemplates() {
      return [{
        name: "prompt-command",
        description: "Prompt command",
        sourceInfo: { path: "/tmp/prompt.md", source: "prompt", scope: "temporary", origin: "top-level" },
      }];
    },
    get resourceLoader() {
      return {
        getSkills() {
          return {
            skills: [
              {
                name: "prompt-command",
                description: "Prompt-owned skill command",
                sourceInfo: { path: "/tmp/prompt-skill/SKILL.md", source: "skill", scope: "temporary", origin: "top-level" },
              },
              {
                name: "skill-command",
                description: "Skill command",
                sourceInfo: { path: "/tmp/SKILL.md", source: "skill", scope: "temporary", origin: "top-level" },
              },
            ],
          };
        },
      };
    },
    get thinkingLevel() { return "high"; },
    get isStreaming() { return false; },
    get isCompacting() { return false; },
    get steeringMode() { return "all"; },
    get followUpMode() { return "one-at-a-time"; },
    get sessionFile() { return "/tmp/session.jsonl"; },
    get sessionName() { return "Session"; },
    get autoCompactionEnabled() { return true; },
    get pendingMessageCount() { return 0; },
    get suspendedRun() {
      return recoveryStatus === undefined ? undefined : structuredClone(recoveryStatus);
    },
    async recoverInterruptedRun(...args: Parameters<AgentSession["recoverInterruptedRun"]>) {
      record("recoverInterruptedRun", ...args);
      return await recoveryHandler(...args);
    },
    async abort() { record("abort"); await abortHandler(); },
    async steer(message: string, images?: unknown[]) {
      record("steer", message, images);
      await steerHandler(message, images);
    },
    async followUp(message: string, images?: unknown[]) {
      record("followUp", message, images);
      await followUpHandler(message, images);
    },
    clearQueue() {
      record("clearQueue");
      return { steering: ["cancelled steer"], followUp: ["cancelled follow-up"] };
    },
    setThinkingLevel(...args: unknown[]) { record("setThinkingLevel", ...args); },
    cycleThinkingLevel() { record("cycleThinkingLevel"); return "xhigh"; },
    getAvailableThinkingLevels() { record("getAvailableThinkingLevels"); return ["off", "high", "xhigh"]; },
    setSteeringMode(...args: unknown[]) { record("setSteeringMode", ...args); },
    setFollowUpMode(...args: unknown[]) { record("setFollowUpMode", ...args); },
    async compact(...args: unknown[]) { record("compact", ...args); return { sessionId: "session", results: [] }; },
    setAutoCompactionEnabled(...args: unknown[]) { record("setAutoCompactionEnabled", ...args); },
    setAutoRetryEnabled(...args: unknown[]) { record("setAutoRetryEnabled", ...args); },
    abortRetry() { record("abortRetry"); },
    async executeBash(
      command: string,
      onChunk: ((chunk: string) => void) | undefined,
      options: { excludeFromContext?: boolean; timeoutMs?: number },
    ) {
      record("executeBash", command, onChunk === undefined ? "undefined" : "function", options);
      return await bashHandler(command, onChunk, options);
    },
    abortBash() { record("abortBash"); },
    getSessionStats() {
      record("getSessionStats");
      return {
        sessionFile: "/tmp/session.jsonl",
        sessionId: "session",
        userMessages: 1,
        assistantMessages: 1,
        toolCalls: 0,
        toolResults: 0,
        totalMessages: 2,
        usage: {},
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        cost: 0,
        usageBreakdown: [],
      };
    },
    async exportToHtml(...args: unknown[]) { record("exportToHtml", ...args); return "/tmp/session.html"; },
    async setModel(...args: unknown[]) { record("setModel", ...args); },
    async cycleModel() {
      record("cycleModel");
      return { model: MODEL, thinkingLevel: "high" as const, isScoped: true };
    },
    getUserMessagesForForking() { record("getUserMessagesForForking"); return [{ entryId: "entry-1", text: "hello" }]; },
    getLastAssistantText() { record("getLastAssistantText"); return "answer"; },
    setSessionName(...args: unknown[]) { record("setSessionName", ...args); },
  };
  const session = agentSessionFixture(sessionFixture);
  const runtime: RpcSessionRuntime = {
    session,
    async newSession(...args) { record("newSession", ...args); await rebind?.(session); return { cancelled: false }; },
    async switchSession(...args) { record("switchSession", ...args); await rebind?.(session); return { cancelled: false }; },
    async fork(entryId, options) {
      record("fork", entryId, options);
      const fork: ForkRecord = { entryId };
      if (options?.position !== undefined) fork.position = options.position;
      forks.push(fork);
      await rebind?.(session);
      return { cancelled: false };
    },
    setRebindSession(callback) { rebind = callback; },
    setBeforeSessionInvalidate() {},
  };
  return {
    runtime,
    outputs,
    prompts,
    calls,
    historyMaterializations,
    forks,
    setPrompt(handler) { promptHandler = handler; },
    setBash(handler) { bashHandler = handler; },
    setRecoveryStatus(status) {
      recoveryStatus = status === undefined ? undefined : structuredClone(status);
    },
    setRecovery(handler) { recoveryHandler = handler; },
    setQueueHandlers(handlers) {
      steerHandler = handlers.steer ?? steerHandler;
      followUpHandler = handlers.followUp ?? followUpHandler;
    },
    setAbort(handler) { abortHandler = handler; },
    setTreeRevision(revision) { treeRevision = revision; },
    setSessionSnapshot(sessionId, nextMessages, sessionFile = currentSessionFile) {
      currentSessionId = sessionId;
      currentSessionFile = sessionFile;
      currentMessages = nextMessages;
    },
    async emit(event) {
      for (const listener of listeners) await listener(event);
    },
  };
}

async function turn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function runtimeForSession(session: AgentSession): RpcSessionRuntime {
  return {
    session,
    async newSession() { return { cancelled: false }; },
    async switchSession() { return { cancelled: false }; },
    async fork() { return { cancelled: false }; },
    setRebindSession() {},
    setBeforeSessionInvalidate() {},
  };
}

function callObjectArgument(
  call: { method: string; args: unknown[] },
  index: number,
): JsonObject {
  const argument = call.args[index];
  assert.ok(isJsonObject(argument));
  return argument;
}

test("RPC dispatcher binds the replacement supplied before runtime publication", async () => {
  const initialListeners = new Set<Listener>();
  const replacementListeners = new Set<Listener>();
  const session = (id: string, listeners: Set<Listener>): AgentSession => {
    const candidate = {
      sessionId: id,
      subscribe(listener: Listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    return agentSessionFixture(candidate);
  };
  const initial = session("initial", initialListeners);
  const replacement = session("replacement", replacementListeners);
  let current = initial;
  let rebind: ((session: AgentSession) => Promise<void>) | undefined;
  let beforeInvalidate: (() => void) | undefined;
  const runtime: RpcSessionRuntime = {
    get session() { return current; },
    async newSession() { return { cancelled: false }; },
    async switchSession() { return { cancelled: false }; },
    async fork() { return { cancelled: false }; },
    setRebindSession(callback?: (session: AgentSession) => Promise<void>) { rebind = callback; },
    setBeforeSessionInvalidate(callback?: () => void) { beforeInvalidate = callback; },
  };
  const outputs: RpcTestOutput[] = [];
  const bound: string[] = [];
  const dispatcher = new RpcRuntimeDispatcher({
    runtime,
    output(record) { outputs.push(record); },
    async bindSession(candidate) { bound.push(candidate.sessionId); },
  });

  await dispatcher.start();
  beforeInvalidate?.();
  await rebind?.(replacement);
  current = replacement;
  const event: AgentSessionEvent = { type: "thinking_level_changed", level: "high" };
  for (const listener of replacementListeners) await listener(event);

  assert.deepEqual(bound, ["initial", "replacement"]);
  assert.equal(initialListeners.size, 0);
  assert.equal(replacementListeners.size, 1);
  assert.deepEqual(outputs, [event]);
  await dispatcher.close();
  assert.equal(replacementListeners.size, 0);
});

test("RPC prompt responds only after successful preflight and emits raw agent events", async () => {
  const value = fixture();
  value.setPrompt(async (_message, options) => {
    options.preflightResult?.(true);
    options.preflightResult?.(true);
    return { sessionId: "session", results: [] };
  });
  const dispatcher = new RpcRuntimeDispatcher({ runtime: value.runtime, output(record) { value.outputs.push(record); } });
  await dispatcher.start();

  assert.equal(await dispatcher.dispatch({ id: "req_1", type: "prompt", message: "hello" }), undefined);
  await turn();
  assert.deepEqual(value.outputs, [{ id: "req_1", type: "response", command: "prompt", success: true }]);
  await value.emit({ type: "agent_end", messages: [], willRetry: false });
  assert.deepEqual(value.outputs[1], { type: "agent_end", messages: [], willRetry: false });
  await value.emit({ type: "bash_execution_update", id: "session-owned", delta: "duplicate" });
  assert.equal(value.outputs.length, 2);
  await dispatcher.close();
});

test("RPC prompt dispatch remains active until prompt preflight settles", async () => {
  const value = fixture();
  let releasePreflight!: () => void;
  const preflight = new Promise<void>((resolve) => { releasePreflight = resolve; });
  value.setPrompt(async (_message, options) => {
    await preflight;
    options.preflightResult?.(true);
    return { sessionId: "session", results: [] };
  });
  const dispatcher = new RpcRuntimeDispatcher({ runtime: value.runtime, output(record) { value.outputs.push(record); } });
  await dispatcher.start();

  let settled = false;
  const operation = dispatcher.dispatch({ id: "bounded-prompt", type: "prompt", message: "wait" })
    .finally(() => { settled = true; });
  await turn();
  assert.equal(settled, false);
  assert.deepEqual(value.outputs, []);

  releasePreflight();
  assert.equal(await operation, undefined);
  assert.deepEqual(value.outputs, [{ id: "bounded-prompt", type: "response", command: "prompt", success: true }]);
  await dispatcher.close();
});

test("RPC abort can cancel a prompt whose preflight still owns a handler", async () => {
  const value = fixture();
  let rejectPrompt!: (error: Error) => void;
  const pendingPrompt = new Promise<AgentSessionRun>((_resolve, reject) => { rejectPrompt = reject; });
  value.setPrompt(async () => await pendingPrompt);
  value.setAbort(async () => { rejectPrompt(new Error("prompt cancelled")); });
  const dispatcher = new RpcRuntimeDispatcher({ runtime: value.runtime, output(record) { value.outputs.push(record); } });
  await dispatcher.start();

  const prompt = dispatcher.dispatch({ id: "pending-prompt", type: "prompt", message: "wait" });
  await turn();
  assert.deepEqual(await dispatcher.dispatch({ id: "cancel", type: "abort" }), {
    id: "cancel",
    type: "response",
    command: "abort",
    success: true,
  });
  assert.equal(await prompt, undefined);
  assert.deepEqual(value.outputs, [{
    id: "pending-prompt",
    type: "response",
    command: "prompt",
    success: false,
    error: "prompt cancelled",
  }]);
  await dispatcher.close();
});

test("RPC prompt applies the current tool policy as an immutable per-run ceiling", async () => {
  const value = fixture();
  let allowedTools = ["read"];
  const dispatcher = new RpcRuntimeDispatcher({
    runtime: value.runtime,
    output(record) { value.outputs.push(record); },
    promptOptions(session) {
      assert.equal(session, value.runtime.session);
      return { allowedTools: [...allowedTools], excludedTools: ["bash"] };
    },
  });
  await dispatcher.start();

  await dispatcher.dispatch({ id: "policy_1", type: "prompt", message: "first" });
  await turn();
  allowedTools = ["read", "grep"];
  await dispatcher.dispatch({ id: "policy_2", type: "prompt", message: "second" });
  await turn();

  assert.deepEqual(value.prompts.map(({ options }) => ({
    allowedTools: options.allowedTools,
    excludedTools: options.excludedTools,
  })), [
    { allowedTools: ["read"], excludedTools: ["bash"] },
    { allowedTools: ["read", "grep"], excludedTools: ["bash"] },
  ]);
  await dispatcher.close();
});

test("RPC forwards branch-summary retry lifecycle events without reshaping them", async () => {
  const value = fixture();
  const dispatcher = new RpcRuntimeDispatcher({ runtime: value.runtime, output(record) { value.outputs.push(record); } });
  await dispatcher.start();
  const events: AgentSessionEvent[] = [
    {
      type: "summarization_retry_scheduled",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 2_000,
      errorMessage: "connection reset",
    },
    { type: "summarization_retry_attempt_start", source: "branchSummary" },
    { type: "summarization_retry_finished" },
  ];

  for (const event of events) await value.emit(event);

  assert.deepEqual(value.outputs, events);
  await dispatcher.close();
});

test("RPC prompt reports failures before preflight and preserves streaming behavior", async () => {
  const value = fixture();
  value.setPrompt(async () => { throw new Error("preflight failed"); });
  const dispatcher = new RpcRuntimeDispatcher({ runtime: value.runtime, output(record) { value.outputs.push(record); } });
  await dispatcher.start();
  assert.equal(await dispatcher.dispatch({ id: "req_fail", type: "prompt", message: "bad" }), undefined);
  await turn();
  assert.deepEqual(value.outputs, [{
    id: "req_fail",
    type: "response",
    command: "prompt",
    success: false,
    error: "preflight failed",
  }]);

  value.outputs.length = 0;
  value.setPrompt(async (_message, options) => {
    options.preflightResult?.(true);
    return { sessionId: "session", results: [] };
  });
  await dispatcher.dispatch({ id: "req_queue", type: "prompt", message: "next", streamingBehavior: "followUp" });
  await turn();
  assert.equal(value.prompts.at(-1)?.options.streamingBehavior, "followUp");
  assert.deepEqual(value.outputs, [{ id: "req_queue", type: "response", command: "prompt", success: true }]);
  await dispatcher.close();
});

test("RPC dispatcher failure responses redact registered secrets without changing their schema", async () => {
  const secret = "sk-proj-rpc-dispatch-redaction-1234567890";
  defaultSecretRedactor.register(secret);
  const value = fixture();
  value.setPrompt(async () => { throw new Error(`before-${secret}-after`); });
  const dispatcher = new RpcRuntimeDispatcher({ runtime: value.runtime, output(record) { value.outputs.push(record); } });
  await dispatcher.start();
  await dispatcher.dispatch({ id: "redacted-failure", type: "prompt", message: "fail" });
  await turn();

  assert.deepEqual(value.outputs, [{
    id: "redacted-failure",
    type: "response",
    command: "prompt",
    success: false,
    error: "before-[REDACTED]-after",
  }]);
  await dispatcher.close();
});

test("RPC failure bounds redact a registered secret that crosses the output cutoff", () => {
  const marker = "LEAK-default-max-cutoff-secret-";
  const secret = `${marker}${"s".repeat((64 * 1_024) - marker.length)}`;
  defaultSecretRedactor.register(secret);
  const prefix = "x".repeat(4_080);

  const result = boundedRpcErrorMessage(`${prefix}${secret}-tail`);

  assert.equal(result.startsWith(prefix), true);
  assert.equal(result.slice(prefix.length), "[REDACTED]-tail");
  assert.equal(Buffer.byteLength(result, "utf8") <= 4_096, true);
  assert.doesNotMatch(result, /LEAK-default-max-cutoff/u);
});

test("RPC dispatcher contains hostile thrown values in failure responses", async () => {
  const hostile = new Proxy({}, {
    getPrototypeOf() { throw new Error("prototype trap must not run"); },
    get() { throw new Error("property trap must not run"); },
  });
  const value = fixture();
  Object.defineProperty(value.runtime.session, "getSessionStats", {
    configurable: true,
    value: () => { throw hostile; },
  });
  const dispatcher = new RpcRuntimeDispatcher({ runtime: value.runtime, output(record) { value.outputs.push(record); } });
  await dispatcher.start();

  assert.deepEqual(await dispatcher.dispatch({ id: "hostile", type: "get_session_stats" }), {
    id: "hostile",
    type: "response",
    command: "get_session_stats",
    success: false,
    error: "[Thrown object]",
  });
  await dispatcher.close();
});

test("RPC dispatcher correlates and bounds huge command failures", async () => {
  const value = fixture();
  Object.defineProperty(value.runtime.session, "getSessionStats", {
    configurable: true,
    value: () => {
      throw new Error(`sk-proj-rpc-dispatch-bounded-1234567890 ${"🙂".repeat(5 * 1024 * 1024)}`);
    },
  });
  const dispatcher = new RpcRuntimeDispatcher({ runtime: value.runtime, output(record) { value.outputs.push(record); } });
  await dispatcher.start();

  const response = await dispatcher.dispatch({ id: "huge-dispatch", type: "get_session_stats" });
  assert.equal(response?.id, "huge-dispatch");
  assert.equal(response?.command, "get_session_stats");
  assert.equal(response?.success, false);
  const detail = response?.success === false ? response.error : "";
  assert.ok(Buffer.byteLength(detail, "utf8") <= 4_096);
  assert.match(detail, /\[REDACTED\]/u);
  assert.doesNotMatch(detail, /rpc-dispatch-bounded/u);
  assert.doesNotMatch(detail, /�/u);
  await dispatcher.close();
});

test("RPC model selections preserve request order when catalog lookup overlaps", async () => {
  const alternate: ProviderModel = { ...MODEL, id: "alternate", name: "Alternate" };
  let releaseFirst!: () => void;
  let markFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
  const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let reads = 0;
  const selected: string[] = [];
  const value = fixture();
  Object.defineProperty(value.runtime.session, "modelRegistry", {
    configurable: true,
    value: {
      async getAvailable() {
        reads += 1;
        if (reads === 1) {
          markFirstStarted();
          await firstRelease;
        }
        return [MODEL, alternate];
      },
    },
  });
  Object.defineProperty(value.runtime.session, "setModel", {
    configurable: true,
    value: async (model: ProviderModel) => { selected.push(model.id); },
  });
  const dispatcher = new RpcRuntimeDispatcher({ runtime: value.runtime, output(record) { value.outputs.push(record); } });
  await dispatcher.start();

  const first = dispatcher.dispatch({ id: "first", type: "set_model", provider: MODEL.provider, modelId: MODEL.id });
  await firstStarted;
  const second = dispatcher.dispatch({ id: "second", type: "set_model", provider: alternate.provider, modelId: alternate.id });
  await new Promise<void>((resolve) => setImmediate(resolve));
  releaseFirst();
  await Promise.all([first, second]);

  assert.deepEqual(selected, [MODEL.id, alternate.id]);
  await dispatcher.close();
});

test("an RPC model-control failure does not poison the serialized lane", async () => {
  const alternate: ProviderModel = { ...MODEL, id: "alternate", name: "Alternate" };
  let reads = 0;
  const selected: string[] = [];
  const value = fixture();
  Object.defineProperty(value.runtime.session, "modelRegistry", {
    configurable: true,
    value: {
      async getAvailable() {
        reads += 1;
        if (reads === 1) throw new Error("catalog failed");
        return [alternate];
      },
    },
  });
  Object.defineProperty(value.runtime.session, "setModel", {
    configurable: true,
    value: async (model: ProviderModel) => { selected.push(model.id); },
  });
  const dispatcher = new RpcRuntimeDispatcher({ runtime: value.runtime, output(record) { value.outputs.push(record); } });
  await dispatcher.start();

  const [failed, succeeded] = await Promise.all([
    dispatcher.dispatch({ id: "failed", type: "set_model", provider: MODEL.provider, modelId: MODEL.id }),
    dispatcher.dispatch({ id: "succeeded", type: "set_model", provider: alternate.provider, modelId: alternate.id }),
  ]);

  assert.equal(failed?.success, false);
  assert.equal(succeeded?.success, true);
  assert.deepEqual(selected, [alternate.id]);
  await dispatcher.close();
});

test("RPC image inputs use the public mimeType shape and canonicalize before session calls", async () => {
  const value = fixture();
  value.setPrompt(async (_message, options) => {
    options.preflightResult?.(true);
    return { sessionId: "session", results: [] };
  });
  const dispatcher = new RpcRuntimeDispatcher({ runtime: value.runtime, output(record) { value.outputs.push(record); } });
  await dispatcher.start();
  const image = { type: "image" as const, mimeType: "image/JPG", data: "AA==" };
  const canonical = [{ type: "image", mediaType: "image/jpeg", data: "AA==" }];

  assert.equal(await dispatcher.dispatch({ id: "image-prompt", type: "prompt", message: "inspect", images: [image] }), undefined);
  await turn();
  assert.deepEqual(value.prompts.at(-1)?.options.images, canonical);
  assert.deepEqual(await dispatcher.dispatch({ id: "image-steer", type: "steer", message: "redirect", images: [image] }), {
    id: "image-steer", type: "response", command: "steer", success: true,
  });
  assert.deepEqual(await dispatcher.dispatch({ id: "image-follow", type: "follow_up", message: "later", images: [image] }), {
    id: "image-follow", type: "response", command: "follow_up", success: true,
  });
  assert.deepEqual(value.calls, [
    { method: "steer", args: ["redirect", canonical] },
    { method: "followUp", args: ["later", canonical] },
  ]);
  await dispatcher.close();
});

test("RPC rejects ambiguous internal image fields before calling the session", async () => {
  const value = fixture();
  const dispatcher = new RpcRuntimeDispatcher({ runtime: value.runtime, output(record) { value.outputs.push(record); } });
  await dispatcher.start();
  const command: RpcUnknownCommand = {
    id: "internal-image",
    type: "steer",
    message: "redirect",
    images: [{ type: "image", mediaType: "image/png", data: "AA==" }],
  };

  assert.deepEqual(await dispatcher.dispatch(command), {
    id: "internal-image",
    type: "response",
    command: "steer",
    success: false,
    error: "steer.images[0] contains unsupported field mediaType",
  });
  assert.deepEqual(value.calls, []);

  const malformed: RpcUnknownCommand = {
    id: "malformed-image",
    type: "follow_up",
    message: "later",
    images: [{ type: "image", mimeType: "image/png", data: "AA==\n" }],
  };
  assert.deepEqual(await dispatcher.dispatch(malformed), {
    id: "malformed-image",
    type: "response",
    command: "follow_up",
    success: false,
    error: "follow_up.images[0] is invalid: image data must be valid base64 without whitespace",
  });
  assert.deepEqual(value.calls, []);
  await dispatcher.close();
});

test("RPC model, state, thinking, and queue commands preserve direct session semantics", async () => {
  const value = fixture();
  const dispatcher = new RpcRuntimeDispatcher({ runtime: value.runtime, output(record) { value.outputs.push(record); } });
  await dispatcher.start();

  assert.deepEqual(await dispatcher.dispatch({ id: "state", type: "get_state" }), {
    id: "state",
    type: "response",
    command: "get_state",
    success: true,
    data: {
      model: MODEL,
      thinkingLevel: "high",
      isStreaming: false,
      isCompacting: false,
      steeringMode: "all",
      followUpMode: "one-at-a-time",
      sessionFile: "/tmp/session.jsonl",
      sessionId: "session",
      sessionName: "Session",
      autoCompactionEnabled: true,
      messageCount: 0,
      pendingMessageCount: 0,
    },
  });
  assert.deepEqual(await dispatcher.dispatch({ id: "set-model", type: "set_model", provider: "provider", modelId: "model" }), {
    id: "set-model", type: "response", command: "set_model", success: true, data: MODEL,
  });
  assert.deepEqual(await dispatcher.dispatch({ id: "missing-model", type: "set_model", provider: "provider", modelId: "missing" }), {
    id: "missing-model", type: "response", command: "set_model", success: false,
    error: "Model not found: provider/missing",
  });
  assert.deepEqual(await dispatcher.dispatch({ id: "cycle-model", type: "cycle_model" }), {
    id: "cycle-model", type: "response", command: "cycle_model", success: true,
    data: { model: MODEL, thinkingLevel: "high", isScoped: true },
  });
  assert.deepEqual(await dispatcher.dispatch({ id: "models", type: "get_available_models" }), {
    id: "models", type: "response", command: "get_available_models", success: true, data: { models: [MODEL] },
  });
  assert.deepEqual(await dispatcher.dispatch({ id: "set-thinking", type: "set_thinking_level", level: "high" }), {
    id: "set-thinking", type: "response", command: "set_thinking_level", success: true,
  });
  assert.deepEqual(await dispatcher.dispatch({ id: "cycle-thinking", type: "cycle_thinking_level" }), {
    id: "cycle-thinking", type: "response", command: "cycle_thinking_level", success: true, data: { level: "xhigh" },
  });
  assert.deepEqual(await dispatcher.dispatch({ id: "thinking-levels", type: "get_available_thinking_levels" }), {
    id: "thinking-levels", type: "response", command: "get_available_thinking_levels", success: true,
    data: { levels: ["off", "high", "xhigh"] },
  });
  assert.deepEqual(await dispatcher.dispatch({ id: "steering-mode", type: "set_steering_mode", mode: "one-at-a-time" }), {
    id: "steering-mode", type: "response", command: "set_steering_mode", success: true,
  });
  assert.deepEqual(await dispatcher.dispatch({ id: "follow-up-mode", type: "set_follow_up_mode", mode: "all" }), {
    id: "follow-up-mode", type: "response", command: "set_follow_up_mode", success: true,
  });
  assert.deepEqual(await dispatcher.dispatch({ id: "clear-queue", type: "clear_queue" }), {
    id: "clear-queue",
    type: "response",
    command: "clear_queue",
    success: true,
    data: { steering: ["cancelled steer"], followUp: ["cancelled follow-up"] },
  });

  assert.deepEqual(value.calls, [
    { method: "setModel", args: [MODEL, { persist: false }] },
    { method: "cycleModel", args: [] },
    { method: "setThinkingLevel", args: ["high"] },
    { method: "cycleThinkingLevel", args: [] },
    { method: "getAvailableThinkingLevels", args: [] },
    { method: "setSteeringMode", args: ["one-at-a-time"] },
    { method: "setFollowUpMode", args: ["all"] },
    { method: "clearQueue", args: [] },
  ]);
  await dispatcher.close();
});

test("RPC exposes suspended-run status and passes bounded explicit recovery resolutions", async () => {
  const value = fixture();
  const suspendedRun: AgentSessionSuspendedRun = {
    operationId: "operation-1",
    acceptedAt: "2026-01-01T00:00:00.000Z",
    cancelled: false,
    attempts: 1,
    claimedQueueIds: ["queue-1"],
    effects: [{
      effectId: "effect-1",
      callId: "call-1",
      name: "write",
      policy: "never_repeat",
      status: "in_doubt",
      step: 0,
      index: 0,
      inputHash: "a".repeat(64),
    }],
  };
  value.setRecoveryStatus(suspendedRun);
  value.setRecovery(async (options = {}) => {
    assert.deepEqual(options, {
      resolutions: [{
        effectId: "effect-1",
        outcome: "succeeded",
        result: {
          content: "The write is present.",
          isError: false,
          status: "success",
          metadata: { verified: true },
        },
      }],
    });
    return { recovered: true, operationId: "operation-1", blocked: [] };
  });
  const dispatcher = new RpcRuntimeDispatcher({
    runtime: value.runtime,
    output(record) { value.outputs.push(record); },
  });
  await dispatcher.start();

  assert.deepEqual(await dispatcher.dispatch({ id: "status", type: "get_recovery_status" }), {
    id: "status",
    type: "response",
    command: "get_recovery_status",
    success: true,
    data: suspendedRun,
  });
  const state = await dispatcher.dispatch({ id: "state", type: "get_state" });
  assert.equal(state?.success, true);
  assert.equal(state?.command, "get_state");
  if (state?.success !== true || state.command !== "get_state") assert.fail("get_state did not succeed");
  assert.deepEqual(state.data, {
    model: MODEL,
    thinkingLevel: "high",
    isStreaming: false,
    isCompacting: false,
    steeringMode: "all",
    followUpMode: "one-at-a-time",
    sessionFile: "/tmp/session.jsonl",
    sessionId: "session",
    sessionName: "Session",
    autoCompactionEnabled: true,
    messageCount: 0,
    pendingMessageCount: 0,
    suspendedRun,
  });
  assert.deepEqual(await dispatcher.dispatch({
    id: "recover",
    type: "recover_interrupted_run",
    resolutions: [{
      effectId: "effect-1",
      outcome: "succeeded",
      result: {
        content: "The write is present.",
        isError: false,
        status: "success",
        metadata: { verified: true },
      },
    }],
  }), {
    id: "recover",
    type: "response",
    command: "recover_interrupted_run",
    success: true,
    data: { recovered: true, operationId: "operation-1", blocked: [] },
  });

  const recoverCalls = value.calls.filter((call) => call.method === "recoverInterruptedRun");
  assert.equal(recoverCalls.length, 1);
  await dispatcher.close();
});

test("RPC rejects oversized recovery tool results before invoking the session", async () => {
  const value = fixture();
  const dispatcher = new RpcRuntimeDispatcher({
    runtime: value.runtime,
    output(record) { value.outputs.push(record); },
  });
  await dispatcher.start();

  assert.deepEqual(await dispatcher.dispatch({
    id: "recover-too-large",
    type: "recover_interrupted_run",
    resolutions: [{
      effectId: "effect-1",
      outcome: "failed",
      result: {
        content: "x".repeat(256 * 1024 + 1),
        isError: true,
      },
    }],
  }), {
    id: "recover-too-large",
    type: "response",
    command: "recover_interrupted_run",
    success: false,
    error: "Recovery resolution 0 requires tool result content within 262144 bytes and an isError flag",
  });
  assert.equal(value.calls.some((call) => call.method === "recoverInterruptedRun"), false);
  await dispatcher.close();
});

test("RPC run-control, compaction, retry, and bash commands call the direct session API", async () => {
  const value = fixture();
  const dispatcher = new RpcRuntimeDispatcher({ runtime: value.runtime, output(record) { value.outputs.push(record); } });
  await dispatcher.start();

  const commands = [
    { command: { id: "steer", type: "steer", message: "now" } as const, expected: { id: "steer", type: "response", command: "steer", success: true } },
    { command: { id: "follow", type: "follow_up", message: "later" } as const, expected: { id: "follow", type: "response", command: "follow_up", success: true } },
    { command: { id: "abort", type: "abort" } as const, expected: { id: "abort", type: "response", command: "abort", success: true } },
    {
      command: { id: "compact", type: "compact", customInstructions: "preserve decisions" } as const,
      expected: { id: "compact", type: "response", command: "compact", success: true, data: { sessionId: "session", results: [] } },
    },
    { command: { id: "auto-compact", type: "set_auto_compaction", enabled: false } as const, expected: { id: "auto-compact", type: "response", command: "set_auto_compaction", success: true } },
    { command: { id: "auto-retry", type: "set_auto_retry", enabled: false } as const, expected: { id: "auto-retry", type: "response", command: "set_auto_retry", success: true } },
    { command: { id: "abort-retry", type: "abort_retry" } as const, expected: { id: "abort-retry", type: "response", command: "abort_retry", success: true } },
    {
      command: { id: "bash", type: "bash", command: "echo done", excludeFromContext: true } as const,
      expected: { id: "bash", type: "response", command: "bash", success: true, data: { output: "done", exitCode: 0, cancelled: false, truncated: false } },
    },
    { command: { id: "abort-bash", type: "abort_bash" } as const, expected: { id: "abort-bash", type: "response", command: "abort_bash", success: true } },
  ];
  for (const item of commands) assert.deepEqual(await dispatcher.dispatch(item.command), item.expected);

  assert.deepEqual(value.calls, [
    { method: "steer", args: ["now", undefined] },
    { method: "followUp", args: ["later", undefined] },
    { method: "abort", args: [] },
    { method: "compact", args: ["preserve decisions"] },
    { method: "setAutoCompactionEnabled", args: [false] },
    { method: "setAutoRetryEnabled", args: [false] },
    { method: "abortRetry", args: [] },
    { method: "executeBash", args: ["echo done", "function", { excludeFromContext: true, id: "bash" }] },
    { method: "abortBash", args: [] },
  ]);
  await dispatcher.close();
});

test("RPC queue commands wait for admission and report asynchronous rejection", async () => {
  const value = fixture();
  let rejectSteer!: (error: Error) => void;
  const pendingSteer = new Promise<void>((_resolve, reject) => { rejectSteer = reject; });
  value.setQueueHandlers({
    async steer() { await pendingSteer; },
    async followUp() { throw new Error("follow-up queue is closed"); },
  });
  const dispatcher = new RpcRuntimeDispatcher({ runtime: value.runtime, output(record) { value.outputs.push(record); } });
  await dispatcher.start();

  let settled = false;
  const steer = dispatcher.dispatch({ id: "steer-rejected", type: "steer", message: "now" })
    .finally(() => { settled = true; });
  await turn();
  assert.equal(settled, false);
  rejectSteer(new Error("steering queue is full"));
  assert.deepEqual(await steer, {
    id: "steer-rejected",
    type: "response",
    command: "steer",
    success: false,
    error: "steering queue is full",
  });
  assert.deepEqual(await dispatcher.dispatch({ id: "follow-rejected", type: "follow_up", message: "later" }), {
    id: "follow-rejected",
    type: "response",
    command: "follow_up",
    success: false,
    error: "follow-up queue is closed",
  });
  await dispatcher.close();
});

test("RPC streams correlated bash output in order before returning the final result", async () => {
  const value = fixture();
  value.setBash(async (_command, onChunk) => {
    onChunk?.("first ");
    onChunk?.("second");
    return { output: "first second", exitCode: 0, cancelled: false, truncated: false };
  });
  const dispatcher = new RpcRuntimeDispatcher({
    runtime: value.runtime,
    async output(record) {
      await Promise.resolve();
      value.outputs.push(record);
    },
  });
  await dispatcher.start();

  const response = await dispatcher.dispatch({ id: "bash-stream", type: "bash", command: "printf output" });
  assert.deepEqual(value.outputs, [
    { type: "bash_execution_update", id: "bash-stream", delta: "first " },
    { type: "bash_execution_update", id: "bash-stream", delta: "second" },
  ]);
  assert.deepEqual(response, {
    id: "bash-stream",
    type: "response",
    command: "bash",
    success: true,
    data: { output: "first second", exitCode: 0, cancelled: false, truncated: false },
  });
  await dispatcher.close();
});

test("RPC preserves a real non-zero bash exit and writes every correlated update before its final response", async (context) => {
  if (process.platform === "win32") {
    context.skip("The real non-zero shell fixture requires a POSIX shell");
    return;
  }
  const cwd = await mkdtemp(join(tmpdir(), "ohm-rpc-bash-exit-"));
  const session = await AgentSession.create({
    sessionManager: SessionManager.inMemory(cwd, { id: "rpc-bash-exit" }),
    providers: new ProviderRegistry(),
    settingsManager: SettingsManager.inMemory(),
  });
  const runtime = runtimeForSession(session);
  const outputs: RpcTestOutput[] = [];
  const lifecycle: AgentSessionEvent[] = [];
  session.subscribe((event) => {
    if (
      event.type === "tool_execution_start" ||
      event.type === "tool_execution_update" ||
      event.type === "tool_execution_end"
    ) lifecycle.push(event);
  });
  const dispatcher = new RpcRuntimeDispatcher({
    runtime,
    async output(record) {
      await Promise.resolve();
      outputs.push(record);
    },
  });
  try {
    await dispatcher.start();
    const response = await dispatcher.dispatch({
      id: "bash-exit-7",
      type: "bash",
      command: "printf 'rpc-out\\n'; printf 'rpc-err\\n' >&2; exit 7",
    });
    assert.ok(response?.success === true && response.command === "bash");
    assert.equal(response.data.exitCode, 7);
    assert.equal(response.data.isError, true);
    assert.equal(response.data.cancelled, false);
    assert.equal(response.data.truncated, false);
    assert.match(response.data.output, /^Tool failed: /u);
    assert.match(response.data.output, /rpc-out/u);
    assert.match(response.data.output, /rpc-err/u);
    assert.match(response.data.output, /Shell command ended with status 7$/u);
    const updates = outputs.filter((record): record is RpcBashExecutionUpdate =>
      record.type === "bash_execution_update");
    assert.equal(updates.length > 0, true);
    assert.equal(updates.every((record) => record.id === "bash-exit-7"), true);
    const streamed = updates.map((record) => record.delta).join("");
    assert.match(streamed, /rpc-out/u);
    assert.match(streamed, /rpc-err/u);
    assert.equal(lifecycle.length > 0, true);
    assert.equal(lifecycle.every((event) =>
      "toolCallId" in event && event.toolCallId === "bash-exit-7"), true);
    assert.equal(lifecycle.at(-1)?.type, "tool_execution_end");
  } finally {
    await dispatcher.close();
    await session.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("RPC preserves extension shell transforms, terminal state, journal input, and post events", async (context) => {
  const cwd = await mkdtemp(join(tmpdir(), "ohm-rpc-shell-transform-"));
  context.after(async () => await rm(cwd, { recursive: true, force: true }));
  const transformedCwd = join(cwd, "transformed");
  await mkdir(transformedCwd);
  const transformedOperations = { async exec() { return { exitCode: 0 }; } };
  const executions: Array<{
    command: string;
    options: Parameters<AgentSession["executeBash"]>[2];
  }> = [];
  const recorded: Array<{ command: string; result: AgentSessionBashResult }> = [];
  const observed: RuntimeExtensionEventMap["event"][] = [];
  const sessionFixture = {
    cwd,
    hasExtensionHandlers(event: string) {
      return event === "before_user_shell" || event === "user_shell";
    },
    extensionRunner: {
      async emitUserBash(event: { command: string }) {
        if (event.command === "outside") return { command: "outside transformed", cwd: join(cwd, "..") };
        if (event.command === "handled") {
          return {
            command: "handled transformed",
            cwd: transformedCwd,
            result: {
              output: "timeout preview",
              isError: false,
              cancelled: false,
              timedOut: true,
              truncated: false,
            },
          };
        }
        if (event.command === "signal") {
          return {
            command: "signal transformed",
            cwd: transformedCwd,
            result: {
              output: "handled signal preview",
              isError: false,
              cancelled: false,
              signal: "SIGTERM",
              truncated: false,
            },
          };
        }
        if (event.command === "cancelled") {
          return {
            command: "cancelled transformed",
            cwd: transformedCwd,
            result: {
              output: "cancelled preview",
              cancelled: true,
              truncated: false,
            },
          };
        }
        return {
          command: "execute transformed",
          cwd: transformedCwd,
          operations: transformedOperations,
        };
      },
      getRuntimeHost() {
        return {
          async dispatch(event: "event", value: RuntimeExtensionEventMap["event"]) {
            if (event === "event") observed.push(value);
          },
        };
      },
    },
    recordBashResult(command: string, result: AgentSessionBashResult) {
      recorded.push({ command, result });
    },
    async executeBash(
      command: string,
      onChunk: ((chunk: string) => void) | undefined,
      options: Parameters<AgentSession["executeBash"]>[2],
    ) {
      executions.push({ command, options });
      onChunk?.("signal preview");
      return {
        output: "signal preview",
        isError: true,
        exitCode: undefined,
        cancelled: false,
        signal: "SIGTERM",
        truncated: false,
      };
    },
    subscribe() { return () => undefined; },
    onEvent() { return () => undefined; },
  };
  const session = agentSessionFixture(sessionFixture);
  const runtime = runtimeForSession(session);
  const outputs: RpcTestOutput[] = [];
  const dispatcher = new RpcRuntimeDispatcher({ runtime, output(record) { outputs.push(record); } });
  await dispatcher.start();
  try {
    const handled = await dispatcher.dispatch({ id: "handled-id", type: "bash", command: "handled" });
    const signalled = await dispatcher.dispatch({ id: "signal-id", type: "bash", command: "signal" });
    const cancelled = await dispatcher.dispatch({ id: "cancelled-id", type: "bash", command: "cancelled" });
    const executed = await dispatcher.dispatch({ id: "execute-id", type: "bash", command: "execute" });
    const outside = await dispatcher.dispatch({ id: "outside-id", type: "bash", command: "outside" });

    assert.ok(handled?.success === true && handled.command === "bash");
    assert.deepEqual(handled.data, {
      output: "timeout preview",
      isError: true,
      exitCode: undefined,
      cancelled: false,
      timedOut: true,
      truncated: false,
    });
    assert.ok(signalled?.success === true && signalled.command === "bash");
    assert.deepEqual(signalled.data, {
      output: "handled signal preview",
      isError: true,
      exitCode: undefined,
      cancelled: false,
      signal: "SIGTERM",
      truncated: false,
    });
    assert.ok(cancelled?.success === true && cancelled.command === "bash");
    assert.deepEqual(cancelled.data, {
      output: "cancelled preview",
      isError: true,
      exitCode: undefined,
      cancelled: true,
      truncated: false,
    });
    assert.deepEqual(recorded, [
      { command: "handled transformed", result: handled.data },
      { command: "signal transformed", result: signalled.data },
      { command: "cancelled transformed", result: cancelled.data },
    ]);
    assert.deepEqual(executions, [{
      command: "execute transformed",
      options: {
        excludeFromContext: false,
        id: "execute-id",
        cwd: transformedCwd,
        operations: transformedOperations,
      },
    }]);
    assert.ok(executed?.success === true && executed.command === "bash");
    assert.equal(executed.data.signal, "SIGTERM");
    assert.ok(outside?.success === false && outside.command === "bash");
    assert.match(outside.error, /escapes workspace/u);
    assert.equal(executions.length, 1);
    assert.deepEqual(observed, [
      {
        type: "user_shell",
        command: "handled transformed",
        hidden: false,
        result: {
          text: "timeout preview",
          exitCode: null,
          isError: true,
          cancelled: false,
          timedOut: true,
          truncated: false,
        },
      },
      {
        type: "user_shell",
        command: "signal transformed",
        hidden: false,
        result: {
          text: "handled signal preview",
          exitCode: null,
          isError: true,
          cancelled: false,
          signal: "SIGTERM",
          truncated: false,
        },
      },
      {
        type: "user_shell",
        command: "cancelled transformed",
        hidden: false,
        result: {
          text: "cancelled preview",
          exitCode: null,
          isError: true,
          cancelled: true,
          signal: "CANCELLED",
          truncated: false,
        },
      },
      {
        type: "user_shell",
        command: "execute transformed",
        hidden: false,
        result: {
          text: "signal preview",
          exitCode: null,
          isError: true,
          cancelled: false,
          signal: "SIGTERM",
          truncated: false,
        },
      },
    ]);
    assert.equal(outputs.some((record) =>
      record.type === "bash_execution_update" && record.id === "execute-id"), true);
  } finally {
    await dispatcher.close();
  }
});

test("RPC bash updates preserve UTF-8 boundaries and terminate a bounded event stream", async () => {
  const value = fixture();
  const unicode = "é".repeat(40_000);
  value.setBash(async (_command, onChunk) => {
    onChunk?.(unicode);
    for (let index = 0; index < 2_100; index += 1) onChunk?.("x");
    return { output: "complete", exitCode: 0, cancelled: false, truncated: false };
  });
  const dispatcher = new RpcRuntimeDispatcher({ runtime: value.runtime, output(record) { value.outputs.push(record); } });
  await dispatcher.start();

  await dispatcher.dispatch({ id: "bash-bounded", type: "bash", command: "large output" });
  const updates = value.outputs.filter((record): record is RpcBashExecutionUpdate =>
    record.type === "bash_execution_update");
  assert.equal(updates.length, 2_048);
  assert.equal(updates.every((event) => event.type === "bash_execution_update" && event.id === "bash-bounded"), true);
  assert.equal(updates.every((event) => Buffer.byteLength(event.delta, "utf8") <= 64 * 1024), true);
  assert.equal(updates.slice(0, 2).map((event) => event.delta).join(""), unicode);
  assert.equal(updates.some((event) => event.delta.includes("�")), false);
  assert.deepEqual(updates.at(-1), {
    type: "bash_execution_update",
    id: "bash-bounded",
    delta: "",
    truncated: true,
  });
  await dispatcher.close();
});

test("RPC session navigation, history, export, and discovery commands preserve values", async () => {
  const value = fixture();
  const dispatcher = new RpcRuntimeDispatcher({ runtime: value.runtime, output(record) { value.outputs.push(record); } });
  await dispatcher.start();

  assert.deepEqual(await dispatcher.dispatch({ id: "new", type: "new_session", parentSession: "/tmp/parent.jsonl" }), {
    id: "new", type: "response", command: "new_session", success: true, data: { cancelled: false },
  });
  assert.deepEqual(await dispatcher.dispatch({ id: "stats", type: "get_session_stats" }), {
    id: "stats", type: "response", command: "get_session_stats", success: true,
    data: {
      sessionFile: "/tmp/session.jsonl",
      sessionId: "session",
      userMessages: 1,
      assistantMessages: 1,
      toolCalls: 0,
      toolResults: 0,
      totalMessages: 2,
      usage: {},
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
      usageBreakdown: [],
    },
  });
  assert.deepEqual(await dispatcher.dispatch({ id: "html", type: "export_html", outputPath: "/tmp/export.html" }), {
    id: "html", type: "response", command: "export_html", success: true, data: { path: "/tmp/session.html" },
  });
  assert.deepEqual(await dispatcher.dispatch({ id: "switch", type: "switch_session", sessionPath: "/tmp/other.jsonl" }), {
    id: "switch", type: "response", command: "switch_session", success: true, data: { cancelled: false },
  });
  assert.deepEqual(await dispatcher.dispatch({ id: "fork", type: "fork", entryId: "entry-1" }), {
    id: "fork", type: "response", command: "fork", success: true, data: { text: "", cancelled: false },
  });
  assert.deepEqual(await dispatcher.dispatch({ id: "fork-messages", type: "get_fork_messages" }), {
    id: "fork-messages", type: "response", command: "get_fork_messages", success: true,
    data: { messages: [{ entryId: "entry-1", text: "hello" }] },
  });
  assert.deepEqual(await dispatcher.dispatch({ id: "entries", type: "get_entries" }), {
    id: "entries", type: "response", command: "get_entries", success: true,
    data: {
      entries: ENTRIES,
      leafId: "entry-2",
      sequenceStart: 1,
      nextSequence: 2,
      hasMore: false,
      totalEntries: 2,
    },
  });
  assert.deepEqual(await dispatcher.dispatch({ id: "entries-since", type: "get_entries", since: "entry-1" }), {
    id: "entries-since", type: "response", command: "get_entries", success: true,
    data: {
      entries: [ENTRIES[1]],
      leafId: "entry-2",
      sequenceStart: 2,
      nextSequence: 2,
      hasMore: false,
      totalEntries: 2,
    },
  });
  assert.deepEqual(await dispatcher.dispatch({ id: "entries-page", type: "get_entries", afterSequence: 0, limit: 1 }), {
    id: "entries-page", type: "response", command: "get_entries", success: true,
    data: {
      entries: [ENTRIES[0]],
      leafId: "entry-2",
      sequenceStart: 1,
      nextSequence: 1,
      hasMore: true,
      totalEntries: 2,
    },
  });
  assert.deepEqual(await dispatcher.dispatch({ id: "entries-missing", type: "get_entries", since: "missing" }), {
    id: "entries-missing", type: "response", command: "get_entries", success: false, error: "Entry not found: missing",
  });
  assert.deepEqual(await dispatcher.dispatch({ id: "entries-conflict", type: "get_entries", since: "entry-1", afterSequence: 1 }), {
    id: "entries-conflict", type: "response", command: "get_entries", success: false,
    error: "Use either since or afterSequence, not both",
  });
  assert.deepEqual(await dispatcher.dispatch({ id: "entries-limit", type: "get_entries", limit: 0 }), {
    id: "entries-limit", type: "response", command: "get_entries", success: false,
    error: "get_entries limit must be between 1 and 2048",
  });
  assert.deepEqual(await dispatcher.dispatch({ id: "tree", type: "get_tree" }), {
    id: "tree", type: "response", command: "get_tree", success: true,
    data: {
      tree: TREE,
      leafId: "entry-2",
      nextCursor: null,
      hasMore: false,
      totalEntries: 2,
    },
  });
  assert.deepEqual(await dispatcher.dispatch({ id: "last", type: "get_last_assistant_text" }), {
    id: "last", type: "response", command: "get_last_assistant_text", success: true, data: { text: "answer" },
  });
  assert.deepEqual(await dispatcher.dispatch({ id: "name", type: "set_session_name", name: "  renamed  " }), {
    id: "name", type: "response", command: "set_session_name", success: true,
  });
  assert.deepEqual(await dispatcher.dispatch({ id: "empty-name", type: "set_session_name", name: "  " }), {
    id: "empty-name", type: "response", command: "set_session_name", success: false,
    error: "A session name must contain text",
  });
  assert.deepEqual(await dispatcher.dispatch({ id: "messages", type: "get_messages" }), {
    id: "messages", type: "response", command: "get_messages", success: true,
    data: { messages: [], nextCursor: null, hasMore: false, totalMessages: 0 },
  });
  const commands = await dispatcher.dispatch({ id: "commands", type: "get_commands" });
  if (commands?.success !== true || commands.command !== "get_commands" || !("data" in commands) || commands.data === null) {
    assert.fail("get_commands did not return its command catalog");
  }
  assert.deepEqual(commands.data.commands.map((command) => [command.name, command.source]), [
    ["extension-command", "extension"],
    ["prompt-command", "prompt"],
    ["skill:prompt-command", "skill"],
    ["skill:skill-command", "skill"],
  ]);

  assert.equal(value.calls.some((entry) => entry.method === "newSession"
    && callObjectArgument(entry, 0)["parentSession"] === "/tmp/parent.jsonl"), true);
  assert.equal(value.calls.some((entry) => entry.method === "switchSession" && entry.args[0] === "/tmp/other.jsonl"), true);
  assert.equal(value.calls.some((entry) => entry.method === "setSessionName" && entry.args[0] === "renamed"), true);
  assert.deepEqual(value.forks, [{ entryId: "entry-1" }]);
  await dispatcher.close();
});

test("RPC history projects split tool results, hides provider traces, and resolves public fork IDs", async () => {
  const assistantMessage = {
    id: "assistant-message",
    role: "assistant",
    content: [
      { type: "thinking", thinking: "private provider trace", visibility: "provider_trace" },
      { type: "text", text: "public answer" },
    ],
    createdAt: "2026-01-01T00:00:00.000Z",
    stopReason: "stop",
  } satisfies SessionContextMessage;
  const toolMessage = {
    id: "tool-message",
    role: "tool",
    content: [
      { type: "tool_result", callId: "call-one", name: "one", content: "first", isError: false },
      { type: "tool_result", callId: "call-two", name: "two", content: "second", isError: true },
    ],
    createdAt: "2026-01-01T00:00:01.000Z",
  } satisfies SessionContextMessage;
  const entries: SessionEntry[] = [
    {
      type: "message",
      id: "assistant-entry",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: assistantMessage,
    },
    {
      type: "message",
      id: "tool-entry",
      parentId: "assistant-entry",
      timestamp: "2026-01-01T00:00:01.000Z",
      message: toolMessage,
    },
    {
      type: "thinking_level_change",
      id: "after-tools",
      parentId: "tool-entry",
      timestamp: "2026-01-01T00:00:02.000Z",
      thinkingLevel: "high",
    },
  ];
  const tree: SessionTreeNode[] = [{
    entry: entries[0]!,
    children: [{
      entry: entries[1]!,
      children: [{ entry: entries[2]!, children: [] }],
    }],
  }];
  const value = fixture(entries, tree, [assistantMessage, toolMessage]);
  const dispatcher = new RpcRuntimeDispatcher({ runtime: value.runtime, output(record) { value.outputs.push(record); } });
  await dispatcher.start();

  const entryResponse = await dispatcher.dispatch({ id: "projected-entries", type: "get_entries" });
  if (entryResponse?.success !== true || entryResponse.command !== "get_entries" || !("data" in entryResponse)) {
    assert.fail("get_entries did not return projected entries");
  }
  assert.deepEqual(entryResponse.data.entries.map((entry) => entry.id), [
    "assistant-entry",
    "tool-entry",
    "tool-entry~1",
    "after-tools",
  ]);
  assert.deepEqual(entryResponse.data.entries.slice(0, 3).map((entry) => entry.type === "message" ? entry.message.role : entry.type), [
    "assistant",
    "toolResult",
    "toolResult",
  ]);
  assert.doesNotMatch(JSON.stringify(entryResponse), /private provider trace/u);

  const afterSplit = await dispatcher.dispatch({ id: "after-split", type: "get_entries", since: "tool-entry~1" });
  if (afterSplit?.success !== true || afterSplit.command !== "get_entries" || !("data" in afterSplit)) {
    assert.fail("get_entries did not resolve a split public entry ID");
  }
  assert.deepEqual(afterSplit.data.entries.map((entry) => entry.id), ["after-tools"]);

  const messageResponse = await dispatcher.dispatch({ id: "projected-messages", type: "get_messages" });
  if (messageResponse?.success !== true || messageResponse.command !== "get_messages" || !("data" in messageResponse)) {
    assert.fail("get_messages did not return projected messages");
  }
  assert.deepEqual(messageResponse.data.messages.map((message) => message.role), [
    "assistant",
    "toolResult",
    "toolResult",
  ]);
  assert.doesNotMatch(JSON.stringify(messageResponse), /private provider trace/u);

  await dispatcher.dispatch({ id: "fork-split", type: "fork", entryId: "tool-entry~1" });
  assert.deepEqual(value.forks, [{ entryId: "tool-entry" }]);
  await dispatcher.close();
});

test("RPC history retains durable extension provenance on custom records", async () => {
  const provenance = {
    schemaVersion: 1 as const,
    extensionId: "example.extension",
    sourceSha256: "a".repeat(64),
    packageVersion: "1.2.3",
    packageContentSha256: "b".repeat(64),
    manifestSha256: "c".repeat(64),
  };
  const customMessage = {
    role: "custom" as const,
    customType: "example.message",
    content: "Ready",
    display: true,
    timestamp: 1,
    provenance,
  };
  const entries: SessionEntry[] = [
    {
      type: "custom",
      id: "custom-state",
      parentId: null,
      timestamp: "2026-08-21T00:00:00.000Z",
      customType: "example.state",
      data: { ready: true },
      provenance,
    },
    {
      type: "custom_message",
      id: "custom-entry",
      parentId: "custom-state",
      timestamp: "2026-08-21T00:00:01.000Z",
      customType: "example.entry",
      content: "Ready",
      display: true,
      provenance,
    },
    {
      type: "message",
      id: "custom-message",
      parentId: "custom-entry",
      timestamp: "2026-08-21T00:00:02.000Z",
      message: customMessage,
    },
  ];
  const tree: SessionTreeNode[] = [{
    entry: entries[0]!,
    children: [{ entry: entries[1]!, children: [{ entry: entries[2]!, children: [] }] }],
  }];
  const value = fixture(entries, tree, [customMessage]);
  const dispatcher = new RpcRuntimeDispatcher({ runtime: value.runtime, output(record) { value.outputs.push(record); } });
  await dispatcher.start();

  const entryResponse = await dispatcher.dispatch({ id: "custom-entries", type: "get_entries" });
  if (entryResponse?.success !== true || entryResponse.command !== "get_entries" || !("data" in entryResponse)) {
    assert.fail("get_entries did not return custom entries");
  }
  assert.deepEqual(entryResponse.data.entries.map((entry) => {
    if (entry.type === "message" && entry.message.role === "custom") return entry.message.provenance;
    if (entry.type === "custom" || entry.type === "custom_message") return entry.provenance;
    return undefined;
  }), [provenance, provenance, provenance]);

  const treeResponse = await dispatcher.dispatch({ id: "custom-tree", type: "get_tree" });
  if (treeResponse?.success !== true || treeResponse.command !== "get_tree" || !("data" in treeResponse)) {
    assert.fail("get_tree did not return custom entries");
  }
  const nestedMessage = treeResponse.data.tree[0]?.children[0]?.children[0]?.entry;
  assert.equal(nestedMessage?.type, "message");
  if (nestedMessage?.type !== "message" || nestedMessage.message.role !== "custom") {
    assert.fail("get_tree did not retain the custom message");
  }
  assert.deepEqual(nestedMessage.message.provenance, provenance);

  const messageResponse = await dispatcher.dispatch({ id: "custom-messages", type: "get_messages" });
  if (messageResponse?.success !== true || messageResponse.command !== "get_messages" || !("data" in messageResponse)) {
    assert.fail("get_messages did not return custom messages");
  }
  assert.equal(messageResponse.data.messages[0]?.role, "custom");
  if (messageResponse.data.messages[0]?.role !== "custom") assert.fail("missing custom message");
  assert.deepEqual(messageResponse.data.messages[0].provenance, provenance);
  await dispatcher.close();
});

test("RPC tree and context history use bounded deterministic snapshot pages", async () => {
  const entries: SessionEntry[] = Array.from({ length: 5 }, (_, index) => ({
    type: "thinking_level_change",
    id: `page-${index + 1}`,
    parentId: index === 0 ? null : `page-${index}`,
    timestamp: `2026-01-01T00:00:0${index}.000Z`,
    thinkingLevel: "off",
  }));
  const tree: SessionTreeNode[] = [{
    entry: entries[0]!,
    children: [{
      entry: entries[1]!,
      children: [{
        entry: entries[2]!,
        children: [{
          entry: entries[3]!,
          children: [{ entry: entries[4]!, children: [] }],
        }],
      }],
    }],
  }];
  const messages: SessionContextMessage[] = Array.from({ length: 5 }, (_, index) => ({
    id: `message-${index + 1}`,
    role: "user",
    content: [{ type: "text", text: `message-${index + 1}` }],
    createdAt: new Date(index + 1).toISOString(),
  }));
  const publicMessages = Array.from({ length: 5 }, (_, index) => ({
    role: "user" as const,
    content: [{ type: "text" as const, text: `message-${index + 1}` }],
    timestamp: index + 1,
  }));
  const value = fixture(entries, tree, messages);
  const dispatcher = new RpcRuntimeDispatcher({ runtime: value.runtime, output(record) { value.outputs.push(record); } });
  await dispatcher.start();
  const treeIds = (nodes: readonly PublicSessionTreeNode[]): string[] =>
    nodes.flatMap((node) => [node.entry.id, ...treeIds(node.children)]);

  const firstTree = await dispatcher.dispatch({ id: "tree-1", type: "get_tree", limit: 2 });
  if (firstTree?.success !== true || firstTree.command !== "get_tree" || !("data" in firstTree)) {
    assert.fail("get_tree did not return a page");
  }
  assert.deepEqual(treeIds(firstTree.data.tree), ["page-1", "page-2"]);
  assert.equal(firstTree.data.totalEntries, 5);
  assert.equal(firstTree.data.hasMore, true);
  const firstTreeCursor = firstTree.data.nextCursor;
  if (firstTreeCursor === null) assert.fail("first tree page did not return a cursor");

  const repeatedTree = await dispatcher.dispatch({ id: "tree-repeat", type: "get_tree", limit: 2 });
  if (repeatedTree?.success !== true || repeatedTree.command !== "get_tree" || !("data" in repeatedTree)) {
    assert.fail("repeated get_tree did not return a page");
  }
  assert.deepEqual(repeatedTree.data, firstTree.data);

  const secondTree = await dispatcher.dispatch({
    id: "tree-2",
    type: "get_tree",
    cursor: firstTreeCursor,
    limit: 2,
  });
  if (secondTree?.success !== true || secondTree.command !== "get_tree" || !("data" in secondTree)) {
    assert.fail("continued get_tree did not return a page");
  }
  assert.deepEqual(treeIds(secondTree.data.tree), ["page-3", "page-4"]);
  assert.equal(secondTree.data.hasMore, true);
  const secondTreeCursor = secondTree.data.nextCursor;
  assert.notEqual(secondTreeCursor, null);

  const thirdTree = await dispatcher.dispatch({
    id: "tree-3",
    type: "get_tree",
    cursor: secondTreeCursor,
    limit: 2,
  });
  if (thirdTree?.success !== true || thirdTree.command !== "get_tree" || !("data" in thirdTree)) {
    assert.fail("final get_tree did not return a page");
  }
  assert.deepEqual(treeIds(thirdTree.data.tree), ["page-5"]);
  assert.equal(thirdTree.data.hasMore, false);
  assert.equal(thirdTree.data.nextCursor, null);

  const firstMessages = await dispatcher.dispatch({ id: "messages-1", type: "get_messages", limit: 2 });
  if (firstMessages?.success !== true || firstMessages.command !== "get_messages" || !("data" in firstMessages)) {
    assert.fail("get_messages did not return a page");
  }
  assert.deepEqual(firstMessages.data.messages, publicMessages.slice(0, 2));
  assert.equal(firstMessages.data.totalMessages, 5);
  assert.equal(firstMessages.data.hasMore, true);
  const firstMessageCursor = firstMessages.data.nextCursor;
  assert.notEqual(firstMessageCursor, null);
  const secondMessages = await dispatcher.dispatch({
    id: "messages-2",
    type: "get_messages",
    cursor: firstMessageCursor,
    limit: 2,
  });
  if (secondMessages?.success !== true || secondMessages.command !== "get_messages" || !("data" in secondMessages)) {
    assert.fail("continued get_messages did not return a page");
  }
  assert.deepEqual(secondMessages.data.messages, publicMessages.slice(2, 4));
  assert.equal(value.historyMaterializations.messages, 0);

  assert.deepEqual(await dispatcher.dispatch({ id: "bad-tree-cursor", type: "get_tree", cursor: "not-base64!" }), {
    id: "bad-tree-cursor",
    type: "response",
    command: "get_tree",
    success: false,
    error: "get_tree cursor is invalid",
  });
  assert.deepEqual(await dispatcher.dispatch({
    id: "wrong-cursor-kind",
    type: "get_messages",
    cursor: firstTreeCursor,
  }), {
    id: "wrong-cursor-kind",
    type: "response",
    command: "get_messages",
    success: false,
    error: "get_messages cursor is invalid",
  });
  assert.deepEqual(await dispatcher.dispatch({ id: "bad-tree-limit", type: "get_tree", limit: 0 }), {
    id: "bad-tree-limit",
    type: "response",
    command: "get_tree",
    success: false,
    error: "get_tree limit must be between 1 and 2048",
  });
  assert.deepEqual(await dispatcher.dispatch({ id: "bad-message-limit", type: "get_messages", limit: 2.5 }), {
    id: "bad-message-limit",
    type: "response",
    command: "get_messages",
    success: false,
    error: "get_messages limit must be between 1 and 2048",
  });
  const outsidePayload: JsonValue = JSON.parse(
    Buffer.from(firstTreeCursor, "base64url").toString("utf8"),
  );
  assert.ok(isJsonObject(outsidePayload));
  outsidePayload.offset = 999;
  const outsideCursor = Buffer.from(JSON.stringify(outsidePayload), "utf8").toString("base64url");
  assert.deepEqual(await dispatcher.dispatch({ id: "outside-tree-cursor", type: "get_tree", cursor: outsideCursor }), {
    id: "outside-tree-cursor",
    type: "response",
    command: "get_tree",
    success: false,
    error: "get_tree cursor is outside the session history",
  });

  value.setTreeRevision(1);
  assert.deepEqual(await dispatcher.dispatch({
    id: "stale-tree-label-cursor",
    type: "get_tree",
    cursor: firstTreeCursor,
  }), {
    id: "stale-tree-label-cursor",
    type: "response",
    command: "get_tree",
    success: false,
    error: "get_tree cursor no longer matches the current session history",
  });

  entries.push({
    type: "thinking_level_change",
    id: "page-6",
    parentId: "page-5",
    timestamp: "2026-01-01T00:00:05.000Z",
    thinkingLevel: "high",
  });
  assert.deepEqual(await dispatcher.dispatch({
    id: "stale-tree-cursor",
    type: "get_tree",
    cursor: firstTreeCursor,
  }), {
    id: "stale-tree-cursor",
    type: "response",
    command: "get_tree",
    success: false,
    error: "get_tree cursor no longer matches the current session history",
  });
  await dispatcher.close();
});

test("RPC context pages clone only the selected page and remain mutation-isolated", async () => {
  const messages: SessionContextMessage[] = Array.from({ length: 5 }, (_, index) => ({
    id: `clone-message-${index + 1}`,
    role: "user",
    content: [{ type: "text", text: `clone-message-${index + 1}` }],
    createdAt: new Date(index + 1).toISOString(),
  }));
  const value = fixture(ENTRIES, TREE, messages);
  const dispatcher = new RpcRuntimeDispatcher({ runtime: value.runtime, output(record) { value.outputs.push(record); } });
  await dispatcher.start();

  const originalStructuredClone = globalThis.structuredClone;
  let fullContextClones = 0;
  const countingStructuredClone = <Value>(
    input: Value,
    options?: StructuredSerializeOptions,
  ): Value => {
    if (
      Array.isArray(input) &&
      input.length === messages.length &&
      input.every((entry) => isJsonObject(entry) && entry.role === "user" && Array.isArray(entry.content))
    ) fullContextClones += 1;
    return originalStructuredClone(input, options);
  };
  globalThis.structuredClone = countingStructuredClone;
  try {
    let cursor: string | undefined;
    for (let index = 0; index < messages.length; index += 1) {
      const command: Extract<RpcCommand, { type: "get_messages" }> = {
        id: `clone-page-${index + 1}`,
        type: "get_messages",
        limit: 1,
      };
      if (cursor !== undefined) command.cursor = cursor;
      const response = await dispatcher.dispatch(command);
      if (response?.success !== true || response.command !== "get_messages" || !("data" in response)) {
        assert.fail("get_messages did not return a page");
      }
      assert.equal(response.data.messages.length, 1);
      cursor = response.data.nextCursor ?? undefined;
    }

    const first = await dispatcher.dispatch({ id: "clone-first", type: "get_messages", limit: 1 });
    if (first?.success !== true || first.command !== "get_messages" || !("data" in first)) {
      assert.fail("get_messages did not return the first page");
    }
    const firstMessage = first.data.messages[0];
    if (firstMessage?.role !== "user") assert.fail("get_messages did not return a user message");
    if (!Array.isArray(firstMessage.content)) assert.fail("get_messages did not return block content");
    const block = firstMessage.content[0];
    if (block?.type !== "text") assert.fail("get_messages did not return text content");
    Reflect.set(block, "text", "mutated by caller");

    const repeated = await dispatcher.dispatch({ id: "clone-repeat", type: "get_messages", limit: 1 });
    if (repeated?.success !== true || repeated.command !== "get_messages" || !("data" in repeated)) {
      assert.fail("get_messages did not return the repeated page");
    }
    const repeatedMessage = repeated.data.messages[0];
    if (repeatedMessage?.role !== "user") assert.fail("get_messages did not return a user message");
    if (!Array.isArray(repeatedMessage.content)) assert.fail("get_messages did not return block content");
    assert.equal(repeatedMessage.content[0]?.type === "text"
      ? repeatedMessage.content[0].text
      : undefined, "clone-message-1");
    assert.equal(fullContextClones, 1);
  } finally {
    globalThis.structuredClone = originalStructuredClone;
    await dispatcher.close();
  }
});

test("RPC message cache follows an in-place session switch with the same history shape", async () => {
  const firstMessages: PersistedSessionMessage[] = [{
    id: "shared-message-1",
    role: "user",
    content: [{ type: "text", text: "first session" }],
    createdAt: "2026-01-01T00:00:00.000Z",
  }, {
    id: "shared-message-2",
    role: "user",
    content: [{ type: "text", text: "first session page two" }],
    createdAt: "2026-01-01T00:00:01.000Z",
  }];
  const secondMessages: PersistedSessionMessage[] = [{
    id: "shared-message-1",
    role: "user",
    content: [{ type: "text", text: "second session" }],
    createdAt: "2026-01-01T00:00:00.000Z",
  }, {
    id: "shared-message-2",
    role: "user",
    content: [{ type: "text", text: "second session page two" }],
    createdAt: "2026-01-01T00:00:01.000Z",
  }];
  const value = fixture(ENTRIES, TREE, firstMessages);
  const dispatcher = new RpcRuntimeDispatcher({ runtime: value.runtime, output(record) { value.outputs.push(record); } });
  await dispatcher.start();

  const before = await dispatcher.dispatch({ id: "before-switch", type: "get_messages", limit: 1 });
  if (before?.success !== true || before.command !== "get_messages" || !("data" in before)) {
    assert.fail("get_messages did not return the first session");
  }
  assert.deepEqual(before.data.messages, extensionMessages(firstMessages[0]!));
  const messageCursor = before.data.nextCursor;
  if (messageCursor === null) assert.fail("get_messages did not return a cursor");
  const beforeTree = await dispatcher.dispatch({ id: "before-tree-switch", type: "get_tree", limit: 1 });
  if (beforeTree?.success !== true || beforeTree.command !== "get_tree" || !("data" in beforeTree)) {
    assert.fail("get_tree did not return the first session");
  }
  const treeCursor = beforeTree.data.nextCursor;
  if (treeCursor === null) assert.fail("get_tree did not return a cursor");

  value.setSessionSnapshot("session", secondMessages, "/tmp/session-after-switch.jsonl");
  assert.deepEqual(await dispatcher.dispatch({
    id: "switch-same-shape",
    type: "switch_session",
    sessionPath: "/tmp/session-after-switch.jsonl",
  }), {
    id: "switch-same-shape",
    type: "response",
    command: "switch_session",
    success: true,
    data: { cancelled: false },
  });
  assert.deepEqual(await dispatcher.dispatch({
    id: "stale-message-file-cursor",
    type: "get_messages",
    cursor: messageCursor,
    limit: 1,
  }), {
    id: "stale-message-file-cursor",
    type: "response",
    command: "get_messages",
    success: false,
    error: "get_messages cursor no longer matches the current session history",
  });
  assert.deepEqual(await dispatcher.dispatch({
    id: "stale-tree-file-cursor",
    type: "get_tree",
    cursor: treeCursor,
    limit: 1,
  }), {
    id: "stale-tree-file-cursor",
    type: "response",
    command: "get_tree",
    success: false,
    error: "get_tree cursor no longer matches the current session history",
  });
  const after = await dispatcher.dispatch({ id: "after-switch", type: "get_messages", limit: 1 });
  if (after?.success !== true || after.command !== "get_messages" || !("data" in after)) {
    assert.fail("get_messages did not return the switched session");
  }
  assert.deepEqual(after.data.messages, extensionMessages(secondMessages[0]!));
  await dispatcher.close();
});

test("RPC history commands preserve complete responses when paging is omitted", async () => {
  const entries: SessionEntry[] = Array.from({ length: 600 }, (_, index) => ({
    type: "thinking_level_change",
    id: `bounded-${index}`,
    parentId: null,
    timestamp: new Date(1_700_000_000_000 + index).toISOString(),
    thinkingLevel: "off",
  }));
  const tree = entries.map((entry) => ({ entry, children: [] }));
  const messages: SessionContextMessage[] = entries.map((_entry, index) => ({
    id: `bounded-message-${index}`,
    role: "user",
    content: [{ type: "text", text: `bounded-${index}` }],
    createdAt: new Date(1_700_000_000_000 + index).toISOString(),
    timestamp: index,
  }));
  const value = fixture(entries, tree, messages);
  const dispatcher = new RpcRuntimeDispatcher({ runtime: value.runtime, output(record) { value.outputs.push(record); } });
  await dispatcher.start();

  const treeResponse = await dispatcher.dispatch({ type: "get_tree" });
  if (treeResponse?.success !== true || treeResponse.command !== "get_tree" || !("data" in treeResponse)) {
    assert.fail("get_tree did not return a page");
  }
  assert.equal(treeResponse.data.tree.length, 600);
  assert.equal(treeResponse.data.hasMore, false);
  assert.equal(treeResponse.data.totalEntries, 600);

  const messageResponse = await dispatcher.dispatch({ type: "get_messages" });
  if (messageResponse?.success !== true || messageResponse.command !== "get_messages" || !("data" in messageResponse)) {
    assert.fail("get_messages did not return a page");
  }
  assert.equal(messageResponse.data.messages.length, 600);
  assert.equal(messageResponse.data.hasMore, false);
  assert.equal(messageResponse.data.totalMessages, 600);
  assert.equal(value.historyMaterializations.messages, 0);
  await dispatcher.close();
});

test("RPC history pages stop before the wire budget and reject one oversized item", async () => {
  const large = "x".repeat(3 * 1024 * 1024);
  const entries: SessionEntry[] = Array.from({ length: 3 }, (_, index) => ({
    type: "custom",
    id: `large-${index}`,
    parentId: null,
    timestamp: new Date(1_700_000_000_000 + index).toISOString(),
    customType: "large",
    data: large,
  }));
  const tree = entries.map((entry) => ({ entry, children: [] }));
  const messages: SessionContextMessage[] = entries.map((_entry, index) => ({
    role: "custom",
    customType: "large",
    content: large,
    display: false,
    timestamp: index,
  }));
  const value = fixture(entries, tree, messages);
  const dispatcher = new RpcRuntimeDispatcher({ runtime: value.runtime, output(record) { value.outputs.push(record); } });
  await dispatcher.start();

  const entryResponse = await dispatcher.dispatch({ type: "get_entries", limit: 2_048 });
  if (entryResponse?.success !== true || entryResponse.command !== "get_entries" || !("data" in entryResponse)) {
    assert.fail("get_entries did not return a byte-bounded page");
  }
  assert.equal(entryResponse.data.entries.length, 2);
  assert.equal(entryResponse.data.hasMore, true);
  assert.equal(entryResponse.data.nextSequence, 2);

  const treeResponse = await dispatcher.dispatch({ type: "get_tree", limit: 2_048 });
  if (treeResponse?.success !== true || treeResponse.command !== "get_tree" || !("data" in treeResponse)) {
    assert.fail("get_tree did not return a byte-bounded page");
  }
  assert.equal(treeResponse.data.tree.length, 2);
  assert.equal(treeResponse.data.hasMore, true);

  const messageResponse = await dispatcher.dispatch({ type: "get_messages", limit: 2_048 });
  if (messageResponse?.success !== true || messageResponse.command !== "get_messages" || !("data" in messageResponse)) {
    assert.fail("get_messages did not return a byte-bounded page");
  }
  assert.equal(messageResponse.data.messages.length, 2);
  assert.equal(messageResponse.data.hasMore, true);
  await dispatcher.close();

  const oversized = "界".repeat(3 * 1024 * 1024);
  const oversizedEntry: SessionEntry = {
    type: "custom",
    id: "oversized",
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    customType: "oversized",
    data: oversized,
  };
  const oversizedMessage: SessionContextMessage = {
    role: "custom",
    customType: "oversized",
    content: oversized,
    display: false,
    timestamp: 1,
  };
  const oversizedValue = fixture(
    [oversizedEntry],
    [{ entry: oversizedEntry, children: [] }],
    [oversizedMessage],
  );
  const oversizedDispatcher = new RpcRuntimeDispatcher({
    runtime: oversizedValue.runtime,
    output(record) { oversizedValue.outputs.push(record); },
  });
  await oversizedDispatcher.start();
  assert.deepEqual(await oversizedDispatcher.dispatch({ id: "oversized-tree", type: "get_tree" }), {
    id: "oversized-tree",
    type: "response",
    command: "get_tree",
    success: false,
    error: "get_tree history item exceeds the RPC page byte limit",
  });
  assert.deepEqual(await oversizedDispatcher.dispatch({ id: "oversized-messages", type: "get_messages" }), {
    id: "oversized-messages",
    type: "response",
    command: "get_messages",
    success: false,
    error: "get_messages history item exceeds the RPC page byte limit",
  });
  await oversizedDispatcher.close();
});

test("unknown commands preserve IDs and clone forks the selected leaf at its exact position", async () => {
  const value = fixture();
  const dispatcher = new RpcRuntimeDispatcher({ runtime: value.runtime, output(record) { value.outputs.push(record); } });
  await dispatcher.start();
  assert.deepEqual(await dispatcher.dispatch({ id: "req_unknown", type: "future" }), {
    id: "req_unknown",
    type: "response",
    command: "future",
    success: false,
    error: "Unknown command: future",
  });
  assert.deepEqual(await dispatcher.dispatch({ id: "req_clone", type: "clone" }), {
    id: "req_clone",
    type: "response",
    command: "clone",
    success: true,
    data: { cancelled: false },
  });
  assert.deepEqual(value.forks, [{ entryId: "entry-2", position: "at" }]);
  await dispatcher.close();
});

test("RPC entry history is complete by default and supports explicit append-order pages", async () => {
  const entries: SessionEntry[] = Array.from({ length: 600 }, (_, index) => ({
    type: "thinking_level_change",
    id: `entry-${index + 1}`,
    parentId: index === 0 ? null : `entry-${index}`,
    timestamp: new Date(1_700_000_000_000 + index).toISOString(),
    thinkingLevel: "off",
  }));
  const value = fixture(entries, []);
  const dispatcher = new RpcRuntimeDispatcher({ runtime: value.runtime, output(record) { value.outputs.push(record); } });
  await dispatcher.start();

  const complete = await dispatcher.dispatch({ id: "complete", type: "get_entries" });
  if (complete?.success !== true || complete.command !== "get_entries" || !("data" in complete)) {
    assert.fail("missing complete history");
  }
  assert.equal(complete.data.entries.length, 600);
  assert.equal(complete.data.hasMore, false);

  const first = await dispatcher.dispatch({ id: "first", type: "get_entries", limit: 512 });
  if (first?.success !== true || first.command !== "get_entries" || !("data" in first)) assert.fail("missing first page");
  assert.equal(first.data.entries.length, 512);
  assert.equal(first.data.nextSequence, 512);
  assert.equal(first.data.hasMore, true);

  const second = await dispatcher.dispatch({ id: "second", type: "get_entries", afterSequence: first.data.nextSequence });
  if (second?.success !== true || second.command !== "get_entries" || !("data" in second)) assert.fail("missing second page");
  assert.equal(second.data.entries.length, 88);
  assert.equal(second.data.entries[0]?.id, "entry-513");
  assert.equal(second.data.nextSequence, 600);
  assert.equal(second.data.hasMore, false);
  await dispatcher.close();
});
