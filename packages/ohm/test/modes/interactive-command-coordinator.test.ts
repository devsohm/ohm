import assert from "node:assert/strict";
import test from "node:test";

import {
  INTERACTIVE_BUILTIN_COMMANDS,
  InteractiveCommandCoordinator,
  type InteractiveActionHandlers,
  type InteractiveCommandHandlers,
} from "../../src/modes/interactive-command-coordinator.js";
import type { PickerItem, TuiAction } from "../../src/tui/types.js";

function commandHandlers<TImage>(
  handler: InteractiveCommandHandlers<TImage>[keyof InteractiveCommandHandlers<TImage>],
): InteractiveCommandHandlers<TImage> {
  return {
    atlas: handler,
    cancel: handler,
    changelog: handler,
    clone: handler,
    compact: handler,
    context: handler,
    copy: handler,
    export: handler,
    fork: handler,
    help: handler,
    hotkeys: handler,
    import: handler,
    login: handler,
    logout: handler,
    model: handler,
    name: handler,
    new: handler,
    quit: handler,
    recover: handler,
    refresh: handler,
    resources: handler,
    resume: handler,
    "scoped-models": handler,
    session: handler,
    settings: handler,
    share: handler,
    thinking: handler,
    trust: handler,
  };
}

test("interactive coordinator dispatches every built-in and canonical alias", async () => {
  const removedCommand = ["/re", "load"].join("");
  const calls: Array<{ command: string; args: string; images: readonly string[] }> = [];
  const commands = commandHandlers<string>((request) => {
    calls.push({ command: request.command, args: request.args, images: request.images });
  });
  const unknown: string[] = [];
  const coordinator = new InteractiveCommandCoordinator<string>({
    commands,
    unknownCommand(request) { unknown.push(request.command); return false; },
    submissions: { prompt() {}, shell() {} },
    actions: actionHandlers(),
  });

  for (const command of INTERACTIVE_BUILTIN_COMMANDS) {
    assert.equal(await coordinator.dispatchSlash(`/${command} first   second`, ["image"]), true);
  }
  assert.equal(await coordinator.dispatchSlash("/exit", []), true);
  assert.equal(await coordinator.dispatchSlash("/clear", []), true);
  assert.equal(await coordinator.dispatchSlash("/models provider/model", []), false);
  assert.equal(await coordinator.dispatchSlash(removedCommand, []), false);
  assert.equal(await coordinator.dispatchSlash("/extension-command value", []), false);
  assert.deepEqual(calls.slice(0, INTERACTIVE_BUILTIN_COMMANDS.length).map((call) => call.command), [...INTERACTIVE_BUILTIN_COMMANDS]);
  assert.deepEqual(calls[0], { command: "atlas", args: "first second", images: ["image"] });
  assert.deepEqual(calls.slice(-2).map((call) => call.command), ["quit", "new"]);
  assert.deepEqual(unknown, ["models", removedCommand.slice(1), "extension-command"]);
});

test("interactive coordinator classifies slash, shell, hidden shell, and prompt submissions", async () => {
  const events: unknown[] = [];
  const coordinator = new InteractiveCommandCoordinator<string>({
    commands: commandHandlers<string>((request) => { events.push(["command", request.command]); }),
    unknownCommand() { return false; },
    submissions: {
      prompt(text, images) { events.push(["prompt", text, images]); },
      shell(request) { events.push(["shell", request]); },
    },
    actions: actionHandlers(),
  });

  await coordinator.dispatchSubmission("/help");
  await coordinator.dispatchSubmission("/unknown value", ["attachment"]);
  await coordinator.dispatchSubmission("! pwd ");
  await coordinator.dispatchSubmission("!! env");
  await coordinator.dispatchSubmission("hello", ["attachment"]);
  assert.deepEqual(events, [
    ["command", "help"],
    ["prompt", "/unknown value", ["attachment"]],
    ["shell", { command: "pwd", hidden: false, input: "! pwd " }],
    ["shell", { command: "env", hidden: true, input: "!! env" }],
    ["prompt", "hello", ["attachment"]],
  ]);
  await assert.rejects(async () => await coordinator.dispatchSubmission("! pwd", ["attachment"]), /do not accept image attachments/u);
});

test("interactive coordinator routes the complete TUI action surface", async () => {
  const calls: string[] = [];
  const coordinator = new InteractiveCommandCoordinator<never>({
    commands: commandHandlers<never>(() => undefined),
    unknownCommand() { return false; },
    submissions: { prompt() {}, shell() {} },
    actions: actionHandlers(calls),
  });
  const item: PickerItem = { id: "fixture", label: "Fixture", value: "/tmp/session.jsonl" };
  const actions: TuiAction[] = [
    { type: "exit" },
    { type: "signal", signal: "SIGTERM" },
    { type: "error", error: new Error("fixture") },
    { type: "cancel" },
    { type: "submit", text: "hello" },
    { type: "steer", text: "now" },
    { type: "follow_up", text: "later" },
    { type: "dequeue" },
    { type: "queue_restore_discard" },
    { type: "model_open" },
    { type: "session_open" },
    { type: "session_scope", scope: "all" },
    { type: "session_search", scope: "all", query: "needle" },
    { type: "session_more", scope: "all", query: "needle" },
    { type: "session_delete", item, scope: "all", query: "" },
    { type: "select", picker: "session", item },
    { type: "select", picker: "model", item },
    { type: "command", item },
    { type: "copy" },
    { type: "copy_text", text: "value", label: "Value" },
    { type: "cycle_thinking" },
    { type: "toggle_thinking_visibility" },
    { type: "extension_shortcut", shortcut: "ctrl+x", generation: new AbortController().signal },
    { type: "paste_image" },
    { type: "suspend" },
    { type: "select", picker: "provider", item },
  ];
  for (const action of actions) await coordinator.dispatchAction(action);
  assert.deepEqual(calls, [
    "exit", "exit", "error", "cancel", "submit", "active", "active", "dequeue", "queue", "models",
    "catalog", "catalog", "catalog", "catalog", "mutation", "session", "model",
    "command", "copy", "copyText", "thinking", "thinkingVisibility", "shortcut", "other", "other", "other",
  ]);
});

function actionHandlers(calls: string[] = []): InteractiveActionHandlers {
  return {
    exit() { calls.push("exit"); },
    error() { calls.push("error"); },
    cancel() { calls.push("cancel"); },
    submit() { calls.push("submit"); },
    activeSubmission() { calls.push("active"); },
    dequeue() { calls.push("dequeue"); },
    queueRestoreDiscard() { calls.push("queue"); },
    modelCatalog() { calls.push("models"); },
    sessionCatalog() { calls.push("catalog"); },
    sessionMutation() { calls.push("mutation"); },
    selectSession() { calls.push("session"); },
    selectModel() { calls.push("model"); },
    command() { calls.push("command"); },
    copy() { calls.push("copy"); },
    copyText() { calls.push("copyText"); },
    cycleThinking() { calls.push("thinking"); },
    toggleThinkingVisibility() { calls.push("thinkingVisibility"); },
    extensionShortcut() { calls.push("shortcut"); },
    other() { calls.push("other"); },
  };
}
