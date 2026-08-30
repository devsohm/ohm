import { optionalProperties } from "../../../src/core/optional-properties.js";
import { terminalPattern } from "../../../src/tui/terminal-pattern.js";
import assert from "node:assert/strict";
import test from "node:test";

import type { RuntimeUiBlock } from "../../../src/tui/components.js";
import {
  INTERNAL_TUI_PERSISTENT_POINTER_SOURCE,
  type TuiPersistentPointerBlock,
} from "../../../src/tui/frame-projector.js";
import {
  projectRuntimeUiBlock,
  projectTuiRawBlock,
  projectTuiRuntimeSurfaces,
  type TuiRuntimeSurfaceBlock,
} from "../../../src/tui/native-renderer/runtime-surfaces.js";
import { createTheme } from "../../../src/tui/theme.js";
import type { TuiRawBlock, TuiViewState } from "../../../src/tui/types.js";
import { cellWidth, stripAnsi } from "../../../src/tui/unicode.js";

function structured(text: string, cursor?: { row: number; column: number }): RuntimeUiBlock {
  return {
    lines: [{ spans: [{ text }] }],
    ...optionalProperties(cursor === undefined ? undefined : { cursor }),
  };
}

function raw(text: string, cursor?: { row: number; column: number }): TuiRawBlock {
  return {
    lines: [text],
    ...optionalProperties(cursor === undefined ? undefined : { cursor }),
  };
}

function plain(block: TuiRuntimeSurfaceBlock | undefined): string[] {
  return (block?.lines ?? []).map((line) => stripAnsi(line));
}

function slotPlain(blocks: readonly TuiRuntimeSurfaceBlock[]): string[] {
  return blocks.flatMap(plain);
}

function baseView(): TuiViewState {
  return {
    context: {
      active: false,
      status: "idle",
    },
    transcript: [],
    transcriptOffset: 0,
    editorText: "",
    editorCursor: 0,
    inputLabel: "you",
    inputMode: "normal",
  };
}

test("structured projection sanitizes controls, bounds every target width, and clamps its cursor", () => {
  for (const columns of [1, 12, 42, 188]) {
    const projected = projectRuntimeUiBlock({
      lines: [{
        spans: [
          { text: "safe\u001b]2;owned\u0007 ", role: "accent" },
          { text: "界".repeat(200), role: "success" },
        ],
        fill: true,
      }],
      cursor: { row: 99, column: 99_999 },
    }, { columns, maxLines: 1 });

    assert.equal(projected.source, "structured");
    assert.equal(projected.lines.length, 1);
    assert.equal(projected.fill[0], true);
    assert.doesNotMatch(stripAnsi(projected.lines[0] ?? ""), /owned/u);
    assert.ok(cellWidth(stripAnsi(projected.lines[0] ?? "")) <= columns);
    assert.deepEqual(projected.cursor, {
      row: 0,
      column: Math.min(columns - 1, cellWidth(stripAnsi(projected.lines[0] ?? ""))),
    });
  }
});

test("raw projection preserves trusted ANSI, enforces byte and line structure, and clamps its cursor", () => {
  const ansi = "\u001b[31mred\u001b[0m";
  const preserved = projectTuiRawBlock(raw(ansi, { row: -50, column: 99 }), { columns: 12 });
  assert.deepEqual(preserved.lines, [ansi]);
  assert.deepEqual(preserved.cursor, { row: 0, column: 11 });

  const clipped = projectTuiRawBlock(raw("\u001b[32mabcdefghijk\u001b[0m", { row: 50, column: 50 }), {
    columns: 4,
  });
  assert.match(clipped.lines[0] ?? "", terminalPattern("\\u001b\\[32m", "u"));
  assert.equal(cellWidth(stripAnsi(clipped.lines[0] ?? "")), 4);
  assert.deepEqual(clipped.cursor, { row: 0, column: 3 });

  assert.throws(
    () => projectTuiRawBlock({ lines: ["one\ntwo"] }, { columns: 12 }),
    /contains a line break/u,
  );
  assert.throws(
    () => projectTuiRawBlock({ lines: ["12345"] }, { columns: 12, maxBytes: 4 }),
    /exceeds 4 bytes/u,
  );
  assert.throws(
    () => projectTuiRawBlock({ lines: ["one", "two"] }, { columns: 12, maxLines: 1 }),
    /exceeds 1 lines/u,
  );
  assert.throws(
    () => projectTuiRawBlock({ lines: [], cursor: { row: 0, column: 0 } }, { columns: 12 }),
    /cannot target an empty block/u,
  );
});

test("raw projection reports bounded Kitty and iTerm image reservations", () => {
  const kitty = "\u001b[2C\u001b_Ga=T,f=100,C=1,c=3,r=2,i=7;AAAA\u001b\\";
  const iterm = "\u001b[1A\u001b[5C\u001b]1337;File=inline=1;width=4;height=2:AAAA\u0007";
  const projected = projectTuiRawBlock({
    lines: [kitty, "", "", iterm],
  }, { columns: 12 });

  assert.deepEqual(projected.imageReservations, [
    { row: 0, column: 2, rows: 2, columns: 3 },
    { row: 2, column: 5, rows: 2, columns: 4 },
  ]);
  assert.equal(projected.lines[0], kitty);
  assert.equal(projected.lines[3], iterm);
  assert.equal(projectRuntimeUiBlock(structured("plain"), { columns: 12 }).imageReservations, undefined);

  const clipped = projectTuiRawBlock({
    lines: ["\u001b[11C\u001b_Ga=T,c=8,r=8;AAAA\u001b\\"],
  }, { columns: 12 });
  assert.deepEqual(clipped.imageReservations, [
    { row: 0, column: 11, rows: 1, columns: 1 },
  ]);
});

test("slot projection preserves controller order and raw replacement precedence", () => {
  const view: TuiViewState = {
    ...baseView(),
    context: {
      active: true,
      status: "working",
      extensionHeaders: ["extension header\u001b[31m"],
      extensionFooters: ["extension footer"],
      widgets: ["context widget"],
      extensionStatus: "extension ready\u001b]2;bad\u0007",
      workingMessage: "indexing",
      workingVisible: true,
      activity: { phase: "fallback", startedAt: 0 },
      activityFrame: 1,
    },
    runtimeHeaderComponents: [structured("structured header")],
    rawHeaderComponents: [raw("\u001b[36mraw header\u001b[0m")],
    runtimeFooterComponents: [structured("structured footer")],
    rawFooterComponents: [raw("raw footer")],
    runtimeWidgetComponents: [structured("structured widget")],
    rawWidgetComponents: [raw("raw widget")],
    runtimeWidgetBelowComponents: [structured("structured below")],
    rawWidgetBelowComponents: [raw("raw below")],
    editorBlock: structured("structured editor", { row: 0, column: 17 }),
    rawEditorBlock: raw("raw editor", { row: 0, column: 99 }),
    runtimeComponent: structured("structured runtime", { row: 0, column: 99 }),
    rawRuntimeComponent: raw("raw runtime", { row: 0, column: 99 }),
    workingIndicator: { frames: [".", "/"], intervalMs: 80 },
  };
  const projected = projectTuiRuntimeSurfaces(view, { columns: 42, rows: 12 });

  assert.deepEqual(slotPlain(projected.header.blocks), [
    " extension header",
    "structured header",
    "raw header",
  ]);
  assert.deepEqual(slotPlain(projected.footer.blocks), [
    " extension footer",
    "structured footer",
    "raw footer",
  ]);
  assert.deepEqual(slotPlain(projected.widget.blocks), [
    " context widget",
    "structured widget",
    "raw widget",
  ]);
  assert.deepEqual(slotPlain(projected.widgetBelow.blocks), ["structured below", "raw below"]);
  assert.equal(projected.header.replacement, false);
  assert.equal(projected.footer.replacement, false);
  assert.equal(projected.editor?.source, "raw");
  assert.deepEqual(plain(projected.editor), ["raw editor"]);
  assert.deepEqual(projected.editor?.cursor, { row: 0, column: 41 });
  assert.equal(projected.runtime?.source, "raw");
  assert.deepEqual(plain(projected.runtime), ["raw runtime"]);
  assert.deepEqual(plain(projected.extensionStatus), [" extension ready"]);
  assert.deepEqual(plain(projected.working), [" / indexing"]);

  const replacements = projectTuiRuntimeSurfaces({
    ...view,
    runtimeHeaderReplacement: structured("structured header replacement"),
    rawHeaderReplacement: raw("raw header replacement"),
    runtimeFooterReplacement: structured("structured footer replacement"),
  }, { columns: 42, rows: 12 });
  assert.equal(replacements.header.replacement, "raw");
  assert.deepEqual(slotPlain(replacements.header.blocks), ["raw header replacement"]);
  assert.equal(replacements.footer.replacement, "structured");
  assert.deepEqual(slotPlain(replacements.footer.blocks), ["structured footer replacement"]);
});

test("editor replacements may defer cursor placement to the controller-owned composer", () => {
  const projected = projectTuiRuntimeSurfaces({
    ...baseView(),
    rawEditorBlock: { lines: ["custom editor"] },
  }, { columns: 42, rows: 12 });

  assert.deepEqual(projected.editor?.lines, ["custom editor"]);
  assert.equal(projected.editor?.cursor, undefined);
});

test("source surface height is validated independently from the terminal viewport", () => {
  const editorLines = Array.from({ length: 8 }, (_, index) => `editor-${index + 1}`);
  const runtimeLines = Array.from({ length: 12 }, (_, index) => `runtime-${index + 1}`);
  const overlayLines = Array.from({ length: 5 }, (_, index) => `overlay-${index + 1}`);
  const projected = projectTuiRuntimeSurfaces({
    ...baseView(),
    rawEditorBlock: { lines: editorLines },
    rawRuntimeComponent: { lines: runtimeLines },
    rawRuntimeOverlays: [{
      block: { lines: overlayLines },
      options: { anchor: "top-left" },
      focused: false,
      width: 16,
    }],
  }, { columns: 42, rows: 2 });

  assert.deepEqual(projected.editor?.lines, editorLines);
  assert.deepEqual(projected.runtime?.lines, runtimeLines);
  assert.deepEqual(projected.overlays[0]?.block.lines, overlayLines);
  assert.equal(projected.overlays[0]?.height, 2);
});

test("bounded slots report every omitted leading row and reject invalid source blocks", () => {
  const headers = Array.from({ length: 10 }, (_, index) => structured(`header-${index}`));
  const projected = projectTuiRuntimeSurfaces({
    ...baseView(),
    runtimeHeaderComponents: headers,
  }, { columns: 42, rows: 12 });
  assert.equal(projected.header.omittedLines, 2);
  assert.deepEqual(slotPlain(projected.header.blocks), headers.slice(2).map((_, index) => `header-${index + 2}`));

  assert.throws(() => projectTuiRuntimeSurfaces({
    ...baseView(),
    runtimeHeaderComponents: [{
      lines: Array.from({ length: 5 }, () => ({ spans: [{ text: "line" }] })),
    }],
  }, { columns: 42, rows: 12 }), /exceeds 4 lines/u);
});

test("bounded structured slot projection preserves exact persistent pointer lineage", () => {
  const token = {};
  const pointerBlock = (prefix: string, rows: number): TuiPersistentPointerBlock => ({
    lines: Array.from({ length: rows }, (_, index) => ({ spans: [{ text: `${prefix}-${index}` }] })),
    [INTERNAL_TUI_PERSISTENT_POINTER_SOURCE]: {
      token,
      rows: Array.from({ length: rows }, (_, index) => index),
    },
  });
  const projected = projectTuiRuntimeSurfaces({
    ...baseView(),
    runtimeHeaderComponents: [
      pointerBlock("first", 3),
      pointerBlock("second", 3),
      pointerBlock("third", 4),
    ],
  }, { columns: 42, rows: 12 });

  assert.equal(projected.header.omittedLines, 2);
  assert.deepEqual(
    projected.header.blocks.map((block) => block[INTERNAL_TUI_PERSISTENT_POINTER_SOURCE]?.rows),
    [[2], [0, 1, 2], [0, 1, 2, 3]],
  );

  const replaced = projectTuiRuntimeSurfaces({
    ...baseView(),
    runtimeHeaderReplacement: pointerBlock("structured", 1),
    rawHeaderReplacement: raw("raw replacement"),
  }, { columns: 42, rows: 12 });
  assert.equal(replaced.header.replacement, "raw");
  assert.equal(replaced.header.blocks[0]?.[INTERNAL_TUI_PERSISTENT_POINTER_SOURCE], undefined);

  const structuredReplacement = projectTuiRuntimeSurfaces({
    ...baseView(),
    runtimeFooterReplacement: pointerBlock("structured", 1),
  }, { columns: 42, rows: 12 });
  assert.equal(structuredReplacement.footer.replacement, "structured");
  assert.deepEqual(
    structuredReplacement.footer.blocks[0]?.[INTERNAL_TUI_PERSISTENT_POINTER_SOURCE]?.rows,
    [0],
  );
});

test("bounded raw slots translate and crop retained image reservations", () => {
  const iterm = "\u001b[2A\u001b[2C\u001b]1337;File=inline=1;width=3;height=3:AAAA\u0007";
  const projected = projectTuiRuntimeSurfaces({
    ...baseView(),
    rawHeaderComponents: [
      { lines: ["leading", "", "", iterm] },
      { lines: ["middle-1", "middle-2", "middle-3"] },
      { lines: ["latest-1", "latest-2", "latest-3"] },
    ],
  }, { columns: 12, rows: 12 });

  assert.equal(projected.header.omittedLines, 2);
  assert.deepEqual(projected.header.blocks[0]?.lines, ["", iterm]);
  assert.deepEqual(projected.header.blocks[0]?.imageReservations, [
    { row: 0, column: 2, rows: 2, columns: 3 },
  ]);
});

test("overlay projection keeps paint order, bounded placement, and the final focused cursor", () => {
  const view: TuiViewState = {
    ...baseView(),
    runtimeOverlays: [{
      block: {
        lines: [{ spans: [{ text: "structured one" }] }],
        cursor: { row: 9, column: 99 },
      },
      options: { anchor: "top-left" },
      focused: true,
      width: 10,
    }],
    rawRuntimeOverlays: [{
      block: raw("\u001b[35mraw\u001b[0m", { row: 99, column: 99 }),
      options: { anchor: "bottom-right", margin: 1 },
      focused: true,
      width: 8,
    }],
  };

  for (const [columns, rows] of [[1, 1], [12, 12], [42, 42], [188, 188]] as const) {
    const projected = projectTuiRuntimeSurfaces(view, { columns, rows });
    assert.deepEqual(projected.overlays.map((overlay) => overlay.block.source), ["structured", "raw"]);
    for (const overlay of projected.overlays) {
      assert.ok(overlay.row >= 0 && overlay.row + overlay.height <= rows);
      assert.ok(overlay.column >= 0 && overlay.column + overlay.width <= columns);
      assert.ok((overlay.cursor?.row ?? 0) >= overlay.row);
      assert.ok((overlay.cursor?.column ?? 0) >= overlay.column);
    }
    assert.equal(projected.focusedOverlay?.block.source, "raw");
    assert.deepEqual(projected.focusedOverlay?.cursor, {
      row: Math.max(0, rows - 2),
      column: Math.max(0, columns - 2),
    });
  }

  assert.throws(() => projectTuiRuntimeSurfaces({
    ...baseView(),
    runtimeOverlays: [{
      block: { lines: [] },
      options: { anchor: "center" },
      focused: true,
      width: 10,
    }],
  }, { columns: 42, rows: 12 }), /at least one line/u);
});

test("invalid dimensions and impossible structured data fail explicitly", () => {
  assert.throws(() => projectRuntimeUiBlock(structured("x"), { columns: 0 }), /positive safe integer/u);
  assert.throws(() => projectTuiRuntimeSurfaces(baseView(), { columns: 12, rows: 0 }), /positive safe integer/u);
  assert.throws(() => projectRuntimeUiBlock({
    lines: [{ spans: [{ text: "x", role: JSON.parse('"not-a-role"') }] }],
  }, { columns: 12 }), /role is invalid/u);
  assert.throws(() => projectRuntimeUiBlock({
    lines: [],
    cursor: { row: 0, column: 0 },
  }, { columns: 12 }), /cannot target an empty block/u);
});

test("structured runtime spans use supplied custom role codes", () => {
  const theme = createTheme("runtime-test", { color: true, unicode: true }, {
    schemaVersion: 1,
    name: "runtime-test",
    base: "dark",
    styles: {
      accent: { foreground: 201 },
      success: { foreground: 46 },
      selection: { foreground: 16, background: 220 },
    },
  });
  const projected = projectRuntimeUiBlock({
    lines: [{
      spans: [
        { text: "accent", role: "accent" },
        { text: " success", role: "success" },
        { text: " selected", role: "selection" },
      ],
    }],
  }, { columns: 42, theme });

  assert.match(projected.lines[0] ?? "", terminalPattern("\\u001b\\[38;5;201maccent", "u"));
  assert.match(projected.lines[0] ?? "", terminalPattern("\\u001b\\[38;5;46m success", "u"));
  assert.match(projected.lines[0] ?? "", terminalPattern("\\u001b\\[38;5;16m\\u001b\\[48;5;220m selected", "u"));
});

test("structured tool failures stay foreground-only under custom themes", () => {
  const theme = createTheme("runtime-tool-error", { color: true, unicode: true }, {
    schemaVersion: 1,
    name: "runtime-tool-error",
    base: "dark",
    styles: {
      error: { foreground: 196 },
      toolError: { foreground: 252, background: 52 },
    },
  });
  const projected = projectRuntimeUiBlock({
    lines: [{ spans: [{ text: "failed", role: "toolError" }] }],
  }, { columns: 42, theme });

  assert.match(projected.lines[0] ?? "", terminalPattern("\\u001b\\[38;5;196mfailed", "u"));
  assert.doesNotMatch(projected.lines[0] ?? "", terminalPattern("\\u001b\\[48;", "u"));
});

test("no-color runtime projection strips host styling but preserves trusted raw ANSI", () => {
  const theme = createTheme("signal", { color: false, unicode: false });
  const trusted = "\u001b[35mraw\u001b[0m";
  const view: TuiViewState = {
    ...baseView(),
    context: {
      active: true,
      status: "working",
      extensionHeaders: ["host header"],
      extensionStatus: "ready",
      activity: { phase: "checking", startedAt: 0 },
    },
    runtimeHeaderComponents: [{ lines: [{ spans: [{ text: "structured", role: "accent" }] }] }],
    rawHeaderComponents: [raw(trusted)],
  };
  const projected = projectTuiRuntimeSurfaces(view, {
    columns: 42,
    rows: 12,
    theme,
    unicode: false,
  });
  const structuredLines = projected.header.blocks
    .filter((block) => block.source === "structured")
    .flatMap((block) => block.lines);
  const rawLines = projected.header.blocks
    .filter((block) => block.source === "raw")
    .flatMap((block) => block.lines);

  assert.ok(structuredLines.length > 0);
  assert.ok(structuredLines.every((line) => !line.includes("\u001b")));
  assert.deepEqual(rawLines, [trusted]);
  assert.doesNotMatch(projected.extensionStatus?.lines[0] ?? "", terminalPattern("\\u001b", "u"));
});
