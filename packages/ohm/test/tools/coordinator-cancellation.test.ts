import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DirectProcessRunner } from "../../src/process/index.js";
import {
  ToolCoordinator,
  ToolRegistry,
  WorkspaceBoundary,
} from "../../src/tools/index.js";
import type {
  HarnessTool,
  ResourceClaim,
  ToolContext,
  ToolInvocationResult,
  ToolResult,
} from "../../src/tools/types.js";
import type {
  ToolCoordinatorInterceptor,
  ToolCoordinatorObserver,
} from "../../src/tools/coordinator.js";

type LifecyclePhase =
  | "prepareInput"
  | "beforeCall"
  | "received"
  | "resources"
  | "started"
  | "authorize"
  | "dispatching"
  | "progress"
  | "afterResult";

function nonCooperativeGate() {
  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => { markEntered = resolve; });
  const pending = new Promise<never>(() => undefined);
  return {
    entered,
    wait<T = never>(): Promise<T> {
      markEntered();
      return pending;
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((selected) => { resolve = selected; });
  return { promise, resolve };
}

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 1_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function context(
  t: { after(callback: () => Promise<void>): void },
  signal: AbortSignal,
): Promise<ToolContext> {
  const root = await mkdtemp(join(tmpdir(), "harness-tool-cancellation-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  return {
    workspace: await WorkspaceBoundary.create(root),
    runner: new DirectProcessRunner(),
    signal,
    runId: "run",
    threadId: "thread",
  };
}

for (const phase of [
  "prepareInput",
  "beforeCall",
  "received",
  "resources",
  "started",
  "authorize",
  "dispatching",
  "progress",
  "afterResult",
] as const satisfies readonly LifecyclePhase[]) {
  test(`coordinator aborts a non-cooperative ${phase} hook`, async (t) => {
    const gate = nonCooperativeGate();
    const controller = new AbortController();
    const baseTool: HarnessTool = {
      definition: { name: "blocked", description: "blocked lifecycle hook", inputSchema: { type: "object" } },
      validate() {},
      async resources() {
        return phase === "resources" ? await gate.wait<ResourceClaim[]>() : [];
      },
      async execute(_input, selected) {
        if (phase === "progress") {
          selected.reportProgress?.({
            type: "result",
            content: "working",
            isError: false,
          });
        }
        return { content: "done", isError: false };
      },
    };
    const tool: HarnessTool = phase === "prepareInput"
      ? { ...baseTool, prepareInput: async () => await gate.wait() }
      : baseTool;
    const configuredObserver: ToolCoordinatorObserver = phase === "received"
      ? { received: async () => await gate.wait() }
      : phase === "progress"
        ? { progress: async () => await gate.wait() }
        : {};
    const executionObserver: ToolCoordinatorObserver = phase === "started"
      ? { started: async () => await gate.wait() }
      : phase === "dispatching"
        ? { dispatching: async () => await gate.wait() }
        : {};
    const interceptor: ToolCoordinatorInterceptor = phase === "beforeCall"
      ? { beforeCall: async () => await gate.wait() }
      : phase === "authorize"
        ? { authorize: async () => await gate.wait() }
        : phase === "afterResult"
          ? { afterResult: async () => await gate.wait() }
          : {};
    const coordinator = new ToolCoordinator(
      new ToolRegistry([tool]),
      configuredObserver,
      undefined,
      interceptor,
    );
    const running = coordinator.execute(
      [{ callId: "blocked", name: "blocked", input: {}, index: 0 }],
      await context(t, controller.signal),
      executionObserver,
    );

    await within(gate.entered, `${phase} hook entry`);
    const reason = new Error(`cancel ${phase}`);
    controller.abort(reason);
    await assert.rejects(
      within(running, `${phase} cancellation`),
      (error) => error === reason,
    );
  });
}

test("an invocation cancelled before scheduling never reaches the dispatch boundary", async (t) => {
  const controller = new AbortController();
  const reason = new Error("cancel before run");
  controller.abort(reason);
  let dispatches = 0;
  let executions = 0;
  const tool: HarnessTool = {
    definition: { name: "cancelled", description: "cancelled", inputSchema: { type: "object" } },
    validate() {},
    resources() { return []; },
    async execute() {
      executions += 1;
      return { content: "unexpected", isError: false };
    },
  };
  await assert.rejects(
    new ToolCoordinator(new ToolRegistry([tool])).execute(
      [{ callId: "cancelled", name: "cancelled", input: {}, index: 0 }],
      await context(t, controller.signal),
      { dispatching() { dispatches += 1; } },
    ),
    (error) => error === reason,
  );
  assert.equal(dispatches, 0);
  assert.equal(executions, 0);
});

test("an aborted non-cooperative tool retains its batch until the raw effect settles", async (t) => {
  const entered = deferred<void>();
  const releaseExecution = deferred<void>();
  const controller = new AbortController();
  let durableResult: string | undefined;
  const hung: HarnessTool = {
    definition: { name: "hung", description: "ignores cancellation", inputSchema: { type: "object" } },
    validate() {},
    resources() { return []; },
    async execute() {
      entered.resolve();
      await releaseExecution.promise;
      return { content: "settled after cancellation", isError: false };
    },
  };
  const recovery: HarnessTool = {
    definition: { name: "recovery", description: "recovers", inputSchema: { type: "object" } },
    validate() {},
    resources() { return []; },
    async execute() { return { content: "recovered", isError: false }; },
  };
  const coordinator = new ToolCoordinator(
    new ToolRegistry([hung, recovery]),
    {},
    undefined,
    {},
    { activeTools: ["hung"] },
  );
  const running = coordinator.execute(
    [{ callId: "hung", name: "hung", input: {}, index: 0 }],
    await context(t, controller.signal),
    { completed(entry) { durableResult = entry.result.content; } },
  );
  let settled = false;
  void running.then(
    () => { settled = true; },
    () => { settled = true; },
  );

  await within(entered.promise, "hung tool entry");
  assert.deepEqual(coordinator.queueActiveTools(["recovery"]), ["recovery"]);
  assert.throws(() => coordinator.turnSnapshot(), /while a tool batch is executing/u);
  const reason = new Error("cancel hung tool");
  controller.abort(reason);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(durableResult, undefined);
  assert.throws(() => coordinator.turnSnapshot(), /while a tool batch is executing/u);

  releaseExecution.resolve();
  await assert.rejects(within(running, "hung tool settlement"), (error) => error === reason);
  assert.equal(durableResult, "settled after cancellation");

  assert.deepEqual(coordinator.turnSnapshot(), {
    definitions: [recovery.definition],
    names: ["recovery"],
    revision: 1,
    changed: true,
  });
  const result: ToolInvocationResult[] = await coordinator.execute(
    [{ callId: "recovery", name: "recovery", input: {}, index: 0 }],
    await context(t, new AbortController().signal),
  );
  assert.equal(result[0]?.result.content, "recovered");
});

test("cancellation remains effective after a non-cooperative durable completion observer settles", async (t) => {
  const completionEntered = deferred<void>();
  const releaseCompletion = deferred<void>();
  const controller = new AbortController();
  const tool: HarnessTool = {
    definition: { name: "completed", description: "waits at durable completion", inputSchema: { type: "object" } },
    validate() {},
    resources() { return []; },
    async execute() { return { content: "done", isError: false }; },
  };
  const coordinator = new ToolCoordinator(new ToolRegistry([tool]));
  const running = coordinator.execute(
    [{ callId: "completed", name: "completed", input: {}, index: 0 }],
    await context(t, controller.signal),
    {
      async completed() {
        completionEntered.resolve();
        await releaseCompletion.promise;
      },
    },
  );
  let settled = false;
  void running.then(
    () => { settled = true; },
    () => { settled = true; },
  );

  await within(completionEntered.promise, "durable completion entry");
  const reason = new Error("cancel durable completion");
  controller.abort(reason);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.throws(() => coordinator.turnSnapshot(), /while a tool batch is executing/u);

  releaseCompletion.resolve();
  await assert.rejects(within(running, "durable completion settlement"), (error) => error === reason);
  assert.deepEqual(coordinator.turnSnapshot(), {
    definitions: [tool.definition],
    names: ["completed"],
    revision: 0,
    changed: false,
  });
});

test("cancelling a sequential batch prevents later tools from starting", async (t) => {
  const controller = new AbortController();
  let firstStarted!: () => void;
  const entered = new Promise<void>((resolve) => { firstStarted = resolve; });
  let secondStarted = false;
  const first: HarnessTool = {
    definition: { name: "first", description: "waits for cancellation", inputSchema: { type: "object" } },
    executionMode: "sequential",
    validate() {},
    resources() { return []; },
    async execute(_input, selected) {
      firstStarted();
      return await new Promise<ToolResult>((_resolve, reject) => {
        const cancel = () => reject(selected.signal.reason ?? new Error("cancelled"));
        if (selected.signal.aborted) cancel();
        else selected.signal.addEventListener("abort", cancel, { once: true });
      });
    },
  };
  const second: HarnessTool = {
    definition: { name: "second", description: "must not start", inputSchema: { type: "object" } },
    validate() {},
    resources() { return []; },
    async execute() {
      secondStarted = true;
      return { content: "unexpected", isError: false };
    },
  };
  const running = new ToolCoordinator(new ToolRegistry([first, second])).execute(
    [
      { callId: "first", name: "first", input: {}, index: 0 },
      { callId: "second", name: "second", input: {}, index: 1 },
    ],
    await context(t, controller.signal),
  );

  await within(entered, "first tool entry");
  const reason = new Error("cancel sequential batch");
  controller.abort(reason);

  await assert.rejects(within(running, "sequential batch cancellation"), (error) => error === reason);
  assert.equal(secondStarted, false);
});
