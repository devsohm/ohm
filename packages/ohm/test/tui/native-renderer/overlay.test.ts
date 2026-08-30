import assert from "node:assert/strict";
import test from "node:test";

import { stripAnsi } from "@ohm/terminal";

import {
  createNativeOverlaySnapshot,
  projectNativeOverlay,
} from "../../../src/tui/native-renderer/overlay.js";
import { createTheme } from "../../../src/tui/theme.js";
import type { TuiViewState } from "../../../src/tui/types.js";

type ViewOverlay = NonNullable<TuiViewState["overlay"]>;

function project(overlay: ViewOverlay, columns: number, rows: number) {
  const theme = createTheme("signal", { color: true, unicode: true });
  const frame = projectNativeOverlay({
    snapshot: createNativeOverlaySnapshot(overlay),
    columns,
    rows,
    theme,
    unicode: true,
  });
  return { ...frame, text: stripAnsi(frame.text) };
}

test("native overlays preserve picker rows and the filter cursor", () => {
  const frame = project({
    title: "Models",
    pickerKind: "model",
    states: ["available", "all"],
    query: "fix",
    selected: 2,
    items: [
      { id: "a", label: "model-a", detail: "fast", value: 1 },
      { id: "b", label: "model-b", detail: "steady", value: 2 },
      { id: "c", label: "model-c", detail: "balanced", value: 3 },
      { id: "d", label: "model-d", detail: "large", value: 4 },
    ],
    hints: ["Up/Down navigate · Enter select · Esc cancel"],
    status: "Live catalog",
  }, 42, 14);

  assert.equal(frame.text, [
    "Models                                 3/4",
    "available · all",
    "Live catalog",
    "Filter fix",
    "  model-a",
    "  model-b",
    `› model-c${" ".repeat(33)}`,
    "  model-d",
    "balanced",
    "Up/Down navigate · Enter select · Esc",
    "cancel",
  ].join("\n"));
  assert.deepEqual(frame.cursor, { row: 4, column: 11 });
});

test("native overlays retain inline completion layout", () => {
  const frame = project({
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

  assert.equal(frame.text, [
    "  /login — Connect a provider",
    `› /model — Choose a model${" ".repeat(17)}`,
    "2/2",
  ].join("\n"));
  assert.equal(frame.cursor, undefined);
});

test("native overlay rows follow the visible picker window", () => {
  const frame = project({
    title: "Files",
    pickerKind: "file",
    query: "",
    selected: 4,
    maxVisible: 2,
    items: [
      { id: "a", label: "a", value: 1 },
      { id: "b", label: "b", value: 2 },
      { id: "c", label: "c", value: 3 },
      { id: "d", label: "d", value: 4 },
      { id: "e", label: "e", value: 5 },
    ],
  }, 20, 4);

  assert.match(frame.text, /  d\n› e/u);
  assert.doesNotMatch(frame.text, /  [abc](?:\n|$)/u);
});
