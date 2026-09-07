import { terminalPattern } from "../../src/tui/terminal-pattern.js";
import assert from "node:assert/strict";
import test from "node:test";
import { renderTranscript } from "../../src/tui/layout.js";
import { renderMarkdownMessageLines } from "../../src/tui/markdown.js";
import { createTheme } from "../../src/tui/theme.js";
import type { TranscriptEntry } from "../../src/tui/types.js";
import { cellWidth, stripAnsi } from "../../src/tui/unicode.js";

const PATHOLOGICAL_LINE_BYTES = 2 * 1024 * 1024;

function exactPathologicalLine(head: string, tail: string, fill = "x"): string {
  const remaining = PATHOLOGICAL_LINE_BYTES - Buffer.byteLength(head, "utf8") - Buffer.byteLength(tail, "utf8");
  const fillBytes = Buffer.byteLength(fill, "utf8");
  const value = `${head}${fill.repeat(Math.floor(remaining / fillBytes))}${"x".repeat(remaining % fillBytes)}${tail}`;
  assert.equal(Buffer.byteLength(value, "utf8"), PATHOLOGICAL_LINE_BYTES);
  return value;
}

test("unmatched Markdown link openers do not repeatedly search the full remaining suffix", () => {
  const source = "[".repeat(256);
  const descriptor = Object.getOwnPropertyDescriptor(String.prototype, "indexOf");
  assert.ok(descriptor);
  const original = String.prototype.indexOf;
  let searchedUnits = 0;
  let lines: ReturnType<typeof renderMarkdownMessageLines>;
  try {
    Object.defineProperty(String.prototype, "indexOf", {
      ...descriptor,
      value: function (this: string, needle: string, position?: number): number {
        if (this === source && needle === "](") searchedUnits += Math.max(0, source.length - (position ?? 0));
        return original.call(this, needle, position);
      },
    });
    lines = renderMarkdownMessageLines("", source, source.length + 1, "assistant");
  } finally {
    Object.defineProperty(String.prototype, "indexOf", descriptor);
  }
  assert.equal(String.prototype.indexOf, original);
  assert.equal(lines.map((line) => line.text).join("\n"), source);
  assert.ok(searchedUnits <= source.length * 4, `searched ${searchedUnits} suffix units for ${source.length} literal characters`);
});

test("unmatched Markdown emphasis openers do not repeatedly traverse the full remaining suffix", () => {
  const source = `${"*a ".repeat(128)}tail`;
  const descriptor = Object.getOwnPropertyDescriptor(String.prototype, "startsWith");
  assert.ok(descriptor);
  const original = String.prototype.startsWith;
  let markerChecks = 0;
  let lines: ReturnType<typeof renderMarkdownMessageLines>;
  try {
    Object.defineProperty(String.prototype, "startsWith", {
      ...descriptor,
      value: function (this: string, needle: string, position?: number): boolean {
        if (this === source && needle === "*") markerChecks += 1;
        return original.call(this, needle, position);
      },
    });
    lines = renderMarkdownMessageLines("", source, source.length + 1, "assistant");
  } finally {
    Object.defineProperty(String.prototype, "startsWith", descriptor);
  }
  assert.equal(String.prototype.startsWith, original);
  assert.equal(lines.map((line) => line.text).join("\n"), source);
  assert.ok(markerChecks <= source.length * 4, `checked ${markerChecks} delimiter positions for ${source.length} literal characters`);
});

test("a pathological single Markdown line is sampled before parsing and wrapping", () => {
  const source = exactPathologicalLine(
    "discarded-head ",
    " \u001b]8;;https://owned.test\u0007retained-tail-\u754c\ud83d\ude42\u001b]8;;\u0007",
    "\ud83d\ude42",
  );
  const started = process.cpuUsage();
  const lines = renderMarkdownMessageLines("", source, 80, "assistant");
  const elapsed = process.cpuUsage(started);
  const elapsedMs = (elapsed.user + elapsed.system) / 1_000;
  const visible = lines.map((line) => line.text).join("\n");

  assert.match(visible, /^\u2026 earlier Markdown line bytes omitted \u2026$/mu);
  assert.match(visible, /retained-tail-\u754c\ud83d\ude42$/u);
  assert.doesNotMatch(visible, terminalPattern("discarded-head|owned\\.test|\\u001b|\\u0007|\\ufffd", "u"));
  assert.ok(lines.length < 1_000, `sampled line unexpectedly rendered ${lines.length} rows`);
  assert.ok(lines.every((line) => cellWidth(line.text) <= 80));
  assert.ok(elapsedMs < 250, `cold Markdown render used ${elapsedMs.toFixed(1)}ms CPU`);
});

test("streaming assistant cache invalidates when a sampled Markdown tail changes", () => {
  const theme = createTheme("mono", { color: false, unicode: true });
  const entry: TranscriptEntry = {
    id: "sampled-streaming-assistant",
    kind: "assistant",
    text: exactPathologicalLine("discarded-first ", " first-tail"),
    streaming: true,
  };

  const first = stripAnsi(renderTranscript([entry], 80, theme));
  assert.match(first, /earlier Markdown line bytes omitted/u);
  assert.match(first, /first-tail/u);

  entry.text = exactPathologicalLine("discarded-second ", " second-tail", "y");
  const second = stripAnsi(renderTranscript([entry], 80, theme));
  assert.match(second, /earlier Markdown line bytes omitted/u);
  assert.match(second, /second-tail/u);
  assert.doesNotMatch(second, /first-tail/u);
});
