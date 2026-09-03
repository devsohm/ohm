import assert from "node:assert/strict";
import test from "node:test";

import { cellWidth, stripAnsi } from "@ohm/terminal";

import type { OhmTuiSnapshot, OhmTuiToolDetail } from "../../../src/tui/native-renderer/types.js";
import {
  internalCreateOhmNativeToolDetailCache,
  internalPrewarmOhmNativeToolDetail,
  projectOhmNativeFrame,
  projectOhmNativeTranscriptEntries,
  OhmNativeView,
  type OhmNativeViewProps,
} from "../../../src/tui/native-renderer/view.js";
import { terminalPattern } from "../../../src/tui/terminal-pattern.js";
import { createTheme, type Theme } from "../../../src/tui/theme.js";

const themeDefinition = {
  schemaVersion: 1 as const,
  name: "native-view",
  base: "dark" as const,
  styles: {
    accent: { foreground: 196 },
    border: { foreground: 33 },
    userMessage: { foreground: 15, background: 22 },
    toolPending: { foreground: 244, background: 236 },
    toolRunning: { foreground: 208, background: 235 },
    toolSuccess: { foreground: 46, background: 22 },
    toolError: { foreground: 196, background: 52 },
  },
};

function selectedTheme(color: boolean): Theme {
  return createTheme("native-view", { color, unicode: true }, themeDefinition);
}

const snapshot: OhmTuiSnapshot = {
  transcript: [
    { id: "user", kind: "user", text: "Check the renderer and keep it stable." },
    { id: "assistant", kind: "assistant", text: "I will inspect the active state." },
    { id: "thinking", kind: "thinking", status: "active", text: "Checking the current frame." },
    { id: "pending", kind: "tool", name: "read", status: "pending", summary: "Waiting for a slot" },
    {
      id: "running",
      kind: "tool",
      name: "bash",
      status: "running",
      summary: "Focused checks",
      details: [{ kind: "progress", label: "Progress", value: "line one\nline two", preview: true }],
    },
    { id: "done", kind: "tool", name: "edit", status: "completed", summary: "Two files" },
    {
      id: "failed",
      kind: "tool",
      name: "write",
      status: "error",
      state: "failed · exit 1",
      summary: "Unavailable",
      details: [{ kind: "error", label: "Error", value: "denied", preview: true }],
    },
    { id: "notice", kind: "notice", tone: "warning", label: "Catalog", text: "temporarily unavailable" },
  ],
  queuedMessages: [{ id: "queued", text: "Run the narrow check next." }],
  composer: { value: "Add an update test.", cursor: 7, prompt: "What next?", mode: "manual" },
  status: { connection: "connected", model: "model-x", reasoning: "max", activity: "testing" },
  telemetry: {
    contextTokens: 47_200,
    contextWindowTokens: 100_000,
    inputTokens: 12_400,
    outputTokens: 860,
    cacheReadTokens: 11_000,
    cacheWriteTokens: 800,
    cacheHitPercent: 91,
    cost: 0.125,
    subscription: true,
  },
};

function props(columns: number, theme?: Theme): OhmNativeViewProps {
  const base: OhmNativeViewProps = {
    snapshot,
    columns,
    thinkingExpanded: true,
    toolDetailsExpanded: false,
    editorPaddingX: 2,
  };
  return theme === undefined ? base : { ...base, theme };
}

const exactFrame = [
  "",
  " Check the renderer and keep it stable.",
  "",
  "",
  "I will inspect the active state.",
  "",
  "✦ Thinking",
  "  Checking the current frame.",
  "",
  "○ read · pending",
  "  ↳ Waiting for a slot",
  "● bash · running",
  "  ↳ Focused checks",
  "  ↳ Progress",
  "    line one",
  "    line two",
  "✓ edit · done",
  "  ↳ Two files",
  "× write · failed · exit 1",
  "  ↳ Unavailable",
  "  ↳ Error",
  "    denied",
  "",
  "! warning Catalog",
  "  temporarily unavailable",
  "",
  "Queued · 1",
  "  Run the narrow check next.",
  "",
  "─ Ask ohm · manual ────────────────────",
  "  What next?",
  "  › Add an update test.",
  "───────────────────────────────────────",
  "",
  "● connected · model-x · max · testing",
  "  ctx 47.2%/100k · in 12k · out 860",
  "  R11k · W800 · cache hit 91.0%",
  "  $0.125 (sub)",
].join("\n");

const exactThemedFrame = [
  " ".repeat(40),
  " Check the renderer and keep it stable. ",
  " ".repeat(40),
  "",
  "I will inspect the active state.",
  "",
  "◆ Thinking",
  "  Checking the current frame.",
  "",
  "… read · pending".padEnd(40),
  "  ↳ Waiting for a slot".padEnd(40),
  "▸ bash · running".padEnd(40),
  "  ↳ Focused checks".padEnd(40),
  "  ↳ Progress".padEnd(40),
  "    line one".padEnd(40),
  "    line two".padEnd(40),
  "✓ edit · done".padEnd(40),
  "  ↳ Two files".padEnd(40),
  "✗ write · failed · exit 1",
  "  ↳ Unavailable",
  "  ↳ Error",
  "    denied",
  "",
  "! warning Catalog",
  "  temporarily unavailable",
  "",
  "Queued · 1",
  "  Run the narrow check next.",
  "",
  "─ Ask ohm · manual ────────────────────",
  "  What next?",
  "  › Add an update test.",
  "───────────────────────────────────────",
  "",
  "✓ connected · model-x · max · testing",
  "  ctx 47.2%/100k · in 12k · out 860",
  "  R11k · W800 · cache hit 91.0%",
  "  $0.125 (sub)",
].join("\n");

test("native view projects the exact visible frame and composer geometry", () => {
  const projected = projectOhmNativeFrame(props(40));
  assert.equal(projected.text, exactFrame);
  assert.deepEqual(projected.cursor, { row: 32, column: 12 });
  assert.deepEqual(projected.composer, { top: 29, bottom: 33 });
});

test("native view keeps narrow projections bounded and marker-free", () => {
  for (const columns of [1, 2, 8, 12, 40]) {
    const projected = projectOhmNativeFrame(props(columns));
    const rows = projected.text.split("\n");
    assert.ok(projected.cursor.row >= 1 && projected.cursor.row <= rows.length, `cursor row at ${columns}`);
    assert.ok(projected.cursor.column >= 1 && projected.cursor.column <= columns, `cursor column at ${columns}`);
    assert.ok(projected.composer.top >= 0, `composer top at ${columns}`);
    assert.ok(projected.composer.bottom <= rows.length, `composer bottom at ${columns}`);
    assert.ok(projected.cursor.row - 1 >= projected.composer.top, `cursor before composer at ${columns}`);
    assert.ok(projected.cursor.row - 1 < projected.composer.bottom, `cursor after composer at ${columns}`);
    assert.doesNotMatch(projected.text, /[\u2061\u2062\u2063\ue000]/u);
    for (const row of rows) assert.ok(cellWidth(row) <= columns, `width ${columns}: ${row}`);
  }
});

test("native thinking entries override the global expansion fallback independently", () => {
  const blocks = projectOhmNativeTranscriptEntries({
    snapshot: {
      transcript: [
        { id: "thinking-a", kind: "thinking", status: "completed", text: "hidden first body", expanded: false },
        { id: "thinking-b", kind: "thinking", status: "completed", text: "visible second body", expanded: true },
      ],
      queuedMessages: [],
      composer: { value: "" },
      status: { connection: "connected" },
      telemetry: {},
    },
    columns: 40,
    thinkingExpanded: true,
  });
  assert.ok(blocks);
  assert.equal(blocks.length, 2);
  assert.doesNotMatch(stripAnsi(blocks[0]!.join("\n")), /hidden first body/u);
  assert.match(stripAnsi(blocks[1]!.join("\n")), /visible second body/u);
});

test("native color projection preserves exact visible geometry and semantic roles", () => {
  const theme = selectedTheme(true);
  const projected = projectOhmNativeFrame(props(40, theme));
  assert.equal(stripAnsi(projected.text), exactThemedFrame);
  assert.deepEqual(projected.cursor, { row: 32, column: 12 });
  assert.deepEqual(projected.composer, { top: 29, bottom: 33 });
  assert.match(projected.text, terminalPattern("\\u001b\\[38;5;15m\\u001b\\[48;5;22m", "u"));
  assert.match(projected.text, terminalPattern("\\u001b\\[38;5;196m", "u"));
  assert.match(projected.text, terminalPattern("\\u001b\\[38;5;33m", "u"));
});

test("failed tool headers remain foreground-only for built-in and generic tools", () => {
  const theme = createTheme("native-view-errors", { color: true, unicode: true }, {
    ...themeDefinition,
    name: "native-view-errors",
    styles: {
      ...themeDefinition.styles,
      toolError: { foreground: 196, background: 52 },
      error: { foreground: 197, background: 88 },
    },
  });
  const failed: OhmTuiSnapshot = {
    transcript: ["read", "write", "bash", "custom"].map((name, index) => ({
      id: `failed-${index}`,
      kind: "tool" as const,
      name,
      status: "error" as const,
      state: "failed · exit 1",
    })),
    queuedMessages: [],
    composer: { value: "" },
    status: { connection: "connected" },
    telemetry: {},
  };
  const lines = projectOhmNativeFrame({ snapshot: failed, columns: 40, theme }).text.split("\n")
    .filter((line) => stripAnsi(line).includes("failed · exit 1"));
  assert.equal(lines.length, 4);
  for (const line of lines) {
    assert.match(line, terminalPattern("\\u001b\\[38;5;197m", "u"));
    assert.doesNotMatch(line, terminalPattern("\\u001b\\[(?:[^m;]+;)*48;", "u"));
  }
});

test("native tool blocks use neutral live backgrounds, success backgrounds, and background-free failures", () => {
  const theme = selectedTheme(true);
  const builtInsAndUnknown = [
    "read",
    "bash",
    "shell",
    "edit",
    "write",
    "grep",
    "find",
    "ls",
    "apply_patch",
    "extension.unknown",
  ];
  const toolSnapshot: OhmTuiSnapshot = {
    transcript: [
      { id: "pending", kind: "tool", name: "read", status: "pending", headline: "queued" },
      { id: "running", kind: "tool", name: "bash", status: "running", headline: "working" },
      ...builtInsAndUnknown.map((name, index) => ({
        id: `complete-${index}`,
        kind: "tool" as const,
        name,
        status: "completed" as const,
        headline: "finished",
      })),
      { id: "failed", kind: "tool", name: "write", status: "error", headline: "denied" },
    ],
    queuedMessages: [],
    composer: { value: "" },
    status: { connection: "connected" },
    telemetry: {},
  };

  for (const columns of [1, 2, 8, 32]) {
    const blocks = projectOhmNativeTranscriptEntries({ snapshot: toolSnapshot, columns, theme });
    assert.ok(blocks[0]!.every((line) => line.includes(theme.getBgAnsi("toolPendingBg"))));
    assert.ok(blocks[1]!.every((line) => line.includes(theme.getBgAnsi("toolPendingBg"))));
    for (const block of blocks.slice(2, -1)) {
      assert.ok(block.every((line) => line.includes(theme.getBgAnsi("toolSuccessBg"))));
      assert.ok(block.every((line) => cellWidth(line) === columns));
    }
    const failure = blocks.at(-1)!;
    assert.ok(failure.every((line) => !line.includes(theme.getBgAnsi("toolPendingBg"))));
    assert.ok(failure.every((line) => !line.includes(theme.getBgAnsi("toolSuccessBg"))));
    assert.ok(failure.every((line) => !line.includes(theme.getBgAnsi("toolErrorBg"))));
  }
});

test("native transcript compacts consecutive tools without merging retained identities", () => {
  const compactSnapshot: OhmTuiSnapshot = {
    transcript: [
      { id: "read", kind: "tool", name: "read", status: "completed" },
      { id: "write", kind: "tool", name: "write", status: "completed" },
      { id: "answer", kind: "assistant", text: "Both calls completed." },
      { id: "grep", kind: "tool", name: "grep", status: "completed" },
    ],
    queuedMessages: [],
    composer: { value: "" },
    status: { connection: "connected" },
    telemetry: {},
  };
  const initial: OhmNativeViewProps = { snapshot: compactSnapshot, columns: 32 };
  const view = new OhmNativeView(initial);
  const text = stripAnsi(view.project().text);
  assert.match(text, /✓ read · done\n✓ write · done\n\nBoth calls completed\.\n\n✓ grep · done/u);
  assert.deepEqual(view.transcriptRenderCounts(), [1, 1, 1, 1]);

  view.update({
    ...initial,
    snapshot: {
      ...compactSnapshot,
      transcript: compactSnapshot.transcript.map((entry) => entry.id === "write"
        ? { ...entry, state: "done · 1ms" }
        : entry),
    },
  });
  view.project();
  assert.deepEqual(view.transcriptRenderCounts(), [1, 2, 1, 1]);
});

test("native tool components retain identity while their live background becomes successful", () => {
  const theme = selectedTheme(true);
  const running: OhmTuiSnapshot = {
    transcript: [{ id: "call", kind: "tool", name: "bash", status: "running", state: "running" }],
    queuedMessages: [],
    composer: { value: "" },
    status: { connection: "connected" },
    telemetry: {},
  };
  const view = new OhmNativeView({ snapshot: running, columns: 30, theme });
  const live = view.projectTranscriptEntries()[0]!;
  assert.deepEqual(view.transcriptRenderCounts(), [1]);
  assert.ok(live.every((line) => line.includes(theme.getBgAnsi("toolPendingBg"))));

  view.update({
    snapshot: {
      ...running,
      transcript: [{ id: "call", kind: "tool", name: "bash", status: "completed", state: "done · 12ms" }],
    },
    columns: 30,
    theme,
  });
  const complete = view.projectTranscriptEntries()[0]!;
  assert.deepEqual(view.transcriptRenderCounts(), [2]);
  assert.ok(complete.every((line) => line.includes(theme.getBgAnsi("toolSuccessBg"))));
});

test("native transcript batch projection returns exact independent entry blocks", () => {
  assert.deepEqual(projectOhmNativeTranscriptEntries(props(40, selectedTheme(false))), [
    ["", " Check the renderer and keep it stable.", ""],
    ["I will inspect the active state."],
    ["◆ Thinking", "  Checking the current frame."],
    ["… read · pending", "  ↳ Waiting for a slot"],
    [
      "▸ bash · running",
      "  ↳ Focused checks",
      "  ↳ Progress",
      "    line one",
      "    line two",
    ],
    ["✓ edit · done", "  ↳ Two files"],
    [
      "✗ write · failed · exit 1",
      "  ↳ Unavailable",
      "  ↳ Error",
      "    denied",
    ],
    ["! warning Catalog", "  temporarily unavailable"],
  ]);
});

test("native tool detail prewarming populates the exact width-keyed render cache", () => {
  const cache = internalCreateOhmNativeToolDetailCache();
  const isolated = internalCreateOhmNativeToolDetailCache();
  const detail: OhmTuiToolDetail = {
    kind: "source",
    label: "Source",
    value: `native-prewarm-cache-sentinel ${"x".repeat(180)}`,
  };
  assert.equal(internalPrewarmOhmNativeToolDetail(detail, 54, "", cache), true);
  assert.equal(internalPrewarmOhmNativeToolDetail(detail, 54, "", cache), false);
  assert.equal(internalPrewarmOhmNativeToolDetail(detail, 55, "", cache), true);
  assert.equal(internalPrewarmOhmNativeToolDetail(detail, 54, "", isolated), true);

  const frame = stripAnsi(projectOhmNativeFrame({
    snapshot: {
      transcript: [{ id: "prewarmed", kind: "tool", name: "write", status: "completed", details: [detail], expanded: true }],
      queuedMessages: [],
      composer: { value: "" },
      status: { connection: "connected" },
      telemetry: {},
    },
    columns: 54,
  }, cache).text);
  assert.match(frame, /native-prewarm-cache-sentinel/u);
  assert.equal(internalPrewarmOhmNativeToolDetail(detail, 54, "", cache), false);
  cache.clear();
  assert.equal(internalPrewarmOhmNativeToolDetail(detail, 54, "", cache), true);
  assert.equal(internalPrewarmOhmNativeToolDetail(detail, 54, "", isolated), false);
});

test("controller-scoped native view retains unchanged transcript components", () => {
  const initial = props(40, selectedTheme(false));
  const view = new OhmNativeView(initial);
  view.project();
  const first = view.transcriptRenderCounts();
  assert.deepEqual(first, Array.from({ length: snapshot.transcript.length }, () => 1));

  view.update({
    ...initial,
    snapshot: {
      ...snapshot,
      composer: { ...snapshot.composer, value: "Only the composer changed." },
    },
  });
  view.project();
  assert.deepEqual(view.transcriptRenderCounts(), first);

  view.update({
    ...initial,
    snapshot: {
      ...snapshot,
      transcript: snapshot.transcript.map((entry) => entry.id === "assistant"
        ? { ...entry, text: "Only this retained entry changed." }
        : entry),
    },
  });
  view.project();
  const changed = [...first];
  changed[1] = 2;
  assert.deepEqual(view.transcriptRenderCounts(), changed);
});
