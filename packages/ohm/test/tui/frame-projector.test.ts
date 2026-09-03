import { terminalPattern } from "../../src/tui/terminal-pattern.js";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";

import { cellWidth, splitGraphemes } from "@ohm/terminal";

import { TuiController } from "../../src/tui/controller.js";
import { MAX_TERMINAL_IMAGE_AGGREGATE_BYTES } from "../../src/tui/terminal-image.js";
import {
  INTERNAL_TUI_FRAME_PROJECTOR,
  INTERNAL_TUI_FRAME_PROJECTOR_CLEAR,
  INTERNAL_TUI_PERSISTENT_POINTER_MAP,
  INTERNAL_TUI_PERSISTENT_POINTER_SOURCE,
  type InternalTuiControllerOptions,
  type TuiFrameProjectionRequest,
  type TuiFrameProjector,
  type TuiPersistentPointerBlock,
  type TuiPersistentPointerMap,
} from "../../src/tui/frame-projector.js";
import { internalToolRenderEntryKey } from "../../src/tui/layout.js";
import type { TuiControllerOptions, TuiViewState } from "../../src/tui/types.js";
import { createTheme } from "../../src/tui/theme.js";
import { stripAnsi } from "../../src/tui/unicode.js";
import { FakeInput, FakeOutput, envelope, tick } from "./helpers.js";
import { FocusedVirtualTerminal } from "./virtual-terminal.js";

async function richFrameProjector() {
  const previousForceColor = process.env.FORCE_COLOR;
  const previousNoColor = process.env.NO_COLOR;
  process.env.FORCE_COLOR = "3";
  delete process.env.NO_COLOR;
  try {
    return await import("../../src/tui/rich-frame-projector.js");
  } finally {
    if (previousForceColor === undefined) delete process.env.FORCE_COLOR;
    else process.env.FORCE_COLOR = previousForceColor;
    if (previousNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previousNoColor;
  }
}

interface ProjectedControllerFixture {
  input: FakeInput;
  output: FakeOutput;
  controller: TuiController;
}

function projectedController(projector: TuiFrameProjector): ProjectedControllerFixture {
  const input = new FakeInput();
  const output = new FakeOutput();
  const base: TuiControllerOptions = {
    input,
    output,
    environment: {
      TERM: "xterm-256color",
      LANG: "en_US.UTF-8",
      TERM_COLOR: "0",
    },
    handleSignals: false,
  };
  const options: InternalTuiControllerOptions = {
    ...base,
    [INTERNAL_TUI_FRAME_PROJECTOR]: projector,
  };
  return { input, output, controller: new TuiController(options) };
}

test("full mode rejects a missing rich projector before terminal startup", () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  assert.throws(
    () => new TuiController({
      input,
      output,
      environment: { TERM: "xterm-256color", LANG: "en_US.UTF-8" },
      handleSignals: false,
    }),
    /Full TUI mode requires the rich frame projector/u,
  );
  assert.equal(input.isRaw, false);
  assert.deepEqual(input.rawChanges, []);
  assert.equal(output.text, "");
});

test("line and accessibility modes do not require the rich projector", () => {
  for (const mode of ["line", "accessible"] as const) {
    const controller = new TuiController({
      input: new FakeInput(),
      output: new FakeOutput(),
      environment: { TERM: "dumb" },
      mode,
      handleSignals: false,
    });
    assert.equal(controller.mode, mode);
    controller.close();
  }
});

test("the public controller installs the shipping rich projector", async () => {
  await richFrameProjector();
  const { TuiController: PublicTuiController } = await import("../../src/tui/public-controller.js");
  const input = new FakeInput();
  const output = new FakeOutput();
  const controller = new PublicTuiController({
    input,
    output,
    environment: { TERM: "xterm-256color", LANG: "en_US.UTF-8", TERM_COLOR: "0" },
    handleSignals: false,
  });
  controller.start();
  assert.match(output.text, terminalPattern("\\u001b\\[\\?1049h", "u"));
  controller.close();
  assert.deepEqual(input.rawChanges, [true, false]);
});

test("the internal frame projector reuses controller input, expansion, and terminal cleanup", async () => {
  const requests: TuiFrameProjectionRequest[] = [];
  const projector: TuiFrameProjector = (request) => {
    requests.push(request);
    const prefix = "> ";
    const beforeCursor = splitGraphemes(request.view.editorText)
      .slice(0, request.view.editorCursor)
      .join("");
    return {
      text: [
        "projected",
        `${prefix}${request.view.editorText}`,
        request.thinkingExpanded ? "thinking-expanded" : "thinking-compact",
        request.toolDetailsExpanded ? "tools-expanded" : "tools-compact",
      ].join("\n"),
      cursor: { row: 2, column: cellWidth(prefix) + cellWidth(beforeCursor) + 1 },
    };
  };
  const { input, output, controller } = projectedController(projector);
  controller.setActionHandler((action) => {
    if (action.type === "toggle_thinking_visibility") controller.toggleReasoning();
  });
  controller.start();
  assert.equal(getEventListeners(input, "data").length, 1);
  assert.deepEqual(input.rawChanges, [true]);

  const answer = controller.question("you> ");
  input.write("a🙂b");
  input.write("\u001b[D");
  await tick();
  controller.renderNow();
  const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
  for (const chunk of output.chunks) terminal.write(chunk.toString("utf8"));
  const editorRow = terminal.viewport().findIndex((line) => line.includes("> a🙂b"));
  assert.notEqual(editorRow, -1);
  assert.deepEqual(terminal.cursor(), {
    row: editorRow,
    column: cellWidth("> a🙂"),
  });

  controller.render(envelope({
    type: "reasoning_completed",
    text: "completed public reasoning",
    part: 0,
    visibility: "summary",
  }, 1));
  controller.render(envelope({
    type: "tool_requested",
    callId: "projected-tool",
    name: "read",
    input: { path: "fixture.txt" },
    index: 0,
  }, 2));
  input.write(Buffer.from([15]));
  await tick();
  const expandedRequest = requests.at(-1);
  assert.equal(expandedRequest?.toolDetailsExpanded, true);
  assert.equal(expandedRequest?.thinkingExpanded, true);
  assert.deepEqual(
    expandedRequest?.view.transcript.filter((entry) => entry.kind === "reasoning").map((entry) => entry.expanded),
    [true],
  );
  input.write(Buffer.from([15]));
  await tick();
  const collapsedRequest = requests.at(-1);
  assert.equal(collapsedRequest?.toolDetailsExpanded, false);
  assert.equal(collapsedRequest?.thinkingExpanded, true);
  assert.deepEqual(
    collapsedRequest?.view.transcript.filter((entry) => entry.kind === "reasoning").map((entry) => entry.expanded),
    [true],
  );
  input.write(Buffer.from([20]));
  await tick();
  const thinkingCollapsedRequest = requests.at(-1);
  assert.equal(thinkingCollapsedRequest?.toolDetailsExpanded, false);
  assert.equal(thinkingCollapsedRequest?.thinkingExpanded, false);
  assert.deepEqual(
    thinkingCollapsedRequest?.view.transcript.filter((entry) => entry.kind === "reasoning").map((entry) => entry.expanded),
    [false],
  );

  input.write("\r");
  assert.equal(await answer, "a🙂b");
  controller.close();
  assert.equal(getEventListeners(input, "data").length, 0);
  assert.deepEqual(input.rawChanges, [true, false]);
  assert.match(output.text, terminalPattern("\\u001b\\[\\?1049h", "u"));
  assert.match(output.text, terminalPattern("\\u001b\\[\\?1049l", "u"));
});

test("a frame projection failure restores the terminal immediately", () => {
  const { input, output, controller } = projectedController(() => {
    throw new Error("projection failed");
  });
  assert.throws(() => controller.start(), /projection failed/u);
  assert.equal(input.isRaw, false);
  assert.deepEqual(input.rawChanges, [true, false]);
  assert.match(output.text, terminalPattern("\\u001b\\[\\?1049h", "u"));
  assert.match(output.text, terminalPattern("\\u001b\\[\\?1049l", "u"));
});

test("a configured rich projector cannot silently fall through to the line frame", () => {
  const missingFrame: TuiFrameProjector = () => JSON.parse("null") ?? undefined;
  const { input, output, controller } = projectedController(missingFrame);
  assert.throws(() => controller.start(), /TUI frame projector returned no frame/u);
  assert.equal(input.isRaw, false);
  assert.deepEqual(input.rawChanges, [true, false]);
  assert.match(output.text, terminalPattern("\\u001b\\[\\?1049h", "u"));
  assert.match(output.text, terminalPattern("\\u001b\\[\\?1049l", "u"));
  assert.doesNotMatch(output.text, /Ask ohm/u);
});

function baseView(): TuiViewState {
  return {
    context: {
      active: false,
      status: "idle",
      provider: "provider",
      model: "model",
      thinking: "max",
      contextTokens: 25,
      contextWindowTokens: 100,
    },
    transcript: [{ id: "user-1", kind: "user", text: "hello" }],
    transcriptOffset: 0,
    editorText: "a🙂b",
    editorCursor: 2,
    inputLabel: "you",
    inputMode: "normal",
    usage: {
      total: {
        inputTokens: 10,
        outputTokens: 4,
        cacheReadTokens: 6,
        cacheWriteTokens: 2,
        cost: { input: 0.001, output: 0.002, cacheRead: 0.003, cacheWrite: 0.004, total: 0.01 },
      },
      promptInputTokens: 18,
      latestCacheHitRate: 75,
    },
  };
}

function request(view: TuiViewState, overrides: Partial<TuiFrameProjectionRequest> = {}): TuiFrameProjectionRequest {
  return {
    view,
    size: { columns: 60, rows: 24 },
    theme: createTheme("signal", { color: true, unicode: true }),
    transcriptOptions: {},
    themeName: "signal",
    color: true,
    unicode: true,
    thinkingExpanded: false,
    toolDetailsExpanded: false,
    hideReasoningBlock: false,
    editorPaddingX: 0,
    outputPad: 1,
    codeBlockIndent: "",
    ...overrides,
  };
}

test("the rich projector hides cache hit telemetry while compaction is active", async () => {
  const { projectRichTuiFrame } = await richFrameProjector();
  const view = baseView();
  view.context = {
    ...view.context,
    active: true,
    activity: { phase: "Compacting context", startedAt: Date.now(), cancellable: true },
  };
  view.usage = { ...view.usage!, latestCacheHitRate: 0 };

  const frame = projectRichTuiFrame(request(view));
  assert.doesNotMatch(stripAnsi(frame?.text ?? ""), /cache hit/u);
});

test("the rich projector preserves user color, cursor geometry, telemetry, and explicit fallbacks", async () => {
  const { projectRichTuiFrame } = await richFrameProjector();

  const frame = projectRichTuiFrame(request(baseView()));
  assert.ok(frame);
  assert.match(frame.text, terminalPattern("\\u001b\\[48;5;236m", "u"));
  const plain = stripAnsi(frame.text);
  assert.match(plain, /ctx 25\.0%\/100/u);
  assert.match(plain, /in 18/u);
  assert.match(plain, /out 4/u);
  assert.match(plain, /R6/u);
  assert.match(plain, /W2/u);
  assert.match(plain, /cache hit 75\.0%/u);
  assert.match(plain, /\$0\.010/u);
  assert.doesNotMatch(plain, /cache in|cache out/u);
  const lines = plain.split("\n");
  const editorRow = lines.findIndex((line) => line.includes("› a🙂b"));
  assert.deepEqual(frame.cursor, {
    row: editorRow + 1,
    column: cellWidth("› a🙂") + 1,
  });

  const padded = projectRichTuiFrame(request(baseView(), { editorPaddingX: 2 }));
  assert.ok(padded);
  const paddedLines = stripAnsi(padded.text).split("\n");
  const paddedEditorRow = paddedLines.findIndex((line) => line.includes("  › a🙂b"));
  assert.ok(paddedEditorRow >= 0);
  assert.deepEqual(padded.cursor, {
    row: paddedEditorRow + 1,
    column: 2 + cellWidth("› a🙂") + 1,
  });

  const thinkingView: TuiViewState = {
    ...baseView(),
    transcript: [{
      id: "thinking-1",
      kind: "reasoning",
      text: "visible public reasoning",
      streaming: true,
      expanded: false,
    }],
  };
  const activeThinking = projectRichTuiFrame(request(thinkingView));
  assert.doesNotMatch(stripAnsi(activeThinking?.text ?? ""), /visible public reasoning/u);
  const expandedActiveThinking = projectRichTuiFrame(request(thinkingView, { thinkingExpanded: true }));
  assert.doesNotMatch(stripAnsi(expandedActiveThinking?.text ?? ""), /visible public reasoning/u);
  const completedThinking = projectRichTuiFrame(request({
    ...thinkingView,
    transcript: [{ ...thinkingView.transcript[0]!, streaming: false }],
  }));
  assert.doesNotMatch(stripAnsi(completedThinking?.text ?? ""), /visible public reasoning/u);
  const expandedThinking = projectRichTuiFrame(request({
    ...thinkingView,
    transcript: [{ ...thinkingView.transcript[0]!, streaming: false }],
  }, { thinkingExpanded: true }));
  assert.doesNotMatch(stripAnsi(expandedThinking?.text ?? ""), /visible public reasoning/u);
  const inheritedThinking = projectRichTuiFrame(request({
    ...thinkingView,
    transcript: [{
      id: "thinking-inherited",
      kind: "reasoning",
      text: "inherited public reasoning",
      streaming: false,
    }],
  }, { thinkingExpanded: true }));
  assert.match(stripAnsi(inheritedThinking?.text ?? ""), /inherited public reasoning/u);

  const transcriptOnly = (
    transcript: TuiViewState["transcript"],
    thinkingExpanded = false,
  ): string => {
    const projected = projectRichTuiFrame(request({ ...baseView(), transcript }, { thinkingExpanded }));
    assert.ok(projected);
    const text = stripAnsi(projected.text);
    const composer = text.indexOf("\n\n─ Ask ohm ");
    assert.notEqual(composer, -1);
    return text.slice(0, composer);
  };

  assert.equal(transcriptOnly([
    {
      id: "run-a:reasoning:7:0",
      kind: "reasoning",
      text: "Plan the change.",
      streaming: false,
    },
    {
      id: "run-a:reasoning:7:1",
      kind: "reasoning",
      text: "Verify the result.",
      streaming: true,
    },
  ], true), [
    "◆ Thinking",
    "  Plan the change.",
    "",
    "  Verify the result.",
  ].join("\n"));

  assert.equal(transcriptOnly([
    { id: "live-a", kind: "reasoning", text: "One live part.", streaming: true },
    { id: "live-b", kind: "reasoning", text: "Another live part.", streaming: true },
  ], true), [
    "◆ Thinking",
    "  One live part.",
    "",
    "  Another live part.",
  ].join("\n"));

  const completedParts: TuiViewState["transcript"] = [
    {
      id: "message-a:reasoning:0",
      sourceMessageId: "message-a",
      kind: "reasoning",
      text: "First summary.",
      streaming: false,
    },
    {
      id: "message-a:reasoning:2",
      sourceMessageId: "message-a",
      kind: "reasoning",
      text: "Second summary.",
      streaming: false,
    },
  ];
  assert.equal(transcriptOnly(completedParts), "… Thinking");
  assert.equal(transcriptOnly(completedParts, true), [
    "… Thinking",
    "  First summary.",
    "",
    "  Second summary.",
  ].join("\n"));

  assert.equal(transcriptOnly([
    {
      id: "message-a:reasoning:0",
      sourceMessageId: "message-a",
      kind: "reasoning",
      text: "First response.",
    },
    {
      id: "message-b:reasoning:0",
      sourceMessageId: "message-b",
      kind: "reasoning",
      text: "Second response.",
    },
  ], true), [
    "… Thinking",
    "  First response.",
    "",
    "… Thinking",
    "  Second response.",
  ].join("\n"));

  assert.equal(transcriptOnly([
    { id: "run-a:reasoning:1:0", kind: "reasoning", text: "First run.", streaming: true },
    { id: "run-b:reasoning:1:0", kind: "reasoning", text: "Second run.", streaming: true },
  ], true), [
    "◆ Thinking",
    "  First run.",
    "",
    "◆ Thinking",
    "  Second run.",
  ].join("\n"));

  assert.equal(transcriptOnly([
    {
      id: "message-a:reasoning:0",
      sourceMessageId: "message-a",
      kind: "reasoning",
      text: "Before answer.",
    },
    { id: "answer", kind: "assistant", text: "Answer boundary." },
    {
      id: "message-a:reasoning:1",
      sourceMessageId: "message-a",
      kind: "reasoning",
      text: "After answer.",
    },
  ], true), [
    "… Thinking",
    "  Before answer.",
    "",
    "Answer boundary.",
    "",
    "… Thinking",
    "  After answer.",
  ].join("\n"));

  const toolBoundary = transcriptOnly([
    { id: "tool-source:reasoning:0", sourceMessageId: "tool-source", kind: "reasoning", text: "Before tool." },
    { id: "tool", kind: "tool", title: "read", status: "completed", text: "" },
    { id: "tool-source:reasoning:1", sourceMessageId: "tool-source", kind: "reasoning", text: "After tool." },
  ], true);
  assert.equal(toolBoundary.match(/Thinking/gu)?.length, 2);
  const userBoundary = transcriptOnly([
    { id: "user-source:reasoning:0", sourceMessageId: "user-source", kind: "reasoning", text: "Before user." },
    { id: "user", kind: "user", text: "User boundary." },
    { id: "user-source:reasoning:1", sourceMessageId: "user-source", kind: "reasoning", text: "After user." },
  ], true);
  assert.equal(userBoundary.match(/Thinking/gu)?.length, 2);
  const toolStates = transcriptOnly([
    { id: "pending", kind: "tool", title: "pending-tool", status: "pending", text: "" },
    { id: "running", kind: "tool", title: "running-tool", status: "running", text: "" },
    { id: "completed", kind: "tool", title: "completed-tool", status: "completed", text: "" },
    { id: "failed", kind: "tool", title: "failed-tool", status: "failed", text: "" },
    { id: "in-doubt", kind: "tool", title: "in-doubt-tool", status: "in_doubt", text: "" },
  ]);
  assert.match(toolStates, /… pending-tool · queued/u);
  assert.match(toolStates, /▸ running-tool · running/u);
  assert.match(toolStates, /✓ completed-tool · done/u);
  assert.match(toolStates, /✗ failed-tool · failed/u);
  assert.match(toolStates, /… in-doubt-tool · outcome unknown/u);

  assert.equal(transcriptOnly([
    { id: "status", kind: "status", text: "Ready" },
    { id: "warning", kind: "warning", text: "Interrupted" },
    { id: "error", kind: "error", text: "Request failed" },
  ]), [
    "… Ready",
    "",
    "! warning Interrupted",
    "",
    "✗ error Request failed",
  ].join("\n"));

  assert.equal(transcriptOnly([
    {
      id: "status-source:reasoning:0",
      sourceMessageId: "status-source",
      kind: "reasoning",
      text: "Before status.",
    },
    { id: "status", kind: "status", text: "Status boundary." },
    {
      id: "status-source:reasoning:1",
      sourceMessageId: "status-source",
      kind: "reasoning",
      text: "After status.",
    },
  ], true), [
    "… Thinking",
    "  Before status.",
    "",
    "… Status boundary.",
    "",
    "… Thinking",
    "  After status.",
  ].join("\n"));

  const transientNotice = projectRichTuiFrame(request({
    ...baseView(),
    notice: "Interrupted\u001b]2;owned\u0007\nnow",
  }));
  assert.ok(transientNotice);
  assert.match(stripAnsi(transientNotice.text), /… Interrupted\n  now/u);
  assert.doesNotMatch(stripAnsi(transientNotice.text), /owned/u);

  const modelOverlay = projectRichTuiFrame(request({
    ...baseView(),
    overlay: {
      title: "Models",
      pickerKind: "model",
      query: "sol",
      queryCursor: 2,
      selected: 1,
      items: [
        { id: "first", label: "First", value: "first" },
        { id: "second", label: "Second", value: "second" },
      ],
    },
  }));
  assert.ok(modelOverlay);
  assert.match(stripAnsi(modelOverlay.text), /Models\s+2\/2/u);
  assert.match(stripAnsi(modelOverlay.text), /Filter sol/u);
  assert.doesNotMatch(stripAnsi(modelOverlay.text), /─ Ask ohm /u);
  assert.equal(modelOverlay.cursor.column, cellWidth("Filter so") + 1);
  const withAttachment = projectRichTuiFrame(request({
    ...baseView(),
    inputImages: [{ label: "image", mediaType: "image/png" }],
  }));
  assert.ok(withAttachment);
  assert.match(stripAnsi(withAttachment.text), /Attachments · image \(image\/png\)/u);
  const requestedOffset = projectRichTuiFrame(request({ ...baseView(), transcriptOffset: 1 }));
  assert.ok(requestedOffset);
  assert.ok(requestedOffset.transcriptNavigation);
  const withBackground = projectRichTuiFrame(request({
    ...baseView(),
    backgroundCells: [
      { row: 1, column: 20, text: "X" },
      { row: 3, column: 50, text: "B" },
    ],
  }));
  assert.ok(withBackground);
  const backgroundLines = stripAnsi(withBackground.text).split("\n");
  assert.equal(backgroundLines[1]?.includes("X"), false);
  assert.equal(backgroundLines[3]?.[50], "B");
  assert.ok(projectRichTuiFrame(request(baseView(), { codeBlockIndent: "  " })));
  const fencedCode = projectRichTuiFrame(request({
    ...baseView(),
    transcript: [{ id: "assistant-code", kind: "assistant", text: "```ts\nconst ready = true;\n```" }],
  }, { codeBlockIndent: "  ", transcriptOptions: { codeBlockIndent: "  " } }));
  assert.ok(fencedCode);
  assert.match(stripAnsi(fencedCode.text), /const ready = true;/u);
  const hostPreferences = projectRichTuiFrame(request({
    ...baseView(),
    transcript: [{ id: "host-preferences", kind: "assistant", text: "```ts\nconst padded = true;\n```" }],
  }, {
    outputPad: 0,
    codeBlockIndent: "    ",
    transcriptOptions: { outputPad: 0, codeBlockIndent: "    " },
  }));
  assert.ok(hostPreferences);
  assert.match(stripAnsi(hostPreferences.text), /const padded = true;/u);

  const plainTheme = { ...createTheme("mono", { color: false, unicode: false }), name: "fixture-theme" };
  const plainFrame = projectRichTuiFrame(request({
    ...baseView(),
    transcript: [{
      id: "plain-tall",
      kind: "assistant",
      text: Array.from({ length: 20 }, (_, index) => `plain-${index}`).join("\n"),
    }],
    backgroundCells: [{ row: 1, column: 20, text: "X" }],
  }, {
    size: { columns: 40, rows: 12 },
    theme: plainTheme,
    themeName: "fixture-theme",
    color: false,
    unicode: true,
    transcriptOptions: JSON.parse('{"fullscreenScrollbar":"always"}'),
  }));
  assert.ok(plainFrame);
  assert.equal(plainFrame.text.includes("\u001b"), false);
  assert.match(plainFrame.text, /- Ask ohm/u);
  assert.match(plainFrame.text, /> a🙂b/u);
  assert.ok(plainFrame.transcriptNavigation?.pointerRegion?.scrollbar);

  const croppedSingleEntry = projectRichTuiFrame(request(baseView(), { size: { columns: 60, rows: 8 } }));
  assert.ok(croppedSingleEntry);
  assert.match(stripAnsi(croppedSingleEntry.text), /hello/u);
  assert.ok(croppedSingleEntry.text.split("\n").length <= 8);
  for (const rows of [1, 2, 3, 4]) {
    const tiny = projectRichTuiFrame(request(baseView(), { size: { columns: 60, rows } }));
    assert.ok(tiny);
    const tinyLines = stripAnsi(tiny.text).split("\n");
    assert.ok(tinyLines.length <= rows);
    assert.ok(tiny.cursor.row >= 1 && tiny.cursor.row <= tinyLines.length);
    assert.ok(tiny.cursor.column >= 1 && tiny.cursor.column <= 60);
    assert.match(tinyLines[tiny.cursor.row - 1] ?? "", /a🙂b/u);
  }

  const plainRawEditor = projectRichTuiFrame(request({
    ...baseView(),
    rawEditorBlock: { lines: ["raw editor"], cursor: { row: 0, column: 3 } },
  }, { size: { columns: 40, rows: 1 } }));
  assert.ok(plainRawEditor);
  assert.equal(stripAnsi(plainRawEditor.text), "raw editor");
  assert.deepEqual(plainRawEditor.cursor, { row: 1, column: 4 });
});

test("the rich projector omits built-in semantic pointer metadata", async () => {
  const { projectRichTuiFrame } = await richFrameProjector();
  const views: TuiViewState[] = [
    baseView(),
    {
      ...baseView(),
      transcript: [{
        id: "tool-a-entry",
        callId: "tool-a-call",
        kind: "tool",
        title: "read",
        status: "completed",
        text: "result",
      }, {
        id: "thinking-a",
        kind: "reasoning",
        text: "thinking body",
        expandable: true,
      }],
    },
    {
      ...baseView(),
      overlay: {
        title: "Choices",
        pickerKind: "generic",
        query: "filter",
        selected: 0,
        items: [{ id: "model-a", label: "Model A", value: "a" }],
      },
    },
  ];
  for (const view of views) {
    const frame = projectRichTuiFrame(request(view));
    assert.equal(
      Reflect.ownKeys(frame).some((key) => String(key) === "Symbol(ohm.tui.pointer-map)"),
      false,
    );
  }
});

test("the rich projector translates, crops, and masks persistent component pointer rows", async () => {
  const { projectRichTuiFrame } = await richFrameProjector();
  const tokens = {
    header: {},
    widget: {},
    below: {},
    footer: {},
  };
  const persistent = <Token extends object>(text: string, token: Token, localRow: number): TuiPersistentPointerBlock => ({
    lines: [{ spans: [{ text }] }],
    [INTERNAL_TUI_PERSISTENT_POINTER_SOURCE]: { token, rows: [localRow] },
  });
  const frame = projectRichTuiFrame(request({
    ...baseView(),
    runtimeHeaderComponents: [persistent("PERSISTENT HEADER", tokens.header, 2)],
    runtimeWidgetComponents: [persistent("PERSISTENT WIDGET", tokens.widget, 1)],
    runtimeWidgetBelowComponents: [persistent("PERSISTENT BELOW", tokens.below, 3)],
    runtimeFooterComponents: [persistent("PERSISTENT FOOTER", tokens.footer, 0)],
    runtimeOverlays: [{
      block: { lines: [{ spans: [{ text: "XX" }] }] },
      options: { anchor: "top-left", width: 8 },
      focused: false,
      width: 8,
    }],
  }, { size: { columns: 60, rows: 60 } }));
  assert.ok(frame);
  const lines = stripAnsi(frame.text).split("\n");
  const pointer = frame[INTERNAL_TUI_PERSISTENT_POINTER_MAP];
  assert.ok(pointer);

  for (const [text, token, localRow] of [
    ["PERSISTENT HEADER", tokens.header, 2],
    ["PERSISTENT WIDGET", tokens.widget, 1],
    ["PERSISTENT BELOW", tokens.below, 3],
    ["PERSISTENT FOOTER", tokens.footer, 0],
  ] as const) {
    const targets: TuiPersistentPointerMap["rows"][number][] = pointer.rows.filter((target) =>
      target.token === token);
    assert.ok(targets.length > 0);
    assert.ok(targets.every((target) => target.localRow === localRow));
    if (token !== tokens.header) assert.match(lines[targets[0]!.row] ?? "", new RegExp(text, "u"));
  }

  const headerRow = pointer.rows.find((target) => target.token === tokens.header)?.row ?? -1;
  const headerTargets = pointer.rows.filter((target) => target.row === headerRow && target.token === tokens.header);
  assert.deepEqual(headerTargets.map(({ left, right, localColumn }) => ({ left, right, localColumn })), [
    { left: 2, right: 60, localColumn: 2 },
  ]);

  const compact = projectRichTuiFrame(request({
    ...baseView(),
    runtimeHeaderComponents: Array.from({ length: 3 }, (_, block) => ({
      lines: Array.from({ length: 4 }, (_, row) => ({ spans: [{ text: `compact-${block}-${row}` }] })),
      [INTERNAL_TUI_PERSISTENT_POINTER_SOURCE]: {
        token: tokens.header,
        rows: [0, 1, 2, undefined],
      },
    })),
  }, { size: { columns: 40, rows: 4 } }));
  assert.ok(compact);
  const compactLines = stripAnsi(compact.text).split("\n");
  const compactPointer = compact[INTERNAL_TUI_PERSISTENT_POINTER_MAP];
  assert.equal(compactPointer?.rows.some((target) =>
    compactLines[target.row]?.includes("earlier extension rows")) ?? false, false);
  assert.ok((compactPointer?.rows ?? []).every((target) =>
    target.row >= 0 && target.row < compactLines.length));
});

test("the rich projector bounds long drafts, prompts, queues, and aggregate extension surfaces", async () => {
  const { projectRichTuiFrame } = await richFrameProjector();
  const draft = Array.from({ length: 30 }, (_, index) => `draft-${String(index).padStart(2, "0")}`).join("\n");
  const draftCursor = draft.indexOf("draft-15") + "draft-15".length;
  const draftFrame = projectRichTuiFrame(request({
    ...baseView(),
    editorText: draft,
    editorCursor: draftCursor,
  }, { size: { columns: 60, rows: 12 } }));
  assert.ok(draftFrame);
  const draftLines = stripAnsi(draftFrame.text).split("\n");
  assert.ok(draftLines.length <= 12);
  assert.match(draftLines[draftFrame.cursor.row - 1] ?? "", /draft-15/u);
  assert.doesNotMatch(draftFrame.text, /draft-00|draft-29/u);

  const queuedFrame = projectRichTuiFrame(request({
    ...baseView(),
    inputPrompt: Array.from({ length: 20 }, (_, index) => `prompt-${index}`).join("\n"),
    queuedMessages: Array.from({ length: 100 }, (_, index) => ({
      mode: "follow_up" as const,
      text: `queue-${index}`,
    })),
  }, { size: { columns: 60, rows: 12 } }));
  assert.ok(queuedFrame);
  const queuedText = stripAnsi(queuedFrame.text);
  assert.ok(queuedText.split("\n").length <= 12);
  assert.match(queuedText, /Queued · 100 · 98 earlier/u);
  assert.match(queuedText, /queue-99/u);
  assert.match(queuedText, /prompt-19/u);
  assert.doesNotMatch(queuedText, /queue-0\b|prompt-0\b/u);
  assert.match(queuedText.split("\n")[queuedFrame.cursor.row - 1] ?? "", /a🙂b/u);

  const blocks = (prefix: string) => Array.from({ length: 4 }, (_, block) => ({
    lines: Array.from({ length: 4 }, (_, row) => ({
      spans: [{ text: `${prefix}-${block}-${row}\u001b]2;owned\u0007`, role: "accent" as const }],
    })),
  }));
  const extensionFrame = projectRichTuiFrame(request({
    ...baseView(),
    transcript: [{
      id: "extension-history",
      kind: "assistant",
      text: Array.from({ length: 30 }, (_, index) => `history-${index}`).join("\n"),
    }],
    runtimeHeaderComponents: blocks("HEADER"),
    runtimeFooterComponents: blocks("FOOTER"),
    runtimeWidgetComponents: blocks("WIDGET"),
    runtimeWidgetBelowComponents: blocks("BELOW"),
  }, { size: { columns: 80, rows: 24 } }));
  assert.ok(extensionFrame);
  const extensionText = stripAnsi(extensionFrame.text);
  assert.ok(extensionText.split("\n").length <= 24);
  assert.equal(extensionText.match(/… 15 earlier extension rows/gu)?.length, 4);
  assert.match(extensionText, /HEADER-3-3/u);
  assert.match(extensionText, /WIDGET-3-3/u);
  assert.match(extensionText, /BELOW-3-3/u);
  assert.match(extensionText, /FOOTER-3-3/u);
  assert.doesNotMatch(extensionText, /owned/u);
  assert.ok(extensionText.indexOf("HEADER-3-3") < extensionText.indexOf("WIDGET-3-3"));
  assert.ok(extensionText.indexOf("WIDGET-3-3") < extensionText.indexOf("BELOW-3-3"));
  assert.ok(extensionText.indexOf("BELOW-3-3") < extensionText.indexOf("FOOTER-3-3"));
  assert.ok(extensionFrame.cursor.row >= 1 && extensionFrame.cursor.row <= 24);
  assert.ok(extensionFrame.transcriptNavigation?.viewportRows);
  assert.equal(extensionFrame.transcriptNavigation?.pointerRegion?.scrollbar, undefined);

  const runtimeDraft = Array.from({ length: 30 }, (_, index) => `runtime-draft-${index}`).join("\n");
  const runtimeFrame = projectRichTuiFrame(request({
    ...baseView(),
    editorText: runtimeDraft,
    editorCursor: runtimeDraft.indexOf("runtime-draft-15") + "runtime-draft-15".length,
    runtimeComponent: {
      lines: Array.from({ length: 24 }, (_, index) => ({
        spans: [{ text: `runtime-${index}`, role: "info" as const }],
      })),
    },
    runtimeHeaderComponents: blocks("RUNTIME-HEADER").slice(0, 2),
    runtimeFooterComponents: blocks("RUNTIME-FOOTER").slice(0, 2),
  }, { size: { columns: 40, rows: 24 } }));
  assert.ok(runtimeFrame);
  const runtimeLines = stripAnsi(runtimeFrame.text).split("\n");
  assert.equal(runtimeLines.length, 24);
  assert.match(runtimeLines[0] ?? "", /… 7 earlier extension rows/u);
  assert.match(runtimeLines[1] ?? "", /RUNTIME-HEADER-1-3/u);
  assert.match(runtimeFrame.text, /… 14 earlier extension rows/u);
  assert.match(runtimeFrame.text, /runtime-23/u);
  assert.match(runtimeLines[runtimeFrame.cursor.row - 1] ?? "", /runtime-draft-15/u);
  assert.match(runtimeFrame.text, /RUNTIME-FOOTER-1-3/u);
  assert.equal(runtimeFrame.transcriptNavigation, undefined);

  const asciiTheme = { ...createTheme("mono", { color: false, unicode: false }), name: "ascii-fixture" };
  const asciiFrame = projectRichTuiFrame(request({
    ...baseView(),
    transcript: [{
      id: "ascii-tool",
      callId: "ascii-tool",
      kind: "tool",
      title: "read",
      status: "completed",
      summary: "fixture",
      text: "done",
    }],
    inputImages: [{ label: "image", mediaType: "image/png" }],
    runtimeHeaderComponents: blocks("HEADER"),
    runtimeFooterComponents: blocks("FOOTER"),
    runtimeWidgetComponents: blocks("WIDGET"),
    runtimeWidgetBelowComponents: blocks("BELOW"),
    backgroundCells: [{ row: 3, column: 50, text: "X" }],
  }, {
    size: { columns: 60, rows: 24 },
    theme: asciiTheme,
    themeName: "ascii-fixture",
    color: false,
    unicode: false,
    transcriptOptions: JSON.parse('{"fullscreenScrollbar":"always"}'),
  }));
  assert.ok(asciiFrame);
  assert.equal(asciiFrame.text.includes("\u001b"), false);
  assert.match(asciiFrame.text, /\.\.\. 15 earlier extension rows/u);
  assert.match(asciiFrame.text, /Attachments \| image \(image\/png\)/u);
  assert.match(asciiFrame.text, /\+ read \| done/u);
  assert.match(asciiFrame.text, /> fixture/u);
  assert.doesNotMatch(asciiFrame.text, /…|·|✓|▸|─/u);
  assert.ok(asciiFrame.transcriptNavigation?.pointerRegion?.scrollbar);
});

test("the rich projector navigates exact visual rows inside one tall entry", async () => {
  const { projectRichTuiFrame } = await richFrameProjector();
  const transcript: TuiViewState["transcript"] = [{
    id: "tall-answer",
    kind: "assistant",
    text: Array.from({ length: 30 }, (_, index) => `ROW-${String(index).padStart(2, "0")}`).join("\n"),
  }];
  const frame = projectRichTuiFrame(request({ ...baseView(), transcript }, {
    size: { columns: 40, rows: 12 },
    transcriptOptions: JSON.parse('{"fullscreenScrollbar":"auto"}'),
  }));
  assert.ok(frame);
  assert.deepEqual(frame.transcriptNavigation, {
    totalRows: 30,
    startRow: 26,
    viewportRows: 4,
    messageRows: [],
    pointerRegion: { top: 0, bottom: 3 },
  });
  assert.match(stripAnsi(frame.text), /ROW-26[\s\S]*ROW-29/u);
  assert.doesNotMatch(stripAnsi(frame.text), /ROW-25/u);
  const scrolled = projectRichTuiFrame(request({
    ...baseView(),
    transcript,
    transcriptOffset: 3,
  }, { size: { columns: 40, rows: 12 } }));
  assert.ok(scrolled);
  assert.match(stripAnsi(scrolled.text), /ROW-23[\s\S]*ROW-26/u);
  assert.doesNotMatch(stripAnsi(scrolled.text), /ROW-27/u);
  assert.equal(
    (scrolled.transcriptNavigation?.totalRows ?? 0)
      - (scrolled.transcriptNavigation?.startRow ?? 0)
      - (scrolled.transcriptNavigation?.viewportRows ?? 0),
    3,
  );

  const top = projectRichTuiFrame(request({ ...baseView(), transcript, transcriptOffset: 1_000 }, {
    size: { columns: 40, rows: 12 },
  }));
  assert.ok(top);
  assert.equal(top.transcriptNavigation?.startRow, 0);
  assert.match(stripAnsi(top.text), /ROW-00[\s\S]*ROW-03/u);

  const hovered = projectRichTuiFrame(request({ ...baseView(), transcript }, {
    size: { columns: 40, rows: 12 },
    transcriptOptions: JSON.parse('{"fullscreenScrollbar":"auto","fullscreenScrollbarHovered":true}'),
  }));
  assert.ok(hovered?.transcriptNavigation?.pointerRegion?.scrollbar);
  assert.equal(hovered.transcriptNavigation.pointerRegion.scrollbar.column, 39);

  const prompts = projectRichTuiFrame(request({
    ...baseView(),
    transcript: [
      { id: "prompt-1", kind: "user", text: "hello\nworld" },
      { id: "answer", kind: "assistant", text: "answer" },
      { id: "prompt-2", kind: "user", text: "last" },
    ],
  }, { size: { columns: 40, rows: 30 } }));
  assert.ok(prompts);
  assert.equal(prompts.transcriptNavigation?.totalRows, 10);
  assert.deepEqual(prompts.transcriptNavigation?.messageRows, [0, 7]);
});

test("the retained native projector windows a bounded transcript without changing frame semantics", async () => {
  const {
    internalCreateRichTuiFrameProjector,
    projectRichTuiFrame,
  } = await richFrameProjector();
  const transcript = Array.from({ length: 2_000 }, (_, index): TuiViewState["transcript"][number] => (
    index === 0 || index === 1_000
      ? { id: `window-user-${index}`, kind: "user", text: `prompt-${index}` }
      : { id: `window-answer-${index}`, kind: "assistant", text: `answer-${index}` }
  ));
  const initial = request({ ...baseView(), transcript }, {
    size: { columns: 44, rows: 12 },
    transcriptRevision: 1,
  });
  const retained = internalCreateRichTuiFrameProjector();
  assert.deepEqual(retained(initial), projectRichTuiFrame(initial));

  const paged = {
    ...initial,
    view: { ...initial.view, transcriptOffset: 1_000 },
  };
  assert.deepEqual(retained(paged), projectRichTuiFrame(paged));

  const updatedTranscript = transcript.map((entry, index) => index + 1 === transcript.length
    ? { ...entry, text: "updated-live-tail" }
    : entry);
  const updated = {
    ...paged,
    transcriptRevision: 2,
    view: { ...paged.view, transcript: updatedTranscript },
  };
  assert.deepEqual(retained(updated), projectRichTuiFrame(updated));
  assert.doesNotMatch(stripAnsi(retained(updated).text), /updated-live-tail/u);

  const tail = {
    ...updated,
    view: { ...updated.view, transcriptOffset: 0 },
  };
  assert.deepEqual(retained(tail), projectRichTuiFrame(tail));
  assert.match(stripAnsi(retained(tail).text), /updated-live-tail/u);
});

test("retained completed tools reuse both explicit global expansion variants", async () => {
  const { internalCreateRichTuiFrameProjector } = await richFrameProjector();
  let detailReads = 0;
  const tool = (expanded: boolean): TuiViewState["transcript"][number] => {
    const entry: TuiViewState["transcript"][number] = {
      id: "global-tool-layout",
      callId: "global-tool-layout",
      kind: "tool",
      title: "read",
      status: "completed",
      expanded,
      text: "",
    };
    Object.defineProperty(entry, "text", {
      enumerable: false,
      get() {
        detailReads += 1;
        return Array.from({ length: 20 }, (_, index) => `global-tool-detail-${index + 1}`).join("\n");
      },
    });
    return entry;
  };
  const collapsed = request({ ...baseView(), transcript: [tool(false)] }, {
    size: { columns: 60, rows: 80 },
    transcriptRevision: 1,
    toolDetailsExpanded: false,
    transcriptOptions: { expandKeyHint: "Ctrl+O" },
  });
  const projector = internalCreateRichTuiFrameProjector();

  const firstCollapsed = stripAnsi(projector(collapsed).text);
  const collapsedReads = detailReads;
  assert.ok(collapsedReads > 0);
  assert.doesNotMatch(firstCollapsed, /global-tool-detail-20/u);

  const expanded = {
    ...collapsed,
    transcriptRevision: 2,
    toolDetailsExpanded: true,
    view: { ...collapsed.view, transcript: [tool(true)] },
  };
  const firstExpanded = stripAnsi(projector(expanded).text);
  const expandedReads = detailReads;
  assert.ok(expandedReads > collapsedReads);
  assert.match(firstExpanded, /global-tool-detail-20/u);

  assert.doesNotMatch(stripAnsi(projector({
    ...collapsed,
    transcriptRevision: 3,
    view: { ...collapsed.view, transcript: [tool(false)] },
  }).text), /global-tool-detail-20/u);
  assert.equal(detailReads, expandedReads, "collapsing re-rendered the retained completed tool");

  assert.match(stripAnsi(projector({
    ...expanded,
    transcriptRevision: 4,
    view: { ...expanded.view, transcript: [tool(true)] },
  }).text), /global-tool-detail-20/u);
  assert.equal(detailReads, expandedReads, "re-expanding re-rendered the retained completed tool");

  projector[INTERNAL_TUI_FRAME_PROJECTOR_CLEAR]?.();
  projector({
    ...collapsed,
    transcriptRevision: 5,
    view: { ...collapsed.view, transcript: [tool(false)] },
  });
  assert.ok(detailReads > expandedReads, "clearing the retained projector kept prior transcript renders");
});

test("a near-budget Ctrl+O expansion preserves the collapsed render working set", async () => {
  const { internalCreateRichTuiFrameProjector } = await richFrameProjector();
  const theme = createTheme("mono", { color: false, unicode: true });
  const detail = Array.from(
    { length: 120 },
    (_, index) => `near-budget-detail-${index + 1} ${"x".repeat(445)}`,
  ).join("\n");
  let detailReads = 0;
  const transcript = (expanded: boolean): TuiViewState["transcript"] => Array.from(
    { length: 145 },
    (_, index) => {
      const entry: TuiViewState["transcript"][number] = {
        id: `near-budget-tool-${index}`,
        callId: `near-budget-tool-${index}`,
        kind: "tool",
        title: "read",
        status: "completed",
        expanded,
        text: "",
      };
      Object.defineProperty(entry, "text", {
        enumerable: false,
        get() {
          detailReads += 1;
          return detail;
        },
      });
      return entry;
    },
  );
  const collapsed = request({ ...baseView(), transcript: transcript(false) }, {
    size: { columns: 500, rows: 40 },
    theme,
    themeName: "mono",
    color: false,
    transcriptRevision: 1,
    toolDetailsExpanded: false,
    transcriptOptions: { expandKeyHint: "Ctrl+O" },
  });
  const projector = internalCreateRichTuiFrameProjector();

  projector(collapsed);
  const collapsedReads = detailReads;
  assert.ok(collapsedReads > 0);

  const expanded = {
    ...collapsed,
    transcriptRevision: 2,
    toolDetailsExpanded: true,
    view: { ...collapsed.view, transcript: transcript(true) },
  };
  projector(expanded);
  const expandedReads = detailReads;
  assert.ok(expandedReads > collapsedReads);

  projector({
    ...collapsed,
    transcriptRevision: 3,
    view: { ...collapsed.view, transcript: transcript(false) },
  });
  assert.equal(detailReads, expandedReads, "near-budget expansion evicted the collapsed working set");

  projector({
    ...expanded,
    transcriptRevision: 4,
    view: { ...expanded.view, transcript: transcript(true) },
  });
  assert.ok(detailReads > expandedReads, "fixture did not reach the retained render cache budget");
  const saturatedReads = detailReads;
  const appendedTool = (): TuiViewState["transcript"][number] => {
    const entry: TuiViewState["transcript"][number] = {
      id: "near-budget-appended-tool",
      callId: "near-budget-appended-tool",
      kind: "tool",
      title: "read",
      status: "completed",
      expanded: true,
      text: "",
    };
    Object.defineProperty(entry, "text", {
      enumerable: false,
      get() {
        detailReads += 1;
        return detail;
      },
    });
    return entry;
  };
  const appended = (): TuiViewState["transcript"] => [
    ...transcript(true),
    appendedTool(),
  ];

  projector({
    ...expanded,
    transcriptRevision: 5,
    view: { ...expanded.view, transcript: appended() },
  });
  const appendedReads = detailReads;
  assert.ok(appendedReads > saturatedReads);
  projector({
    ...expanded,
    transcriptRevision: 6,
    view: { ...expanded.view, transcript: transcript(true) },
  });
  assert.equal(detailReads, appendedReads);
  projector({
    ...expanded,
    transcriptRevision: 7,
    view: { ...expanded.view, transcript: appended() },
  });
  assert.equal(
    detailReads,
    appendedReads,
    "a newly appended key was starved after retained render cache saturation",
  );
});

test("tool-tail expansion retains unrelated history and both completed variants", async () => {
  const { internalCreateRichTuiFrameProjector } = await richFrameProjector();
  let historyReads = 0;
  let toolReads = 0;
  const history = Array.from({ length: 64 }, (_, index): TuiViewState["transcript"][number] => {
    const entry: TuiViewState["transcript"][number] = {
      id: `unrelated-global-tool-${index}`,
      kind: "status",
      text: "",
    };
    Object.defineProperty(entry, "text", {
      enumerable: false,
      get() {
        historyReads += 1;
        return `unrelated retained history ${index}`;
      },
    });
    return entry;
  });
  const tail = (expanded: boolean): TuiViewState["transcript"][number] => {
    const entry: TuiViewState["transcript"][number] = {
      id: "unrelated-global-tool-tail",
      callId: "unrelated-global-tool-tail",
      kind: "tool",
      title: "read",
      status: "completed",
      expanded,
      text: "",
    };
    Object.defineProperty(entry, "text", {
      enumerable: false,
      get() {
        toolReads += 1;
        return Array.from({ length: 20 }, (_, index) => `tool-tail-detail-${index + 1}`).join("\n");
      },
    });
    return entry;
  };
  const collapsed = request({ ...baseView(), transcript: [...history, tail(false)] }, {
    size: { columns: 60, rows: 80 },
    transcriptRevision: 1,
    toolDetailsExpanded: false,
  });
  const projector = internalCreateRichTuiFrameProjector();

  projector(collapsed);
  const initialReads = historyReads;
  const collapsedToolReads = toolReads;
  assert.ok(initialReads > 0);
  assert.ok(collapsedToolReads > 0);

  const expanded = {
    ...collapsed,
    transcriptRevision: 2,
    toolDetailsExpanded: true,
    view: { ...collapsed.view, transcript: [...history, tail(true)] },
  };
  projector(expanded);
  const expandedToolReads = toolReads;
  assert.ok(expandedToolReads > collapsedToolReads);
  assert.equal(historyReads, initialReads, "expanding the tool tail re-rendered unrelated history");

  projector({
    ...collapsed,
    transcriptRevision: 3,
    view: { ...collapsed.view, transcript: [...history, tail(false)] },
  });
  assert.equal(historyReads, initialReads, "collapsing the tool tail re-rendered unrelated history");
  assert.equal(toolReads, expandedToolReads, "collapsing missed the completed tool variant cache");

  projector({
    ...expanded,
    transcriptRevision: 4,
    view: { ...expanded.view, transcript: [...history, tail(true)] },
  });
  assert.equal(historyReads, initialReads, "re-expanding the tool tail re-rendered unrelated history");
  assert.equal(toolReads, expandedToolReads, "re-expanding missed the completed tool variant cache");
});

test("tool-prefix expansion retains the stable suffix and both completed variants", async () => {
  const { internalCreateRichTuiFrameProjector } = await richFrameProjector();
  let historyReads = 0;
  let toolReads = 0;
  const history = Array.from({ length: 64 }, (_, index): TuiViewState["transcript"][number] => {
    const entry: TuiViewState["transcript"][number] = {
      id: `tool-prefix-history-${index}`,
      kind: "status",
      text: "",
    };
    Object.defineProperty(entry, "text", {
      enumerable: false,
      get() {
        historyReads += 1;
        return `stable suffix history ${index}`;
      },
    });
    return entry;
  });
  const tool = (expanded: boolean): TuiViewState["transcript"][number] => {
    const entry: TuiViewState["transcript"][number] = {
      id: "tool-prefix",
      callId: "tool-prefix",
      kind: "tool",
      title: "read",
      status: "completed",
      expanded,
      text: "",
    };
    Object.defineProperty(entry, "text", {
      enumerable: false,
      get() {
        toolReads += 1;
        return Array.from({ length: 20 }, (_, index) => `tool-prefix-detail-${index + 1}`).join("\n");
      },
    });
    return entry;
  };
  const collapsed = request({ ...baseView(), transcript: [tool(false), ...history] }, {
    size: { columns: 60, rows: 80 },
    transcriptRevision: 1,
    toolDetailsExpanded: false,
  });
  const projector = internalCreateRichTuiFrameProjector();

  projector(collapsed);
  const initialReads = historyReads;
  const collapsedToolReads = toolReads;
  assert.ok(initialReads > 0);
  assert.ok(collapsedToolReads > 0);

  const expanded = {
    ...collapsed,
    transcriptRevision: 2,
    toolDetailsExpanded: true,
    view: { ...collapsed.view, transcript: [tool(true), ...history] },
  };
  projector(expanded);
  const expandedToolReads = toolReads;
  assert.ok(expandedToolReads > collapsedToolReads);
  assert.equal(historyReads, initialReads, "expanding the tool prefix re-rendered the stable suffix");

  projector({
    ...collapsed,
    transcriptRevision: 3,
    view: { ...collapsed.view, transcript: [tool(false), ...history] },
  });
  assert.equal(historyReads, initialReads, "collapsing the tool prefix re-rendered the stable suffix");
  assert.equal(toolReads, expandedToolReads, "collapsing missed the completed tool variant cache");

  projector({
    ...expanded,
    transcriptRevision: 4,
    view: { ...expanded.view, transcript: [tool(true), ...history] },
  });
  assert.equal(historyReads, initialReads, "re-expanding the tool prefix re-rendered the stable suffix");
  assert.equal(toolReads, expandedToolReads, "re-expanding missed the completed tool variant cache");
});

test("retained Markdown transforms sample once per relevant chunk and replay the sampled output", async () => {
  const { internalCreateRichTuiFrameProjector } = await richFrameProjector();
  let pass = 1;
  const calls: Array<{
    pass: number;
    input: string;
    messageType: "user" | "assistant" | "assistant-thinking";
    isStreaming: boolean;
    availableWidth: number;
  }> = [];
  const projection = request({
    ...baseView(),
    transcript: [{
      id: "transform-user",
      kind: "user",
      text: "user source",
    }, {
      id: "transform-assistant-one",
      kind: "assistant",
      text: "same assistant source",
    }, {
      id: "transform-assistant-two",
      kind: "assistant",
      text: "same assistant source",
    }, {
      id: "transform-reasoning-one",
      kind: "reasoning",
      text: "thought one",
      sourceMessageId: "transform-reasoning-source",
    }, {
      id: "transform-reasoning-two",
      kind: "reasoning",
      text: "thought two",
      sourceMessageId: "transform-reasoning-source",
    }, {
      id: "transform-empty",
      kind: "assistant",
      text: "",
    }, {
      id: "transform-tool",
      kind: "tool",
      title: "read",
      status: "completed",
      text: "done",
    }],
  }, {
    size: { columns: 60, rows: 100 },
    thinkingExpanded: true,
    transcriptRevision: 1,
    transcriptOptions: {
      outputPad: 1,
      transformMarkdown: (input, context) => {
        const ordinal = calls.filter((call) => call.pass === pass).length + 1;
        calls.push({ pass, input, ...context });
        return input === "user source" ? "**stable-user**" : `**frame-${pass}-call-${ordinal}**`;
      },
    },
  });
  const projector = internalCreateRichTuiFrameProjector();

  const first = stripAnsi(projector(projection).text);
  assert.equal(calls.length, 4);
  assert.deepEqual(calls, [{
    pass: 1,
    input: "user source",
    messageType: "user",
    isStreaming: false,
    availableWidth: 58,
  }, {
    pass: 1,
    input: "same assistant source",
    messageType: "assistant",
    isStreaming: false,
    availableWidth: 58,
  }, {
    pass: 1,
    input: "same assistant source",
    messageType: "assistant",
    isStreaming: false,
    availableWidth: 58,
  }, {
    pass: 1,
    input: "thought one\n\nthought two",
    messageType: "assistant-thinking",
    isStreaming: false,
    availableWidth: 58,
  }]);
  assert.match(first, /stable-user[\s\S]*frame-1-call-2[\s\S]*frame-1-call-3[\s\S]*frame-1-call-4/u);

  pass = 2;
  const second = stripAnsi(projector(projection).text);
  assert.equal(calls.length, 8);
  assert.deepEqual(calls.slice(4).map((call) => call.pass), [2, 2, 2, 2]);
  assert.match(second, /stable-user[\s\S]*frame-2-call-2[\s\S]*frame-2-call-3[\s\S]*frame-2-call-4/u);
  assert.doesNotMatch(second, /frame-1-call/u);
});

test("oversized aggregate Markdown transforms stay single-sampled and bypass retained projection caches", async () => {
  const { internalCreateRichTuiFrameProjector } = await richFrameProjector();
  const largeHiddenOutput = `<!--${"x".repeat(4 * 1024 * 1024 + 1_024)}-->`;
  let pass = 1;
  const calls: Array<{ pass: number; ordinal: number; input: string }> = [];
  const projection = request({
    ...baseView(),
    transcript: Array.from({ length: 4 }, (_, index) => ({
      id: `aggregate-transform-${index}`,
      kind: "assistant" as const,
      text: `aggregate source ${index + 1}`,
    })),
  }, {
    size: { columns: 60, rows: 40 },
    transcriptRevision: 1,
    transcriptOptions: {
      transformMarkdown: (input) => {
        const ordinal = calls.filter((call) => call.pass === pass).length + 1;
        calls.push({ pass, ordinal, input });
        return ordinal <= 2 ? largeHiddenOutput : `**aggregate-frame-${pass}-call-${ordinal}**`;
      },
    },
  });
  const projector = internalCreateRichTuiFrameProjector();

  const first = stripAnsi(projector(projection).text);
  assert.deepEqual(calls.map((call) => [call.pass, call.ordinal]), [
    [1, 1], [1, 2], [1, 3], [1, 4],
  ]);
  assert.match(first, /aggregate-frame-1-call-3[\s\S]*aggregate-frame-1-call-4/u);

  pass = 2;
  const second = stripAnsi(projector(projection).text);
  assert.deepEqual(calls.slice(4).map((call) => [call.pass, call.ordinal]), [
    [2, 1], [2, 2], [2, 3], [2, 4],
  ]);
  assert.match(second, /aggregate-frame-2-call-3[\s\S]*aggregate-frame-2-call-4/u);
  assert.doesNotMatch(second, /aggregate-frame-1/u);
});

test("the retained native projector keeps reused provider call IDs as distinct tool rows", async () => {
  const { internalCreateRichTuiFrameProjector } = await richFrameProjector();
  const frame = internalCreateRichTuiFrameProjector()(request({
    ...baseView(),
    transcript: ["first", "second"].map((summary, index) => ({
      id: `reused-call-row-${index}`,
      callId: "reused-provider-call",
      kind: "tool" as const,
      title: "read",
      status: "completed" as const,
      summary,
      text: summary,
    })),
  }, { transcriptRevision: 1 }));
  assert.equal(stripAnsi(frame.text).match(/✓ read · done/gu)?.length, 2);
  assert.match(stripAnsi(frame.text), /first[\s\S]*second/u);
});

test("the retained projector binds reused provider call IDs to exact custom tool rows", async () => {
  const { internalCreateRichTuiFrameProjector } = await richFrameProjector();
  const transcript: TuiViewState["transcript"] = ["first", "second"].map((summary, index) => ({
    id: `reused-custom-row-${index}`,
    callId: "reused-custom-provider-call",
    kind: "tool" as const,
    title: "custom_read",
    status: "completed" as const,
    summary,
    text: summary,
  }));
  const frame = internalCreateRichTuiFrameProjector()(request({
    ...baseView(),
    transcript,
  }, {
    transcriptRevision: 1,
    transcriptOptions: {
      toolRenderBlocks: new Map(transcript.map((entry, index) => [
        internalToolRenderEntryKey(entry.id),
        {
          call: { lines: [{ spans: [{ text: `custom call ${index + 1}` }] }] },
          result: { lines: [{ spans: [{ text: `custom result ${index + 1}` }] }] },
        },
      ])),
    },
  }));
  const text = stripAnsi(frame.text);
  assert.match(text, /custom call 1[\s\S]*custom result 1[\s\S]*custom call 2[\s\S]*custom result 2/u);
  assert.equal(text.match(/custom call [12]/gu)?.length, 2);
  assert.equal(text.match(/custom result [12]/gu)?.length, 2);
});

test("the rich projector keeps built-in tool details collapsed until Ctrl+O expansion", async () => {
  const { projectRichTuiFrame } = await richFrameProjector();
  const output = Array.from({ length: 20 }, (_, index) => `line-${index}`).join("\n");
  const tool: TuiViewState["transcript"][number] = {
    id: "read-tool",
    kind: "tool",
    title: "read",
    status: "completed",
    summary: "lines 1-20",
    inputPreview: "/tmp/a",
    text: output,
    expandable: true,
    expanded: false,
  };
  const collapsed = projectRichTuiFrame(request({ ...baseView(), transcript: [tool] }, {
    size: { columns: 50, rows: 40 },
    transcriptOptions: { expandKeyHint: "Ctrl+O" },
  }));
  assert.ok(collapsed);
  const collapsedText = stripAnsi(collapsed.text);
  assert.match(collapsedText, /✓ read · done/u);
  assert.match(collapsedText, /↳ lines 1-20/u);
  assert.match(collapsedText, /line-2/u);
  assert.doesNotMatch(collapsedText, /line-3/u);
  assert.match(collapsedText, /… Ctrl\+O details/u);
  assert.doesNotMatch(collapsedText, /(?:^|\n)│/u);

  const expanded = projectRichTuiFrame(request({
    ...baseView(),
    transcript: [{ ...tool, expanded: true }],
  }, {
    size: { columns: 50, rows: 40 },
    thinkingExpanded: false,
    toolDetailsExpanded: true,
    transcriptOptions: { expandKeyHint: "Ctrl+O" },
  }));
  assert.ok(expanded);
  const expandedText = stripAnsi(expanded.text);
  assert.match(expandedText, /line-19/u);
  assert.doesNotMatch(expandedText, /output shortened/u);

  const collapsedStartup = projectRichTuiFrame(request({
    ...baseView(),
    transcript: [{
      id: "startup",
      kind: "startup",
      text: "Long startup help",
      compactText: "Startup ready",
      expandable: true,
      expanded: false,
    }],
  }));
  const expandedStartup = projectRichTuiFrame(request({
    ...baseView(),
    transcript: [{
      id: "startup",
      kind: "startup",
      text: "Long startup help",
      compactText: "Startup ready",
      expandable: true,
      expanded: true,
    }],
  }));
  assert.match(stripAnsi(collapsedStartup?.text ?? ""), /Startup ready/u);
  assert.doesNotMatch(stripAnsi(collapsedStartup?.text ?? ""), /Long startup help/u);
  assert.match(stripAnsi(expandedStartup?.text ?? ""), /Long startup help/u);

  const collapsedCard = projectRichTuiFrame(request({
    ...baseView(),
    transcript: [{
      id: "compaction-card",
      kind: "status",
      title: "Context compacted",
      compactText: "50,000 tokens before",
      summary: "cache retained",
      text: "Retained summary body",
      status: "completed",
      expandable: true,
      expanded: false,
      card: "compaction",
    }],
  }, { transcriptOptions: { expandKeyHint: "Ctrl+O" } }));
  const collapsedCardText = stripAnsi(collapsedCard.text);
  assert.match(collapsedCardText, /✓ context · compacted/u);
  assert.match(collapsedCardText, /Context compacted · 50,000 tokens before · cache\s+retained/u);
  assert.match(collapsedCardText, /… Ctrl\+O details/u);
  assert.doesNotMatch(collapsedCardText, /Retained summary body/u);
  assert.doesNotMatch(collapsedCardText, /(?:^|\n)│/u);

  const expandedCard = projectRichTuiFrame(request({
    ...baseView(),
    transcript: [{
      id: "compaction-card",
      kind: "status",
      title: "Context compacted",
      text: "Retained summary body",
      status: "completed",
      expandable: true,
      expanded: true,
      card: "compaction",
    }],
  }, { transcriptOptions: { expandKeyHint: "Ctrl+O" } }));
  assert.match(stripAnsi(expandedCard.text), /Retained summary body/u);
});

test("the rich projector retains bounded multiline startup, extension, and diagnostic entries", async () => {
  const { projectRichTuiFrame } = await richFrameProjector();
  const retainedRows = (prefix: string, count: number): string => [
    `${prefix} head`,
    ...Array.from({ length: count }, (_, index) => `${prefix} row ${index + 1} ${"x".repeat(16)}`),
    `${prefix} tail`,
  ].join("\n");

  const collapsedStartup = projectRichTuiFrame(request({
    ...baseView(),
    transcript: [{
      id: "retained-startup",
      kind: "startup",
      text: retainedRows("startup", 140),
      compactText: "Startup ready",
      expandable: true,
      expanded: false,
    }],
  }, {
    size: { columns: 64, rows: 200 },
    transcriptOptions: { expandKeyHint: "Ctrl+O" },
  }));
  const collapsedStartupText = stripAnsi(collapsedStartup.text);
  assert.match(collapsedStartupText, /Startup ready/u);
  assert.match(collapsedStartupText, /Ctrl\+O details/u);
  assert.doesNotMatch(collapsedStartupText, /startup (?:head|tail)/u);

  const expandedStartup = projectRichTuiFrame(request({
    ...baseView(),
    transcript: [{
      id: "retained-startup",
      kind: "startup",
      text: retainedRows("startup", 140),
      compactText: "Startup ready",
      expandable: true,
      expanded: true,
    }],
  }, {
    size: { columns: 64, rows: 200 },
    transcriptOptions: { expandKeyHint: "Ctrl+O" },
  }));
  const expandedStartupText = stripAnsi(expandedStartup.text);
  assert.match(expandedStartupText, /startup head/u);
  assert.match(expandedStartupText, /startup tail/u);
  assert.match(expandedStartupText, /… \d+ rows omitted/u);
  assert.match(expandedStartupText, /Ctrl\+O collapse/u);
  assert.doesNotMatch(expandedStartupText, /(?:^|\n)│/u);

  const collapsedExtension = projectRichTuiFrame(request({
    ...baseView(),
    transcript: [{
      id: "retained-extension",
      kind: "status",
      text: retainedRows("extension", 140),
      expandable: true,
      expanded: false,
      extension: { type: "message", customType: "owner.extension/notice" },
    }],
  }, {
    size: { columns: 64, rows: 200 },
    transcriptOptions: { expandKeyHint: "Ctrl+O" },
  }));
  const collapsedExtensionText = stripAnsi(collapsedExtension.text);
  assert.match(collapsedExtensionText, /owner\.extension\/notice/u);
  assert.match(collapsedExtensionText, /Ctrl\+O details/u);
  assert.doesNotMatch(collapsedExtensionText, /extension (?:head|tail)/u);

  const expandedExtension = projectRichTuiFrame(request({
    ...baseView(),
    transcript: [{
      id: "retained-extension",
      kind: "status",
      text: retainedRows("extension", 140),
      expandable: true,
      expanded: true,
      extension: { type: "message", customType: "owner.extension/notice" },
    }],
  }, {
    size: { columns: 64, rows: 200 },
    transcriptOptions: { expandKeyHint: "Ctrl+O" },
  }));
  const expandedExtensionText = stripAnsi(expandedExtension.text);
  assert.match(expandedExtensionText, /owner\.extension\/notice/u);
  assert.match(expandedExtensionText, /extension head/u);
  assert.match(expandedExtensionText, /extension tail/u);
  assert.match(expandedExtensionText, /… \d+ rows omitted/u);
  assert.match(expandedExtensionText, /Ctrl\+O collapse/u);
  assert.doesNotMatch(expandedExtensionText, /(?:^|\n)│/u);

  const diagnostic = projectRichTuiFrame(request({
    ...baseView(),
    transcript: [{
      id: "retained-diagnostic",
      kind: "warning",
      title: "Provider warning",
      text: retainedRows("diagnostic", 40),
    }],
  }, { size: { columns: 64, rows: 80 } }));
  const diagnosticText = stripAnsi(diagnostic.text);
  assert.match(diagnosticText, /Provider warning/u);
  assert.match(diagnosticText, /diagnostic head/u);
  assert.match(diagnosticText, /diagnostic tail/u);
  assert.match(diagnosticText, /… \d+ rows omitted/u);
  assert.doesNotMatch(diagnosticText, /(?:^|\n)│/u);
});

test("expanded native skill, compaction, and branch cards preserve Markdown semantics", async () => {
  const { projectRichTuiFrame } = await richFrameProjector();
  const transformed: string[] = [];
  const projected = projectRichTuiFrame(request({
    ...baseView(),
    transcript: [{
      id: "skill-card",
      kind: "status",
      summary: "review",
      text: "# Skill heading\n\nUse **carefully** with [the guide](https://example.test/skill) and `skillValue`.",
      status: "completed",
      expandable: true,
      expanded: true,
      card: "skill",
    }, {
      id: "compaction-card-markdown",
      kind: "status",
      title: "Context compacted",
      text: "Retain **provider state** and `tool results`.",
      status: "completed",
      expandable: true,
      expanded: true,
      card: "compaction",
    }, {
      id: "branch-card-markdown",
      kind: "status",
      title: "Branch summary",
      text: "- first branch fact\n- second **branch fact**",
      status: "completed",
      expandable: true,
      expanded: true,
      card: "branch_summary",
    }, {
      id: "transformed-assistant",
      kind: "assistant",
      text: "ORIGINAL ASSISTANT",
    }],
  }, {
    size: { columns: 80, rows: 100 },
    transcriptOptions: {
      hyperlinks: true,
      transformMarkdown: (value, context) => {
        transformed.push(context.messageType);
        return value.replace("ORIGINAL ASSISTANT", "**TRANSFORMED ASSISTANT**");
      },
    },
  }));
  const plain = stripAnsi(projected.text);
  assert.match(plain, /Skill heading/u);
  assert.match(plain, /Use carefully with \[the guide\]\(https:\/\/example\.test\/skill\) and skillValue\./u);
  assert.match(plain, /Retain provider state and tool results\./u);
  assert.match(plain, /first branch fact[\s\S]*second branch fact/u);
  assert.match(plain, /TRANSFORMED ASSISTANT/u);
  assert.doesNotMatch(plain, /\*\*carefully\*\*|`(?:skillValue|tool results)`|\*\*branch fact\*\*|\*\*TRANSFORMED ASSISTANT\*\*/u);
  assert.ok(projected.text.includes("\u001b]8;;https://example.test/skill"));
  assert.deepEqual(transformed, ["assistant"]);
  assert.doesNotMatch(plain, /(?:^|\n)│/u);
});

test("the rich projector composes extension transcript renderers, images, and runtime surfaces", async () => {
  const { projectRichTuiFrame } = await richFrameProjector();
  const extensionTranscript = projectRichTuiFrame(request({
    ...baseView(),
    transcript: [{
      id: "tool-entry",
      kind: "tool",
      callId: "call-1",
      title: "fixture",
      status: "completed",
      text: "built-in tool output",
    }, {
      id: "session-entry",
      kind: "status",
      text: "built-in session output",
      extension: { type: "message", customType: "owner.extension/message" },
    }],
  }, {
    transcriptOptions: {
      toolRenderBlocks: new Map([["call-1", {
        call: { lines: [{ spans: [{ text: "CUSTOM TOOL CALL", role: "accent" }] }] },
        result: { lines: [{ spans: [{ text: "CUSTOM TOOL RESULT", role: "success" }] }] },
      }]]),
      sessionRenderBlocks: new Map([["session-entry", {
        lines: [{ spans: [{ text: "CUSTOM SESSION ENTRY", role: "info" }] }],
      }]]),
    },
  }));
  assert.ok(extensionTranscript);
  const extensionText = stripAnsi(extensionTranscript.text);
  assert.match(extensionText, /CUSTOM TOOL CALL[\s\S]*CUSTOM TOOL RESULT[\s\S]*CUSTOM SESSION ENTRY/u);
  assert.doesNotMatch(extensionText, /built-in tool output|built-in session output|owner\.extension/u);
  assert.match(extensionText, /✓ fixture · done/u);
  assert.doesNotMatch(extensionText, /(?:^|\n)│/u);
  assert.match(extensionText, /─ Ask ohm /u);

  const callOnly = projectRichTuiFrame(request({
    ...baseView(),
    transcript: [{
      id: "call-only-tool",
      kind: "tool",
      callId: "call-only",
      title: "fixture",
      status: "completed",
      text: "INHERITED TOOL RESULT",
    }],
  }, {
    transcriptOptions: {
      toolRenderBlocks: new Map([["call-only", {
        call: { lines: [{ spans: [{ text: "CUSTOM CALL ONLY", role: "accent" }] }] },
      }]]),
    },
  }));
  const callOnlyText = stripAnsi(callOnly.text);
  assert.ok(callOnlyText.indexOf("CUSTOM CALL ONLY") < callOnlyText.indexOf("INHERITED TOOL RESULT"));
  assert.doesNotMatch(callOnlyText, /(?:^|\n)│/u);

  const imageData = Buffer.from("rich image fixture").toString("base64");
  const withImage = projectRichTuiFrame(request({
    ...baseView(),
    transcript: [{
      id: "image-entry",
      kind: "assistant",
      text: "Rendered image",
      images: [{
        key: "image-entry:0",
        block: { type: "image", mediaType: "image/png", data: imageData },
      }],
    }],
  }, {
    transcriptOptions: {
      resolveImage: () => ({
        fallback: "[Image: image/png 20x10]",
        image: {
          key: "image-entry:0",
          fingerprint: "image-fingerprint",
          imageId: 7,
          mediaType: "image/png",
          data: imageData,
          bytes: 18,
          widthPx: 20,
          heightPx: 10,
          columns: 4,
          rows: 2,
        },
      }),
    },
  }));
  assert.ok(withImage);
  assert.equal(withImage.images?.length, 1);
  assert.equal(withImage.images?.[0]?.key, "image-entry:0");
  assert.match(stripAnsi(withImage.text), /Rendered image[\s\S]*\[Image: image\/png 20x10\]/u);
  const fallbackRow = stripAnsi(withImage.text).split("\n").findIndex((line) => line.includes("[Image: image/png 20x10]"));
  assert.equal(withImage.images?.[0]?.row, fallbackRow + 1);
  assert.equal(withImage.text.includes(imageData), false);

  const toolImage = projectRichTuiFrame(request({
    ...baseView(),
    transcript: [{
      id: "tool-image-entry",
      kind: "tool",
      title: "read",
      status: "completed",
      text: "tool image result",
      images: [{
        key: "tool-image-entry:0",
        block: { type: "image", mediaType: "image/png", data: imageData },
      }],
    }],
  }, {
    transcriptOptions: {
      resolveImage: () => ({
        fallback: "[Image: image/png 20x10]",
        image: {
          key: "tool-image-entry:0",
          fingerprint: "tool-image-fingerprint",
          imageId: 8,
          mediaType: "image/png",
          data: imageData,
          bytes: 18,
          widthPx: 20,
          heightPx: 10,
          columns: 4,
          rows: 2,
        },
      }),
    },
  }));
  const toolImageText = stripAnsi(toolImage.text);
  assert.match(toolImageText, /✓ read · done/u);
  assert.match(toolImageText, /tool image result/u);
  assert.match(toolImageText, /\[Image: image\/png 20x10\]/u);
  assert.doesNotMatch(toolImageText, /(?:^|\n)│/u);
  assert.equal(toolImage.images?.[0]?.key, "tool-image-entry:0");

  let resolvedImageCount = 0;
  const boundedImages = projectRichTuiFrame(request({
    ...baseView(),
    transcript: Array.from({ length: 10 }, (_, index) => ({
      id: `bounded-image-${index}`,
      kind: "assistant" as const,
      text: `image ${index}`,
      images: [{
        key: `bounded-image-${index}:0`,
        block: { type: "image" as const, mediaType: "image/png", data: imageData },
      }],
    })),
  }, {
    size: { columns: 60, rows: 120 },
    transcriptOptions: {
      resolveImage: (image) => {
        resolvedImageCount += 1;
        return {
          fallback: "[Image: image/png 20x10]",
          image: {
            key: image.key,
            fingerprint: `bounded-${resolvedImageCount}`,
            imageId: 20 + resolvedImageCount,
            mediaType: "image/png",
            data: imageData,
            bytes: 18,
            widthPx: 20,
            heightPx: 10,
            columns: 4,
            rows: 1,
          },
        };
      },
    },
  }));
  assert.equal(resolvedImageCount, 8);
  assert.equal(boundedImages.images?.length, 8);
  assert.match(stripAnsi(boundedImages.text), /terminal preview limit reached/u);

  const byteBoundedImages = projectRichTuiFrame(request({
    ...baseView(),
    transcript: Array.from({ length: 2 }, (_, index) => ({
      id: `byte-bounded-image-${index}`,
      kind: "assistant" as const,
      text: `large image ${index}`,
      images: [{
        key: `byte-bounded-image-${index}:0`,
        block: { type: "image" as const, mediaType: "image/png", data: imageData },
      }],
    })),
  }, {
    size: { columns: 60, rows: 60 },
    transcriptOptions: {
      resolveImage: (image) => ({
        fallback: "[Image: image/png 20x10]",
        image: {
          key: image.key,
          fingerprint: image.key,
          imageId: image.key.endsWith("0:0") ? 40 : 41,
          mediaType: "image/png",
          data: imageData,
          bytes: Math.floor(MAX_TERMINAL_IMAGE_AGGREGATE_BYTES * 0.6),
          widthPx: 20,
          heightPx: 10,
          columns: 4,
          rows: 1,
        },
      }),
    },
  }));
  assert.equal(byteBoundedImages.images?.length, 1);
  assert.match(stripAnsi(byteBoundedImages.text), /terminal preview byte limit reac/u);

  const runtimeSurfaces = projectRichTuiFrame(request({
    ...baseView(),
    runtimeHeaderComponents: [{ lines: [{ spans: [{ text: "EXTENSION HEADER", role: "accent" }] }] }],
    runtimeFooterComponents: [{ lines: [{ spans: [{ text: "EXTENSION FOOTER", role: "muted" }] }] }],
    runtimeWidgetComponents: [{ lines: [{ spans: [{ text: "EXTENSION WIDGET", role: "info" }] }] }],
    runtimeWidgetBelowComponents: [{ lines: [{ spans: [{ text: "EXTENSION BELOW", role: "success" }] }] }],
    editorBlock: {
      lines: [{ spans: [{ text: "EXTENSION EDITOR", role: "editor" }] }],
      cursor: { row: 0, column: 4 },
    },
    runtimeOverlays: [{
      block: { lines: [{ spans: [{ text: "OVERLAY", role: "selection" }], fill: true }], cursor: { row: 0, column: 2 } },
      options: { anchor: "top-right", margin: 1 },
      focused: true,
      width: 12,
    }],
  }));
  assert.ok(runtimeSurfaces);
  const runtimeText = stripAnsi(runtimeSurfaces.text);
  assert.match(runtimeText, /EXTENSION HEADER/u);
  assert.match(runtimeText, /EXTENSION FOOTER/u);
  assert.match(runtimeText, /EXTENSION WIDGET/u);
  assert.match(runtimeText, /EXTENSION BELOW/u);
  assert.match(runtimeText, /EXTENSION EDITOR/u);
  assert.match(runtimeText, /OVERLAY/u);
  assert.ok(runtimeText.indexOf("EXTENSION EDITOR") < runtimeText.indexOf("EXTENSION BELOW"));
  assert.ok(runtimeText.indexOf("EXTENSION BELOW") < runtimeText.indexOf("EXTENSION FOOTER"));
  const overlayLine = runtimeText.split("\n").find((line) => line.includes("OVERLAY"));
  assert.equal(overlayLine?.indexOf("OVERLAY"), 47);
  assert.ok(runtimeSurfaces.cursor.row >= 1 && runtimeSurfaces.cursor.row <= runtimeText.split("\n").length);

  const kitty = "\u001b_Ga=T,c=4,r=2;AAAA\u001b\\";
  const rawImageSurface = projectRichTuiFrame(request({
    ...baseView(),
    rawHeaderReplacement: { lines: [kitty, ""] },
    backgroundCells: [
      { row: 0, column: 0, text: "B" },
      { row: 1, column: 0, text: "C" },
    ],
  }));
  assert.ok(rawImageSurface);
  const rawImageLines = rawImageSurface.text.split("\n");
  assert.equal(rawImageLines[0], kitty);
  assert.equal(rawImageLines[1], "");

  const invalidExtension = projectRichTuiFrame(request({
    ...baseView(),
    runtimeHeaderComponents: JSON.parse('[{"lines":[{"spans":[{"text":42,"role":"accent"}]}]}]'),
  }));
  const recoveredText = stripAnsi(invalidExtension.text);
  assert.match(recoveredText, /hello/u);
  assert.match(recoveredText, /Extension UI unavailable; core view preserved/u);
  assert.match(recoveredText, /─ Ask ohm /u);

  const recoveredFrame = projectRichTuiFrame(request({
    ...baseView(),
    inputImages: [{ label: JSON.parse("42"), mediaType: "image/png" }],
  }));
  const recoveredFrameText = stripAnsi(recoveredFrame.text);
  assert.match(recoveredFrameText, /hello/u);
  assert.match(recoveredFrameText, /Display extension unavailable; core view preserved/u);
  assert.match(recoveredFrameText, /─ Ask ohm /u);
  assert.doesNotMatch(recoveredFrameText, /(?:^|\n)│/u);
});

test("the rich projector preserves hidden thinking, status, Markdown, prompts, and raw overlay contracts", async () => {
  const { projectRichTuiFrame } = await richFrameProjector();
  const hidden = projectRichTuiFrame(request({
    ...baseView(),
    hiddenReasoningLabel: "Private work hidden",
    transcript: [{ id: "hidden", kind: "reasoning", text: "secret reasoning", streaming: false }],
  }, { hideReasoningBlock: true, transcriptOptions: { hideReasoningBlock: true } }));
  assert.ok(hidden);
  assert.match(stripAnsi(hidden.text), /Private work hidden/u);
  assert.doesNotMatch(stripAnsi(hidden.text), /secret reasoning/u);

  const defaultHidden = projectRichTuiFrame(request({
    ...baseView(),
    transcript: [{ id: "default-hidden", kind: "reasoning", text: "secret default", streaming: false }],
  }, { hideReasoningBlock: true, transcriptOptions: { hideReasoningBlock: true } }));
  assert.ok(defaultHidden);
  assert.match(stripAnsi(defaultHidden.text), /Thinking\.\.\./u);
  assert.doesNotMatch(stripAnsi(defaultHidden.text), /secret default/u);

  const status = projectRichTuiFrame(request({
    ...baseView(),
    context: {
      ...baseView().context,
      active: true,
      status: "working",
      activity: { phase: "Provider work", startedAt: 0 },
      extensionStatus: "Extension ready",
      workingMessage: "Extension work",
      workingVisible: true,
    },
    workingIndicator: { frames: [".", "o"], intervalMs: 80 },
  }));
  assert.ok(status);
  const statusText = stripAnsi(status.text);
  assert.match(statusText, /Provider work/u);
  assert.match(statusText, /Extension ready/u);
  assert.match(statusText, /Extension work/u);
  assert.equal(statusText.match(/Extension work/gu)?.length, 1);

  const defaultWorking = projectRichTuiFrame(request({
    ...baseView(),
    context: {
      ...baseView().context,
      active: true,
      status: "working",
      activity: { phase: "Default work", startedAt: Date.now(), cancellable: true },
    },
  }, { size: { columns: 100, rows: 24 } }));
  const defaultWorkingText = stripAnsi(defaultWorking?.text ?? "");
  assert.equal(defaultWorkingText.match(/Default work/gu)?.length, 1);
  assert.match(defaultWorkingText, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Default work/u);
  assert.match(defaultWorkingText, /Esc to cancel/u);

  const animatedWorking0 = projectRichTuiFrame(request({
    ...baseView(),
    context: {
      ...baseView().context,
      active: true,
      status: "working",
      activity: { phase: "Animated work", startedAt: Date.now(), cancellable: true },
      activityFrame: 0,
    },
    workingIndicator: { frames: [".", "o"], intervalMs: 80 },
  }, { size: { columns: 100, rows: 24 } }));
  const animatedWorking1 = projectRichTuiFrame(request({
    ...baseView(),
    context: {
      ...baseView().context,
      active: true,
      status: "working",
      activity: { phase: "Animated work", startedAt: Date.now(), cancellable: true },
      activityFrame: 1,
    },
    workingIndicator: { frames: [".", "o"], intervalMs: 80 },
  }, { size: { columns: 100, rows: 24 } }));
  const animatedText0 = stripAnsi(animatedWorking0?.text ?? "");
  const animatedText1 = stripAnsi(animatedWorking1?.text ?? "");
  assert.equal(animatedText0.match(/Animated work/gu)?.length, 1);
  assert.equal(animatedText1.match(/Animated work/gu)?.length, 1);
  assert.match(animatedText0, /\. Animated work/u);
  assert.match(animatedText1, /o Animated work/u);

  const explicitWorking = projectRichTuiFrame(request({
    ...baseView(),
    context: {
      ...baseView().context,
      active: true,
      status: "working",
      workingMessage: "Public work",
      activity: { phase: "Provider work", startedAt: Date.now() },
    },
  }));
  assert.equal(stripAnsi(explicitWorking?.text ?? "").match(/Public work/gu)?.length, 1);

  const hiddenWorking = projectRichTuiFrame(request({
    ...baseView(),
    context: {
      ...baseView().context,
      active: true,
      status: "working",
      workingMessage: "Hidden work",
      workingVisible: false,
      activity: { phase: "Hidden phase", startedAt: Date.now(), cancellable: true },
    },
  }));
  assert.doesNotMatch(stripAnsi(hiddenWorking?.text ?? ""), /Hidden work|Hidden phase|Esc to cancel/u);

  const markdown = projectRichTuiFrame(request({
    ...baseView(),
    transcript: [{ id: "plain-tool", kind: "tool", title: "read", status: "completed", text: "done" }, {
      id: "markdown",
      kind: "assistant",
      text: "*emphasis* and ~~removed~~ and <https://example.test>",
    }, { id: "later", kind: "assistant", text: "ordinary later answer" }],
  }, { transcriptOptions: { hyperlinks: true } }));
  assert.ok(markdown);
  const markdownText = stripAnsi(markdown.text);
  assert.match(markdownText, /✓ read · done/u);
  assert.match(markdownText, /emphasis and removed and <https:\/\/example\.test>/u);
  assert.doesNotMatch(markdownText, /\*emphasis\*|~~removed~~/u);
  assert.ok(markdown.text.includes("\u001b]8;;https://example.test"));
  assert.match(markdownText, /ordinary later answer/u);

  const liveMarkdownThinkingView: TuiViewState = {
    ...baseView(),
    transcript: [{
      id: "live-markdown-thinking",
      kind: "reasoning",
      text: "**Live reasoning**",
      streaming: true,
    }],
  };
  const collapsedLiveMarkdownThinking = projectRichTuiFrame(request(liveMarkdownThinkingView));
  assert.match(stripAnsi(collapsedLiveMarkdownThinking.text), /◆ Thinking/u);
  assert.doesNotMatch(stripAnsi(collapsedLiveMarkdownThinking.text), /Live reasoning/u);
  const expandedLiveMarkdownThinking = projectRichTuiFrame(request(
    liveMarkdownThinkingView,
    { thinkingExpanded: true },
  ));
  assert.match(stripAnsi(expandedLiveMarkdownThinking.text), /Live reasoning/u);

  const thinkingTransforms: Array<{ messageType: string; isStreaming: boolean; availableWidth: number }> = [];
  const markdownThinking = projectRichTuiFrame(request({
    ...baseView(),
    transcript: [{
      id: "markdown-thinking",
      kind: "reasoning",
      text: "**Reasoned** with <https://example.test/evidence>",
      streaming: false,
    }],
  }, {
    thinkingExpanded: true,
    outputPad: 0,
    transcriptOptions: {
      hyperlinks: true,
      outputPad: 0,
      transformMarkdown: (value, context) => {
        thinkingTransforms.push(context);
        return value;
      },
    },
  }));
  const markdownThinkingText = stripAnsi(markdownThinking.text);
  assert.match(markdownThinkingText, /… Thinking/u);
  assert.match(markdownThinkingText, /Reasoned with <https:\/\/example\.test\/evidence>/u);
  assert.doesNotMatch(markdownThinkingText, /\*\*Reasoned\*\*/u);
  assert.doesNotMatch(markdownThinkingText, /(?:^|\n)│|╭|╰/u);
  assert.ok(markdownThinking.text.includes("\u001b]8;;https://example.test/evidence"));
  assert.deepEqual(thinkingTransforms, [{
    messageType: "assistant-thinking",
    isStreaming: false,
    availableWidth: 58,
  }]);

  const prompt = projectRichTuiFrame(request({
    ...baseView(),
    inputPrompt: "First question\nSecond question\u001b]2;owned\u0007",
  }));
  assert.ok(prompt);
  const promptText = stripAnsi(prompt.text);
  assert.match(promptText, /─ Ask ohm /u);
  assert.match(promptText, /First question[\s\S]*Second question/u);
  assert.doesNotMatch(promptText, /owned/u);
  assert.equal(promptText.split("\n")[prompt.cursor.row - 1]?.includes("› a🙂b"), true);

  const rawOverlay = projectRichTuiFrame(request({
    ...baseView(),
    transcript: [{ id: "base", kind: "assistant", text: "BBBBBBBB" }],
    rawRuntimeOverlays: [{
      block: { lines: ["X"] },
      options: { anchor: "top-left" },
      focused: false,
      width: 4,
    }],
  }));
  assert.ok(rawOverlay);
  assert.match(stripAnsi(rawOverlay.text).split("\n")[0] ?? "", /^X   BBBB/u);

  const overflow = projectRichTuiFrame(request({
    ...baseView(),
    context: { ...baseView().context, contextTokens: 110, contextWindowTokens: 100 },
  }));
  assert.match(stripAnsi(overflow?.text ?? ""), /ctx 110\.0%\/100/u);
});

test("the rich controller keeps one terminal owner across cropped tool history and notices", async () => {
  const { createRichTuiController } = await richFrameProjector();
  const input = new FakeInput();
  const output = new FakeOutput();
  const controller = createRichTuiController({
    input,
    output,
    environment: { TERM: "xterm-256color", LANG: "en_US.UTF-8" },
    handleSignals: false,
  });
  const viewport = (): string => {
    const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
    for (const chunk of output.chunks) terminal.write(chunk.toString("utf8"));
    return terminal.viewport().join("\n");
  };

  controller.start();
  assert.equal(getEventListeners(input, "data").length, 1);
  assert.deepEqual(input.rawChanges, [true]);
  controller.render(envelope({
    type: "message_appended",
    message: {
      id: "rich-user",
      role: "user",
      content: [{ type: "text", text: "short ordinary state" }],
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  }, 1));
  controller.renderNow();
  assert.match(viewport(), /short ordinary state/u);
  assert.match(viewport(), /─ Ask ohm /u);

  for (let index = 0; index < 20; index += 1) {
    controller.render(envelope({
      type: "tool_requested",
      callId: `cropped-tool-${index}`,
      name: `read-${index}`,
      input: { path: `fixture-${index}.txt` },
      index,
    }, index + 2));
  }
  controller.notify("Interrupted", "warning");
  controller.renderNow();
  assert.match(viewport(), /! warning Interrupted/u);
  assert.match(viewport(), /… read-19 · queued[\s\S]*fixture-19\.txt/u);
  assert.doesNotMatch(viewport(), /read-0 · pending/u);
  assert.match(viewport(), /─ Ask ohm /u);
  assert.equal(getEventListeners(input, "data").length, 1);
  assert.deepEqual(input.rawChanges, [true]);

  input.write("\u001b[5~");
  await tick();
  controller.renderNow();
  const pagedLines = viewport().split("\n");
  const anchorRow = pagedLines.findIndex((line) => /fixture-\d+\.txt/u.test(line));
  const anchor = /fixture-\d+\.txt/u.exec(pagedLines[anchorRow] ?? "")?.[0];
  assert.ok(anchorRow >= 0 && anchor !== undefined);

  output.resize(68, 18);
  await tick();
  controller.renderNow();
  const resizedLines = viewport().split("\n");
  assert.match(resizedLines[anchorRow] ?? "", new RegExp(`${anchor}\\b`, "u"));

  controller.render(envelope({
    type: "tool_requested",
    callId: "cropped-tool-20",
    name: "read-20",
    input: { path: "fixture-20.txt" },
    index: 20,
  }, 100));
  await tick();
  controller.renderNow();
  assert.match(viewport().split("\n")[anchorRow] ?? "", new RegExp(`${anchor}\\b`, "u"));

  controller.close();
  assert.equal(getEventListeners(input, "data").length, 0);
  assert.deepEqual(input.rawChanges, [true, false]);
});

test("unchanged rich transcript history does not block editor redraws", async () => {
  const { createRichTuiController } = await richFrameProjector();
  const input = new FakeInput();
  const output = new FakeOutput();
  output.resize(143, 53);
  const controller = createRichTuiController({
    input,
    output,
    environment: {
      TERM: "xterm-256color",
      LANG: "en_US.UTF-8",
      TERM_COLOR: "0",
    },
    handleSignals: false,
  });
  controller.start();
  for (let index = 0; index < 64; index += 1) {
    controller.notify(`retained notice ${index} ${"x".repeat(96)}`);
  }
  await tick();
  controller.renderNow();

  const samples: number[] = [];
  for (let index = 0; index < 7; index += 1) {
    const startedAt = performance.now();
    controller.renderNow();
    samples.push(performance.now() - startedAt);
  }
  samples.sort((left, right) => left - right);
  assert.ok(samples[3]! < 40, `unchanged rich frame took ${samples[3]!.toFixed(1)}ms`);
  controller.close();
});

test("an unchanged native rich prefix does not block streaming tail redraws", async () => {
  const { createRichTuiController } = await richFrameProjector();
  const input = new FakeInput();
  const output = new FakeOutput();
  output.resize(143, 53);
  const controller = createRichTuiController({
    input,
    output,
    environment: {
      TERM: "xterm-256color",
      LANG: "en_US.UTF-8",
      TERM_COLOR: "0",
    },
    handleSignals: false,
  });
  controller.start();
  for (let index = 0; index < 64; index += 1) {
    controller.notify(`retained warning ${index} ${"x".repeat(96)}`, "warning");
  }
  controller.render(envelope({ type: "run_started", provider: "openai", model: "gpt-test" }, 1));
  controller.render(envelope({ type: "assistant_started", step: 1 }, 2));
  await tick();
  controller.renderNow();

  const samples: number[] = [];
  for (let index = 0; index < 9; index += 1) {
    const startedAt = performance.now();
    controller.render(envelope({
      type: "text_delta",
      text: `streaming-tail-${index}\n`,
      part: 0,
    }, index + 3));
    controller.renderNow();
    samples.push(performance.now() - startedAt);
  }
  samples.sort((left, right) => left - right);
  assert.ok(samples[4]! < 40, `streaming rich frame took ${samples[4]!.toFixed(1)}ms`);
  const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
  for (const chunk of output.chunks) terminal.write(chunk.toString("utf8"));
  assert.match(terminal.viewport().join("\n"), /streaming-tail-8/u);
  controller.close();
});

test("completed Markdown history stays cached while the live-sized rich tail streams", async () => {
  const { createRichTuiController } = await richFrameProjector();
  const input = new FakeInput();
  const output = new FakeOutput();
  output.resize(119, 39);
  const controller = createRichTuiController({
    input,
    output,
    environment: {
      TERM: "xterm-256color",
      LANG: "en_US.UTF-8",
      TERM_COLOR: "0",
    },
    handleSignals: false,
  });
  const history = Array.from({ length: 50 }, (_, index) => [
    envelope({
      type: "message_appended" as const,
      message: {
        id: `markdown-user-${index}`,
        role: "user" as const,
        content: [{ type: "text" as const, text: `Question ${index}: explain the retained behavior` }],
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    }, index * 2 + 1),
    envelope({
      type: "message_appended" as const,
      message: {
        id: `markdown-assistant-${index}`,
        role: "assistant" as const,
        content: [{
          type: "text" as const,
          text: [
            `## Result ${index}`,
            "",
            `- first **bold** item with [link](https://example.test/${index})`,
            `- second item with \`code-${index}\``,
            "",
            `Explanation ${"word ".repeat(25)}`,
          ].join("\n"),
        }],
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    }, index * 2 + 2),
  ]).flat();
  controller.start();
  controller.replaceTranscript(history, "markdown-history");
  controller.renderNow();
  controller.render(envelope({ type: "run_started", provider: "openai", model: "gpt-test" }, 101));
  controller.render(envelope({ type: "assistant_started", step: 1 }, 102));
  controller.renderNow();

  const samples: number[] = [];
  for (let index = 0; index < 9; index += 1) {
    const startedAt = performance.now();
    controller.render(envelope({ type: "text_delta", text: `stream-${index} `, part: 0 }, index + 103));
    controller.renderNow();
    samples.push(performance.now() - startedAt);
  }
  samples.sort((left, right) => left - right);
  assert.ok(samples[4]! < 25, `Markdown streaming rich frame took ${samples[4]!.toFixed(1)}ms`);
  assert.ok(samples[8]! < 40, `Markdown streaming rich p100 took ${samples[8]!.toFixed(1)}ms`);
  controller.close();
});

test("cached Markdown history invalidates on replacement, width, and theme changes", async () => {
  const { createRichTuiController } = await richFrameProjector();
  const input = new FakeInput();
  const output = new FakeOutput();
  output.resize(96, 28);
  const controller = createRichTuiController({
    input,
    output,
    environment: { TERM: "xterm-256color", LANG: "en_US.UTF-8" },
    handleSignals: false,
  });
  const history = (text: string) => [envelope({
    type: "message_appended" as const,
    message: {
      id: "cached-markdown-message",
      role: "assistant" as const,
      content: [{ type: "text" as const, text }],
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  }, 1)];
  const viewport = (): string => {
    const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
    for (const chunk of output.chunks) terminal.write(chunk.toString("utf8"));
    return terminal.viewport().join("\n");
  };

  controller.start();
  controller.replaceTranscript(history("## Old heading\n\n- old cached body"), "markdown-old");
  controller.renderNow();
  controller.renderNow();
  assert.match(viewport(), /Old heading[\s\S]*old cached body/u);

  controller.replaceTranscript(history("## New heading\n\n- new cached body"), "markdown-new");
  controller.renderNow();
  assert.match(viewport(), /New heading[\s\S]*new cached body/u);
  assert.doesNotMatch(viewport(), /Old heading|old cached body/u);

  output.resize(48, 20);
  await tick();
  controller.renderNow();
  const resized = viewport();
  assert.match(resized, /New heading[\s\S]*new cached body/u);
  for (const line of resized.split("\n")) assert.ok(cellWidth(line) <= 48, line);

  output.chunks.length = 0;
  controller.setTheme("mono");
  await tick();
  controller.renderNow();
  assert.equal(controller.selectedThemeName(), "mono");
  assert.match(output.text, terminalPattern("\\u001b\\[1;97m", "u"));
  assert.doesNotMatch(output.text, terminalPattern("\\u001b\\[38;5;179m", "u"));
  controller.close();
});

test("the native rich prefix invalidates tool state, detail, size, and theme changes", async () => {
  const { createRichTuiController } = await richFrameProjector();
  const input = new FakeInput();
  const output = new FakeOutput();
  output.resize(100, 30);
  const controller = createRichTuiController({
    input,
    output,
    environment: { TERM: "xterm-256color", LANG: "en_US.UTF-8" },
    handleSignals: false,
  });
  const viewport = (): string => {
    const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
    for (const chunk of output.chunks) terminal.write(chunk.toString("utf8"));
    return terminal.viewport().join("\n");
  };
  controller.start();
  for (let index = 0; index < 12; index += 1) controller.notify(`cache warning ${index}`, "warning");
  controller.render(envelope({
    type: "tool_requested",
    callId: "cache-tool",
    name: "read",
    input: { path: "cache-fixture.txt" },
    index: 0,
  }, 1));
  controller.render(envelope({
    type: "tool_started",
    callId: "cache-tool",
    name: "read",
    input: { path: "cache-fixture.txt" },
    index: 0,
    recoveryMode: "never_repeat",
  }, 2));
  controller.renderNow();
  assert.match(viewport(), /read .* running/u);

  controller.render(envelope({
    type: "tool_completed",
    callId: "cache-tool",
    name: "read",
    index: 0,
    isError: false,
    preview: "cache-final-output",
  }, 3));
  controller.renderNow();
  assert.match(viewport(), /read .* done/u);
  assert.match(viewport(), /cache-final-output/u);
  assert.doesNotMatch(viewport(), /read .* running/u);

  controller.renderNow();
  input.write(Buffer.from([15]));
  await tick();
  assert.match(viewport(), /cache-fixture\.txt/u);
  assert.match(viewport(), /cache-final-output/u);

  output.resize(58, 24);
  await tick();
  controller.renderNow();
  const resized = viewport();
  assert.match(resized, /cache-final-output/u);
  for (const line of resized.split("\n")) assert.ok(cellWidth(line) <= 58, line);

  output.chunks.length = 0;
  controller.setTheme("mono");
  await tick();
  controller.renderNow();
  assert.equal(controller.selectedThemeName(), "mono");
  assert.match(output.text, terminalPattern("\\u001b\\[38;5;250m", "u"));
  assert.doesNotMatch(output.text, terminalPattern("\\u001b\\[38;5;179m! warning", "u"));
  controller.close();
});

test("the native rich prefix invalidates reasoning groups, Ctrl+T, and session replacement", async () => {
  const { createRichTuiController } = await richFrameProjector();
  const input = new FakeInput();
  const output = new FakeOutput();
  output.resize(100, 30);
  const controller = createRichTuiController({
    input,
    output,
    environment: { TERM: "xterm-256color", LANG: "en_US.UTF-8" },
    handleSignals: false,
  });
  controller.setActionHandler((action) => {
    if (action.type === "toggle_thinking_visibility") controller.toggleReasoning();
  });
  const viewport = (): string => {
    const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
    for (const chunk of output.chunks) terminal.write(chunk.toString("utf8"));
    return terminal.viewport().join("\n");
  };
  controller.start();
  controller.replaceTranscript([envelope({
    type: "message_appended",
    message: {
      id: "cache-reasoning-message",
      role: "assistant",
      content: [
        { type: "thinking", thinking: "first grouped thought", visibility: "summary" },
        { type: "thinking", thinking: "second grouped thought", visibility: "summary" },
        { type: "text", text: "grouped answer" },
      ],
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  }, 1)], "reasoning");
  await tick();
  controller.renderNow();
  const grouped = viewport();
  assert.equal(grouped.match(/Thinking/gu)?.length, 1);
  assert.match(grouped, /first grouped thought[\s\S]*second grouped thought/u);

  controller.renderNow();
  input.write(Buffer.from([20]));
  await tick();
  assert.doesNotMatch(viewport(), /first grouped thought|second grouped thought/u);
  input.write(Buffer.from([20]));
  await tick();
  assert.match(viewport(), /first grouped thought[\s\S]*second grouped thought/u);

  const history = (message: string) => [envelope({
    type: "warning" as const,
    code: "same-cache-entry",
    message,
  }, 1)];
  controller.replaceTranscript(history("old session body"), "old-session");
  await tick();
  controller.renderNow();
  assert.match(viewport(), /old session body/u);
  controller.renderNow();
  controller.replaceTranscript(history("new session body"), "new-session");
  await tick();
  controller.renderNow();
  assert.match(viewport(), /new session body/u);
  assert.doesNotMatch(viewport(), /old session body/u);
  controller.close();
});
