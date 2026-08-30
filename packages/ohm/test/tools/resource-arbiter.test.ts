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

test("completion failure releases a shared resource lease", async (t) => {
  const arbiter = new ToolResourceArbiter();
  const firstTool = fixtureTool("first", "write", async () => ({ content: "first", isError: false }));
  let secondStarted = false;
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
  await assert.rejects(first.execute(
    [{ callId: "first-call", name: "first", input: {}, index: 0 }],
    await context(t),
    { completed() { throw new Error("completion failed"); } },
  ), /completion failed/u);
  await within(second.execute(
    [{ callId: "second-call", name: "second", input: {}, index: 0 }],
    await context(t),
  ), "execution after completion failure");
  assert.equal(secondStarted, true);
});

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
