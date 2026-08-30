import { terminalPattern } from "../../../src/tui/terminal-pattern.js";
import assert from "node:assert/strict";
import test from "node:test";

import { cellWidth, splitGraphemes, stripAnsi } from "@ohm/terminal";

import {
  createNativeOverlaySnapshot,
  normalizeNativeOverlaySnapshot,
  projectNativeOverlay,
  type NativeOverlaySnapshot,
} from "../../../src/tui/native-renderer/overlay.js";
import { createTheme } from "../../../src/tui/theme.js";
import type { TuiViewState } from "../../../src/tui/types.js";

type ViewOverlay = NonNullable<TuiViewState["overlay"]>;

function plainProjection(
  overlay: ViewOverlay,
  columns: number,
  rows: number,
  queryCursor?: number,
) {
  const snapshot = createNativeOverlaySnapshot(overlay, queryCursor);
  const projected = projectNativeOverlay({ snapshot, columns, rows });
  return { ...projected, text: stripAnsi(projected.text) };
}

test("full-width model picker renders states, filter, selected description, status, hints, and pagination", () => {
  const projected = plainProjection({
    title: "Models",
    pickerKind: "model",
    states: ["available", "all"],
    query: "fix",
    selected: 2,
    items: [
      { id: "a", label: "model-a", detail: "fast", value: 1 },
      { id: "b", label: "model-b", detail: "steady", value: 2 },
      {
        id: "c",
        label: "model-c",
        detail: "balanced",
        description: "Selected model description",
        value: 3,
      },
      { id: "d", label: "model-d", detail: "large", value: 4 },
    ],
    hints: ["↑/↓ navigate · Enter select · Esc cancel"],
    status: "Live catalog",
  }, 42, 14);

  assert.equal(projected.text, [
    "Models                                 3/4",
    "available · all",
    "Live catalog",
    "Filter fix",
    "  model-a",
    "  model-b",
    "› model-c",
    "  model-d",
    "Selected model description",
    "↑/↓ navigate · Enter select · Esc cancel",
  ].join("\n"));
  assert.deepEqual(projected.cursor, { row: 4, column: 11 });
});

test("inline slash completion stays a passive single-column list", () => {
  const projected = plainProjection({
    title: "Commands",
    pickerKind: "command",
    inline: true,
    query: "mod",
    selected: 1,
    items: [
      { id: "login", label: "/login", detail: "Connect a provider", value: 1 },
      { id: "model", label: "/model", detail: "Choose a model", value: 2 },
    ],
  }, 42, 7);

  assert.equal(projected.text, [
    "  /login — Connect a provider",
    "› /model — Choose a model",
    "2/2",
  ].join("\n"));
  assert.equal(projected.cursor, undefined);
  assert.doesNotMatch(projected.text, /[│█╭╮╰╯]/u);
});

test("settings keep selected values and controller-provided description visible", () => {
  const projected = plainProjection({
    title: "Settings",
    settings: true,
    states: ["project"],
    queryLabel: "> ",
    query: "cache",
    selected: 1,
    selectedDescription: "Show the latest cache hit percentage",
    items: [
      { id: "theme", label: "Theme", detail: "system", value: 1 },
      { id: "cache", label: "Cache telemetry", detail: "hit only", value: 2 },
      { id: "thinking", label: "Thinking blocks", detail: "collapsed", value: 3 },
    ],
    hints: ["↑/↓ navigate · Enter next · Esc close"],
    status: "Changes save immediately",
  }, 42, 14);

  assert.equal(projected.text, [
    "Settings                               2/3",
    "project",
    "Changes save immediately",
    "> cache",
    "  Theme                             system",
    "› Cache telemetry                 hit only",
    "  Thinking blocks                collapsed",
    "Show the latest cache hit percentage",
    "↑/↓ navigate · Enter next · Esc close",
  ].join("\n"));
  assert.deepEqual(projected.cursor, { row: 4, column: 8 });
});

test("provider and thinking choices share the bounded full-width picker grammar", () => {
  const providers = plainProjection({
    title: "Providers",
    pickerKind: "provider",
    query: "",
    selected: 0,
    items: [
      { id: "first", label: "provider-a", detail: "configured", value: 1 },
      { id: "second", label: "provider-b", detail: "available", value: 2 },
    ],
    hints: ["Enter select · Esc cancel"],
  }, 42, 8);
  const thinking = plainProjection({
    title: "Thinking level",
    query: "",
    selected: 1,
    items: [
      { id: "off", label: "off", detail: "no reasoning", value: 1 },
      { id: "high", label: "high", detail: "deep reasoning", value: 2 },
      { id: "max", label: "max", detail: "maximum reasoning", value: 3 },
    ],
    hints: ["Enter select · Esc cancel"],
  }, 42, 8);

  assert.equal(providers.text, [
    "Providers                              1/2",
    "Filter",
    "› provider-a — configured",
    "  provider-b — available",
    "Enter select · Esc cancel",
  ].join("\n"));
  assert.equal(thinking.text, [
    "Thinking level                         2/3",
    "Filter",
    "  off — no reasoning",
    "› high — deep reasoning",
    "  max — maximum reasoning",
    "Enter select · Esc cancel",
  ].join("\n"));
  assert.deepEqual(providers.cursor, { row: 2, column: 8 });
  assert.deepEqual(thinking.cursor, { row: 2, column: 8 });
});

test("Atlas window preserves a deeply nested selected row tail without a scrollbar", () => {
  const items: ViewOverlay["items"] = Array.from({ length: 10 }, (_, index) => ({
    id: String(index),
    label: index === 7 ? `● ${"   ".repeat(30)}└─ selected-branch-tail` : `entry-${index}`,
    detail: `kind-${index}`,
    tree: {
      eventId: String(index),
      kind: "user",
      depth: index,
      prefix: "",
      branches: [],
      paths: [],
      active: index === 7,
    },
    value: index,
  }));
  const projected = plainProjection({
    title: "Atlas",
    states: ["all entries", "active path"],
    query: "branch",
    selected: 7,
    items,
    hints: ["Enter open · Left fold · Right unfold", "Ctrl+T path · Esc close"],
    status: "Indexed session",
  }, 42, 12);

  assert.equal(projected.text, [
    "Atlas                                 8/10",
    "all entries · active path",
    "Indexed session",
    "Filter branch",
    "  entry-2 — kind-2",
    "  entry-3 — kind-3",
    "  entry-4 — kind-4",
    "  entry-5 — kind-5",
    "  entry-6 — kind-6",
    "› ● …              └─ selected-branch-tail",
    "Enter open · Left fold · Right unfold",
    "Ctrl+T path · Esc close",
  ].join("\n"));
  assert.match(projected.text, /^› ● ….*selected-branch-tail$/mu);
  assert.doesNotMatch(projected.text, /[│█]/u);
  assert.deepEqual(projected.cursor, { row: 4, column: 14 });
});

test("mid-query grapheme cursor remains exact in a narrow viewport", () => {
  const projected = plainProjection({
    title: "Provider",
    pickerKind: "provider",
    query: "abc界def",
    selected: 0,
    items: [{ id: "provider", label: "provider-one", value: 1 }],
  }, 12, 4, 4);

  assert.equal(projected.text, [
    "Provid…  1/1",
    "Filter …c界d",
    "› provider-…",
  ].join("\n"));
  assert.deepEqual(projected.cursor, { row: 2, column: 12 });
});

test("normalization bounds collections, clamps selection, and sanitizes every text field", () => {
  const unsafe = "safe\u001b]2;owned\u0007\nline\u2063\ue000";
  const source: NativeOverlaySnapshot = {
    title: unsafe,
    pickerKind: "generic",
    inline: false,
    settings: false,
    selectedDescription: unsafe,
    states: Array.from({ length: 40 }, () => unsafe),
    queryLabel: unsafe,
    query: `ab\u001b[31mcd\u001b[0m`,
    queryCursor: splitGraphemes(`ab\u001b[31mcd\u001b[0m`).length,
    selected: Number.POSITIVE_INFINITY,
    items: Array.from({ length: 5_001 }, (_, index) => ({
      id: `${index}${unsafe}`,
      label: unsafe,
      detail: unsafe,
      description: unsafe,
      tree: { active: true },
    })),
    hints: Array.from({ length: 40 }, () => unsafe),
    status: unsafe,
    emptyMessage: unsafe,
    maxVisible: 100,
  };
  const normalized = normalizeNativeOverlaySnapshot(source);
  const serialized = JSON.stringify(normalized);

  assert.equal(normalized.items.length, 5_000);
  assert.equal(normalized.states.length, 32);
  assert.equal(normalized.hints.length, 32);
  assert.equal(normalized.selected, 4_999);
  assert.equal(normalized.maxVisible, 20);
  assert.equal(normalized.query, "abcd");
  assert.equal(normalized.queryCursor, 4);
  assert.doesNotMatch(serialized, terminalPattern("[\\u001b\\u0007\\u2063\\ue000]", "u"));
  assert.doesNotMatch(serialized, /owned/u);
});

test("all supported terminal sizes stay bounded and retain the selected row", () => {
  const snapshot = createNativeOverlaySnapshot({
    title: "Resume Session",
    pickerKind: "session",
    states: ["workspace", "named", "recent", "path off"],
    query: "release",
    selected: 17,
    items: Array.from({ length: 31 }, (_, index) => ({
      id: String(index),
      label: index === 17 ? "selected-session" : `session-${index}`,
      detail: `/workspace/${index}`,
      value: index,
    })),
    hints: ["↑/↓ navigate · Enter open · Esc close"],
    status: "31 indexed sessions",
  });

  for (const columns of [1, 12, 42, 188]) {
    for (let rows = 1; rows <= 42; rows += 1) {
      const projected = projectNativeOverlay({ snapshot, columns, rows });
      const plain = stripAnsi(projected.text);
      const lines = plain.split("\n");
      assert.ok(lines.length >= 1 && lines.length <= rows, `${columns}x${rows}`);
      assert.ok(lines.every((line) => cellWidth(line) <= columns), `${columns}x${rows}`);
      assert.match(plain, /›/u, `${columns}x${rows}`);
      if (projected.cursor !== undefined) {
        assert.ok(projected.cursor.row >= 1 && projected.cursor.row <= lines.length, `${columns}x${rows}`);
        assert.ok(projected.cursor.column >= 1 && projected.cursor.column <= columns, `${columns}x${rows}`);
      }
      assert.doesNotMatch(plain, /[│█╭╮╰╯]/u);
    }
  }
});

test("empty pickers retain recovery text and dismissal help when space is available", () => {
  const projected = plainProjection({
    title: "Resume Session",
    pickerKind: "session",
    query: "none",
    selected: 0,
    items: [],
    emptyMessage: "No matching sessions in this workspace.",
    hints: ["Esc close"],
    status: "Search complete",
  }, 42, 10);

  assert.equal(projected.text, [
    "Resume Session                         0/0",
    "Search complete",
    "Filter none",
    "No matching sessions in this workspace.",
    "Esc close",
  ].join("\n"));
  assert.deepEqual(projected.cursor, { row: 3, column: 12 });
});

test("picker semantic roles come from a supplied custom theme", () => {
  const theme = createTheme("overlay-test", { color: true, unicode: true }, {
    schemaVersion: 1,
    name: "overlay-test",
    base: "dark",
    styles: {
      title: { foreground: 201, bold: true },
      accent: { foreground: 45 },
      muted: { foreground: 244 },
      selection: { foreground: 16, background: 220 },
    },
  });
  const snapshot = createNativeOverlaySnapshot({
    title: "Providers",
    states: ["configured", "all"],
    query: "local",
    selected: 1,
    items: [
      { id: "one", label: "provider-one", detail: "ready", value: 1 },
      { id: "two", label: "provider-two", detail: "local", value: 2 },
    ],
    hints: ["Enter select"],
  });
  const projected = projectNativeOverlay({ snapshot, columns: 42, rows: 10, theme, unicode: true });

  assert.match(projected.text, terminalPattern("\\u001b\\[38;5;201mProviders", "u"));
  assert.match(projected.text, terminalPattern("\\u001b\\[38;5;45mFilter local", "u"));
  assert.match(projected.text, terminalPattern("\\u001b\\[38;5;16m\\u001b\\[48;5;220m› provider-two", "u"));
  assert.match(projected.text, terminalPattern("\\u001b\\[38;5;244mconfigured · all", "u"));
});

test("no-color ASCII pickers stay bounded without ANSI or Unicode renderer chrome", () => {
  const theme = createTheme("signal", { color: false, unicode: false });
  const snapshot = createNativeOverlaySnapshot({
    title: "Providers",
    states: ["configured", "all"],
    query: "local",
    selected: 1,
    items: [
      { id: "one", label: "provider-one", detail: "ready", value: 1 },
      { id: "two", label: "provider-two", detail: "local", value: 2 },
    ],
    hints: ["Enter select"],
  });

  for (const columns of [1, 12, 60]) {
    const projected = projectNativeOverlay({ snapshot, columns, rows: 10, theme, unicode: false });
    assert.doesNotMatch(projected.text, terminalPattern("\\u001b", "u"));
    assert.match(projected.text, />/u);
    assert.doesNotMatch(projected.text, /[›—…·●]/u);
    for (const line of projected.text.split("\n")) assert.ok(cellWidth(line) <= columns, line);
    if (projected.cursor !== undefined) {
      assert.ok(projected.cursor.row >= 1 && projected.cursor.row <= projected.text.split("\n").length);
      assert.ok(projected.cursor.column >= 1 && projected.cursor.column <= columns);
    }
  }

  const wide = projectNativeOverlay({ snapshot, columns: 60, rows: 10, theme, unicode: false }).text;
  assert.match(wide, /^configured \| all$/mu);
  assert.match(wide, /^> provider-two - local/mu);
});
