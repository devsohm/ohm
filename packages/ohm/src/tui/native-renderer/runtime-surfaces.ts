import {
  isBooleanValue,
  isNumberValue,
  isObjectValue,
  isRecordValue,
  isSafeIntegerValue,
  isStringValue,
  type RuntimeRecord,
} from "../value-guards.js";
import { terminalPattern } from "../terminal-pattern.js";
import { optionalProperties } from "../../core/optional-properties.js";
import { isImageLine, truncateToWidth, visibleWidth } from "@ohm/terminal";

import {
  DEFAULT_RUNTIME_UI_MAX_BYTES,
  sanitizeRuntimeUiBlock,
  type RuntimeUiBlock,
  type RuntimeUiLine,
  type RuntimeUiOverlayLength,
  type RuntimeUiOverlayOptions,
} from "../components.js";
import {
  INTERNAL_TUI_PERSISTENT_POINTER_SOURCE,
  type TuiPersistentPointerBlock,
  type TuiPersistentPointerSource,
} from "../frame-projector.js";
import { elapsedText } from "../model.js";
import type { Theme, ThemeRole } from "../theme.js";
import type { TuiRawBlock, TuiViewState, TuiWorkingIndicatorOptions } from "../types.js";
import { byteTruncate, sanitizeTerminalText, truncateCells, wrapCells } from "../unicode.js";
import { nativeStyle } from "./style.js";

const MAX_COLUMNS = 500;
const MAX_ROWS = 200;
const MAX_SLOT_COMPONENTS = 16;
const MAX_SLOT_SOURCE_LINES = 4;
const MAX_SLOT_SOURCE_BYTES = 16 * 1024;
const MAX_SLOT_LINES = 8;
const MAX_EDITOR_LINES = 8;
const MAX_EXTENSION_VALUES = 4;
const MAX_EXTENSION_BYTES = 32 * 1024;
const MAX_EXTENSION_LINES = 2;
const DEFAULT_UNICODE_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const DEFAULT_ASCII_SPINNER_FRAMES = ["|", "/", "-", "\\"] as const;

export interface TuiRuntimeSurfaceCursor {
  /** Zero-based row in the projected block. */
  readonly row: number;
  /** Zero-based terminal-cell column in the projected block. */
  readonly column: number;
}

export interface TuiRuntimeSurfaceImageReservation {
  /** Zero-based row in the projected raw block. */
  readonly row: number;
  /** Zero-based terminal-cell column in the projected raw block. */
  readonly column: number;
  readonly rows: number;
  readonly columns: number;
}

export interface TuiRuntimeSurfaceBlock {
  readonly source: "structured" | "raw";
  /** ANSI is host-produced for structured data and extension-trusted for raw data. */
  readonly lines: readonly string[];
  /** Whether a structured line intentionally occupies the full block width. */
  readonly fill: readonly boolean[];
  readonly cursor?: TuiRuntimeSurfaceCursor;
  /** Raw terminal-image cells that must remain untouched by host composition. */
  readonly imageReservations?: readonly TuiRuntimeSurfaceImageReservation[];
  readonly [INTERNAL_TUI_PERSISTENT_POINTER_SOURCE]?: TuiPersistentPointerSource;
}

export interface TuiRuntimeSurfaceSlot {
  readonly blocks: readonly TuiRuntimeSurfaceBlock[];
  readonly replacement: false | "structured" | "raw";
  /** Leading rows omitted by the documented slot-height bound. */
  readonly omittedLines: number;
}

export interface TuiRuntimeOverlayProjection {
  readonly block: TuiRuntimeSurfaceBlock;
  readonly focused: boolean;
  readonly row: number;
  readonly column: number;
  readonly width: number;
  readonly height: number;
  /** Zero-based frame coordinate selected only when this overlay owns focus. */
  readonly cursor?: TuiRuntimeSurfaceCursor;
}

export interface TuiRuntimeSurfaceProjection {
  readonly columns: number;
  readonly rows: number;
  readonly header: TuiRuntimeSurfaceSlot;
  readonly footer: TuiRuntimeSurfaceSlot;
  readonly widget: TuiRuntimeSurfaceSlot;
  readonly widgetBelow: TuiRuntimeSurfaceSlot;
  /** Extension editor replacement only. Core editor state remains host-owned. */
  readonly editor?: TuiRuntimeSurfaceBlock;
  /** Full runtime component only. Transcript projection remains host-owned. */
  readonly runtime?: TuiRuntimeSurfaceBlock;
  readonly extensionStatus?: TuiRuntimeSurfaceBlock;
  readonly working?: TuiRuntimeSurfaceBlock;
  /** Structured overlays first, then raw overlays, preserving controller order. */
  readonly overlays: readonly TuiRuntimeOverlayProjection[];
  /** Last focused overlay after raw-over-structured paint precedence. */
  readonly focusedOverlay?: TuiRuntimeOverlayProjection;
}

interface OverlayMargins {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

interface OverlayPosition {
  readonly row: number;
  readonly column: number;
}

interface OverlayValue<Block> {
  readonly block: Block;
  readonly focused: boolean;
  readonly options: RuntimeUiOverlayOptions;
  readonly width: number;
}

function dimension(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${label} must be a positive safe integer`);
  return Math.min(value, maximum);
}

function limit(value: number | undefined, fallback: number, label: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1) throw new RangeError(`${label} must be a positive safe integer`);
  return selected;
}

function lineLimit(value: number | undefined): number {
  return Math.min(limit(value, MAX_ROWS, "Runtime UI line limit"), MAX_ROWS);
}

function byteLimit(value: number | undefined): number {
  return Math.min(limit(value, DEFAULT_RUNTIME_UI_MAX_BYTES, "Runtime UI byte limit"), DEFAULT_RUNTIME_UI_MAX_BYTES);
}

function object<Value>(value: Value, label: string): RuntimeRecord {
  if (!isRecordValue(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function exact(value: RuntimeRecord, keys: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  if (unknown.length > 0) throw new TypeError(`${label} contains unknown keys: ${unknown.join(", ")}`);
}

function integerCursor<Value>(value: Value, label: string): TuiRuntimeSurfaceCursor {
  const cursor = object(value, label);
  exact(cursor, ["row", "column"], label);
  if (!isSafeIntegerValue(cursor.row) || !isSafeIntegerValue(cursor.column)) {
    throw new TypeError(`${label} coordinates must be safe integers`);
  }
  return { row: cursor.row, column: cursor.column };
}

function clampedCursor(
  value: RuntimeRecord[string] | undefined,
  lines: readonly string[],
  columns: number,
  label: string,
  boundToLine: boolean,
): TuiRuntimeSurfaceCursor | undefined {
  if (value === undefined) return undefined;
  if (lines.length === 0) throw new RangeError(`${label} cannot target an empty block`);
  const cursor = integerCursor(value, label);
  const row = Math.max(0, Math.min(lines.length - 1, cursor.row));
  const maximumColumn = boundToLine
    ? Math.min(Math.max(0, columns - 1), visibleWidth(lines[row] ?? ""))
    : Math.max(0, columns - 1);
  return Object.freeze({
    row,
    column: Math.max(0, Math.min(maximumColumn, cursor.column)),
  });
}

function structuredBlock(
  value: RuntimeUiBlock,
  columns: number,
  maximumLines: number,
  maximumBytes: number,
): RuntimeUiBlock {
  const record = object(value, "Runtime UI block");
  const cursor = record.cursor;
  const withoutCursor = { ...record };
  delete withoutCursor.cursor;
  const safe = sanitizeRuntimeUiBlock(withoutCursor, {
    width: columns,
    maxLines: maximumLines,
    maxBytes: maximumBytes,
  });
  const plainLines = safe.lines.map((line) => line.spans.map((span) => span.text).join(""));
  const selectedCursor = clampedCursor(cursor, plainLines, columns, "Runtime UI cursor", true);
  return Object.freeze({
    lines: safe.lines,
    ...optionalProperties(selectedCursor === undefined ? undefined : { cursor: selectedCursor }),
  });
}

function positiveImageParameter(
  source: string,
  separator: "," | ";",
  name: string,
  maximum: number,
): number | undefined {
  for (const parameter of source.split(separator)) {
    const equals = parameter.indexOf("=");
    if (equals < 0 || parameter.slice(0, equals) !== name) continue;
    const raw = parameter.slice(equals + 1);
    if (!/^\d+$/u.test(raw)) return undefined;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value > 0 ? Math.min(value, maximum) : undefined;
  }
  return undefined;
}

function imageColumn(prefix: string, maximum: number): number {
  const cursor = terminalPattern("\\u001b\\[(?:(\\d+)(?:;(\\d+))?)?([ACDGHf])", "gu");
  let column = 0;
  let offset = 0;
  for (const match of prefix.matchAll(cursor)) {
    column += visibleWidth(prefix.slice(offset, match.index));
    const first = Number(match[1] ?? 1);
    const second = Number(match[2] ?? 1);
    switch (match[3]) {
      case "C": column += first; break;
      case "D": column = Math.max(0, column - first); break;
      case "G": column = Math.max(0, first - 1); break;
      case "H":
      case "f": column = Math.max(0, second - 1); break;
      case "A": break;
    }
    offset = (match.index ?? 0) + match[0].length;
  }
  column += visibleWidth(prefix.slice(offset));
  return Math.min(maximum - 1, Math.max(0, column));
}

function imageCursorUp(prefix: string): number | undefined {
  let rows = 0;
  let found = false;
  for (const match of prefix.matchAll(terminalPattern("\\u001b\\[(\\d*)A", "gu"))) {
    rows += Number(match[1] || 1);
    found = true;
  }
  return found ? rows : undefined;
}

function imageReservation(
  row: number,
  column: number,
  rows: number,
  columns: number,
  lineCount: number,
  blockColumns: number,
): TuiRuntimeSurfaceImageReservation | undefined {
  const selectedRows = Math.min(rows, lineCount - row);
  const selectedColumns = Math.min(columns, blockColumns - column);
  if (selectedRows < 1 || selectedColumns < 1) return undefined;
  return Object.freeze({ row, column, rows: selectedRows, columns: selectedColumns });
}

/** @internal Parse occupied terminal-image cells from already validated raw frame rows. */
export function projectTuiRawImageReservations(
  lines: readonly string[],
  columns: number,
): readonly TuiRuntimeSurfaceImageReservation[] {
  const reservations: TuiRuntimeSurfaceImageReservation[] = [];
  for (const [lineRow, line] of lines.entries()) {
    if (!isImageLine(line)) continue;
    for (const match of line.matchAll(terminalPattern("\\u001b_G([^;]*);", "gu"))) {
      const imageColumns = positiveImageParameter(match[1] ?? "", ",", "c", MAX_COLUMNS);
      const imageRows = positiveImageParameter(match[1] ?? "", ",", "r", MAX_ROWS);
      if (imageColumns === undefined && imageRows === undefined) continue;
      const column = imageColumn(line.slice(0, match.index), columns);
      const reservation = imageReservation(
        lineRow,
        column,
        imageRows ?? 1,
        imageColumns ?? columns - column,
        lines.length,
        columns,
      );
      if (reservation !== undefined) reservations.push(reservation);
    }
    for (const match of line.matchAll(terminalPattern("\\u001b\\]1337;File=([^:\\u0007]*):", "gu"))) {
      const parameters = match[1] ?? "";
      if (!parameters.split(";").includes("inline=1")) continue;
      const prefix = line.slice(0, match.index);
      const cursorUp = imageCursorUp(prefix);
      const imageRows = positiveImageParameter(parameters, ";", "height", MAX_ROWS) ?? (cursorUp ?? 0) + 1;
      const imageColumns = positiveImageParameter(parameters, ";", "width", MAX_COLUMNS);
      const row = Math.max(0, lineRow - (cursorUp ?? imageRows - 1));
      const column = imageColumn(prefix, columns);
      const reservation = imageReservation(
        row,
        column,
        imageRows,
        imageColumns ?? columns - column,
        lines.length,
        columns,
      );
      if (reservation !== undefined) reservations.push(reservation);
    }
  }
  return Object.freeze(reservations);
}

function rawBlock(
  value: TuiRawBlock,
  columns: number,
  maximumLines: number,
  maximumBytes: number,
): TuiRuntimeSurfaceBlock {
  const block = object(value, "Raw UI block");
  exact(block, ["lines", "cursor"], "Raw UI block");
  if (!Array.isArray(block.lines)) throw new TypeError("Raw UI block lines must be an array");
  if (block.lines.length > maximumLines) throw new RangeError(`Raw UI block exceeds ${maximumLines} lines`);
  let bytes = 0;
  const lines = block.lines.map((line, index) => {
    if (!isStringValue(line)) throw new TypeError(`Raw UI line ${index} must be a string`);
    if (line.includes("\n") || line.includes("\r")) throw new TypeError(`Raw UI line ${index} contains a line break`);
    bytes += Buffer.byteLength(line, "utf8");
    if (bytes > maximumBytes) throw new RangeError(`Raw UI block exceeds ${maximumBytes} bytes`);
    return truncateToWidth(line, columns);
  });
  const imageReservations = projectTuiRawImageReservations(lines, columns);
  const cursor = clampedCursor(block.cursor, lines, columns, "Raw UI cursor", false);
  return Object.freeze({
    source: "raw",
    lines: Object.freeze(lines),
    fill: Object.freeze(lines.map(() => false)),
    ...optionalProperties(cursor === undefined ? undefined : { cursor }),
    ...optionalProperties(imageReservations.length === 0 ? undefined : { imageReservations }),
  });
}

function renderRuntimeUiLine(line: RuntimeUiLine, columns: number, theme: Theme | undefined): string {
  const selected = line.spans.map((span) => {
    const role = span.role ?? "muted";
    if (theme === undefined) return span.text;
    return role === "toolError"
      ? theme.fg("error", span.text)
      : nativeStyle(theme, role, span.text);
  }).join("");
  return truncateToWidth(selected, columns);
}

export function projectRuntimeUiBlock(
  value: RuntimeUiBlock,
  options: Readonly<{
    columns: number;
    maxLines?: number;
    maxBytes?: number;
    theme?: Theme;
  }>,
): TuiRuntimeSurfaceBlock {
  const columns = dimension(options.columns, MAX_COLUMNS, "Runtime UI width");
  const safe = structuredBlock(
    value,
    columns,
    lineLimit(options.maxLines),
    byteLimit(options.maxBytes),
  );
  const lines = safe.lines.map((line) => renderRuntimeUiLine(line, columns, options.theme));
  // SAFETY: the private symbol property is written only by the controller's structured block bridge.
  const candidate = (value as TuiPersistentPointerBlock)[INTERNAL_TUI_PERSISTENT_POINTER_SOURCE];
  const pointerSource = candidate !== undefined
      && isObjectValue(candidate.token)
      && candidate.rows.length === lines.length
      && candidate.rows.every((row) => row === undefined || (Number.isSafeInteger(row) && row >= 0))
    ? Object.freeze({ token: candidate.token, rows: Object.freeze([...candidate.rows]) })
    : undefined;
  return Object.freeze({
    source: "structured",
    lines: Object.freeze(lines),
    fill: Object.freeze(safe.lines.map((line) => line.fill === true)),
    ...optionalProperties(safe.cursor === undefined ? undefined : { cursor: safe.cursor }),
    ...optionalProperties(pointerSource === undefined ? undefined : {
      [INTERNAL_TUI_PERSISTENT_POINTER_SOURCE]: pointerSource,
    }),
  });
}

export function projectTuiRawBlock(
  value: TuiRawBlock,
  options: Readonly<{ columns: number; maxLines?: number; maxBytes?: number }>,
): TuiRuntimeSurfaceBlock {
  const columns = dimension(options.columns, MAX_COLUMNS, "Raw UI width");
  return rawBlock(
    value,
    columns,
    lineLimit(options.maxLines),
    byteLimit(options.maxBytes),
  );
}

function blockRows(block: TuiRuntimeSurfaceBlock): number {
  return block.lines.length;
}

function croppedImageReservations(
  reservations: readonly TuiRuntimeSurfaceImageReservation[] | undefined,
  start: number,
  end: number,
): readonly TuiRuntimeSurfaceImageReservation[] {
  if (reservations === undefined) return Object.freeze([]);
  return Object.freeze(reservations.flatMap((reservation) => {
    const top = Math.max(start, reservation.row);
    const bottom = Math.min(end, reservation.row + reservation.rows);
    return bottom <= top
      ? []
      : [Object.freeze({
          ...reservation,
          row: top - start,
          rows: bottom - top,
        })];
  }));
}

function tailBlocks(
  values: readonly TuiRuntimeSurfaceBlock[],
  maximumLines: number,
  replacement: TuiRuntimeSurfaceSlot["replacement"] = false,
): TuiRuntimeSurfaceSlot {
  const total = values.reduce((sum, block) => sum + blockRows(block), 0);
  let omitted = Math.max(0, total - maximumLines);
  const selected: TuiRuntimeSurfaceBlock[] = [];
  for (const block of values) {
    if (omitted >= block.lines.length) {
      omitted -= block.lines.length;
      continue;
    }
    if (omitted === 0) {
      selected.push(block);
      continue;
    }
    const start = omitted;
    omitted = 0;
    const cursor = block.cursor === undefined || block.cursor.row < start
      ? undefined
      : Object.freeze({ row: block.cursor.row - start, column: block.cursor.column });
    const imageReservations = croppedImageReservations(block.imageReservations, start, block.lines.length);
    const {
      cursor: _cursor,
      imageReservations: _imageReservations,
      [INTERNAL_TUI_PERSISTENT_POINTER_SOURCE]: pointerSource,
      ...withoutCursor
    } = block;
    const croppedPointerSource = pointerSource === undefined
      ? undefined
      : Object.freeze({ token: pointerSource.token, rows: Object.freeze(pointerSource.rows.slice(start)) });
    selected.push(Object.freeze({
      ...withoutCursor,
      lines: Object.freeze(block.lines.slice(start)),
      fill: Object.freeze(block.fill.slice(start)),
      ...optionalProperties(cursor === undefined ? undefined : { cursor }),
      ...optionalProperties(imageReservations.length === 0 ? undefined : { imageReservations }),
      ...optionalProperties(croppedPointerSource === undefined ? undefined : {
        [INTERNAL_TUI_PERSISTENT_POINTER_SOURCE]: croppedPointerSource,
      }),
    }));
  }
  return Object.freeze({
    blocks: Object.freeze(selected),
    replacement,
    omittedLines: Math.max(0, total - maximumLines),
  });
}

function projectedText(
  value: string,
  columns: number,
  role: ThemeRole,
  maximumLines: number,
  theme: Theme | undefined,
): TuiRuntimeSurfaceBlock {
  const inner = Math.max(1, columns - 2);
  const safe = byteTruncate(sanitizeTerminalText(value), MAX_EXTENSION_BYTES - 1);
  const lines = wrapCells(safe, inner).slice(0, maximumLines).map((line) => ({
    spans: [{ text: truncateCells(`${columns > 1 ? " " : ""}${line}`, columns, ""), role }],
  }));
  return projectRuntimeUiBlock({ lines }, {
    columns,
    maxLines: maximumLines,
    maxBytes: MAX_EXTENSION_BYTES,
    ...optionalProperties(theme === undefined ? undefined : { theme }),
  });
}

function projectedTextValues(
  values: readonly string[] | undefined,
  columns: number,
  role: ThemeRole,
  theme: Theme | undefined,
): TuiRuntimeSurfaceBlock[] {
  return (values ?? []).slice(-MAX_EXTENSION_VALUES).map((value, index) => {
    if (!isStringValue(value)) throw new TypeError(`Runtime text surface ${index} must be a string`);
    return projectedText(value, columns, role, MAX_EXTENSION_LINES, theme);
  });
}

function structuredSlot(
  values: readonly RuntimeUiBlock[] | undefined,
  columns: number,
  theme: Theme | undefined,
): TuiRuntimeSurfaceBlock[] {
  if (values !== undefined && !Array.isArray(values)) throw new TypeError("Runtime UI slot must be an array");
  return (values ?? []).slice(-MAX_SLOT_COMPONENTS).map((value) => projectRuntimeUiBlock(value, {
    columns,
    maxLines: MAX_SLOT_SOURCE_LINES,
    maxBytes: MAX_SLOT_SOURCE_BYTES,
    ...optionalProperties(theme === undefined ? undefined : { theme }),
  }));
}

function rawSlot(
  values: readonly TuiRawBlock[] | undefined,
  columns: number,
): TuiRuntimeSurfaceBlock[] {
  if (values !== undefined && !Array.isArray(values)) throw new TypeError("Raw UI slot must be an array");
  return (values ?? []).slice(-MAX_SLOT_COMPONENTS).map((value) => projectTuiRawBlock(value, {
    columns,
    maxLines: MAX_SLOT_SOURCE_LINES,
    maxBytes: DEFAULT_RUNTIME_UI_MAX_BYTES,
  }));
}

function replacementSlot(
  raw: TuiRawBlock | undefined,
  structured: RuntimeUiBlock | undefined,
  columns: number,
  theme: Theme | undefined,
): TuiRuntimeSurfaceSlot | undefined {
  if (raw !== undefined) {
    return tailBlocks([projectTuiRawBlock(raw, { columns, maxLines: MAX_SLOT_LINES })], MAX_SLOT_LINES, "raw");
  }
  if (structured !== undefined) {
    return tailBlocks([projectRuntimeUiBlock(structured, {
      columns,
      maxLines: MAX_SLOT_LINES,
      ...optionalProperties(theme === undefined ? undefined : { theme }),
    })], MAX_SLOT_LINES, "structured");
  }
  return undefined;
}

function spinner(
  options: TuiWorkingIndicatorOptions | undefined,
  activityFrame: number | undefined,
  unicode: boolean,
): string | undefined {
  if (options?.hidden === true) return undefined;
  const frames = options?.frames ?? (unicode ? DEFAULT_UNICODE_SPINNER_FRAMES : DEFAULT_ASCII_SPINNER_FRAMES);
  if (!Array.isArray(frames) || frames.length < 1 || frames.length > 32) {
    throw new RangeError("Working indicator frames must contain 1-32 values");
  }
  const safe = frames.map((frame, index) => {
    if (!isStringValue(frame)) throw new TypeError(`Working indicator frame ${index} must be a string`);
    const selected = truncateCells(sanitizeTerminalText(frame).replaceAll("\n", " "), 16, "").trim();
    if (selected === "") throw new TypeError(`Working indicator frame ${index} is empty`);
    return selected;
  });
  const selectedFrame = Number.isSafeInteger(activityFrame) ? Math.abs(activityFrame ?? 0) : 0;
  return safe[selectedFrame % safe.length];
}

function indicatorBlocks(
  view: TuiViewState,
  columns: number,
  theme: Theme | undefined,
  unicode: boolean,
): Pick<TuiRuntimeSurfaceProjection, "extensionStatus" | "working"> {
  const status = view.context.extensionStatus?.trim();
  const activity = view.context.activity;
  const visible = activity !== undefined && view.context.active === true && view.context.workingVisible !== false;
  const explicitWorkingMessage = view.context.workingMessage?.trim();
  const elapsed = activity === undefined || explicitWorkingMessage !== undefined || !Number.isFinite(activity.startedAt)
    ? undefined
    : elapsedText(Math.max(0, Date.now() - activity.startedAt));
  const retryDelay = activity?.retryAt === undefined || explicitWorkingMessage !== undefined
    ? undefined
    : `${(Math.max(0, activity.retryAt - Date.now()) / 1_000).toFixed(1)}s`;
  const retry = retryDelay === undefined
    ? undefined
    : `${activity?.attempt === undefined ? "retry" : `attempt ${activity.attempt}`} in ${retryDelay}`;
  const workingMessage = explicitWorkingMessage ?? [
    activity?.phase.trim(),
    elapsed,
    retry,
    activity?.cancellable === true ? "Esc to cancel" : undefined,
  ].filter((value): value is string => value !== undefined && value !== "").join(unicode ? " · " : " | ");
  const workingFrame = visible ? spinner(view.workingIndicator, view.context.activityFrame, unicode) : undefined;
  const working = visible && workingMessage !== undefined && workingMessage !== ""
    ? projectedText([workingFrame, workingMessage].filter(Boolean).join(" "), columns, "working", 1, theme)
    : undefined;
  return {
    ...optionalProperties(status === undefined || status === "" ? undefined : {
      extensionStatus: projectedText(status, columns, "muted", 1, theme),
    }),
    ...optionalProperties(working === undefined ? undefined : { working }),
  };
}

function margins(options: RuntimeUiOverlayOptions): OverlayMargins {
  const value = options.margin;
  if (isNumberValue(value)) return { top: value, right: value, bottom: value, left: value };
  return {
    top: value?.top ?? 0,
    right: value?.right ?? 0,
    bottom: value?.bottom ?? 0,
    left: value?.left ?? 0,
  };
}

function coordinate(value: RuntimeUiOverlayLength | undefined, origin: number, available: number): number | undefined {
  if (value === undefined) return undefined;
  if (isNumberValue(value)) return value;
  const match = /^(\d{1,3}(?:\.\d+)?)%$/u.exec(value);
  const percentage = Number(match?.[1]);
  if (match === null || !Number.isFinite(percentage) || percentage < 0 || percentage > 100) {
    throw new TypeError("Runtime overlay coordinate is invalid");
  }
  return origin + Math.floor(available * percentage / 100);
}

function overlayPosition(
  options: RuntimeUiOverlayOptions,
  frameWidth: number,
  frameHeight: number,
  overlayWidth: number,
  overlayHeight: number,
): OverlayPosition {
  const margin = margins(options);
  for (const [label, value] of Object.entries(margin)) {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`Runtime overlay ${label} margin is invalid`);
  }
  const left = Math.min(frameWidth - 1, margin.left);
  const right = Math.max(left + 1, frameWidth - Math.min(frameWidth - left - 1, margin.right));
  const top = Math.min(frameHeight - 1, margin.top);
  const bottom = Math.max(top + 1, frameHeight - Math.min(frameHeight - top - 1, margin.bottom));
  const horizontalSpace = Math.max(0, right - left - overlayWidth);
  const verticalSpace = Math.max(0, bottom - top - overlayHeight);
  const anchor = options.anchor ?? "center";
  if (![
    "top-left", "top-center", "top-right",
    "left-center", "center", "right-center",
    "bottom-left", "bottom-center", "bottom-right",
  ].includes(anchor)) throw new TypeError("Runtime overlay anchor is invalid");
  const anchoredColumn = anchor.endsWith("left") || anchor === "left-center"
    ? 0
    : anchor.endsWith("right") || anchor === "right-center"
      ? horizontalSpace
      : Math.floor(horizontalSpace / 2);
  const anchoredRow = anchor.startsWith("top")
    ? 0
    : anchor.startsWith("bottom")
      ? verticalSpace
      : Math.floor(verticalSpace / 2);
  const explicitColumn = coordinate(options.col, left, horizontalSpace);
  const explicitRow = coordinate(options.row, top, verticalSpace);
  const offsetX = options.offsetX ?? 0;
  const offsetY = options.offsetY ?? 0;
  if (!Number.isSafeInteger(offsetX) || !Number.isSafeInteger(offsetY)) {
    throw new TypeError("Runtime overlay offsets must be safe integers");
  }
  return {
    row: Math.max(top, Math.min(bottom - overlayHeight, (explicitRow ?? top + anchoredRow) + offsetY)),
    column: Math.max(left, Math.min(right - overlayWidth, (explicitColumn ?? left + anchoredColumn) + offsetX)),
  };
}

function overlayProjection<Block>(
  value: OverlayValue<Block>,
  projectBlock: (block: Block, width: number) => TuiRuntimeSurfaceBlock,
  columns: number,
  rows: number,
): TuiRuntimeOverlayProjection {
  if (!Number.isSafeInteger(value.width) || value.width < 1) throw new RangeError("Runtime overlay width is invalid");
  if (!isBooleanValue(value.focused)) throw new TypeError("Runtime overlay focus state must be boolean");
  const margin = margins(value.options);
  const availableWidth = Math.max(1, columns - margin.left - margin.right);
  const availableHeight = Math.max(1, rows - margin.top - margin.bottom);
  const width = Math.max(1, Math.min(availableWidth, value.width));
  const block = projectBlock(value.block, width);
  const height = Math.min(availableHeight, block.lines.length);
  if (height < 1) throw new RangeError("Runtime overlay must render at least one line");
  const position = overlayPosition(value.options, columns, rows, width, height);
  const cursor = value.focused
    ? Object.freeze({
        row: position.row + Math.min(height - 1, block.cursor?.row ?? 0),
        column: position.column + Math.min(width - 1, block.cursor?.column ?? 0),
      })
    : undefined;
  return Object.freeze({
    block,
    focused: value.focused,
    row: position.row,
    column: position.column,
    width,
    height,
    ...optionalProperties(cursor === undefined ? undefined : { cursor }),
  });
}

export function projectTuiRuntimeSurfaces(
  view: TuiViewState,
  size: Readonly<{
    columns: number;
    rows: number;
    theme?: Theme;
    unicode?: boolean;
  }>,
): TuiRuntimeSurfaceProjection {
  const columns = dimension(size.columns, MAX_COLUMNS, "Runtime surface width");
  const rows = dimension(size.rows, MAX_ROWS, "Runtime surface height");
  const theme = size.theme;

  const headerReplacement = replacementSlot(
    view.rawHeaderReplacement,
    view.runtimeHeaderReplacement,
    columns,
    theme,
  );
  const footerReplacement = replacementSlot(
    view.rawFooterReplacement,
    view.runtimeFooterReplacement,
    columns,
    theme,
  );
  const header = headerReplacement ?? tailBlocks([
    ...projectedTextValues(view.context.extensionHeaders, columns, "accent", theme),
    ...structuredSlot(view.runtimeHeaderComponents, columns, theme),
    ...rawSlot(view.rawHeaderComponents, columns),
  ], MAX_SLOT_LINES);
  const footer = footerReplacement ?? tailBlocks([
    ...projectedTextValues(view.context.extensionFooters, columns, "muted", theme),
    ...structuredSlot(view.runtimeFooterComponents, columns, theme),
    ...rawSlot(view.rawFooterComponents, columns),
  ], MAX_SLOT_LINES);
  const widget = tailBlocks([
    ...projectedTextValues(view.context.widgets, columns, "accent", theme),
    ...structuredSlot(view.runtimeWidgetComponents, columns, theme),
    ...rawSlot(view.rawWidgetComponents, columns),
  ], MAX_SLOT_LINES);
  const widgetBelow = tailBlocks([
    ...structuredSlot(view.runtimeWidgetBelowComponents, columns, theme),
    ...rawSlot(view.rawWidgetBelowComponents, columns),
  ], MAX_SLOT_LINES);

  const rawEditor = view.rawEditorBlock === undefined
    ? undefined
    : projectTuiRawBlock(view.rawEditorBlock, { columns, maxLines: MAX_EDITOR_LINES });
  const structuredEditor = view.editorBlock === undefined
    ? undefined
    : projectRuntimeUiBlock(view.editorBlock, {
        columns,
        maxLines: MAX_EDITOR_LINES,
        ...optionalProperties(theme === undefined ? undefined : { theme }),
      });
  const editor = rawEditor ?? structuredEditor;

  const runtime = view.rawRuntimeComponent !== undefined
    ? projectTuiRawBlock(view.rawRuntimeComponent, { columns, maxLines: MAX_ROWS })
    : view.runtimeComponent === undefined
      ? undefined
      : projectRuntimeUiBlock(view.runtimeComponent, {
          columns,
          maxLines: MAX_ROWS,
          ...optionalProperties(theme === undefined ? undefined : { theme }),
        });

  const overlays = [
    ...(view.runtimeOverlays ?? []).map((overlay) => overlayProjection(
      overlay,
      (block, width) => projectRuntimeUiBlock(block, {
        columns: width,
        maxLines: MAX_ROWS,
        ...optionalProperties(theme === undefined ? undefined : { theme }),
      }),
      columns,
      rows,
    )),
    ...(view.runtimeOverlay === undefined
      ? []
      : [overlayProjection(
          view.runtimeOverlay,
          (block, width) => projectRuntimeUiBlock(block, {
            columns: width,
            maxLines: MAX_ROWS,
            ...optionalProperties(theme === undefined ? undefined : { theme }),
          }),
          columns,
          rows,
        )]),
    ...(view.rawRuntimeOverlays ?? []).map((overlay) => overlayProjection(
      overlay,
      (block, width) => projectTuiRawBlock(block, { columns: width, maxLines: MAX_ROWS }),
      columns,
      rows,
    )),
  ];
  const focusedOverlay = overlays.filter((overlay) => overlay.focused).at(-1);
  const indicators = indicatorBlocks(view, columns, theme, size.unicode !== false);

  return Object.freeze({
    columns,
    rows,
    header,
    footer,
    widget,
    widgetBelow,
    ...optionalProperties(editor === undefined ? undefined : { editor }),
    ...optionalProperties(runtime === undefined ? undefined : { runtime }),
    ...indicators,
    overlays: Object.freeze(overlays),
    ...optionalProperties(focusedOverlay === undefined ? undefined : { focusedOverlay }),
  });
}
