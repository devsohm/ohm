import assert from "node:assert/strict";
import test from "node:test";

import {
  searchOhmTranscript,
  type OhmTranscriptSearchSource,
} from "../../../src/tui/native-renderer/transcript-search.js";
import {
  INTERNAL_TUI_TRANSCRIPT_SEARCH,
  type TuiFrameProjectionRequest,
} from "../../../src/tui/frame-projector.js";
import { internalCreateRichTuiFrameProjector } from "../../../src/tui/rich-frame-projector.js";
import { createTheme } from "../../../src/tui/theme.js";
import type { TuiViewState } from "../../../src/tui/types.js";
import { cellWidth, stripAnsi } from "@ohm/terminal";

function source(rows: readonly string[], reads: Array<readonly [number, number]> = []): OhmTranscriptSearchSource {
  return {
    totalRows: rows.length,
    window(start, height) {
      reads.push([start, height]);
      return { rows: rows.slice(start, start + height) };
    },
  };
}

test("rendered transcript search is case-insensitive and crosses collapsed row whitespace", () => {
  const result = searchOhmTranscript(source([
    "before Alpha   ",
    "\u001b[31mBETA\u001b[0m after",
  ]), " alpha beta ");

  assert.equal(result.normalizedQuery, "alpha beta");
  assert.equal(result.truncated, false);
  assert.deepEqual(result.matches, [{
    startRow: 0,
    endRow: 1,
    spans: [
      { row: 0, startColumn: 7, endColumn: 12 },
      { row: 1, startColumn: 0, endColumn: 4 },
    ],
  }]);
});

test("rendered transcript search maps ANSI text and wide graphemes to complete terminal cells", () => {
  const result = searchOhmTranscript(source([
    "x \u001b[1m🙂界\u001b[0m y",
    "🙂界",
  ]), "🙂界");

  assert.deepEqual(result.matches.map((match) => match.spans), [
    [{ row: 0, startColumn: 2, endColumn: 6 }],
    [{ row: 1, startColumn: 0, endColumn: 4 }],
  ]);
});

test("rendered transcript search reads bounded windows and caps adversarial match counts", () => {
  const rows = Array.from({ length: 1_025 }, () => "aaaaaaaa");
  const reads: Array<readonly [number, number]> = [];
  const result = searchOhmTranscript(source(rows, reads), "a", { maximumMatches: 600, windowRows: 64 });

  assert.equal(result.matches.length, 600);
  assert.equal(result.truncated, true);
  assert.ok(reads.length > 1);
  assert.ok(reads.every(([, height]) => height <= 64));
  assert.ok(reads.reduce((total, [, height]) => total + height, 0) < rows.length);
});

test("empty and whitespace-only queries do not read transcript rows", () => {
  for (const query of ["", " \n\t "]) {
    const reads: Array<readonly [number, number]> = [];
    assert.deepEqual(searchOhmTranscript(source(["text"], reads), query), {
      normalizedQuery: "",
      matches: [],
      truncated: false,
    });
    assert.deepEqual(reads, []);
  }
});

function projectedSearch(
  text: string,
  query: string,
  selectedMatch: number | undefined,
  size = { columns: 40, rows: 12 },
) {
  const theme = createTheme("signal", { color: true, unicode: true });
  const transcriptSearch = selectedMatch === undefined
    ? { query, cursor: Array.from(query).length, anchorRow: 0 }
    : { query, cursor: Array.from(query).length, selectedMatch, anchorRow: 0 };
  const view: TuiViewState = {
    context: {},
    transcript: [{ id: "answer", kind: "assistant", text }],
    transcriptOffset: 0,
    transcriptSearch,
    editorText: "draft remains",
    editorCursor: 13,
    inputLabel: "you",
    inputMode: "normal",
  };
  const request: TuiFrameProjectionRequest = {
    view,
    size,
    theme,
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
    transcriptRevision: 1,
  };
  const projector = internalCreateRichTuiFrameProjector();
  return { frame: projector(request), projector, request, theme };
}

test("the rich frame search bar highlights every visible result", () => {
  const { frame, projector, request, theme } = projectedSearch("needle then needle", "needle", 1);
  const projection = frame[INTERNAL_TUI_TRANSCRIPT_SEARCH];
  assert.equal(projection?.matches.length, 2);
  assert.equal(projection?.selectedMatch, 1);
  assert.match(stripAnsi(frame.text), /\? needle\s+2\/2/u);
  assert.ok(frame.text.includes(theme.getBgAnsi("selectedBg")));
  assert.ok(frame.text.includes("\u001b[1mneedle"));
  assert.doesNotMatch(stripAnsi(frame.text), /draft remains/u);

  const lines = stripAnsi(frame.text).split("\n");
  assert.ok(frame.cursor.row >= 1 && frame.cursor.row <= lines.length);
  assert.ok(frame.cursor.column >= 1 && frame.cursor.column <= 40);
  assert.strictEqual(projector(request)[INTERNAL_TUI_TRANSCRIPT_SEARCH]?.matches, projection?.matches);
});

test("the rich frame search crosses wrapped rows and stays geometrically valid in tiny terminals", () => {
  const wrapped = projectedSearch("alpha beta and 🙂界", "alpha beta", undefined, { columns: 9, rows: 8 }).frame;
  assert.equal(wrapped[INTERNAL_TUI_TRANSCRIPT_SEARCH]?.matches.length, 1);
  const spanRows = new Set(wrapped[INTERNAL_TUI_TRANSCRIPT_SEARCH]?.matches[0]?.spans.map((span) => span.row));
  assert.ok(spanRows.size >= 2);

  for (const columns of [1, 2, 3, 5, 8, 12]) {
    for (const rows of [1, 2, 3]) {
      const tiny = projectedSearch("🙂界 needle", "🙂界", undefined, { columns, rows }).frame;
      const lines = stripAnsi(tiny.text).split("\n");
      assert.ok(lines.length <= rows);
      assert.ok(lines.every((line) => cellWidth(line) <= columns));
      assert.ok(tiny.cursor.row >= 1 && tiny.cursor.row <= Math.max(1, lines.length));
      assert.ok(tiny.cursor.column >= 1 && tiny.cursor.column <= columns);
    }
  }
});
