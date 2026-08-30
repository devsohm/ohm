import assert from "node:assert/strict";
import test from "node:test";

import {
  InteractiveSessionOperations,
  type InteractiveSessionOperationsTerminal,
  type InteractiveSessionOperationsSession,
  type InteractiveSessionRuntime,
} from "../../src/modes/interactive-session-operations.js";
import { MissingSessionCwdError } from "../../src/service/agent-session-runtime.js";
import { TuiSelectionCancelledError } from "../../src/tui/controller.js";

type ImportTerminalFixture = Pick<InteractiveSessionOperationsTerminal, "choose" | "notify">;

test("bare /import asks for the JSONL path instead of reporting a usage error", async () => {
  const calls: Array<[string, string | undefined, AbortSignal | undefined]> = [];
  const notifications: string[] = [];
  const questions: Array<[string, AbortSignal | undefined, { cancelable?: boolean } | undefined]> = [];
  const sessionFixture = { isIdle: true };
  // SAFETY: importSession never reads the session; isIdle establishes the intended AgentSession test-double surface.
  const session = sessionFixture as InteractiveSessionOperationsSession;
  const runtime: InteractiveSessionRuntime = {
    session,
    cwd: "/active/workspace",
    services: { agentDir: "/agent" },
    async newSession() { return { cancelled: false }; },
    async switchSession() { return { cancelled: false }; },
    async fork() { return { cancelled: false }; },
    async importFromJsonl(path: string, cwdOverride?: string, signal?: AbortSignal) {
      calls.push([path, cwdOverride, signal]);
      return { cancelled: false };
    },
  };
  // SAFETY: the fixture implements the exact terminal methods exercised by importSession.
  const terminal = {
    async question(prompt: string, signal?: AbortSignal, options?: { cancelable?: boolean }) {
      questions.push([prompt, signal, options]);
      return "/tmp/prompted.jsonl";
    },
    async choose<T>(_prompt: string, selections: Array<{ value: T }>) {
      return selections[0]!.value;
    },
    notify(message: string) { notifications.push(message); },
  } as InteractiveSessionOperationsTerminal;
  const operations = new InteractiveSessionOperations({
    runtime,
    terminal,
    resolveInputPath: (value) => value,
    refreshTranscript() {},
    updateContext() {},
  });
  const controller = new AbortController();

  await operations.importSession("", controller.signal);

  assert.deepEqual(questions, [["Import session JSONL path: ", controller.signal, { cancelable: true }]]);
  assert.deepEqual(calls, [["/tmp/prompted.jsonl", undefined, controller.signal]]);
  assert.deepEqual(notifications, ["Imported session from /tmp/prompted.jsonl"]);
});

test("/import offers the active cwd when the stored cwd is missing, then retries with the override", async () => {
  const calls: Array<[string, string | undefined, AbortSignal | undefined]> = [];
  const notifications: string[] = [];
  const choices: unknown[] = [true, "/active/workspace"];
  const choiceSignals: Array<AbortSignal | undefined> = [];
  const sessionFixture = { isIdle: true };
  // SAFETY: importSession never reads the session; isIdle establishes the intended AgentSession test-double surface.
  const session = sessionFixture as InteractiveSessionOperationsSession;
  const runtime: InteractiveSessionRuntime = {
    session,
    cwd: "/active/workspace",
    services: { agentDir: "/agent" },
    async newSession() { return { cancelled: false }; },
    async switchSession() { return { cancelled: false }; },
    async fork() { return { cancelled: false }; },
    async importFromJsonl(path: string, cwdOverride?: string, signal?: AbortSignal) {
      calls.push([path, cwdOverride, signal]);
      if (cwdOverride === undefined) {
        throw new MissingSessionCwdError({
          sessionFile: path,
          sessionCwd: "/old/workspace",
          fallbackCwd: "/active/workspace",
        });
      }
      return { cancelled: false };
    },
  };
  const terminalFixture: ImportTerminalFixture = {
    async choose<T>(_prompt: string, selections: Array<{ value: T }>, signal?: AbortSignal) {
      choiceSignals.push(signal);
      const choice = choices.shift();
      const selected = selections.find((selection) => selection.value === choice);
      if (selected === undefined) throw new Error("Fixture choice is unavailable");
      return selected.value;
    },
    notify(message: string) { notifications.push(message); },
  };
  // SAFETY: this import test invokes only choose and notify, both checked by ImportTerminalFixture.
  const terminal = terminalFixture as InteractiveSessionOperationsTerminal;
  const operations = new InteractiveSessionOperations({
    runtime,
    terminal,
    resolveInputPath: (value) => value,
    refreshTranscript() {},
    updateContext() {},
  });
  const controller = new AbortController();

  await operations.importSession("/tmp/imported.jsonl", controller.signal);

  assert.deepEqual(calls, [
    ["/tmp/imported.jsonl", undefined, controller.signal],
    ["/tmp/imported.jsonl", "/active/workspace", controller.signal],
  ]);
  assert.deepEqual(choiceSignals, [controller.signal, controller.signal]);
  assert.deepEqual(notifications, ["Imported session from /tmp/imported.jsonl"]);
});

test("/import can be cancelled after reporting the missing stored cwd", async () => {
  const calls: Array<[string, string | undefined]> = [];
  const notifications: string[] = [];
  const choices: unknown[] = [true, new TuiSelectionCancelledError()];
  const sessionFixture = { isIdle: true };
  // SAFETY: importSession never reads the session; isIdle establishes the intended AgentSession test-double surface.
  const session = sessionFixture as InteractiveSessionOperationsSession;
  const runtime: InteractiveSessionRuntime = {
    session,
    cwd: "/active/workspace",
    services: { agentDir: "/agent" },
    async newSession() { return { cancelled: false }; },
    async switchSession() { return { cancelled: false }; },
    async fork() { return { cancelled: false }; },
    async importFromJsonl(path: string, cwdOverride?: string) {
      calls.push([path, cwdOverride]);
      throw new MissingSessionCwdError({
        sessionFile: path,
        sessionCwd: "/old/workspace",
        fallbackCwd: "/active/workspace",
      });
    },
  };
  const terminalFixture: ImportTerminalFixture = {
    async choose<T>(_prompt: string, selections: Array<{ value: T }>) {
      const choice = choices.shift();
      if (choice instanceof Error) throw choice;
      const selected = selections.find((selection) => selection.value === choice);
      if (selected === undefined) throw new Error("Fixture choice is unavailable");
      return selected.value;
    },
    notify(message: string) { notifications.push(message); },
  };
  // SAFETY: this test invokes only choose and notify, both checked by ImportTerminalFixture.
  const terminal = terminalFixture as InteractiveSessionOperationsTerminal;
  const operations = new InteractiveSessionOperations({
    runtime,
    terminal,
    resolveInputPath: (value) => value,
    refreshTranscript() {},
    updateContext() {},
  });

  await operations.importSession("/tmp/imported.jsonl");

  assert.deepEqual(calls, [["/tmp/imported.jsonl", undefined]]);
  assert.deepEqual(notifications, ["Import cancelled"]);
});
