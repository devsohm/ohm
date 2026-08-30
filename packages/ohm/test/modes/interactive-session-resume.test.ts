import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  InteractiveSessionOperations,
  type InteractiveSessionOperationsTerminal,
  type InteractiveSessionOperationsSession,
  type InteractiveSessionRuntime,
} from "../../src/modes/interactive-session-operations.js";
import { MissingSessionCwdError } from "../../src/service/agent-session-runtime.js";
import { SessionManager } from "../../src/storage/session-manager.js";
import type { PickerItem } from "../../src/tui/types.js";

test("session resume offers the active cwd when the stored cwd is missing, then retries with the override", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-session-resume-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const path = join(root, "saved.jsonl");
  await writeFile(path, "{}\n");
  const calls: Array<[string, { cwdOverride?: string; signal?: AbortSignal } | undefined]> = [];
  const notifications: string[] = [];
  let chooseSignal: AbortSignal | undefined;
  const sessionFixture: Partial<InteractiveSessionOperationsSession> = {
    isIdle: true,
    sessionFile: join(root, "active.jsonl"),
  };
  // SAFETY: switchSession reads only isIdle and sessionFile from this session fixture.
  const session = sessionFixture as InteractiveSessionOperationsSession;
  const runtime: InteractiveSessionRuntime = {
    session,
    cwd: root,
    services: { agentDir: join(root, ".ohm") },
    async newSession() { return { cancelled: false }; },
    async switchSession(selectedPath: string, options?: { cwdOverride?: string; signal?: AbortSignal }) {
      calls.push([selectedPath, options]);
      if (options?.cwdOverride === undefined) {
        throw new MissingSessionCwdError({
          sessionFile: selectedPath,
          sessionCwd: "/old/workspace",
          fallbackCwd: root,
        });
      }
      return { cancelled: false };
    },
    async fork() { return { cancelled: false }; },
    async importFromJsonl() { return { cancelled: false }; },
  };
  const terminalFixture: Pick<InteractiveSessionOperationsTerminal, "choose" | "notify"> = {
    async choose<T>(_prompt: string, choices: Array<{ value: T }>, signal?: AbortSignal) {
      chooseSignal = signal;
      const selected = choices.find((choice) => choice.value === root);
      if (selected === undefined) throw new Error("Current workspace choice is unavailable");
      return selected.value;
    },
    notify(message: string) { notifications.push(message); },
  };
  // SAFETY: this test invokes only choose and notify, both checked by the fixture type.
  const terminal = terminalFixture as InteractiveSessionOperationsTerminal;
  const operations = new InteractiveSessionOperations({
    runtime,
    terminal,
    refreshTranscript() {},
    updateContext() {},
  });
  const controller = new AbortController();

  await operations.switchSession(path, controller.signal);

  assert.deepEqual(calls, [
    [path, { signal: controller.signal }],
    [path, { cwdOverride: root, signal: controller.signal }],
  ]);
  assert.equal(chooseSignal, controller.signal);
  assert.deepEqual(notifications, ["Resumed session in current working directory"]);
});

test("session resume forwards its caller signal through an explicit path switch", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-session-resume-signal-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const manager = SessionManager.create(root, root, { id: "resume-signal" });
  manager.appendMessage({
    id: "message",
    role: "user",
    content: [{ type: "text", text: "hello" }],
    createdAt: "2026-07-25T00:00:00.000Z",
  });
  manager.appendMessage({
    id: "answer",
    role: "assistant",
    content: [{ type: "text", text: "hi" }],
    createdAt: "2026-07-25T00:00:01.000Z",
  });
  const path = manager.getSessionFile()!;
  let switchSignal: AbortSignal | undefined;
  const sessionFixture: Partial<InteractiveSessionOperationsSession> = {
    isIdle: true,
    sessionFile: manager.getSessionFile(),
    nativeSessionManager: manager,
  };
  // SAFETY: explicit-path resume reads only isIdle and the stored session metadata from this fixture.
  const session = sessionFixture as InteractiveSessionOperationsSession;
  const runtime: InteractiveSessionRuntime = {
    session,
    cwd: root,
    services: { agentDir: join(root, ".ohm") },
    async newSession() { return { cancelled: false }; },
    async switchSession(_path: string, options?: { signal?: AbortSignal }) {
      switchSignal = options?.signal;
      return { cancelled: false };
    },
    async fork() { return { cancelled: false }; },
    async importFromJsonl() { return { cancelled: false }; },
  };
  const terminalFixture: Pick<InteractiveSessionOperationsTerminal, "notify"> = { notify() {} };
  // SAFETY: explicit-path resume reaches only notify, checked by the fixture type.
  const terminal = terminalFixture as InteractiveSessionOperationsTerminal;
  const operations = new InteractiveSessionOperations({
    runtime,
    terminal,
    refreshTranscript() {},
    updateContext() {},
  });
  const controller = new AbortController();

  await operations.resume(path, controller.signal);

  assert.equal(switchSignal, controller.signal);
});

test("default session discovery resumes another workspace by picker or reference", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-session-resume-all-"));
  const previousAgentDir = process.env["OHM_HOME"];
  process.env["OHM_HOME"] = join(root, "agent");
  context.after(() => {
    if (previousAgentDir === undefined) delete process.env["OHM_HOME"];
    else process.env["OHM_HOME"] = previousAgentDir;
  });
  const currentCwd = join(root, "current");
  const otherCwd = join(root, "other");
  await mkdir(currentCwd, { recursive: true });
  await mkdir(otherCwd, { recursive: true });
  const current = SessionManager.create(currentCwd, undefined, { id: "current-session" });
  const other = SessionManager.create(otherCwd, undefined, { id: "other-session" });
  context.after(async () => {
    current.closeV4Store();
    other.closeV4Store();
    await rm(root, { recursive: true, force: true });
  });
  for (const manager of [current, other]) {
    manager.appendMessage({
      id: `${manager.getSessionId()}-message`,
      role: "user",
      content: [{ type: "text", text: manager.getSessionId() }],
      createdAt: "2026-07-25T00:00:00.000Z",
    });
  }
  const pickerPaths: string[] = [];
  const switched: string[] = [];
  const sessionFixture: Partial<InteractiveSessionOperationsSession> = {
    isIdle: true,
    sessionFile: current.getSessionFile(),
    nativeSessionManager: current,
  };
  // SAFETY: discovery reads only isIdle, sessionFile, and nativeSessionManager from this fixture.
  const session = sessionFixture as InteractiveSessionOperationsSession;
  const runtime: InteractiveSessionRuntime = {
    session,
    cwd: currentCwd,
    services: { agentDir: join(root, "agent") },
    async newSession() { return { cancelled: false }; },
    async switchSession(path: string) {
      switched.push(path);
      return { cancelled: false };
    },
    async fork() { return { cancelled: false }; },
    async importFromJsonl() { return { cancelled: false }; },
  };
  const terminalFixture: Pick<
    InteractiveSessionOperationsTerminal,
    "notify" | "openPicker" | "setPickerItems" | "setSessionPickerPagination" | "setSessionPickerScope"
  > = {
    setPickerItems<T>(_kind: "session", items: readonly PickerItem<T>[]) {
      pickerPaths.splice(0, pickerPaths.length, ...items.map((item) => String(item.value)));
    },
    setSessionPickerScope() {},
    setSessionPickerPagination() {},
    openPicker() {},
    notify() {},
  };
  // SAFETY: discovery reaches only picker and notification methods checked by the fixture type.
  const terminal = terminalFixture as InteractiveSessionOperationsTerminal;
  const operations = new InteractiveSessionOperations({
    runtime,
    terminal,
    refreshTranscript() {},
    updateContext() {},
  });

  await operations.resume("--all");
  assert.equal(pickerPaths.includes(other.getSessionFile()!), true);

  await operations.resume("other-session");
  assert.deepEqual(switched, [other.getSessionFile()]);
});
