import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";

import { defaultSecretRedactor } from "../../src/auth/redaction.js";
import type { RuntimeEvent } from "../../src/core/events.js";
import { isJsonObject, type JsonObject } from "../../src/core/json.js";
import { FUNCTION_VALUE } from "../../src/core/value-schemas.js";
import { runPrintMode } from "../../src/modes/print-mode.js";
import { createPrintOutput } from "../../src/modes/print-output.js";
import { MAX_RPC_LINE_BYTES } from "../../src/interfaces/rpc.js";
import type {
  AgentSession,
  AgentSessionRecoveryOptions,
  PluginBindings,
} from "../../src/service/agent-session.js";
import type { AgentSessionRuntime } from "../../src/service/agent-session-runtime.js";
import { SessionManager } from "../../src/storage/session-manager.js";
import type { SessionContextMessage } from "../../src/storage/types.js";
import type { ImageContent } from "@ohm/models";
import { Check } from "typebox/value";

interface PrintSessionEntryFixture {
  id: string;
  parentId: string | null;
  timestamp: string;
  type: "message";
  message: SessionContextMessage;
}

interface PrintPromptOptions {
  images?: readonly object[];
}

interface PrintSessionFixture {
  readonly nativeSessionManager: SessionManager;
  readonly sessionManager: {
    getEntries(): PrintSessionEntryFixture[];
    getHeader(): {
      type: "session";
      version: number;
      id: string;
      timestamp: string;
      cwd: string;
    } | null;
  };
  readonly state: { readonly messages: SessionContextMessage[] };
  readonly suspendedRun?: { readonly operationId: string } | undefined;
  bindPlugins(value?: PluginBindings, signal?: AbortSignal): Promise<void>;
  subscribe(listener: (event: RuntimeEvent) => void | Promise<void>): () => void;
  prompt(
    text: string,
    options?: PrintPromptOptions,
  ): Promise<{ sessionId: string; results: readonly object[] }>;
  recoverInterruptedRun?: AgentSession["recoverInterruptedRun"];
  waitForIdle?: AgentSession["waitForIdle"];
  navigateTree?: AgentSession["navigateTree"];
  refresh?: AgentSession["refresh"];
}

function printSessionFixture(fixture: PrintSessionFixture): AgentSession {
  // SAFETY: the fixture contract checks every session member exercised by print mode and its command actions.
  return fixture as AgentSession;
}

type PrintRuntimeFixture = Partial<Pick<
  AgentSessionRuntime,
  | "dispose"
  | "fork"
  | "newSession"
  | "refreshSession"
  | "setBeforeSessionInvalidate"
  | "setRebindSession"
  | "switchSession"
>> & {
  readonly session: AgentSession;
  triggerRebind?(replacement?: AgentSession): Promise<void>;
};

function printRuntimeFixture(fixture: PrintRuntimeFixture): AgentSessionRuntime {
  // SAFETY: the fixture contract checks every runtime member exercised by print mode and its command actions.
  return fixture as AgentSessionRuntime;
}

function parseJsonLines(output: string): JsonObject[] {
  return output.trim().split("\n").map((line) => {
    const parsed: unknown = JSON.parse(line);
    if (!isJsonObject(parsed)) throw new Error("Print fixture emitted a non-object JSON record");
    return parsed;
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
}

interface PrintFixture {
  runtime: AgentSessionRuntime;
  prompted: Array<{ text: string; imageCount: number }>;
  promptImages: Array<readonly unknown[]>;
  bindCount(): number;
  disposeCount(): number;
  binding(): PluginBindings | undefined;
  calls: string[];
  triggerRebind(session?: AgentSession): Promise<void>;
}

function fixture(
  onPrompt?: (
    emit: (event: RuntimeEvent) => Promise<void>,
    messages: SessionContextMessage[],
  ) => void | Promise<void>,
  options: {
    blockedRecovery?: boolean;
    initialMessages?: SessionContextMessage[];
    onBind?: (binding: PluginBindings | undefined, signal?: AbortSignal) => void;
  } = {},
): PrintFixture {
  const listeners = new Set<(event: RuntimeEvent) => void | Promise<void>>();
  const messages: SessionContextMessage[] = [...(options.initialMessages ?? [])];
  const prompted: Array<{ text: string; imageCount: number }> = [];
  const promptImages: Array<readonly unknown[]> = [];
  let bound = 0;
  let disposed = 0;
  let binding: PluginBindings | undefined;
  let rebind: ((session: AgentSession) => Promise<void>) | undefined;
  let beforeInvalidate: (() => void) | undefined;
  const calls: string[] = [];
  const nativeSessionManager = SessionManager.inMemory("/tmp", { id: "s" });
  const session = printSessionFixture({
    nativeSessionManager,
    sessionManager: {
      getHeader: () => ({ type: "session", version: 4, id: "s", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp" }),
      getEntries: () => messages.map((message, index) => ({
        id: `entry-${index}`,
        parentId: index === 0 ? null : `entry-${index - 1}`,
        timestamp: "2026-01-01T00:00:00.000Z",
        type: "message",
        message,
      })),
    },
    get state() { return { messages }; },
    get suspendedRun() {
      return options.blockedRecovery === true
        ? { operationId: "interrupted-operation" }
        : undefined;
    },
    async recoverInterruptedRun() {
      calls.push("session:recover");
      return options.blockedRecovery === true
        ? {
            recovered: false,
            operationId: "interrupted-operation",
            blocked: [{
              effectId: "unsafe-effect",
              name: "write",
              reason: "the prior effect outcome is unknown",
            }],
          }
        : { recovered: false, blocked: [] };
    },
    async bindPlugins(value?: PluginBindings, signal?: AbortSignal) {
      bound += 1;
      binding = value;
      options.onBind?.(value, signal);
    },
    subscribe(listener: (event: RuntimeEvent) => void | Promise<void>) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async waitForIdle() { calls.push("session:wait"); },
    async navigateTree(targetId: string, options: { summarize?: boolean }) {
      calls.push(`session:navigate:${targetId}:${options.summarize === true}`);
      return { cancelled: false };
    },
    async refresh() { calls.push("session:refresh"); },
    async prompt(text: string, options: PrintPromptOptions = {}) {
      prompted.push({ text, imageCount: options.images?.length ?? 0 });
      promptImages.push(structuredClone(options.images ?? []));
      const emit = async (event: RuntimeEvent): Promise<void> => {
        for (const listener of Array.from(listeners)) await listener(event);
      };
      await onPrompt?.(emit, messages);
      return { sessionId: "s", results: [] };
    },
  });
  let currentSession = session;
  const runtime = printRuntimeFixture({
    get session() { return currentSession; },
    setRebindSession(callback: (session: AgentSession) => Promise<void>) { rebind = callback; },
    setBeforeSessionInvalidate(callback?: () => void) { beforeInvalidate = callback; },
    async newSession(options: { parentSession?: string } = {}) {
      calls.push(`runtime:new:${options.parentSession ?? ""}`);
      return { cancelled: false };
    },
    async fork(entryId: string, options: { position?: string } = {}) {
      calls.push(`runtime:fork:${entryId}:${options.position ?? ""}`);
      return { cancelled: false };
    },
    async switchSession(path: string) {
      calls.push(`runtime:switch:${path}`);
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
    async dispose() {
      disposed += 1;
      nativeSessionManager.closeV4Store();
    },
    async triggerRebind(replacement = session) {
      beforeInvalidate?.();
      await rebind?.(replacement);
      currentSession = replacement;
    },
  });
  return {
    runtime,
    prompted,
    promptImages,
    bindCount: () => bound,
    disposeCount: () => disposed,
    binding: () => binding,
    calls,
    async triggerRebind(replacement = session) {
      beforeInvalidate?.();
      await rebind?.(replacement);
      currentSession = replacement;
    },
  };
}

async function captureStdout<T>(operation: () => Promise<T>): Promise<{ result: T; output: string }> {
  const original = process.stdout.write;
  let output = "";
  const captureWrite = (chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void): boolean => {
    output += String(chunk);
    const done = Check(FUNCTION_VALUE, encodingOrCallback) ? encodingOrCallback : callback;
    done?.();
    return true;
  };
  // SAFETY: captureWrite implements the exercised stdout overloads and preserves callback completion.
  process.stdout.write = captureWrite as typeof process.stdout.write;
  try {
    return { result: await operation(), output };
  } finally {
    process.stdout.write = original;
  }
}

test("print mode binds the direct session, writes final assistant text, and disposes once", async () => {
  const value = fixture((_emit, messages) => {
    messages.push({
      id: "m",
      role: "assistant",
      content: [{ type: "text", text: "finished" }],
      createdAt: "2026-01-01T00:00:00.000Z",
      stopReason: "stop",
    });
  });
  const captured = await captureStdout(() => runPrintMode(value.runtime, {
    mode: "text",
    initialMessage: "first",
    initialImages: [{ type: "image", mimeType: "image/JPG", data: "AA==" }],
    messages: ["second"],
  }));
  assert.equal(captured.result, 0);
  assert.equal(captured.output, "finished\n");
  assert.deepEqual(value.prompted, [{ text: "first", imageCount: 1 }, { text: "second", imageCount: 0 }]);
  assert.deepEqual(value.promptImages, [
    [{ type: "image", mediaType: "image/jpeg", data: "AA==" }],
    [],
  ]);
  assert.equal(value.bindCount(), 1);
  assert.equal(value.disposeCount(), 1);
  assert.equal(value.binding()?.mode, "print");
  const actions = value.binding()?.commandContextActions;
  assert.ok(actions);
  await actions.waitForIdle();
  await actions.newSession({ parentSession: "parent.jsonl" });
  await actions.fork("entry", { position: "at" });
  await actions.navigateTree("target", { summarize: true });
  await actions.switchSession("/tmp/session.jsonl");
  await actions.refresh();
  assert.deepEqual(value.calls, [
    "session:wait",
    "runtime:new:parent.jsonl",
    "runtime:fork:entry:at",
    "session:navigate:target:true",
    "runtime:switch:/tmp/session.jsonl",
    "session:refresh",
  ]);
});

test("print mode redacts extension and assistant failures before writing stderr", async () => {
  const secret = "sk-proj-print-mode-redaction-1234567890";
  const terminalControl = "\x1b[2J";
  defaultSecretRedactor.register(secret);
  let value: PrintFixture;
  value = fixture((_emit, messages) => {
    value.binding()?.onError?.({
      extensionPath: `/extensions/before-${secret}-after${terminalControl}.mjs`,
      event: "input",
      error: `extension-before-${secret}-after${terminalControl}`,
    });
    messages.push({
      id: "failure",
      role: "assistant",
      content: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      stopReason: "error",
      errorMessage: `assistant-before-${secret}-after${terminalControl}`,
    });
  });
  const errors: string[] = [];
  const original = console.error;
  console.error = (...items) => { errors.push(items.map(String).join(" ")); };
  try {
    assert.equal(await runPrintMode(value.runtime, {
      mode: "text",
      initialMessage: "fail",
      write() {},
    }), 1);
  } finally {
    console.error = original;
  }
  assert.equal(errors.length, 2);
  assert.equal(errors.some((entry) => entry.includes(secret)), false);
  assert.equal(errors.every((entry) => entry.includes("[REDACTED]")), true);
  assert.equal(errors.some((entry) => entry.includes("\x1b")), false);
  assert.equal(errors.every((entry) => entry.includes("\\x1b[2J")), true);
});

test("JSON print mode emits its session header before an owner-identified startup extension failure", async () => {
  const output: string[] = [];
  const value = fixture(undefined, {
    onBind(binding) {
      binding?.onError?.({
        extensionId: "startup-owner",
        extensionPath: "/extensions/startup.mjs",
        event: "session_start",
        error: "startup failure",
      });
    },
  });

  assert.equal(await runPrintMode(value.runtime, { mode: "json", write: (text) => output.push(text) }), 0);
  const records = parseJsonLines(output.join(""));
  assert.equal(records[0]?.type, "session");
  assert.deepEqual(records[1], {
    type: "extension_error",
    extensionId: "startup-owner",
    extensionPath: "/extensions/startup.mjs",
    event: "session_start",
    error: "startup failure",
  });
});

test("JSON mode preserves plugin error order while its session header is backpressured", { timeout: 5_000 }, async () => {
  const entered = deferred();
  const release = deferred();
  const records: JsonObject[] = [];
  const value = fixture(undefined, {
    onBind(binding) {
      binding?.onError?.({ extensionPath: "/startup.mjs", event: "session_start", error: "first" });
    },
  });
  const running = runPrintMode(value.runtime, {
    mode: "json",
    async write(text) {
      const entries = parseJsonLines(text);
      records.push(...entries);
      if (entries[0]?.type !== "session") return;
      entered.resolve();
      await release.promise;
    },
  });
  try {
    await entered.promise;
    value.binding()?.onError?.({ extensionPath: "/later.mjs", event: "input", error: "second" });
  } finally {
    release.resolve();
  }
  assert.equal(await running, 0);
  assert.deepEqual(records.map((record) => record.type === "session" ? "session" : record.error), ["session", "first", "second"]);
});

test("print mode ignores historical failed assistants when the current prompt has no assistant output", async () => {
  for (const stopReason of ["error", "aborted"] as const) {
    const value = fixture(undefined, {
      initialMessages: [{
        id: `historical-${stopReason}`,
        role: "assistant",
        content: [{ type: "text", text: "historical answer" }],
        createdAt: "2026-01-01T00:00:00.000Z",
        stopReason,
        errorMessage: `historical ${stopReason}`,
      }],
    });
    const errors: string[] = [];
    const output: string[] = [];
    const originalError = console.error;
    console.error = (message) => { errors.push(String(message)); };
    try {
      assert.equal(await runPrintMode(value.runtime, {
        mode: "text",
        initialMessage: "/handled-without-output",
        write(text) { output.push(text); },
      }), 0);
    } finally {
      console.error = originalError;
    }
    assert.deepEqual(errors, [], stopReason);
    assert.deepEqual(output, [], stopReason);
  }
});

test("print mode does not repeat an earlier invocation assistant when the final prompt has no output", async () => {
  let promptCount = 0;
  const value = fixture((_emit, messages) => {
    promptCount += 1;
    if (promptCount !== 1) return;
    messages.push({
      id: "first-assistant",
      role: "assistant",
      content: [{ type: "text", text: "first answer" }],
      createdAt: "2026-01-01T00:00:00.000Z",
      stopReason: "stop",
    });
  });
  const output: string[] = [];

  assert.equal(await runPrintMode(value.runtime, {
    mode: "text",
    initialMessage: "first prompt",
    messages: ["handled without output"],
    write(text) { output.push(text); },
  }), 0);
  assert.deepEqual(output, []);
});

test("print mode does not install process signal handlers", { concurrency: false }, async () => {
  let markPromptEntered!: () => void;
  let finishPrompt!: () => void;
  const promptEntered = new Promise<void>((resolve) => { markPromptEntered = resolve; });
  const promptFinished = new Promise<void>((resolve) => { finishPrompt = resolve; });
  const value = fixture(async () => {
    markPromptEntered();
    await promptFinished;
  });
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const before = new Map(signals.map((signal) => [signal, getEventListeners(process, signal)]));

  const running = runPrintMode(value.runtime, {
    mode: "text",
    initialMessage: "wait",
    write() {},
  });
  await promptEntered;
  for (const signal of signals) {
    assert.deepEqual(getEventListeners(process, signal), before.get(signal));
  }
  finishPrompt();
  assert.equal(await running, 0);
  assert.equal(value.disposeCount(), 1);
});

test("print mode rejects the internal image shape at its public boundary and still disposes", async () => {
  const value = fixture();
  const errors: string[] = [];
  const malformedImageFixture: Partial<ImageContent> & { mediaType: string } = {
    type: "image",
    mediaType: "image/png",
    data: "AA==",
  };
  // SAFETY: this negative boundary test intentionally supplies a checked malformed ImageContent fixture.
  const malformedImage = malformedImageFixture as ImageContent;
  const original = console.error;
  console.error = (...items) => { errors.push(items.map(String).join(" ")); };
  try {
    assert.equal(await runPrintMode(value.runtime, {
      mode: "text",
      initialMessage: "inspect",
      initialImages: [malformedImage],
      write() {},
    }), 1);
  } finally {
    console.error = original;
  }
  assert.deepEqual(value.prompted, []);
  assert.equal(value.disposeCount(), 1);
  assert.match(errors.join("\n"), /initialImages\[0\].*unsupported field mediaType/u);
});

test("print mode contains a hostile thrown value and still disposes", async () => {
  const hostile = new Proxy({}, {
    getPrototypeOf() { throw new Error("prototype trap must not run"); },
    get() { throw new Error("property trap must not run"); },
  });
  const value = fixture(() => { throw hostile; });
  const errors: string[] = [];
  const original = console.error;
  console.error = (...items) => { errors.push(items.join(" ")); };
  try {
    assert.equal(await runPrintMode(value.runtime, { mode: "text", initialMessage: "go" }), 1);
  } finally {
    console.error = original;
  }
  assert.deepEqual(errors, ["[Thrown object]"]);
  assert.equal(value.disposeCount(), 1);
});

test("JSON mode ignores a stale startup bind and writes the replacement session header", async () => {
  let releaseStartup!: () => void;
  let signalStartup!: () => void;
  const startupEntered = new Promise<void>((resolve) => { signalStartup = resolve; });
  const startupRelease = new Promise<void>((resolve) => { releaseStartup = resolve; });
  let replacementSubscriptions = 0;
  let replacementSubscriptionStarts = 0;
  let beforeInvalidate: (() => void) | undefined;
  let rebind: ((session: AgentSession) => Promise<void>) | undefined;
  const createSession = (id: string, waitForRelease: boolean): AgentSession => {
    const messages: SessionContextMessage[] = [];
    return printSessionFixture({
      nativeSessionManager: SessionManager.inMemory("/tmp", { id }),
      sessionManager: {
        getHeader: () => ({ type: "session", version: 4, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp" }),
        getEntries: () => messages.map((message, index) => ({
          id: `${id}-entry-${index}`,
          parentId: index === 0 ? null : `${id}-entry-${index - 1}`,
          timestamp: "2026-01-01T00:00:00.000Z",
          type: "message",
          message,
        })),
      },
      get state() { return { messages }; },
      async bindPlugins() {
        if (!waitForRelease) return;
        signalStartup();
        await startupRelease;
      },
      subscribe() {
        if (id === "replacement") {
          replacementSubscriptions += 1;
          replacementSubscriptionStarts += 1;
        }
        let active = true;
        return () => {
          if (!active) return;
          active = false;
          if (id === "replacement") replacementSubscriptions -= 1;
        };
      },
      async prompt() {
        messages.push({
          id: `${id}-answer`,
          role: "assistant",
          content: [{ type: "text", text: id }],
          createdAt: "2026-01-01T00:00:00.000Z",
          stopReason: "stop",
        });
        return { sessionId: id, results: [] };
      },
    });
  };
  const startup = createSession("startup", true);
  const replacement = createSession("replacement", false);
  let current = startup;
  const runtime = printRuntimeFixture({
    get session() { return current; },
    setBeforeSessionInvalidate(callback?: () => void) { beforeInvalidate = callback; },
    setRebindSession(callback: (session: AgentSession) => Promise<void>) { rebind = callback; },
    async dispose() {
      startup.nativeSessionManager.closeV4Store();
      replacement.nativeSessionManager.closeV4Store();
    },
  });

  const running = captureStdout(async () => await runPrintMode(runtime, {
    mode: "json",
    initialMessage: "go",
  }));
  await startupEntered;
  beforeInvalidate?.();
  await rebind?.(replacement);
  current = replacement;
  assert.equal(replacementSubscriptions, 1);
  releaseStartup();

  const captured = await running;
  assert.equal(captured.result, 0);
  const records = parseJsonLines(captured.output);
  assert.deepEqual(records, [{
    type: "session",
    version: 4,
    id: "replacement",
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd: "/tmp",
  }]);
  assert.equal(replacementSubscriptionStarts, 1);
  assert.equal(replacementSubscriptions, 0);
});

test("JSON mode writes the header before raw events and rebinds after replacement", async () => {
  let turn = 0;
  let value!: PrintFixture;
  value = fixture(async (emit) => {
    emit({ type: "warning", code: `event_${++turn}`, message: "fixture" });
    if (turn === 1) await value.triggerRebind();
  });
  const captured = await captureStdout(async () => {
    const running = runPrintMode(value.runtime, { mode: "json", initialMessage: "one", messages: ["two"] });
    await running;
    return 0;
  });
  const records = parseJsonLines(captured.output);
  assert.deepEqual(records.map((record) => record.code ?? record.type), ["session", "event_1", "event_2"]);
  assert.equal(value.disposeCount(), 1);
  assert.equal(value.bindCount(), 2);
  assert.equal(value.binding()?.mode, "json");
});

test("JSON mode awaits async custom writers before advancing the event stream", async () => {
  const entered = deferred();
  const release = deferred();
  const output: string[] = [];
  let advanced = false;
  const value = fixture(async (emit) => {
    await emit({ type: "warning", code: "first", message: "fixture" });
    advanced = true;
    await emit({ type: "warning", code: "second", message: "fixture" });
  });
  const running = runPrintMode(value.runtime, {
    mode: "json",
    initialMessage: "go",
    async write(text) {
      const record = parseJsonLines(text)[0]!;
      output.push(String(record.code ?? record.type));
      if (record.code === "first") {
        entered.resolve();
        await release.promise;
      }
    },
  });
  await entered.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(advanced, false);
  assert.deepEqual(output, ["session", "first"]);
  release.resolve();
  assert.equal(await running, 0);
  assert.deepEqual(output, ["session", "first", "second"]);
  assert.equal(value.disposeCount(), 1);
});

test("JSON mode waits for default stdout write callbacks", async () => {
  const original = process.stdout.write;
  const forward = original.bind(process.stdout);
  const entered = deferred();
  let completeWrite = (): void => undefined;
  let advanced = false;
  const captureWrite = (chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void): boolean => {
    const done = Check(FUNCTION_VALUE, encodingOrCallback) ? encodingOrCallback : callback;
    if (!String(chunk).startsWith("{")) return forward(chunk, done);
    if (String(chunk).includes('"code":"slow"')) {
      completeWrite = () => done?.();
      entered.resolve();
      return false;
    }
    done?.();
    return true;
  };
  // SAFETY: captureWrite implements the exercised stdout overloads and preserves callback completion.
  process.stdout.write = captureWrite as typeof process.stdout.write;
  const value = fixture(async (emit) => {
    await emit({ type: "warning", code: "slow", message: "fixture" });
    advanced = true;
  });
  try {
    const running = runPrintMode(value.runtime, { mode: "json", initialMessage: "go" });
    await entered.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(advanced, false);
    completeWrite();
    assert.equal(await running, 0);
    assert.equal(advanced, true);
  } finally {
    completeWrite();
    process.stdout.write = original;
  }
});

test("JSON mode drains detached extension errors before returning", async () => {
  const entered = deferred();
  const release = deferred();
  let settled = false;
  let value!: PrintFixture;
  value = fixture(() => {
    value.binding()?.onError?.({ extensionPath: "/extension.mjs", event: "input", error: "fixture" });
  });
  const running = runPrintMode(value.runtime, {
    mode: "json",
    initialMessage: "go",
    async write(text) {
      if (parseJsonLines(text)[0]?.type !== "extension_error") return;
      entered.resolve();
      await release.promise;
    },
  }).then((status) => { settled = true; return status; });
  await entered.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  release.resolve();
  assert.equal(await running, 0);
});

test("JSON mode reports async writer failures and still disposes", async () => {
  const value = fixture();
  const errors: string[] = [];
  const original = console.error;
  console.error = (...items) => { errors.push(items.join(" ")); };
  try {
    assert.equal(await runPrintMode(value.runtime, {
      mode: "json",
      async write() { throw new Error("output disconnected"); },
    }), 1);
  } finally {
    console.error = original;
  }
  assert.equal(value.disposeCount(), 1);
  assert.deepEqual(errors, ["output disconnected"]);
});

for (const limit of ["records", "bytes"] as const) {
  test(`one-shot output bounds queued ${limit} while its writer is stalled`, { timeout: 5_000 }, async () => {
    const entered = deferred();
    const release = deferred();
    let writes = 0;
    const output = createPrintOutput("json", async () => {
      writes += 1;
      entered.resolve();
      await release.promise;
    });
    const accepted = [output.write(limit === "bytes" ? "x".repeat(MAX_RPC_LINE_BYTES) : "x")];
    try {
      await entered.promise;
      if (limit === "records") {
        for (let index = 1; index < 1_024; index += 1) accepted.push(output.write("x"));
      }
      await assert.rejects(output.write("x"), /Print output backlog exceeded/u);
      assert.equal(output.signal.aborted, true);
      assert.equal(writes, 1);
    } finally {
      release.resolve();
      await Promise.allSettled(accepted);
      await assert.rejects(output.close(), /Print output backlog exceeded/u);
    }
    assert.equal(writes, 1);
  });
}

test("JSON mode drains shutdown plugin errors and ignores callbacks after output closes", async () => {
  const value = fixture();
  const originalDispose = value.runtime.dispose.bind(value.runtime);
  value.runtime.dispose = async () => {
    value.binding()?.onError?.({ extensionPath: "/shutdown.mjs", event: "session_shutdown", error: "during disposal" });
    await originalDispose();
  };
  const records: JsonObject[] = [];
  assert.equal(await runPrintMode(value.runtime, { mode: "json", write(text) { records.push(...parseJsonLines(text)); } }), 0);
  value.binding()?.onError?.({ extensionPath: "/late.mjs", event: "late", error: "after disposal" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(records.map((record) => record.type), ["session", "extension_error"]);
  assert.equal(records[1]?.error, "during disposal");
  assert.equal(value.disposeCount(), 1);
});

test("JSON writer failure cancels pending recovery with the startup signal and disposes", { timeout: 5_000 }, async () => {
  let bindSignal: AbortSignal | undefined;
  let recoveryCancelled = false;
  const value = fixture(undefined, {
    blockedRecovery: true,
    onBind(_binding, signal) { bindSignal = signal; },
  });
  value.runtime.session.recoverInterruptedRun = async (options) => {
    const signal = options?.signal;
    assert.ok(signal, "recovery must receive output cancellation");
    assert.equal(signal, bindSignal, "startup and recovery must share output cancellation");
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        recoveryCancelled = true;
        reject(signal.reason);
      }, { once: true });
      value.binding()?.onError?.({ extensionPath: "/recovery.mjs", event: "tool_call", error: "recovery diagnostic" });
    });
    throw new Error("Cancelled recovery must not continue replay");
  };
  const writes: string[] = [];
  const errors: string[] = [];
  const original = console.error;
  console.error = (...items) => { errors.push(items.join(" ")); };
  try {
    assert.equal(await runPrintMode(value.runtime, {
      mode: "json",
      initialMessage: "must not be prompted",
      async write(text) {
        const type = String(parseJsonLines(text)[0]?.type);
        writes.push(type);
        if (type === "extension_error") throw new Error("output disconnected during recovery");
      },
    }), 1);
  } finally {
    console.error = original;
  }
  assert.equal(recoveryCancelled, true);
  assert.deepEqual(writes, ["session", "extension_error"]);
  assert.deepEqual(errors, ["output disconnected during recovery"]);
  assert.deepEqual(value.prompted, []);
  assert.equal(value.disposeCount(), 1);
  assert.ok(bindSignal?.aborted);
  assert.equal(getEventListeners(bindSignal, "abort").length, 0);
});

test("print and JSON modes recover replacements or reject unresolved work before prompting", async () => {
  for (const mode of ["text", "json"] as const) {
    for (const blocked of [false, true]) {
      const order: string[] = [];
      const recoveryOptions: Array<AgentSessionRecoveryOptions | undefined> = [];
      let value!: PrintFixture;
      let replacement!: AgentSession;
      value = fixture(async () => {
        order.push("initial:prompt");
        await value.triggerRebind(replacement);
      });
      const initial = value.runtime.session;
      let suspended = true;
      replacement = Object.create(initial);
      Object.defineProperties(replacement, {
        suspendedRun: { get: () => suspended ? { operationId: "replacement-run" } : undefined },
        recoverInterruptedRun: { value: async (options?: AgentSessionRecoveryOptions) => {
          order.push("replacement:recover");
          recoveryOptions.push(options);
          if (blocked) {
            return {
              recovered: false,
              operationId: "replacement-run",
              blocked: [{
                effectId: "unsafe-effect",
                name: "bash",
                reason: "recovery policy never_repeat requires an explicit decision",
              }],
            };
          }
          suspended = false;
          return { recovered: true, operationId: "replacement-run", blocked: [] };
        } },
        prompt: { value: async (text: string, options: PrintPromptOptions = {}) => {
          order.push("replacement:prompt");
          assert.equal(suspended, false);
          value.prompted.push({ text, imageCount: options.images?.length ?? 0 });
          return { sessionId: "replacement", results: [] };
        } },
      });
      const errors: string[] = [];
      const originalError = console.error;
      console.error = (error) => { errors.push(String(error)); };
      let status: number;
      try {
        status = await runPrintMode(value.runtime, {
          mode,
          initialMessage: "first",
          messages: ["second"],
          write() {},
        });
      } finally {
        console.error = originalError;
      }
      assert.equal(status, blocked ? 1 : 0, `${mode}:${blocked}`);
      assert.deepEqual(order, blocked
        ? ["initial:prompt", "replacement:recover"]
        : ["initial:prompt", "replacement:recover", "replacement:prompt"]);
      assert.equal(recoveryOptions.length, 1);
      assert.ok(recoveryOptions[0]?.signal instanceof AbortSignal);
      assert.equal(recoveryOptions[0].signal.aborted, false);
      assert.deepEqual(Object.keys(recoveryOptions[0]), ["signal"]);
      assert.equal(value.bindCount(), 2);
      assert.equal(value.binding()?.mode, mode === "json" ? "json" : "print");
      assert.equal(value.prompted.length, blocked ? 1 : 2);
      assert.equal(errors.length, blocked ? 1 : 0);
      if (blocked) {
        assert.equal(errors[0], "Interrupted operation replacement-run requires an explicit recovery decision: unsafe-effect (bash): recovery policy never_repeat requires an explicit decision. Open an interactive session and use /recover, or use the RPC or SDK recovery API.");
      }
    }
  }
});

test("assistant provider errors return a failing exit status", async () => {
  const value = fixture((_emit, messages) => {
    messages.push({
      id: "m",
      role: "assistant",
      content: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      stopReason: "error",
      errorMessage: "provider failed",
    });
  });
  const originalError = console.error;
  const errors: string[] = [];
  console.error = (value) => { errors.push(String(value)); };
  try {
    assert.equal(await runPrintMode(value.runtime, { mode: "text", initialMessage: "go" }), 1);
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(errors, ["provider failed"]);
  assert.equal(value.disposeCount(), 1);
});

test("JSON assistant provider errors return a failing status without a human diagnostic", async () => {
  const value = fixture((emit, messages) => {
    emit({ type: "warning", code: "provider_failure", message: "provider failed" });
    messages.push({
      id: "m",
      role: "assistant",
      content: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      stopReason: "error",
      errorMessage: "provider failed",
    });
  });
  const errors: string[] = [];
  const output: string[] = [];
  const originalError = console.error;
  console.error = (message) => { errors.push(String(message)); };
  try {
    assert.equal(await runPrintMode(value.runtime, {
      mode: "json",
      initialMessage: "go",
      messages: ["must not run"],
      write(text) { output.push(text); },
    }), 1);
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(parseJsonLines(output.join("")).map((entry) => entry.type), [
    "session",
    "warning",
  ]);
  assert.deepEqual(errors, []);
  assert.deepEqual(value.prompted, [{ text: "go", imageCount: 0 }]);
  assert.equal(value.disposeCount(), 1);
});

test("print mode reports blocked recovery before it sends a prompt", async () => {
  const value = fixture(undefined, { blockedRecovery: true });
  const originalError = console.error;
  const errors: string[] = [];
  console.error = (message) => { errors.push(String(message)); };
  try {
    assert.equal(await runPrintMode(value.runtime, { mode: "text", initialMessage: "must wait" }), 1);
  } finally {
    console.error = originalError;
  }

  assert.deepEqual(value.calls, ["session:recover"]);
  assert.deepEqual(value.prompted, []);
  assert.equal(value.disposeCount(), 1);
  assert.deepEqual(errors, [
    "Interrupted operation interrupted-operation requires an explicit recovery decision: unsafe-effect (write): the prior effect outcome is unknown. Open an interactive session and use /recover, or use the RPC or SDK recovery API.",
  ]);
});
