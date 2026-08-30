import { optionalProperties } from "../../core/optional-properties.js";
import {
  byteTruncate,
  cellWidth,
  graphemeWidth,
  padCells,
  sanitizeTerminalText,
  splitGraphemes,
  stripAnsi,
  truncateCells,
  wrapCells,
} from "@ohm/terminal";
import type { Theme, ThemeRole } from "../theme.js";
import type { PickerKind, TuiViewState } from "../types.js";
import { nativeStyle } from "./style.js";

const MAX_COLUMNS = 500;
const MAX_ROWS = 200;
const MAX_ITEMS = 5_000;
const MAX_ITEM_BYTES = 16 * 1024;
const MAX_QUERY_BYTES = 256 * 1024;
const MAX_METADATA_ENTRIES = 32;
const MAX_VISIBLE_ROWS = 20;
const CURSOR_SENTINEL = "\u2063";
const CURSOR_CELL = "\ue000";
export interface NativeOverlayItemSnapshot {
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
  readonly description?: string;
  readonly tree?: { readonly active: boolean };
}

/** Renderer-neutral, bounded state for one controller-owned picker. */
export interface NativeOverlaySnapshot {
  readonly title: string;
  readonly pickerKind: PickerKind;
  readonly inline: boolean;
  readonly settings: boolean;
  readonly selectedDescription?: string;
  readonly states: readonly string[];
  readonly queryLabel: string;
  readonly query: string;
  /** Grapheme offset in query. Defaults to the end when omitted by a caller. */
  readonly queryCursor: number;
  readonly selected: number;
  readonly items: readonly NativeOverlayItemSnapshot[];
  readonly hints: readonly string[];
  readonly status?: string;
  readonly emptyMessage?: string;
  readonly maxVisible?: number;
}

export interface NativeOverlayProps {
  readonly snapshot: NativeOverlaySnapshot;
  readonly columns: number;
  readonly rows: number;
  readonly theme?: Theme;
  readonly unicode?: boolean;
}

export interface NativeOverlayProjection {
  readonly text: string;
  /** One-based filter cursor coordinates; inline completion has no filter cursor. */
  readonly cursor?: { readonly row: number; readonly column: number };
}

type OverlayRole = "title" | "accent" | "selection" | "muted" | "normal";

interface OverlayLine {
  readonly text: string;
  readonly role: OverlayRole;
}

interface OverlayLayout {
  readonly lines: readonly OverlayLine[];
  readonly cursor?: { readonly row: number; readonly column: number };
}

interface OverlayPresentation {
  readonly theme?: Theme;
  readonly unicode: boolean;
  readonly selected: string;
  readonly active: string;
  readonly detailSeparator: string;
  readonly separator: string;
  readonly ellipsis: string;
}

function overlayPresentation(theme: Theme | undefined, unicodeOverride: boolean | undefined): OverlayPresentation {
  const unicode = unicodeOverride ?? theme?.unicode ?? true;
  if (theme !== undefined && unicode) {
    return {
      theme,
      unicode,
      selected: theme.glyphs.user,
      active: theme.glyphs.success,
      detailSeparator: " — ",
      separator: " · ",
      ellipsis: "…",
    };
  }
  if (!unicode) {
    return {
      ...optionalProperties(theme === undefined ? undefined : { theme }),
      unicode,
      selected: ">",
      active: "+",
      detailSeparator: " - ",
      separator: " | ",
      ellipsis: "...",
    };
  }
  return {
    unicode,
    selected: "›",
    active: "●",
    detailSeparator: " — ",
    separator: " · ",
    ellipsis: "…",
  };
}

function themed(theme: Theme | undefined, role: ThemeRole, value: string): string {
  return theme === undefined ? value : nativeStyle(theme, role, value);
}

function clipped(value: string, width: number, presentation: OverlayPresentation): string {
  const tail = presentation.unicode
    ? presentation.ellipsis
    : ".".repeat(Math.max(0, Math.min(3, width)));
  return truncateCells(value, width, tail);
}

function dimension(value: number, maximum: number): number {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, maximum) : 1;
}

function cleanText(value: string, maximum: number): string {
  return byteTruncate(sanitizeTerminalText(value), maximum)
    .replaceAll(CURSOR_SENTINEL, "")
    .replaceAll(CURSOR_CELL, "");
}

function cleanLine(value: string, maximum = MAX_ITEM_BYTES): string {
  return cleanText(value, maximum).replaceAll(/\s*\n\s*/gu, " ");
}

function cleanOptionalLine(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const selected = cleanLine(value);
  return selected === "" ? undefined : selected;
}

interface CleanQuery {
  query: string;
  cursor: number;
}

interface QueryViewport {
  text: string;
  cursorColumn: number;
}

function cleanQuery(value: string, cursor: number | undefined): CleanQuery {
  const source = splitGraphemes(value);
  const requested = cursor === undefined || !Number.isFinite(cursor)
    ? source.length
    : Math.max(0, Math.trunc(cursor));
  const query = cleanLine(value, MAX_QUERY_BYTES);
  const cleanPrefix = cleanLine(source.slice(0, requested).join(""), MAX_QUERY_BYTES);
  return {
    query,
    cursor: Math.min(splitGraphemes(query).length, splitGraphemes(cleanPrefix).length),
  };
}

function normalizeItem(item: NativeOverlayItemSnapshot): NativeOverlayItemSnapshot {
  const detail = cleanOptionalLine(item.detail);
  const description = cleanOptionalLine(item.description);
  return {
    id: cleanLine(item.id),
    label: cleanLine(item.label),
    ...optionalProperties(detail === undefined ? undefined : { detail }),
    ...optionalProperties(description === undefined ? undefined : { description }),
    ...optionalProperties(item.tree === undefined ? undefined : { tree: { active: item.tree.active === true } }),
  };
}

/** Sanitize and bound an already renderer-neutral overlay snapshot. */
export function normalizeNativeOverlaySnapshot(
  snapshot: NativeOverlaySnapshot,
): NativeOverlaySnapshot {
  const items = snapshot.items.slice(0, MAX_ITEMS).map(normalizeItem);
  const selected = items.length === 0
    ? 0
    : Math.max(0, Math.min(items.length - 1, Math.trunc(snapshot.selected) || 0));
  const query = cleanQuery(snapshot.query, snapshot.queryCursor);
  const maxVisible = snapshot.maxVisible === undefined || !Number.isFinite(snapshot.maxVisible)
    ? undefined
    : Math.max(1, Math.min(MAX_VISIBLE_ROWS, Math.trunc(snapshot.maxVisible)));
  const states = snapshot.states.slice(0, MAX_METADATA_ENTRIES)
    .map((state) => cleanLine(state))
    .filter((state) => state.trim() !== "");
  const hints = snapshot.hints.slice(0, MAX_METADATA_ENTRIES)
    .map((hint) => cleanLine(hint))
    .filter((hint) => hint.trim() !== "");
  const selectedDescription = cleanOptionalLine(snapshot.selectedDescription);
  const normalizedStatus = cleanOptionalLine(snapshot.status);
  const emptyMessage = cleanOptionalLine(snapshot.emptyMessage);
  return {
    title: cleanLine(snapshot.title),
    pickerKind: snapshot.pickerKind,
    inline: snapshot.inline === true,
    settings: snapshot.settings === true,
    ...optionalProperties(selectedDescription === undefined ? undefined : { selectedDescription }),
    states,
    queryLabel: cleanLine(snapshot.queryLabel),
    query: query.query,
    queryCursor: query.cursor,
    selected,
    items,
    hints,
    ...optionalProperties(normalizedStatus === undefined ? undefined : { status: normalizedStatus }),
    ...optionalProperties(emptyMessage === undefined ? undefined : { emptyMessage }),
    ...optionalProperties(maxVisible === undefined ? undefined : { maxVisible }),
  };
}

/** Project the controller's existing overlay shape into the renderer-neutral form. */
export function createNativeOverlaySnapshot(
  overlay: NonNullable<TuiViewState["overlay"]>,
  queryCursor = overlay.queryCursor,
): NativeOverlaySnapshot {
  return normalizeNativeOverlaySnapshot({
    title: overlay.title,
    pickerKind: overlay.pickerKind ?? "generic",
    inline: overlay.inline === true,
    settings: overlay.settings === true,
    ...optionalProperties(overlay.selectedDescription === undefined ? undefined : { selectedDescription: overlay.selectedDescription }),
    states: overlay.states ?? [],
    queryLabel: overlay.queryLabel ?? "Filter ",
    query: overlay.query,
    queryCursor: queryCursor ?? splitGraphemes(overlay.query).length,
    selected: overlay.selected,
    items: overlay.items.map((item) => ({
      id: item.id,
      label: item.label,
      ...optionalProperties(item.detail === undefined ? undefined : { detail: item.detail }),
      ...optionalProperties(item.description === undefined ? undefined : { description: item.description }),
      ...optionalProperties(item.tree === undefined ? undefined : { tree: { active: item.tree.active } }),
    })),
    hints: overlay.hints ?? [],
    ...optionalProperties(overlay.status === undefined ? undefined : { status: overlay.status }),
    ...optionalProperties(overlay.emptyMessage === undefined ? undefined : { emptyMessage: overlay.emptyMessage }),
    ...optionalProperties(overlay.maxVisible === undefined ? undefined : { maxVisible: overlay.maxVisible }),
  });
}

function tailCells(value: string, maximum: number): string {
  if (maximum <= 0) return "";
  const graphemes = splitGraphemes(value);
  let width = 0;
  const selected: string[] = [];
  for (let index = graphemes.length - 1; index >= 0; index -= 1) {
    const grapheme = graphemes[index]!;
    const next = graphemeWidth(grapheme);
    if (width + next > maximum) break;
    selected.push(grapheme);
    width += next;
  }
  return selected.reverse().join("");
}

function twoColumns(
  left: string,
  right: string,
  width: number,
  presentation: OverlayPresentation,
): string {
  if (width <= 0) return "";
  if (right === "") return clipped(left, width, presentation);
  const rightText = clipped(right, width, presentation);
  if (cellWidth(rightText) >= width) return rightText;
  const gap = width - cellWidth(rightText) >= 3 ? 2 : 1;
  const leftWidth = Math.max(0, width - cellWidth(rightText) - gap);
  const leftText = clipped(left, leftWidth, presentation);
  return `${leftText}${" ".repeat(Math.max(1, width - cellWidth(leftText) - cellWidth(rightText)))}${rightText}`;
}

function titleLine(
  snapshot: NativeOverlaySnapshot,
  width: number,
  presentation: OverlayPresentation,
): OverlayLine {
  const count = snapshot.items.length === 0 ? "0/0" : `${snapshot.selected + 1}/${snapshot.items.length}`;
  return { text: twoColumns(snapshot.title || "Select", count, width, presentation), role: "title" };
}

function selectedTreeLabel(
  item: NativeOverlayItemSnapshot,
  maximum: number,
  presentation: OverlayPresentation,
): string {
  if (cellWidth(item.label) <= maximum) return item.label;
  const active = item.tree?.active === true ? `${presentation.active} ` : "";
  const suffixWidth = Math.max(0, maximum - cellWidth(active) - cellWidth(presentation.ellipsis));
  return `${active}${presentation.ellipsis}${tailCells(item.label, suffixWidth)}`;
}

function itemLine(
  snapshot: NativeOverlaySnapshot,
  item: NativeOverlayItemSnapshot,
  selected: boolean,
  width: number,
  presentation: OverlayPresentation,
): OverlayLine {
  const marker = selected ? presentation.selected : " ";
  if (width === 1) return { text: selected ? marker : "", role: selected ? "selection" : "muted" };
  const bodyWidth = Math.max(0, width - 2);
  let body: string;
  if (selected && item.tree !== undefined) body = selectedTreeLabel(item, bodyWidth, presentation);
  else if (snapshot.pickerKind === "model") body = clipped(item.label, bodyWidth, presentation);
  else if (snapshot.settings && item.detail !== undefined) {
    body = twoColumns(item.label, item.detail, bodyWidth, presentation);
  }
  else {
    const detail = item.detail === undefined ? "" : `${presentation.detailSeparator}${item.detail}`;
    body = clipped(`${item.label}${detail}`, bodyWidth, presentation);
  }
  return { text: `${marker} ${body}`, role: selected ? "selection" : "muted" };
}

interface OverlayItemWindow {
  readonly lines: OverlayLine[];
}

function itemWindow(
  snapshot: NativeOverlaySnapshot,
  width: number,
  rows: number,
  presentation: OverlayPresentation,
): OverlayItemWindow {
  if (snapshot.items.length === 0) {
    return {
      lines: wrapCells(snapshot.emptyMessage ?? "No matches", width)
        .slice(0, Math.max(1, rows))
        .map((text) => ({ text: truncateCells(text, width), role: "muted" })),
    };
  }
  const available = width < 3 ? 1 : Math.max(1, rows);
  const kindLimit = snapshot.inline ? 5 : snapshot.settings ? 10 : available;
  const visible = Math.max(1, Math.min(
    available,
    snapshot.items.length,
    snapshot.maxVisible ?? kindLimit,
  ));
  const start = Math.max(0, Math.min(
    snapshot.selected - visible + 1,
    snapshot.items.length - visible,
  ));
  const selected = snapshot.items.slice(start, start + visible);
  return {
    lines: selected.map((item, offset) => {
      const index = start + offset;
      return itemLine(snapshot, item, index === snapshot.selected, width, presentation);
    }),
  };
}

function queryViewport(
  snapshot: NativeOverlaySnapshot,
  width: number,
  presentation: OverlayPresentation,
): QueryViewport {
  const prefix = clipped(snapshot.queryLabel || "Filter ", Math.max(0, width - 1), presentation);
  const available = Math.max(1, width - cellWidth(prefix));
  const graphemes = splitGraphemes(snapshot.query);
  const cursor = Math.max(0, Math.min(graphemes.length, snapshot.queryCursor));
  const currentWidth = graphemes[cursor] === undefined ? 1 : graphemeWidth(graphemes[cursor]!);
  const reserve = Math.max(1, Math.min(available, currentWidth));
  const leftBudget = Math.max(0, available - reserve);
  const before = graphemes.slice(0, cursor);
  let left = tailCells(before.join(""), leftBudget);
  if (left !== before.join("") && leftBudget > 0) {
    const ellipsis = clipped(presentation.ellipsis, leftBudget, presentation);
    left = `${ellipsis}${tailCells(before.join(""), Math.max(0, leftBudget - cellWidth(ellipsis)))}`;
  }
  const remaining = Math.max(0, available - cellWidth(left));
  let right = "";
  for (const grapheme of graphemes.slice(cursor)) {
    if (cellWidth(right) + graphemeWidth(grapheme) > remaining) break;
    right += grapheme;
  }
  const text = clipped(`${prefix}${left}${right}`, width, presentation) || presentation.selected;
  return {
    text,
    cursorColumn: Math.min(width - 1, cellWidth(prefix) + cellWidth(left)),
  };
}

function wrappedLines(value: string | undefined, width: number, role: OverlayRole, limit: number): OverlayLine[] {
  if (value === undefined || value === "") return [];
  return wrapCells(value, width).slice(0, limit).map((text) => ({ text: truncateCells(text, width), role }));
}

function selectedDescription(snapshot: NativeOverlaySnapshot): string | undefined {
  const selected = snapshot.items[snapshot.selected];
  return snapshot.selectedDescription
    ?? selected?.description
    ?? (snapshot.pickerKind === "model" ? selected?.detail : undefined);
}

function inlineLayout(
  snapshot: NativeOverlaySnapshot,
  width: number,
  height: number,
  presentation: OverlayPresentation,
): OverlayLayout {
  const pagination: OverlayLine = {
    text: snapshot.items.length === 0 ? "0/0" : `${snapshot.selected + 1}/${snapshot.items.length}`,
    role: "muted",
  };
  const itemRows = height === 1 ? 1 : height - 1;
  const items = itemWindow(snapshot, width, itemRows, presentation);
  const lines = [...items.lines, ...(height > 1 ? [pagination] : [])].slice(0, height);
  return { lines };
}

function fullLayout(
  snapshot: NativeOverlaySnapshot,
  width: number,
  height: number,
  presentation: OverlayPresentation,
): OverlayLayout {
  if (height === 1) {
    const items = itemWindow(snapshot, width, 1, presentation);
    return { lines: items.lines };
  }

  let title: OverlayLine[] = [titleLine(snapshot, width, presentation)];
  let states = wrappedLines(snapshot.states.join(presentation.separator), width, "muted", 2);
  let status = wrappedLines(snapshot.status, width, "accent", 2);
  const query = queryViewport(snapshot, width, presentation);
  const queryLine: OverlayLine = { text: query.text, role: "accent" };
  let description = wrappedLines(selectedDescription(snapshot), width, "normal", 3);
  let hints = snapshot.hints.flatMap((hint) => wrappedLines(hint, width, "muted", 2)).slice(0, 4);

  const metadataCount = () => title.length + states.length + status.length + 1 + description.length + hints.length;
  while (metadataCount() + 1 > height) {
    if (hints.length > 0) hints = hints.slice(0, -1);
    else if (states.length > 0) states = states.slice(0, -1);
    else if (status.length > 0) status = status.slice(0, -1);
    else if (description.length > 0) description = description.slice(0, -1);
    else if (title.length > 0) title = [];
    else break;
  }

  const itemRoom = Math.max(1, height - metadataCount());
  const items = itemWindow(snapshot, width, itemRoom, presentation);
  const prefix = [...title, ...states, ...status, queryLine];
  const lines = [...prefix, ...items.lines, ...description, ...hints].slice(0, height);
  return {
    lines,
    cursor: {
      row: prefix.length - 1,
      column: query.cursorColumn,
    },
  };
}

function overlayLayout(
  snapshot: NativeOverlaySnapshot,
  columns: number,
  rows: number,
  presentation: OverlayPresentation,
): OverlayLayout {
  const width = dimension(columns, MAX_COLUMNS);
  const height = dimension(rows, MAX_ROWS);
  const normalized = normalizeNativeOverlaySnapshot(snapshot);
  return normalized.inline
    ? inlineLayout(normalized, width, height, presentation)
    : fullLayout(normalized, width, height, presentation);
}

function projectOverlayLine(
  line: OverlayLine,
  width: number,
  presentation: OverlayPresentation,
): string {
  const text = truncateCells(line.text, width).trimEnd();
  const selected = line.role === "selection" && presentation.theme !== undefined
    ? padCells(text, width)
    : text;
  if (presentation.theme === undefined) return selected;
  const role: ThemeRole = line.role === "normal" ? "assistant" : line.role;
  return themed(presentation.theme, role, selected);
}

/** Render one deterministic native overlay frame without terminal I/O. */
export function projectNativeOverlay({
  snapshot,
  columns,
  rows,
  theme,
  unicode,
}: NativeOverlayProps): NativeOverlayProjection {
  const width = dimension(columns, MAX_COLUMNS);
  const presentation = overlayPresentation(theme, unicode);
  const layout = overlayLayout(snapshot, width, rows, presentation);
  const text = layout.lines.map((line) => projectOverlayLine(line, width, presentation)).join("\n");
  const plainLines = stripAnsi(text).split("\n");
  if (plainLines.length !== layout.lines.length || plainLines.some((line) => cellWidth(line) > width)) {
    throw new Error("Overlay projection exceeded its terminal bounds");
  }
  return {
    text,
    ...optionalProperties(layout.cursor === undefined ? undefined : {
          cursor: {
            row: layout.cursor.row + 1,
            column: layout.cursor.column + 1,
          },
        }),
  };
}
