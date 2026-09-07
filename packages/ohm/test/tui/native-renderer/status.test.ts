import assert from "node:assert/strict";
import test from "node:test";
import { cellWidth, stripAnsi, wrapTextWithAnsi } from "@ohm/terminal";

import { nativeStyle } from "../../../src/tui/native-renderer/style.js";
import type { OhmTuiSnapshot } from "../../../src/tui/native-renderer/types.js";
import { projectOhmNativeFrame } from "../../../src/tui/native-renderer/view.js";
import { createTheme } from "../../../src/tui/theme.js";
import { LiveSurfaceRenderer } from "../../../src/tui/surface-renderer.js";

const snapshot: OhmTuiSnapshot = {
  transcript: [], queuedMessages: [], composer: { value: "Keep this draft.", cursor: 4 },
  status: { connection: "connected", model: "scripted/model-local", reasoning: "high" },
  telemetry: { contextTokens: 90000, contextWindowTokens: 100000, cacheHitPercent: 75,
    inputTokens: 4200, outputTokens: 300, cacheReadTokens: 1800, cacheWriteTokens: 600, cost: 0.125 },
};

test("status ribbon styles labeled facts by meaning and preserves their plain text", () => {
  const theme = createTheme("signal", { color: true, unicode: true });
  const frame = projectOhmNativeFrame({ snapshot, columns: 120, theme });
  const status = frame.text.split("\n").slice(frame.composer.bottom).join("\n");
  for (const [role, text] of [
    ["title", "scripted/model-local"], ["info", "think high"], ["success", "configured"],
    ["warning", "ctx 90.0%/100k"], ["success", "cache hit 75.0%"], ["info", "in 4.2k"],
    ["assistant", "out 300"], ["success", "cache read 1.8k"], ["muted", "cache write 600"], ["accent", "$0.125"],
  ] as const) assert.ok(status.includes(nativeStyle(theme, role, text)), `${role}: ${text}`);
  const plain = projectOhmNativeFrame({ snapshot, columns: 120, theme: createTheme("signal", { color: false, unicode: true }) });
  assert.equal(stripAnsi(frame.text), plain.text);
  assert.deepEqual(frame.cursor, plain.cursor);
});

test("narrow status keeps reasoning, drops redundant healthy state, and labels cache counters", () => {
  const frame = projectOhmNativeFrame({
    snapshot: { ...snapshot, status: { ...snapshot.status, model: "scripted/a-model-name-that-exceeds-the-terminal-width" } },
    columns: 40, theme: createTheme("signal", { color: false, unicode: false }),
  });
  const status = frame.text.split("\n").slice(frame.composer.bottom).filter(Boolean);
  assert.match(status[0]!, /^scripted\/a-model.* \| think high$/u);
  assert.doesNotMatch(status[0]!, /configured/u);
  assert.match(status.join("\n"), /cache hit 75\.0%/u);
  assert.match(status.join("\n"), /read 1\.8k/u);
  assert.match(status.join("\n"), /write 600/u);
  assert.doesNotMatch(status.join("\n"), /ready|R1\.8k|W600|[^\x20-\x7e\n]/u);
  assert.equal(frame.text.split("\n")[frame.cursor.row - 1]?.includes("Keep this draft."), true);
});

test("context pressure colors reflect known usage without inventing missing values", () => {
  const theme = createTheme("signal", { color: true, unicode: true });
  for (const [tokens, role] of [[79999, "info"], [80000, "warning"], [94999, "warning"], [95000, "error"]] as const) {
    const frame = projectOhmNativeFrame({ snapshot: { ...snapshot, telemetry: { contextTokens: tokens, contextWindowTokens: 100000 } }, columns: 80, theme });
    const label = `ctx ${(tokens / 1000).toFixed(1)}%/100k`;
    assert.ok(frame.text.includes(nativeStyle(theme, role, label)), `${tokens}: ${role}`);
  }
  const empty = projectOhmNativeFrame({ snapshot: { ...snapshot, telemetry: {} }, columns: 80, theme });
  assert.doesNotMatch(stripAnsi(empty.text), /ctx|cache|in 0|out 0|\$0/u);
});

test("status activity and explicit connection states retain semantic colors", () => {
  const theme = createTheme("signal", { color: true, unicode: true });
  const active = projectOhmNativeFrame({ snapshot: { ...snapshot, status: { ...snapshot.status, activity: "Running checks" } }, columns: 80, theme });
  assert.ok(active.text.includes(nativeStyle(theme, "working", "Running checks")));
  assert.doesNotMatch(stripAnsi(active.text), /ready|configured/u);
  for (const [connection, role, label] of [["connecting", "warning", "connecting"], ["offline", "muted", "offline"], ["error", "error", "connection error"]] as const) {
    const frame = projectOhmNativeFrame({ snapshot: { ...snapshot, status: { connection } }, columns: 80, theme });
    assert.ok(frame.text.includes(nativeStyle(theme, role, label)), connection);
  }
});

test("blank optional identity fields do not invent a thinking label or separator", () => {
  const frame = projectOhmNativeFrame({
    snapshot: { ...snapshot, status: { connection: "connected", model: " \n", reasoning: "\t ", activity: " \n" }, telemetry: {} },
    columns: 40,
  });
  assert.deepEqual(frame.text.split("\n").slice(frame.composer.bottom), ["", "● configured"]);
});

test("narrow nonhealthy states precede long activity and reasoning", () => {
  for (const [connection, role, label] of [["error", "error", "connection error"], ["connecting", "warning", "connecting"], ["offline", "muted", "offline"]] as const) {
    for (const columns of [24, 40]) for (const color of [false, true]) {
      const theme = createTheme("signal", { color, unicode: color });
      const frame = projectOhmNativeFrame({
        snapshot: { ...snapshot, status: { connection, model: "fixture/model", reasoning: "high", activity: "Retrying request after provider rate limit" } },
        columns, theme,
      });
      const status = frame.text.split("\n").slice(frame.composer.bottom).find((line) => stripAnsi(line).trim() !== "")!;
      assert.ok(stripAnsi(status).startsWith(label), `${columns}: ${stripAnsi(status)}`);
      assert.ok(status.includes(nativeStyle(theme, role, label)), `${columns}: ${role}`);
      assert.ok(cellWidth(status) <= columns);
    }
  }
});

test("wrapped colored status rows close SGR before independently painted rows", () => {
  const theme = createTheme("status-background", { color: true, unicode: true }, {
    schemaVersion: 1, name: "status-background", base: "dark",
    styles: { success: { foreground: 46, background: 23 } },
  });
  const frame = projectOhmNativeFrame({ snapshot: { ...snapshot, telemetry: { cacheHitPercent: 75 } }, columns: 12, theme });
  const metrics = frame.text.split("\n").slice(frame.composer.bottom + 2);
  assert.deepEqual(metrics.map(stripAnsi), ["  cache hit", "  75.0%"]);
  for (const line of metrics) {
    assert.equal(wrapTextWithAnsi(`${line}\nprobe`, 1000).at(-1), "probe", "the terminal style parser must carry no SGR into the next row");
    assert.ok(line.startsWith("  "), "indentation precedes the row's reopened style");
  }
  const renderer = new LiveSurfaceRenderer({ alternateScreen: false, synchronizedOutput: false });
  const cursor = { row: 1, column: 2 };
  renderer.render({ text: "draft\nprevious", cursor }, { columns: 12, rows: 4 });
  const changed = renderer.render({ text: `draft\n${metrics[0]}`, cursor }, { columns: 12, rows: 4 });
  assert.equal(changed.strategy, "diff");
  assert.equal(changed.changedRows, 1);
  assert.equal(wrapTextWithAnsi(`${changed.output}\nprobe`, 1000).at(-1), "probe", "a single wrapped-row diff returns to the editor with neutral SGR");
});

test("status semantic spans remain bounded and sanitize terminal controls at every width", () => {
  const source: OhmTuiSnapshot = { ...snapshot, status: { connection: "error", model: "model\u001b[2J\nunsafe", reasoning: "high\u0007", activity: "working\u001b]52;c;data\u0007" } };
  for (const columns of [1, 2, 8, 24, 40, 80, 120]) for (const color of [false, true]) {
    const frame = projectOhmNativeFrame({ snapshot: source, columns, theme: createTheme("signal", { color, unicode: color }) });
    for (const line of frame.text.split("\n")) assert.ok(cellWidth(line) <= columns, `${columns}: ${stripAnsi(line)}`);
    assert.ok(frame.cursor.column >= 1 && frame.cursor.column <= columns);
    assert.ok(frame.cursor.row - 1 >= frame.composer.top && frame.cursor.row - 1 < frame.composer.bottom);
    for (const control of ["\u001b[2J", "\u001b]52", "\u0007"]) assert.equal(frame.text.includes(control), false);
    if (!color) assert.equal(frame.text.includes("\u001b"), false);
  }
});

test("custom foreground and background roles survive clipping without changing no-color geometry", () => {
  const definition = {
    schemaVersion: 1 as const, name: "status-colors", base: "dark" as const,
    styles: {
      title: { foreground: 196, background: 22 }, info: { foreground: 33, background: 17 },
      warning: { foreground: 208, background: 52 }, success: { foreground: 46, background: 23 },
    },
  };
  const theme = createTheme(definition.name, { color: true, unicode: true }, definition);
  const plainTheme = createTheme(definition.name, { color: false, unicode: true }, definition);
  for (const columns of [1, 2, 12, 40, 80, 120]) {
    const colored = projectOhmNativeFrame({ snapshot, columns, theme });
    const plain = projectOhmNativeFrame({ snapshot, columns, theme: plainTheme });
    assert.deepEqual(stripAnsi(colored.text).split("\n").map((line) => line.trimEnd()),
      plain.text.split("\n").map((line) => line.trimEnd()), `plain geometry at ${columns}`);
    assert.deepEqual(colored.cursor, plain.cursor);
    for (const line of colored.text.split("\n")) assert.ok(cellWidth(line) <= columns);
    if (columns >= 40) {
      assert.ok(colored.text.includes(nativeStyle(theme, "info", "think high")));
      assert.ok(colored.text.includes(nativeStyle(theme, "warning", "ctx 90.0%/100k")));
    }
  }
});
