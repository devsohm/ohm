import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";

import { defaultSecretRedactor } from "../../src/auth/redaction.js";
import type { RuntimeEvent } from "../../src/core/events.js";
import { isJsonObject, type JsonObject } from "../../src/core/json.js";
import { FUNCTION_VALUE } from "../../src/core/value-schemas.js";
import { runPrintMode } from "../../src/modes/print-mode.js";
import type {
  AgentSession,
  AgentSessionRecoveryOptions,
  ExtensionBindings,
} from "../../src/service/agent-session.js";
import type { AgentSessionRuntime } from "../../src/service/agent-session-runtime.js";
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
  bindExtensions(value?: ExtensionBindings): Promise<void>;
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

interface PrintFixture {
  runtime: AgentSessionRuntime;
  prompted: Array<{ text: string; imageCount: number }>;
  promptImages: Array<readonly unknown[]>;
  bindCount(): number;
  disposeCount(): number;
  binding(): ExtensionBindings | undefined;
  calls: string[];
  triggerRebind(session?: AgentSession): Promise<void>;
}

function fixture(
  onPrompt?: (
    emit: (event: RuntimeEvent) => void,
    messages: SessionContextMessage[],
  ) => void | Promise<void>,
  options: {
    blockedRecovery?: boolean;
    initialMessages?: SessionContextMessage[];
    onBind?: (binding: ExtensionBindings | undefined) => void;
  } = {},
): PrintFixture {
  const listeners = new Set<(event: RuntimeEvent) => void>();
  const messages: SessionContextMessage[] = [...(options.initialMessages ?? [])];
  const prompted: Array<{ text: string; imageCount: number }> = [];
  const promptImages: Array<readonly unknown[]> = [];
  let bound = 0;
  let disposed = 0;
  let binding: ExtensionBindings | undefined;
  let rebind: ((session: AgentSession) => Promise<void>) | undefined;
  let beforeInvalidate: (() => void) | undefined;
  const calls: string[] = [];
  const session = printSessionFixture({
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
    async bindExtensions(value?: ExtensionBindings) {
      bound += 1;
      binding = value;
      options.onBind?.(value);
    },
    subscribe(listener: (event: RuntimeEvent) => void) {
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
      const emit = (event: RuntimeEvent): void => { for (const listener of listeners) listener(event); };
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
    async dispose() { disposed += 1; },
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
      async bindExtensions() {
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
    async dispose() {},
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
      assert.deepEqual(recoveryOptions, [undefined]);
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
