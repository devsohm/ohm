import assert from "node:assert/strict";
import test from "node:test";

import { cellWidth, stripAnsi } from "@ohm/terminal";

import { normalizeOhmTuiSnapshot } from "../../../src/tui/native-renderer/snapshot.js";
import type { OhmTuiSnapshot } from "../../../src/tui/native-renderer/types.js";
import { projectOhmNativeFrame } from "../../../src/tui/native-renderer/view.js";
import { terminalPattern } from "../../../src/tui/terminal-pattern.js";
import { createTheme, type Theme } from "../../../src/tui/theme.js";

function rendered(
  snapshot: OhmTuiSnapshot,
  columns: number,
  options: {
    readonly thinkingExpanded?: boolean;
    readonly toolDetailsExpanded?: boolean;
    readonly composerRows?: number;
    readonly promptRows?: number;
    readonly queueRows?: number;
    readonly editorPaddingX?: number;
    readonly theme?: Theme;
    readonly unicode?: boolean;
  } = {},
): string {
  return projectOhmNativeFrame({ snapshot, columns, ...options }).text;
}

const ordinarySnapshot: OhmTuiSnapshot = {
  transcript: [
    { id: "user-1", kind: "user", text: "Check the renderer." },
    { id: "assistant-1", kind: "assistant", text: "I will inspect the active state." },
    { id: "user-2", kind: "user", text: "Keep the update stable." },
    { id: "thinking-old", kind: "thinking", status: "completed", text: "Located the rendering boundary." },
    { id: "thinking-live", kind: "thinking", status: "active", text: "Checking the current frame." },
    { id: "tool-pending", kind: "tool", name: "read", status: "pending", summary: "Waiting for a slot" },
    { id: "tool-running", kind: "tool", name: "test", status: "running", summary: "Focused checks", input: "npm test", output: "still running" },
    { id: "tool-done", kind: "tool", name: "inspect", status: "completed", summary: "Two files" },
    { id: "tool-error", kind: "tool", name: "probe", status: "error", summary: "Unavailable" },
    { id: "assistant-2", kind: "assistant", text: "The first pass is ready." },
  ],
  queuedMessages: [{ id: "queue-1", text: "Run the narrow check next." }],
  composer: { value: "Add an update test.", mode: "manual" },
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

test("native renderer renders the exact ordinary-width frame", () => {
  assert.equal(rendered(ordinarySnapshot, 72), [
    "",
    " Check the renderer.",
    "",
    "",
    "I will inspect the active state.",
    "",
    "",
    " Keep the update stable.",
    "",
    "",
    "◇ Thinking",
    "",
    "✦ Thinking",
    "",
    "○ read · pending",
    "  ↳ Waiting for a slot",
    "● test · running",
    "  ↳ Focused checks",
    "  … Ctrl+O details",
    "✓ inspect · done",
    "  ↳ Two files",
    "× probe · failed",
    "  ↳ Unavailable",
    "",
    "The first pass is ready.",
    "",
    "Queued · 1",
    "  Run the narrow check next.",
    "",
  "─ Ask ohm · manual ────────────────────────────────────────────────────",
    "› Add an update test.",
    "───────────────────────────────────────────────────────────────────────",
    "",
    "● connected · model-x · max · testing",
    "  ctx 47.2%/100k · in 12k · out 860 · R11k · W800 · cache hit 91.0%",
    "  $0.125 (sub)",
  ].join("\n"));
});

test("native renderer renders the exact narrow frame without overflowing", () => {
  const snapshot: OhmTuiSnapshot = {
    transcript: [
      { id: "user-narrow", kind: "user", text: "tiny frame" },
      { id: "thinking-narrow", kind: "thinking", status: "active", text: "still safe" },
      { id: "tool-narrow", kind: "tool", name: "read", status: "completed", summary: "one file" },
    ],
    queuedMessages: [],
    composer: { value: "go", label: "Prompt" },
    status: { connection: "connected" },
    telemetry: { inputTokens: 12, outputTokens: 3, cacheReadTokens: 8, cacheHitPercent: 50 },
  };
  const frame = rendered(snapshot, 12, { thinkingExpanded: true });
  assert.equal(frame, [
    "",
    " tiny frame",
    "",
    "",
    "✦ Thinking",
    "  still safe",
    "",
    "✓ read",
    "  done",
    "  ↳ one file",
    "",
    "─ Prompt ──",
    "› go",
    "───────────",
    "",
    "● connected",
    "  in 12",
    "  out 3",
    "  R8",
    "  cache hit",
    "  50.0%",
  ].join("\n"));
  for (const line of frame.split("\n")) assert.ok(line.length <= 12, line);
});

test("cache hit telemetry renders without aggregate cache counters", () => {
  const snapshot: OhmTuiSnapshot = {
    transcript: [],
    queuedMessages: [],
    composer: { value: "" },
    status: { connection: "connected" },
    telemetry: { cacheHitPercent: 0 },
  };

  assert.match(rendered(snapshot, 40), /cache hit 0\.0%/u);
});

test("notice rows render exact distinct status, warning, and error tones", () => {
  const theme = createTheme("notice-tones", { color: true, unicode: true }, {
    schemaVersion: 1,
    name: "notice-tones",
    base: "dark",
    styles: {
      muted: { foreground: 244 },
      assistant: { foreground: 252 },
      warning: { foreground: 220 },
      error: { foreground: 196 },
      border: { foreground: 33 },
      success: { foreground: 46 },
    },
  });
  const snapshot: OhmTuiSnapshot = {
    transcript: [
      { id: "status", kind: "notice", tone: "status", text: "Ready" },
      { id: "warning", kind: "notice", tone: "warning", text: "Interrupted" },
      { id: "error", kind: "notice", tone: "error", text: "Request failed" },
    ],
    queuedMessages: [],
    composer: { value: "", label: "Prompt" },
    status: { connection: "connected" },
    telemetry: {},
  };
  const frame = rendered(snapshot, 40, { theme });
  assert.equal(stripAnsi(frame), [
    "… Ready",
    "",
    "! warning Interrupted",
    "",
    "✗ error Request failed",
    "",
    "─ Prompt ──────────────────────────────",
    "› ",
    "───────────────────────────────────────",
    "",
    "✓ connected",
  ].join("\n"));
  const lines = frame.split("\n");
  assert.ok(lines[0]?.includes(theme.getFgAnsi("muted")));
  assert.ok(lines[2]?.includes(theme.getFgAnsi("warning")));
  assert.ok(lines[4]?.includes(theme.getFgAnsi("error")));
});

test("retained notices keep unlabeled text inline and labeled bodies below their heading", () => {
  const snapshot: OhmTuiSnapshot = {
    transcript: [
      { id: "inline", kind: "notice", tone: "status", text: "Inline body" },
      { id: "labeled", kind: "notice", tone: "warning", label: "Provider warning", text: "Labeled body" },
    ],
    queuedMessages: [],
    composer: { value: "", label: "Prompt" },
    status: { connection: "connected" },
    telemetry: {},
  };
  const frame = stripAnsi(rendered(snapshot, 40));
  assert.match(frame, /^○ Inline body$/mu);
  assert.match(frame, /^! warning Provider warning\n  Labeled body$/mu);
});

test("thinking and tool details project independently", () => {
  const snapshot: OhmTuiSnapshot = {
    transcript: [
      { id: "done", kind: "thinking", status: "completed", text: "Past reasoning." },
      { id: "live", kind: "thinking", status: "active", text: "Current reasoning." },
      {
        id: "tool",
        kind: "tool",
        name: "read",
        status: "completed",
        summary: "one file",
        input: "notes.md",
        output: "ready",
      },
    ],
    queuedMessages: [],
    composer: { value: "", label: "Prompt" },
    status: { connection: "connected" },
    telemetry: {},
  };
  const collapsed = [
    "◇ Thinking",
    "",
    "✦ Thinking",
    "",
    "✓ read · done",
    "  ↳ one file",
    "  … Ctrl+O details",
    "",
    "─ Prompt ──────────────────────────────",
    "› ",
    "───────────────────────────────────────",
    "",
    "● connected",
  ].join("\n");
  assert.equal(rendered(snapshot, 40), collapsed);

  assert.equal(rendered(snapshot, 40, { thinkingExpanded: true }), [
    "◇ Thinking",
    "  Past reasoning.",
    "",
    "✦ Thinking",
    "  Current reasoning.",
    "",
    "✓ read · done",
    "  ↳ one file",
    "  … Ctrl+O details",
    "",
    "─ Prompt ──────────────────────────────",
    "› ",
    "───────────────────────────────────────",
    "",
    "● connected",
  ].join("\n"));

  assert.equal(rendered(snapshot, 40, { thinkingExpanded: true, toolDetailsExpanded: true }), [
    "◇ Thinking",
    "  Past reasoning.",
    "",
    "✦ Thinking",
    "  Current reasoning.",
    "",
    "✓ read · done",
    "  ↳ one file",
    "  ↳ Input",
    "    notes.md",
    "  ↳ Output",
    "    ready",
    "  … Ctrl+O collapse",
    "",
    "─ Prompt ──────────────────────────────",
    "› ",
    "───────────────────────────────────────",
    "",
    "● connected",
  ].join("\n"));

  assert.equal(rendered(snapshot, 40, { toolDetailsExpanded: true }), [
    "◇ Thinking",
    "",
    "✦ Thinking",
    "",
    "✓ read · done",
    "  ↳ one file",
    "  ↳ Input",
    "    notes.md",
    "  ↳ Output",
    "    ready",
    "  … Ctrl+O collapse",
    "",
    "─ Prompt ──────────────────────────────",
    "› ",
    "───────────────────────────────────────",
    "",
    "● connected",
  ].join("\n"));
});

test("tool-detail row budgets retain useful heads and tails with exact omission counts", () => {
  const value = Array.from({ length: 8 }, (_, index) => `row-${index + 1}`).join("\n");
  const snapshot: OhmTuiSnapshot = {
    transcript: [{
      id: "tool",
      kind: "tool",
      name: "read",
      status: "completed",
      details: [
        { kind: "output", label: "Head", value, preview: true },
        { kind: "progress", label: "Tail", value, preview: true, tail: true },
      ],
    }],
    queuedMessages: [],
    composer: { value: "", label: "Prompt" },
    status: { connection: "connected" },
    telemetry: {},
  };
  const frame = stripAnsi(rendered(snapshot, 40));

  assert.match(frame, /Head\n    row-1\n    row-2\n    row-3\n    … 5 more rows/u);
  assert.match(frame, /Tail\n    … earlier 5 rows hidden\n    row-6\n    row-7\n    row-8/u);
  assert.doesNotMatch(frame, /row-4|row-5/u);
});

test("maximum native tool details remain bounded and deterministic at one- and two-cell widths", { timeout: 5_000 }, () => {
  const framingBytes = Buffer.byteLength("Q\n\nZ");
  const value = `Q\n${"x".repeat((128 * 1024) - framingBytes)}\nZ`;
  assert.equal(Buffer.byteLength(value), 128 * 1024);
  const snapshot: OhmTuiSnapshot = {
    transcript: [{
      id: "tool",
      kind: "tool",
      name: "t",
      status: "completed",
      details: [
        { kind: "output", label: "a", value, preview: true },
        { kind: "progress", label: "b", value, preview: true, tail: true },
      ],
    }],
    queuedMessages: [],
    composer: { value: "", label: "p" },
    status: { connection: "connected" },
    telemetry: {},
  };

  for (const columns of [1, 2]) {
    const first = projectOhmNativeFrame({ snapshot, columns, toolDetailsExpanded: true });
    const second = projectOhmNativeFrame({ snapshot, columns, toolDetailsExpanded: true });
    assert.equal(second.text, first.text, `deterministic width ${columns}`);
    const lines = stripAnsi(first.text).split("\n");
    assert.ok(lines.length <= 400, `bounded width ${columns}: ${lines.length} rows`);
    assert.ok(lines.includes("Q"), `head retained at width ${columns}`);
    assert.ok(lines.includes("Z"), `tail retained at width ${columns}`);
    for (const line of lines) assert.ok(cellWidth(line) <= columns, `width ${columns}: ${line}`);
  }
});

test("maximum retained notices and Markdown cards stay prebounded at one- and two-cell widths", { timeout: 5_000 }, () => {
  const framingBytes = Buffer.byteLength("Q\n\nZ");
  const value = `Q\n${"x".repeat((128 * 1024) - framingBytes)}\nZ`;
  const markdownValue = `M${"\n".repeat((128 * 1024) - 2)}Y`;
  assert.equal(Buffer.byteLength(value), 128 * 1024);
  assert.equal(Buffer.byteLength(markdownValue), 128 * 1024);
  const snapshot: OhmTuiSnapshot = {
    transcript: [{
      id: "notice",
      kind: "notice",
      tone: "warning",
      label: "retained",
      text: value,
      expandable: true,
      expanded: true,
    }, {
      id: "card",
      kind: "tool",
      name: "skill",
      status: "completed",
      expanded: true,
      details: [{ kind: "source", label: "Instructions", value: markdownValue, markdown: true }],
    }],
    queuedMessages: [],
    composer: { value: "", label: "p" },
    status: { connection: "connected" },
    telemetry: {},
  };

  for (const columns of [1, 2]) {
    const first = projectOhmNativeFrame({ snapshot, columns, toolDetailsExpanded: true });
    const second = projectOhmNativeFrame({ snapshot, columns, toolDetailsExpanded: true });
    assert.equal(second.text, first.text, `deterministic width ${columns}`);
    const lines = stripAnsi(first.text).split("\n");
    assert.ok(lines.length <= 320, `bounded width ${columns}: ${lines.length} rows`);
    assert.ok(lines.includes("Q"), `head retained at width ${columns}`);
    assert.ok(lines.includes("Z"), `tail retained at width ${columns}`);
    assert.ok(lines.includes("M"), `Markdown head retained at width ${columns}`);
    assert.ok(lines.includes("Y"), `Markdown tail retained at width ${columns}`);
    for (const line of lines) assert.ok(cellWidth(line) <= columns, `width ${columns}: ${line}`);
  }
});

test("stable IDs update thinking and tools in place", () => {
  const initial: OhmTuiSnapshot = {
    transcript: [
      { id: "user", kind: "user", text: "Run it." },
      { id: "thinking", kind: "thinking", status: "active", text: "First thought" },
      { id: "tool", kind: "tool", name: "test", status: "running", summary: "Working", input: "source input", output: "old output" },
      { id: "notice", kind: "notice", tone: "status", text: "Waiting" },
    ],
    queuedMessages: [],
    composer: { value: "" },
    status: { connection: "connected" },
    telemetry: {},
  };
  assert.doesNotMatch(rendered(initial, 48), /source input|old output/u);
  const updated: OhmTuiSnapshot = {
    ...initial,
    transcript: [
      { id: "user", kind: "user", text: "Run it." },
      { id: "thinking", kind: "thinking", status: "completed", text: "Final thought" },
      { id: "tool", kind: "tool", name: "test", status: "completed", summary: "Passed", input: "source input", output: "new output" },
      { id: "notice", kind: "notice", tone: "warning", text: "Interrupted" },
      { id: "assistant", kind: "assistant", text: "Checks passed." },
    ],
  };
  const compact = rendered(updated, 48);
  assert.equal(compact.match(/Thinking/gu)?.length, 1);
  assert.equal(compact.match(/Interrupted/gu)?.length, 1);
  assert.doesNotMatch(compact, /Final thought/u);
  assert.doesNotMatch(compact, /First thought|old output|Waiting/u);

  const expanded = rendered(updated, 48, { toolDetailsExpanded: true });
  assert.doesNotMatch(expanded, /Final thought/u);
  assert.match(expanded, /Input[\s\S]*source input[\s\S]*Output[\s\S]*new output/u);
});

test("normalization sanitizes terminal text, retains history, and replaces duplicate stable IDs", () => {
  const normalized = normalizeOhmTuiSnapshot({
    ...ordinarySnapshot,
    transcript: [
      { id: "past", kind: "thinking", status: "completed", text: "Past" },
      { id: "active", kind: "thinking", status: "active", text: "Old fragment" },
      { id: "active", kind: "thinking", status: "active", text: "New\u001b]2;owned\u0007 fragment" },
      { id: "user", kind: "user", text: "safe\u001b[31m red\u001b[0m" },
      { id: "notice", kind: "notice", tone: "status", text: "Old notice" },
      { id: "notice", kind: "notice", tone: "warning", text: "Interrupted\u001b]2;owned\u0007\nnow" },
    ],
  });

  assert.deepEqual(normalized.transcript, [
    { id: "past", kind: "thinking", status: "completed", text: "Past" },
    { id: "active", kind: "thinking", status: "active", text: "New fragment" },
    { id: "user", kind: "user", text: "safe red" },
    { id: "notice", kind: "notice", tone: "warning", text: "Interrupted\nnow" },
  ]);

  const retainedNotice = `first diagnostic row\n${"x".repeat(4_096)}\nlast diagnostic row`;
  const bounded = normalizeOhmTuiSnapshot({
    ...ordinarySnapshot,
    transcript: [{ id: "notice", kind: "notice", tone: "status", text: retainedNotice }],
  }).transcript[0];
  assert.equal(bounded?.kind, "notice");
  assert.equal(bounded.text, retainedNotice);
  assert.ok(Buffer.byteLength(bounded.text) > 512);
  assert.ok(Buffer.byteLength(bounded.text) <= 128 * 1_024);

  const clipped = normalizeOhmTuiSnapshot({
    ...ordinarySnapshot,
    transcript: [{ id: "notice", kind: "notice", tone: "error", text: "z".repeat(160 * 1_024) }],
  }).transcript[0];
  assert.equal(clipped?.kind, "notice");
  assert.equal(Buffer.byteLength(clipped.text), 128 * 1_024);
  assert.equal(clipped.truncated, true);

  const telemetry = normalizeOhmTuiSnapshot({
    ...ordinarySnapshot,
    telemetry: {
      cacheReadTokens: Number.NaN,
      cacheWriteTokens: -2,
      cacheHitPercent: 101,
      cost: Number.POSITIVE_INFINITY,
      subscription: true,
    },
  }).telemetry;
  assert.deepEqual(telemetry, {
    cacheWriteTokens: 0,
    cacheHitPercent: 100,
    subscription: true,
  });
});

test("every user message keeps the exact full-width padded color treatment", () => {
  const theme = createTheme("user-message-rows", { color: true, unicode: true }, {
    schemaVersion: 1,
    name: "user-message-rows",
    base: "dark",
    styles: {
      userMessage: { foreground: 255, background: 236 },
    },
  });
  const snapshot: OhmTuiSnapshot = {
    transcript: [
      { id: "first", kind: "user", text: "one" },
      { id: "reply", kind: "assistant", text: "between" },
      { id: "second", kind: "user", text: "two" },
    ],
    queuedMessages: [],
    composer: { value: "" },
    status: { connection: "connected" },
    telemetry: {},
  };
  const frame = rendered(snapshot, 20, { theme });
  const coloredRows = frame.split("\n").filter((line) => (
    line.includes(theme.getFgAnsi("userMessageText"))
    && line.includes(theme.getBgAnsi("userMessageBg"))
  ));
  assert.equal(coloredRows.length, 6);
  assert.deepEqual(coloredRows.map(stripAnsi), [
    " ".repeat(20),
    " one".padEnd(20),
    " ".repeat(20),
    " ".repeat(20),
    " two".padEnd(20),
    " ".repeat(20),
  ]);
});

test("the pure frame projector returns one-based composer cursor coordinates", () => {
  const snapshot: OhmTuiSnapshot = {
    transcript: [],
    queuedMessages: [],
    composer: { value: "word next", cursor: 5, label: "Prompt" },
    status: { connection: "connected" },
    telemetry: {},
  };
  const wrapped = projectOhmNativeFrame({ snapshot, columns: 8 });
  assert.deepEqual(wrapped.cursor, { row: 4, column: 1 });
  assert.equal(wrapped.text.split("\n")[2], "› word");
  assert.equal(wrapped.text.split("\n")[3], "next");
  assert.doesNotMatch(wrapped.text, /[\u2063\ue000]/u);

  const fullLine = projectOhmNativeFrame({
    snapshot: { ...snapshot, composer: { value: "abcdef", cursor: 6, label: "Prompt" } },
    columns: 8,
  });
  assert.deepEqual(fullLine.cursor, { row: 4, column: 1 });
  assert.equal(fullLine.text.split("\n")[2], "› abcdef");
  assert.equal(fullLine.text.split("\n")[3], "");

  const wide = projectOhmNativeFrame({
    snapshot: { ...snapshot, composer: { value: "A界🙂 Z", cursor: 3, label: "Prompt" } },
    columns: 20,
  });
  assert.deepEqual(wide.cursor, { row: 3, column: 8 });

  const tiny = projectOhmNativeFrame({
    snapshot: {
      ...snapshot,
      transcript: [{ id: "wide", kind: "user", text: "界" }],
      composer: { value: "🙂", cursor: 1, label: "界" },
    },
    columns: 0,
  });
  assert.ok(tiny.cursor.row >= 1 && tiny.cursor.row <= tiny.text.split("\n").length);
  assert.equal(tiny.cursor.column, 1);
  for (const line of tiny.text.split("\n")) assert.ok(cellWidth(line) <= 1, line);
});

test("a bounded composer keeps a cursor-local draft window inside a 60x12 frame", () => {
  const draftLines = Array.from({ length: 30 }, (_, index) => `draft ${String(index + 1).padStart(2, "0")}`);
  const value = draftLines.join("\n");
  const snapshot: OhmTuiSnapshot = {
    transcript: [],
    queuedMessages: [],
    composer: { value, cursor: value.indexOf("draft 25") + 3, label: "Prompt" },
    status: { connection: "connected" },
    telemetry: {},
  };
  const frame = projectOhmNativeFrame({ snapshot, columns: 60, composerRows: 6 });
  const lines = stripAnsi(frame.text).split("\n");
  const composer = lines.slice(frame.composer.top, frame.composer.bottom);

  assert.ok(lines.length <= 12);
  assert.deepEqual(composer.slice(1, -1), [
    "draft 23",
    "draft 24",
    "draft 25",
    "draft 26",
    "draft 27",
    "draft 28",
  ]);
  assert.ok(frame.cursor.row - 1 >= frame.composer.top);
  assert.ok(frame.cursor.row - 1 < frame.composer.bottom);
  assert.equal(lines[frame.cursor.row - 1], "draft 25");
  assert.equal(frame.cursor.column, 4);
});

test("bounded prompts keep their useful tail and bounded queues keep the latest receipts", () => {
  const prompt = Array.from({ length: 10 }, (_, index) => `prompt ${String(index + 1).padStart(2, "0")}`).join("\n");
  const queuedMessages = Array.from({ length: 100 }, (_, index) => ({
    id: `queued-${index + 1}`,
    text: `message ${String(index + 1).padStart(3, "0")}`,
  }));
  const snapshot: OhmTuiSnapshot = {
    transcript: [],
    queuedMessages,
    composer: { value: "draft", prompt, label: "Prompt" },
    status: { connection: "connected" },
    telemetry: {},
  };
  const frame = projectOhmNativeFrame({
    snapshot,
    columns: 60,
    composerRows: 2,
    promptRows: 4,
    queueRows: 4,
  });
  const text = stripAnsi(frame.text);

  assert.match(text, /Queued · 100 · 96 earlier/u);
  assert.doesNotMatch(text, /message 096/u);
  assert.match(text, /message 097[\s\S]*message 098[\s\S]*message 099[\s\S]*message 100/u);
  assert.doesNotMatch(text, /prompt 06/u);
  assert.match(text, /prompt 07\nprompt 08\nprompt 09\nprompt 10/u);
  assert.equal(frame.composer.bottom - frame.composer.top, 7);
  assert.ok(frame.cursor.row - 1 >= frame.composer.top);
  assert.ok(frame.cursor.row - 1 < frame.composer.bottom);
});

test("bounded projection remains cursor-safe at a one-cell terminal width", () => {
  const snapshot: OhmTuiSnapshot = {
    transcript: [],
    queuedMessages: Array.from({ length: 6 }, (_, index) => ({ id: String(index), text: `界${index}` })),
    composer: { value: "🙂\n界\na", cursor: 2, prompt: "界\n🙂\nz", label: "界" },
    status: { connection: "connected" },
    telemetry: {},
  };
  const frame = projectOhmNativeFrame({
    snapshot,
    columns: 1,
    composerRows: 2,
    promptRows: 2,
    queueRows: 2,
  });
  const lines = stripAnsi(frame.text).split("\n");

  assert.ok(frame.cursor.row >= 1 && frame.cursor.row <= lines.length);
  assert.equal(frame.cursor.column, 1);
  assert.ok(frame.composer.top >= 0 && frame.composer.bottom <= lines.length);
  assert.ok(frame.cursor.row - 1 >= frame.composer.top && frame.cursor.row - 1 < frame.composer.bottom);
  assert.doesNotMatch(frame.text, /[\u2061\u2062\u2063\ue000]/u);
  for (const line of lines) assert.ok(cellWidth(line) <= 1, line);
});

test("composer padding preserves full-width rails and shifts prompt, draft, and cursor", () => {
  const snapshot: OhmTuiSnapshot = {
    transcript: [],
    queuedMessages: [],
    composer: { value: "draft", cursor: 2, prompt: "question", label: "Ask ohm" },
    status: { connection: "connected" },
    telemetry: {},
  };
  const frame = projectOhmNativeFrame({ snapshot, columns: 20, editorPaddingX: 2 });
  const lines = stripAnsi(frame.text).split("\n");
  const composer = lines.slice(frame.composer.top, frame.composer.bottom);

  assert.equal(cellWidth(composer[0] ?? ""), 19);
  assert.equal(cellWidth(composer.at(-1) ?? ""), 19);
  assert.equal(composer[1], "  question");
  assert.equal(composer[2], "  › draft");
  assert.equal(frame.cursor.column, 7);
});

test("a supplied theme owns semantic colors and glyphs while preserving frame geometry", () => {
  const theme = createTheme("native-contract", { color: true, unicode: true }, {
    schemaVersion: 1,
    name: "native-contract",
    base: "dark",
    styles: {
      accent: { foreground: 196 },
      border: { foreground: 33 },
      selection: { foreground: 16, background: 220 },
      userMessage: { foreground: 15, background: 22 },
      toolRunning: { foreground: 208, background: 235 },
    },
  });
  const snapshot: OhmTuiSnapshot = {
    transcript: [
      { id: "user", kind: "user", text: "Inspect it." },
      { id: "thinking", kind: "thinking", status: "active", text: "Checking." },
      { id: "tool", kind: "tool", name: "read", status: "running", summary: "One file" },
    ],
    queuedMessages: [],
    composer: { value: "continue", cursor: 4, label: "Prompt" },
    status: { connection: "connected" },
    telemetry: {},
  };

  for (const columns of [1, 12, 60]) {
    const ordinary = projectOhmNativeFrame({ snapshot, columns });
    const projected = projectOhmNativeFrame({ snapshot, columns, theme, unicode: true });
    assert.deepEqual(projected.cursor, ordinary.cursor, `cursor at width ${columns}`);
    assert.deepEqual(projected.composer, ordinary.composer, `composer at width ${columns}`);
    assert.equal(projected.text.split("\n").length, ordinary.text.split("\n").length);
    for (const line of stripAnsi(projected.text).split("\n")) assert.ok(cellWidth(line) <= columns, line);
  }

  const projected = projectOhmNativeFrame({ snapshot, columns: 60, theme, unicode: true }).text;
  assert.match(projected, terminalPattern("\\u001b\\[38;5;196m◆ Thinking", "u"));
  assert.match(projected, terminalPattern("\\u001b\\[38;5;15m\\u001b\\[48;5;22m Inspect it\\.", "u"));
  assert.match(projected, terminalPattern("\\u001b\\[48;5;235m\\u001b\\[38;5;208m▸", "u"));
  assert.match(projected, terminalPattern("\\u001b\\[38;5;33m─ Prompt", "u"));
});

test("completed tool blocks use the success background with semantic header foregrounds", () => {
  const theme = createTheme("completed-tool", { color: true, unicode: true }, {
    schemaVersion: 1,
    name: "completed-tool",
    base: "dark",
    styles: {
      success: { foreground: 46, background: 22 },
      assistant: { foreground: 252, background: 52 },
      muted: { foreground: 247, background: 53 },
      toolSuccess: { foreground: 255, background: 22 },
    },
  });
  const snapshot: OhmTuiSnapshot = {
    transcript: [{
      id: "completed",
      kind: "tool",
      name: "read",
      status: "completed",
      state: "done · 6ms",
    }],
    queuedMessages: [],
    composer: { value: "" },
    status: { connection: "connected" },
    telemetry: {},
  };

  const header = projectOhmNativeFrame({ snapshot, columns: 60, theme }).text
    .split("\n")
    .find((line) => stripAnsi(line).includes("✓ read · done · 6ms"));
  assert.ok(header);
  assert.match(header, terminalPattern("\\u001b\\[38;5;46m✓", "u"));
  assert.match(header, terminalPattern("\\u001b\\[38;5;252m read", "u"));
  assert.match(header, terminalPattern("\\u001b\\[38;5;247m · done · 6ms", "u"));
  assert.ok(header.includes(theme.getBgAnsi("toolSuccessBg")));
  assert.equal(cellWidth(header), 60);
  assert.doesNotMatch(header, /48;5;(?:52|53)/u);
});

test("failed tool headers and details use error foregrounds without theme backgrounds", () => {
  const theme = createTheme("failed-tools", { color: true, unicode: true }, {
    schemaVersion: 1,
    name: "failed-tools",
    base: "dark",
    styles: {
      error: { foreground: 196, background: 88 },
      toolError: { foreground: 197, background: 52 },
    },
  });
  const background = terminalPattern("\\u001b\\[[0-9;]*(?:4[0-8]|10[0-7])(?:;[0-9;]*)?m", "u");
  const toolNames = [
    "read",
    "write",
    "edit",
    "bash",
    "shell",
    "ls",
    "grep",
    "find",
    "apply_patch",
    "extension.fixture",
  ];

  for (const name of toolNames) {
    const snapshot: OhmTuiSnapshot = {
      transcript: [{
        id: name,
        kind: "tool",
        name,
        status: "error",
        state: "failed · exit 7 · 8ms",
        expanded: true,
        details: [
          { kind: "error", label: "Error", value: `plain failure from ${name}` },
          { kind: "error", label: "Formatted error", value: `**formatted failure from ${name}**`, markdown: true },
          { kind: "diff", label: "Diff", value: "-removed\n+added" },
        ],
      }],
      queuedMessages: [],
      composer: { value: "" },
      status: { connection: "connected" },
      telemetry: {},
    };
    const frame = projectOhmNativeFrame({ snapshot, columns: 80, theme }).text;
    const relevant = frame.split("\n").filter((line) => {
      const plain = stripAnsi(line);
      return plain.includes(`${theme.glyphs.failure} ${name} · failed · exit 7 · 8ms`)
        || plain.includes(`plain failure from ${name}`)
        || plain.includes(`formatted failure from ${name}`)
        || plain.includes("-removed");
    });

    assert.equal(relevant.length, 4, name);
    for (const line of relevant) {
      assert.ok(line.includes(theme.getFgAnsi("error")), name);
      assert.doesNotMatch(line, background, name);
    }
  }
});

test("a no-color ASCII theme emits no ANSI and uses only ASCII renderer chrome", () => {
  const theme = createTheme("signal", { color: false, unicode: false });
  const snapshot: OhmTuiSnapshot = {
    transcript: [
      { id: "user", kind: "user", text: "plain" },
      { id: "thinking", kind: "thinking", status: "active", text: "safe" },
      { id: "tool", kind: "tool", name: "read", status: "completed", summary: "done" },
      {
        id: "markdown-card",
        kind: "tool",
        name: "skill",
        status: "completed",
        expanded: true,
        details: [{ kind: "source", label: "Instructions", value: "Use **safe** `code`.", markdown: true }],
      },
      { id: "notice", kind: "notice", tone: "error", text: "failed" },
    ],
    queuedMessages: [{ id: "queued", text: "later" }],
    composer: { value: "go", mode: "manual" },
    status: { connection: "connected", model: "model" },
    telemetry: { inputTokens: 2, outputTokens: 1, cacheReadTokens: 1, cacheHitPercent: 50 },
  };
  const projected = projectOhmNativeFrame({ snapshot, columns: 60, theme, unicode: false });

  assert.doesNotMatch(projected.text, terminalPattern("\\u001b", "u"));
  assert.match(projected.text, /^A Thinking$/mu);
  assert.match(projected.text, /^\+ read \| done$/mu);
  assert.match(projected.text, /^\+ skill \| done$/mu);
  assert.match(projected.text, /^    Use safe code\.$/mu);
  assert.doesNotMatch(projected.text, /\*\*safe\*\*|`code`/u);
  assert.match(projected.text, /^x error failed$/mu);
  assert.match(projected.text, /^- Ask ohm \| manual -+$/mu);
  assert.match(projected.text, /^> go$/mu);
  assert.match(projected.text, /^\+ connected \| model \| in 2 \| out 1 \| R1 \| cache hit 50\.0%$/mu);
  assert.doesNotMatch(projected.text, /[✦◇○●✓×›─—…·]/u);
});
