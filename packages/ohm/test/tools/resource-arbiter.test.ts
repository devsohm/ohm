import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DirectProcessRunner } from "../../src/process/index.js";
import {
  ShellTool,
  ToolCoordinator,
  ToolRegistry,
  ToolResourceArbiter,
  WorkspaceBoundary,
} from "../../src/tools/index.js";
import type { HarnessTool, ResourceClaim, ToolContext } from "../../src/tools/types.js";
import type { ToolResourceLease } from "../../src/tools/resource-arbiter.js";

class RejectingResourceArbiter extends ToolResourceArbiter {
  acquired = 0;

  override acquire(_claims: readonly ResourceClaim[], _signal: AbortSignal): Promise<ToolResourceLease> {
    this.acquired += 1;
    throw new Error("must not acquire");
  }
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
  signal = new AbortController().signal,
): Promise<ToolContext> {
  const root = await mkdtemp(join(tmpdir(), "ohm-resource-arbiter-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  return {
    workspace: await WorkspaceBoundary.create(root),
    runner: new DirectProcessRunner(),
    signal,
    runId: "run",
    threadId: "thread",
  };
}

function fixtureTool(
  name: string,
  mode: "read" | "write",
  execute: HarnessTool["execute"],
): HarnessTool {
  return {
    definition: { name, description: `${name} fixture`, inputSchema: { type: "object" } },
    validate() {},
    resources() { return [{ kind: "workspace", key: "workspace", mode }]; },
    execute,
  };
}

test("shared arbiter overlaps reads and serializes a conflicting write", async () => {
  const arbiter = new ToolResourceArbiter();
  const signal = new AbortController().signal;
  const firstRead = await arbiter.acquire([{ kind: "file", key: "/workspace/a", mode: "read" }], signal);
  const secondRead = await within(
    arbiter.acquire([{ kind: "file", key: "/workspace/a", mode: "read" }], signal),
    "the compatible read lease",
  );
  let writeEntered = false;
  const write = arbiter.acquire([{ kind: "workspace", key: "workspace", mode: "write" }], signal)
    .then((lease) => {
      writeEntered = true;
      return lease;
    });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(writeEntered, false);
  firstRead.release();
  secondRead.release();
  const writeLease = await within(write, "the conflicting write lease");
  writeLease.release();
});

test("a cancelled queued lease is removed without blocking the next waiter", async () => {
  const arbiter = new ToolResourceArbiter();
  const activeSignal = new AbortController().signal;
  const active = await arbiter.acquire([{ kind: "workspace", key: "workspace", mode: "write" }], activeSignal);
  const cancelled = new AbortController();
  const waiting = arbiter.acquire([{ kind: "file", key: "/workspace/a", mode: "read" }], cancelled.signal);
  cancelled.abort(new Error("cancel queued lease"));
  await assert.rejects(waiting, /cancel queued lease/u);
  active.release();
  const next = await within(
    arbiter.acquire([{ kind: "file", key: "/workspace/a", mode: "read" }], activeSignal),
    "the waiter after cancellation",
  );
  next.release();
});

test("unrelated leases bypass a waiting writer without letting later readers starve it", async () => {
  const arbiter = new ToolResourceArbiter();
  const controller = new AbortController();
  const claims: ResourceClaim[] = [{ kind: "file", key: "/workspace/a", mode: "read" }];
  const active = await arbiter.acquire(claims, controller.signal);
  const writerAbort = new AbortController();
  const writer = arbiter.acquire([{ ...claims[0]!, mode: "write" }], writerAbort.signal);
  let readerEntered = false;
  const reader = arbiter.acquire(claims, controller.signal).then((lease) => {
    readerEntered = true;
    return lease;
  });
  try {
    const unrelated = await within(arbiter.acquire([
      { kind: "file", key: "/workspace/b", mode: "write" },
    ], controller.signal), "an unrelated lease behind a blocked writer");
    unrelated.release();
    assert.equal(readerEntered, false);
    writerAbort.abort(new Error("cancel blocked writer"));
    await assert.rejects(writer, /cancel blocked writer/u);
    const readerLease = await within(reader, "the compatible reader after writer cancellation");
    readerLease.release();
  } finally {
    controller.abort();
    writerAbort.abort();
    active.release();
    await Promise.allSettled([writer, reader]);
  }
});

test("authorization denial does not acquire a shared resource lease", async (t) => {
  const arbiter = new RejectingResourceArbiter();
  const tool = fixtureTool("write", "write", async () => ({ content: "written", isError: false }));
  const coordinator = new ToolCoordinator(
    new ToolRegistry([tool]),
    {},
    undefined,
    { authorize: () => ({ decision: "deny" }) },
    { resourceArbiter: arbiter },
  );
  const [result] = await coordinator.execute(
    [{ callId: "call", name: "write", input: {}, index: 0 }],
    await context(t),
  );
  assert.equal(arbiter.acquired, 0);
  assert.equal(result?.result.isError, true);
});

test("a conflicting coordinator waits through durable completion", async (t) => {
  const arbiter = new ToolResourceArbiter();
  let completedEntered!: () => void;
  const completionEntered = new Promise<void>((resolve) => { completedEntered = resolve; });
  let releaseCompleted!: () => void;
  const completedReleased = new Promise<void>((resolve) => { releaseCompleted = resolve; });
  let secondStarted = false;
  const firstTool = fixtureTool("first", "write", async () => ({ content: "first", isError: false }));
  const secondTool = fixtureTool("second", "read", async () => {
    secondStarted = true;
    return { content: "second", isError: false };
  });
  const first = new ToolCoordinator(
    new ToolRegistry([firstTool]),
    {},
    undefined,
    {},
    { resourceArbiter: arbiter },
  );
  const second = new ToolCoordinator(
    new ToolRegistry([secondTool]),
    {},
    undefined,
    {},
    { resourceArbiter: arbiter },
  );
  const firstRun = first.execute(
    [{ callId: "first-call", name: "first", input: {}, index: 0 }],
    await context(t),
    {
      async completed() {
        completedEntered();
        await completedReleased;
      },
    },
  );
  await within(completionEntered, "the first completion observer");
  const secondRun = second.execute(
    [{ callId: "second-call", name: "second", input: {}, index: 0 }],
    await context(t),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(secondStarted, false);
  releaseCompleted();
  await within(Promise.all([firstRun, secondRun]), "both coordinated executions");
  assert.equal(secondStarted, true);
});

test("completion failure stops queued dispatch, retains running effects, and releases shared leases", async (t) => {
  for (const failure of [new Error("completion failed"), undefined]) {
    const arbiter = new ToolResourceArbiter();
    let firstEntered!: () => void;
    const entered = new Promise<void>((resolve) => { firstEntered = resolve; });
    let releaseFirst!: () => void;
    const released = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let completionFailed!: () => void;
    const failed = new Promise<void>((resolve) => { completionFailed = resolve; });
    let queuedStarted = false;
    const tools = [
      fixtureTool("first", "write", async () => {
        firstEntered();
        await released;
        return { content: "first", isError: false };
      }),
      fixtureTool("failing", "write", async () => ({ content: "failing", isError: false })),
      fixtureTool("queued", "write", async () => {
        queuedStarted = true;
        return { content: "queued", isError: false };
      }),
    ].map((tool): HarnessTool => ({
      ...tool,
      resources() {
        return [{ kind: "file", key: tool.definition.name === "failing" ? "/workspace/b" : "/workspace/a", mode: "write" }];
      },
    }));
    const first = new ToolCoordinator(new ToolRegistry(tools), {}, undefined, {}, { resourceArbiter: arbiter });
    const running = first.execute(
      tools.map((tool, index) => ({ callId: tool.definition.name, name: tool.definition.name, input: {}, index })),
      await context(t),
      {
        completed(entry) {
          if (entry.invocation.name !== "failing") return;
          completionFailed();
          throw failure;
        },
      },
    );
    const rejected = assert.rejects(running, (error) => error === failure);
    try {
      await within(Promise.all([entered, failed]), "a running effect beside a fatal completion");
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(queuedStarted, false);
      assert.throws(() => first.turnSnapshot(), /while a tool batch is executing/u);
    } finally {
      releaseFirst();
    }
    await within(rejected, "batch failure after raw settlement");
    assert.equal(queuedStarted, false);
    let secondStarted = false;
    const secondTool: HarnessTool = {
      ...fixtureTool("second", "read", async () => {
        secondStarted = true;
        return { content: "second", isError: false };
      }),
      resources() { return [{ kind: "file", key: "/workspace/a", mode: "read" }]; },
    };
    const second = new ToolCoordinator(new ToolRegistry([secondTool]), {}, undefined, {}, { resourceArbiter: arbiter });
    await within(second.execute(
      [{ callId: "second-call", name: "second", input: {}, index: 0 }],
      await context(t),
    ), "execution after completion failure");
    assert.equal(secondStarted, true);
  }
});

for (const boundary of ["authorization", "resource", "presentation dispatch", "durable dispatch"] as const) {
  test(`completion failure prevents raw dispatch after waiting at ${boundary}`, async (t) => {
    const failure = boundary === "resource" ? undefined : new Error("completion failed");
    const arbiter = new ToolResourceArbiter();
    const selectedContext = await context(t);
    const claims: ResourceClaim[] = [{ kind: "file", key: "/workspace/waiting", mode: "write" }];
    const externalLease = boundary === "resource" ? await arbiter.acquire(claims, selectedContext.signal) : undefined;
    let enterBoundary!: () => void;
    const entered = new Promise<void>((resolve) => { enterBoundary = resolve; });
    let releaseBoundary!: () => void;
    const released = new Promise<void>((resolve) => { releaseBoundary = resolve; });
    let markFailed!: () => void;
    const failed = new Promise<void>((resolve) => { markFailed = resolve; });
    const executions: string[] = [];
    const completions: string[] = [];
    const tools = ["waiting", "failing"].map((name): HarnessTool => ({
      ...fixtureTool(name, "write", async () => {
        executions.push(name);
        if (name === "failing") {
          await entered;
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        return { content: name, isError: false };
      }),
      resources() { return [{ kind: "file", key: `/workspace/${name}`, mode: "write" }]; },
    }));
    const coordinator = new ToolCoordinator(new ToolRegistry(tools), {
      async dispatching(invocation) {
        if (invocation.name === "waiting" && boundary === "presentation dispatch") {
          enterBoundary();
          await released;
        }
      },
    }, undefined, {
      async authorize(request) {
        if (request.invocation.name === "waiting") {
          if (boundary === "authorization" || boundary === "resource") enterBoundary();
          if (boundary === "authorization") await released;
        }
        return { decision: "allow_once" };
      },
    }, { resourceArbiter: arbiter });
    const running = coordinator.execute(
      tools.map((tool, index) => ({ callId: tool.definition.name, name: tool.definition.name, input: {}, index })),
      selectedContext,
      {
        async dispatching(invocation) {
          if (invocation.name === "waiting" && boundary === "durable dispatch") {
            enterBoundary();
            await released;
          }
        },
        completed(entry) {
          completions.push(entry.invocation.name);
          if (entry.invocation.name === "failing") {
            markFailed();
            throw failure;
          }
        },
      },
    );
    const rejected = assert.rejects(running, (error) => error === failure);
    try {
      await within(failed, "the fatal completion while dispatch waits");
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.throws(() => coordinator.turnSnapshot(), /while a tool batch is executing/u);
    } finally {
      releaseBoundary();
      externalLease?.release();
    }
    await within(rejected, "the failed batch after dispatch is released");
    assert.deepEqual(executions, ["failing"]);
    assert.deepEqual(completions, ["failing"]);
    const lease = await within(arbiter.acquire(claims, selectedContext.signal), "resource ownership after failure");
    lease.release();
  });
}

test("abort keeps a lease until an abort-ignoring effect actually settles", async (t) => {
  const arbiter = new ToolResourceArbiter();
  const controller = new AbortController();
  let firstEntered!: () => void;
  const entered = new Promise<void>((resolve) => { firstEntered = resolve; });
  let releaseFirst!: () => void;
  const released = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let secondStarted = false;
  let durableEntered!: () => void;
  const durableStarted = new Promise<void>((resolve) => { durableEntered = resolve; });
  let releaseDurable!: () => void;
  const durableReleased = new Promise<void>((resolve) => { releaseDurable = resolve; });
  let durableContent: string | undefined;
  let presentationCompleted = false;
  const firstTool = fixtureTool("first", "write", async () => {
    firstEntered();
    await released;
    return { content: "first", isError: false };
  });
  const secondTool = fixtureTool("second", "read", async () => {
    secondStarted = true;
    return { content: "second", isError: false };
  });
  const first = new ToolCoordinator(
    new ToolRegistry([firstTool]),
    { completed() { presentationCompleted = true; } },
    undefined,
    {},
    { resourceArbiter: arbiter },
  );
  const second = new ToolCoordinator(new ToolRegistry([secondTool]), {}, undefined, {}, { resourceArbiter: arbiter });
  let firstSettled = false;
  const firstRun = first.execute(
    [{ callId: "first-call", name: "first", input: {}, index: 0 }],
    await context(t, controller.signal),
    {
      async completed(entry) {
        durableContent = entry.result.content;
        durableEntered();
        await durableReleased;
      },
    },
  ).finally(() => { firstSettled = true; });
  await within(entered, "the abort-ignoring effect");
  const secondRun = second.execute(
    [{ callId: "second-call", name: "second", input: {}, index: 0 }],
    await context(t),
  );
  const reason = new Error("abort first effect");
  controller.abort(reason);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(firstSettled, false);
  assert.equal(secondStarted, false);
  releaseFirst();
  await within(durableStarted, "durable completion after raw settlement");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(firstSettled, false);
  assert.equal(secondStarted, false);
  assert.equal(durableContent, "first");
  assert.equal(presentationCompleted, false);
  releaseDurable();
  await assert.rejects(firstRun, (error) => error === reason);
  await within(secondRun, "the conflicting execution after raw settlement");
  assert.equal(secondStarted, true);
});

test("presentation completion runs after releasing the shared lease", async (t) => {
  const arbiter = new ToolResourceArbiter();
  const secondTool = fixtureTool("second", "read", async () => ({ content: "second", isError: false }));
  const second = new ToolCoordinator(new ToolRegistry([secondTool]), {}, undefined, {}, { resourceArbiter: arbiter });
  const secondContext = await context(t);
  const firstTool = fixtureTool("first", "write", async () => ({ content: "first", isError: false }));
  const first = new ToolCoordinator(
    new ToolRegistry([firstTool]),
    {
      async completed() {
        await second.execute(
          [{ callId: "second-call", name: "second", input: {}, index: 0 }],
          secondContext,
        );
      },
    },
    undefined,
    {},
    { resourceArbiter: arbiter },
  );
  await within(first.execute(
    [{ callId: "first-call", name: "first", input: {}, index: 0 }],
    await context(t),
  ), "presentation completion without a resource deadlock");
});

test("shell claims the whole workspace as a write resource", async (t) => {
  const tool = new ShellTool();
  const claims = tool.resources({}, await context(t));
  assert.ok(claims.some((claim) => claim.kind === "workspace" && claim.key === "workspace" && claim.mode === "write"));
});
