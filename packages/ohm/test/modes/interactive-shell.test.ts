import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { EventEnvelope } from "../../src/core/events.js";
import { isJsonObject } from "../../src/core/json.js";
import { NUMBER_VALUE } from "../../src/core/value-schemas.js";
import { loadDirectExtensions, type RuntimeExtensionEventMap } from "../../src/extensions/runtime.js";
import {
  beginInteractiveShellPresentation,
  type InteractiveShellHost,
  type InteractiveShellSession,
  runInteractiveShell,
} from "../../src/modes/interactive-shell.js";
import type { AgentSessionBashResult } from "../../src/service/agent-session.js";
import { Check } from "typebox/value";

test("interactive shell presentation streams into one retained tool card", () => {
  const events: EventEnvelope[] = [];
  const settled: string[] = [];
  let now = 1_000;
  const presentation = beginInteractiveShellPresentation({
    terminal: {
      render(event) { events.push(event); },
      settleStandaloneTool(callId) { settled.push(callId); },
    },
    threadId: "thread",
    command: "printf hello",
    hidden: true,
    now: () => now,
  });

  now = 1_250;
  presentation.onChunk("hel");
  now = 1_500;
  presentation.onChunk("lo\n");
  presentation.complete({
    output: "hello\n",
    exitCode: 0,
    cancelled: false,
    truncated: false,
  });
  presentation.complete({ output: "duplicate", exitCode: 0, cancelled: false, truncated: false });

  assert.deepEqual(events.map((entry) => entry.event.type), [
    "tool_requested",
    "tool_started",
    "tool_progress",
    "tool_progress",
    "tool_completed",
  ]);
  assert.deepEqual(settled, [events[0]!.event.type === "tool_requested" ? events[0]!.event.callId : ""]);
  const requested = events[0]!.event;
  assert.equal(requested.type, "tool_requested");
  if (requested.type !== "tool_requested") return;
  assert.deepEqual(requested.input, { command: "!! printf hello", excludeFromContext: true });
  const progress = events[3]!.event;
  assert.equal(progress.type, "tool_progress");
  if (progress.type !== "tool_progress" || progress.progress.type !== "output") return;
  assert.equal(progress.progress.delta, "lo\n");
  assert.equal(progress.progress.stdoutBytes, 6);
  assert.equal(progress.progress.elapsedMs, 500);
  const completed = events[4]!.event;
  assert.equal(completed.type, "tool_completed");
  if (completed.type !== "tool_completed") return;
  assert.equal(completed.result?.content, "hello\n");
  assert.deepEqual(completed.result?.metadata, { exitCode: 0, durationMs: 500 });
});

test("interactive shell presentation settles startup failures as errors", () => {
  const events: EventEnvelope[] = [];
  const presentation = beginInteractiveShellPresentation({
    terminal: { render(event) { events.push(event); }, settleStandaloneTool() {} },
    threadId: "thread",
    command: "broken",
    hidden: false,
  });
  presentation.fail(new Error("could not start"));
  const completed = events.at(-1)!.event;
  assert.equal(completed.type, "tool_completed");
  if (completed.type !== "tool_completed") return;
  assert.equal(completed.isError, true);
  assert.equal(completed.preview, "could not start");
});

test("interactive shell presentation renders completed timeout and signal results as errors", () => {
  const events: EventEnvelope[] = [];
  const presentation = beginInteractiveShellPresentation({
    terminal: { render(event) { events.push(event); }, settleStandaloneTool() {} },
    threadId: "thread",
    command: "slow command",
    hidden: false,
  });

  presentation.complete({
    output: "Tool failed: command stopped",
    exitCode: undefined,
    isError: true,
    cancelled: false,
    timedOut: true,
    signal: "SIGTERM",
    truncated: false,
  });

  const completed = events.at(-1)!.event;
  assert.equal(completed.type, "tool_completed");
  if (completed.type !== "tool_completed") return;
  assert.equal(completed.isError, true);
  const resultMetadata = completed.result?.metadata;
  if (!isJsonObject(resultMetadata)) assert.fail("Shell result metadata must be an object");
  assert.equal(resultMetadata.timedOut, true);
  assert.equal(resultMetadata.signal, "SIGTERM");
  assert.deepEqual(Object.keys(resultMetadata).sort(), ["durationMs", "signal", "timedOut"]);
  if (!Check(NUMBER_VALUE, resultMetadata.durationMs)) assert.fail("Shell duration must be a number");
  assert.ok(resultMetadata.durationMs >= 0);
});

test("interactive shell presentation safely settles hostile startup failures", () => {
  const events: EventEnvelope[] = [];
  let traps = 0;
  const hostile = new Proxy({}, {
    get() {
      traps += 1;
      throw new Error("property trap");
    },
    getOwnPropertyDescriptor() {
      traps += 1;
      throw new Error("descriptor trap");
    },
    getPrototypeOf() {
      traps += 1;
      throw new Error("prototype trap");
    },
    ownKeys() {
      traps += 1;
      throw new Error("keys trap");
    },
  });
  const presentation = beginInteractiveShellPresentation({
    terminal: { render(event) { events.push(event); }, settleStandaloneTool() {} },
    threadId: "thread",
    command: "broken",
    hidden: false,
  });

  presentation.fail(hostile);

  const completed = events.at(-1)!.event;
  assert.equal(completed.type, "tool_completed");
  if (completed.type !== "tool_completed") return;
  assert.equal(completed.isError, true);
  assert.equal(completed.preview, "[Thrown object]");
  assert.equal(traps, 0);
});

test("handled user_bash metadata reaches the durable bash message boundary", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "ohm-interactive-shell-"));
  context.after(async () => await rm(workspace, { recursive: true, force: true }));
  const fullOutputPath = join(workspace, "full-output.log");
  const host = await loadDirectExtensions([], {
    workspace,
    inlineExtensions: [{
      name: "synthetic-shell",
      factory(ohm) {
        ohm.on("user_bash", () => ({
          result: {
            output: "bounded preview",
            exitCode: 9,
            cancelled: false,
            truncated: true,
            fullOutputPath,
          },
        }));
      },
    }],
  });
  context.after(async () => await host.close());
  let recorded: {
    command: string;
    result: AgentSessionBashResult;
    options: { excludeFromContext?: boolean };
  } | undefined;
  // SAFETY: a handled user_bash result invokes only recordBashResult on this fixture.
  const session = {
    recordBashResult(
      command: string,
      result: AgentSessionBashResult,
      options: { excludeFromContext?: boolean },
    ) {
      recorded = { command, result, options };
    },
  } as InteractiveShellSession;

  const result = await runInteractiveShell({
    command: "synthetic",
    hidden: true,
    workspace,
    host,
    session,
  });

  assert.deepEqual(result, {
    output: "bounded preview",
    exitCode: 9,
    isError: true,
    cancelled: false,
    truncated: true,
    fullOutputPath,
  });
  assert.deepEqual(recorded, {
    command: "synthetic",
    result,
    options: { excludeFromContext: true },
  });
});

test("handled shell signals and timeouts stay aligned through persistence and the user_shell event", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "ohm-interactive-shell-terminal-state-"));
  context.after(async () => await rm(workspace, { recursive: true, force: true }));
  const observed: Array<RuntimeExtensionEventMap["event"]> = [];
  const host: InteractiveShellHost = {
    async reduceBeforeUserShell({ command }: { command: string }) {
      return command === "signal"
        ? {
            action: "handled" as const,
            command,
            cwd: workspace,
            result: {
              text: "signal preview",
              exitCode: null,
              isError: false,
              cancelled: false,
              signal: "SIGTERM",
            },
          }
        : {
            action: "handled" as const,
            command,
            cwd: workspace,
            result: {
              text: "timeout preview",
              exitCode: null,
              isError: false,
              cancelled: false,
              timedOut: true,
            },
          };
    },
    async dispatch(event, value) {
      if (event === "event") observed.push(value);
    },
  };
  const recorded: Array<{ command: string; result: AgentSessionBashResult }> = [];
  // SAFETY: handled shell reductions invoke only recordBashResult on this fixture.
  const session = {
    recordBashResult(command: string, result: AgentSessionBashResult) {
      recorded.push({ command, result });
    },
  } as InteractiveShellSession;

  const signal = await runInteractiveShell({
    command: "signal",
    hidden: false,
    workspace,
    host,
    session,
  });
  const timeout = await runInteractiveShell({
    command: "timeout",
    hidden: false,
    workspace,
    host,
    session,
  });

  assert.deepEqual(signal, {
    output: "signal preview",
    isError: true,
    exitCode: undefined,
    cancelled: false,
    signal: "SIGTERM",
    truncated: false,
  });
  assert.deepEqual(timeout, {
    output: "timeout preview",
    isError: true,
    exitCode: undefined,
    cancelled: false,
    timedOut: true,
    truncated: false,
  });
  assert.deepEqual(recorded, [
    { command: "signal", result: signal },
    { command: "timeout", result: timeout },
  ]);
  assert.deepEqual(observed, [
    {
      type: "user_shell",
      command: "signal",
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
    {
      type: "user_shell",
      command: "timeout",
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
  ]);
});

test("interactive shell presentation receives the transformed command before execution", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "ohm-interactive-shell-transform-"));
  context.after(async () => await rm(workspace, { recursive: true, force: true }));
  const host: InteractiveShellHost = {
    async reduceBeforeUserShell() {
      return { action: "execute", command: "printf transformed", cwd: workspace };
    },
    async dispatch() {},
  };
  const prepared: string[] = [];
  const executed: string[] = [];
  // SAFETY: executable shell reductions invoke executeBash and abortBash; recordBashResult is not reached.
  const session = {
    async executeBash(command: string) {
      executed.push(command);
      return { output: "transformed", exitCode: 0, cancelled: false, truncated: false };
    },
    abortBash() {},
  } as InteractiveShellSession;

  await runInteractiveShell({
    command: "printf original",
    hidden: false,
    workspace,
    host,
    session,
    onPrepared(command) { prepared.push(command); },
  });

  assert.deepEqual(prepared, ["printf transformed"]);
  assert.deepEqual(executed, ["printf transformed"]);
});
