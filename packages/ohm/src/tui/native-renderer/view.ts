import {
  byteTail,
  byteTruncate,
  cellWidth,
  graphemeWidth,
  padCells,
  splitGraphemes,
  stripAnsi,
  truncateCells,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
} from "@ohm/terminal";

import { optionalProperties } from "../../core/optional-properties.js";
import { normalizeOhmTuiSnapshot } from "./snapshot.js";
import type {
  OhmTuiSnapshot,
  OhmTuiStatusSnapshot,
  OhmTuiTelemetrySnapshot,
  OhmTuiToolDetail,
  OhmTuiToolEntry,
  OhmTuiToolStatus,
  OhmTuiTranscriptEntry,
} from "./types.js";
import { renderMarkdownMessageLines, type MarkdownRenderedLine } from "../markdown.js";
import { trustedTerminalHyperlink } from "../terminal-image.js";
import { type Theme, type ThemeBg, type ThemeColor, type ThemeRole } from "../theme.js";
import { nativeStyle } from "./style.js";

const CURSOR_SENTINEL = "\u2063";
const CURSOR_CELL = "\ue000";
const COMPOSER_START_SENTINEL = "\u2061";
const COMPOSER_END_SENTINEL = "\u2062";

export interface OhmNativeViewProps {
  readonly snapshot: OhmTuiSnapshot;
  readonly columns: number;
  readonly thinkingExpanded?: boolean;
  readonly toolDetailsExpanded?: boolean;
  readonly toolExpandKeyHint?: string;
  readonly hyperlinks?: boolean;
  readonly codeBlockIndent?: string;
  readonly composerRows?: number;
  readonly promptRows?: number;
  readonly queueRows?: number;
  readonly editorPaddingX?: number;
  readonly theme?: Theme;
  readonly unicode?: boolean;
}

export interface OhmNativeFrameProjection {
  readonly text: string;
  readonly cursor: { readonly row: number; readonly column: number };
  readonly composer: { readonly top: number; readonly bottom: number };
}

interface NativePresentation {
  readonly theme?: Theme;
  readonly unicode: boolean;
  readonly glyphs: {
    readonly thinkingActive: string;
    readonly thinkingCompleted: string;
    readonly pending: string;
    readonly running: string;
    readonly success: string;
    readonly failure: string;
    readonly unknown: string;
    readonly user: string;
    readonly connected: string;
    readonly horizontal: string;
    readonly ellipsis: string;
    readonly branch: string;
  };
  readonly separator: string;
}

interface EntryRenderOptions {
  readonly thinkingExpanded: boolean;
  readonly toolDetailsExpanded: boolean;
  readonly toolExpandKeyHint?: string;
  readonly hyperlinks: boolean;
  readonly codeBlockIndent: string;
  readonly presentation: NativePresentation;
  readonly toolDetailCache: OhmNativeToolDetailCache;
}

function usableWidth(columns: number): number {
  return Number.isFinite(columns) ? Math.max(1, Math.trunc(columns)) : 1;
}

function nativePresentation(theme: Theme | undefined, unicodeOverride: boolean | undefined): NativePresentation {
  const unicode = unicodeOverride ?? theme?.unicode ?? true;
  if (theme !== undefined && unicode) {
    return {
      theme,
      unicode,
      glyphs: {
        thinkingActive: theme.glyphs.assistant,
        thinkingCompleted: theme.glyphs.pending,
        pending: theme.glyphs.pending,
        running: theme.glyphs.tool,
        success: theme.glyphs.success,
        failure: theme.glyphs.failure,
        unknown: theme.glyphs.pending,
        user: theme.glyphs.user,
        connected: theme.glyphs.success,
        horizontal: theme.glyphs.horizontal,
        ellipsis: "…",
        branch: "↳",
      },
      separator: " · ",
    };
  }
  if (!unicode) {
    return {
      ...optionalProperties(theme === undefined ? undefined : { theme }),
      unicode,
      glyphs: {
        thinkingActive: "A",
        thinkingCompleted: ".",
        pending: ".",
        running: ">",
        success: "+",
        failure: "x",
        unknown: "?",
        user: ">",
        connected: "+",
        horizontal: "-",
        ellipsis: ".",
        branch: ">",
      },
      separator: " | ",
    };
  }
  return {
    unicode,
    glyphs: {
      thinkingActive: "✦",
      thinkingCompleted: "◇",
      pending: "○",
      running: "●",
      success: "✓",
      failure: "×",
      unknown: "?",
      user: "›",
      connected: "●",
      horizontal: "─",
      ellipsis: "…",
      branch: "↳",
    },
    separator: " · ",
  };
}

function themed(theme: Theme | undefined, role: ThemeRole, value: string): string {
  return theme === undefined ? value : nativeStyle(theme, role, value);
}

function joinStyledRuns(runs: readonly string[]): string {
  return runs.join("");
}

function wrapAsciiText(value: string, maximum: number, preserveTrailing: boolean): string[] {
  const output: string[] = [];
  for (const physical of value.split("\n")) {
    if (physical.length <= maximum) {
      output.push(preserveTrailing ? physical : physical.trimEnd());
      continue;
    }
    let line = "";
    const finish = (): void => {
      output.push(preserveTrailing ? line : line.trimEnd());
      line = "";
    };
    for (const token of physical.match(/\s+|\S+/gu) ?? []) {
      const whitespace = /^\s+$/u.test(token);
      if (!whitespace && token.length <= maximum && line.length > 0 && line.length + token.length > maximum) {
        finish();
      }
      let offset = 0;
      while (offset < token.length) {
        if (line.length === maximum) finish();
        const available = maximum - line.length;
        const selected = token.slice(offset, offset + available);
        line += selected;
        offset += selected.length;
      }
    }
    output.push(preserveTrailing ? line : line.trimEnd());
  }
  return output.length === 0 ? [""] : output;
}

function wrapNativeText(value: string, width: number, preserveTrailing = false): string[] {
  const maximum = Math.max(1, width);
  if (/^[\x20-\x7e\n]*$/u.test(value)) return wrapAsciiText(value, maximum, preserveTrailing);
  const output: string[] = [];
  for (const physical of value.split("\n")) {
    let line = "";
    let lineWidth = 0;
    const finish = (): void => {
      output.push(preserveTrailing ? line : line.trimEnd());
      line = "";
      lineWidth = 0;
    };
    for (const token of physical.match(/\s+|\S+/gu) ?? []) {
      const tokenWidth = cellWidth(token);
      const whitespace = /^\s+$/u.test(token);
      if (!whitespace && tokenWidth <= maximum && lineWidth > 0 && lineWidth + tokenWidth > maximum) finish();
      for (const grapheme of splitGraphemes(token)) {
        const selectedWidth = graphemeWidth(grapheme);
        if (lineWidth > 0 && lineWidth + selectedWidth > maximum) finish();
        line += grapheme;
        lineWidth += selectedWidth;
      }
    }
    output.push(preserveTrailing ? line : line.trimEnd());
  }
  return output.length === 0 ? [""] : output;
}

function wrapComposerText(value: string, width: number): string[] {
  const maximum = Math.max(1, width);
  const output: string[] = [];
  for (const physical of value.split("\n")) {
    const rows = [""];
    const words = physical.split(" ");
    words.forEach((word, index) => {
      const wordWidth = cellWidth(word);
      let rowWidth = cellWidth(rows.at(-1) ?? "");
      if (index !== 0) {
        if (rowWidth >= maximum) {
          rows.push("");
          rowWidth = 0;
        }
        rows[rows.length - 1] += " ";
        rowWidth += 1;
      }
      if (wordWidth > maximum) {
        const remaining = maximum - rowWidth;
        const breaksHere = 1 + Math.floor((wordWidth - remaining - 1) / maximum);
        const breaksNext = Math.floor((wordWidth - 1) / maximum);
        if (breaksNext < breaksHere) {
          rows.push("");
          rowWidth = 0;
        }
        const graphemes = splitGraphemes(word);
        graphemes.forEach((grapheme, graphemeIndex) => {
          const selectedWidth = graphemeWidth(grapheme);
          if (rowWidth + selectedWidth <= maximum) rows[rows.length - 1] += grapheme;
          else {
            rows.push(grapheme);
            rowWidth = 0;
          }
          rowWidth += selectedWidth;
          if (rowWidth === maximum && graphemeIndex + 1 < graphemes.length) {
            rows.push("");
            rowWidth = 0;
          }
        });
        if (rowWidth === 0 && rows.at(-1) !== "" && rows.length > 1) {
          const trailing = rows.pop();
          const previous = rows.at(-1);
          if (trailing !== undefined && previous !== undefined) rows[rows.length - 1] = previous + trailing;
        }
        return;
      }
      if (rowWidth + wordWidth > maximum && rowWidth > 0 && wordWidth > 0) rows.push("");
      rows[rows.length - 1] += word;
    });
    output.push(...rows);
  }
  return output.length === 0 ? [""] : output;
}

function wrapPresentedText(value: string, width: number, presentation: NativePresentation): string[] {
  const lines = wrapComposerText(value, width);
  return presentation.theme?.ansi === true ? lines : lines.map((line) => line.trimEnd());
}

function singleCellText(value: string, ellipsis: string): string {
  return splitGraphemes(value).map((grapheme) =>
    grapheme !== "\n" && graphemeWidth(grapheme) > 1 ? ellipsis : grapheme).join("");
}

function singleCellEntry(entry: OhmTuiTranscriptEntry, ellipsis: string): OhmTuiTranscriptEntry {
  const single = (value: string): string => singleCellText(value, ellipsis);
  switch (entry.kind) {
    case "user":
    case "assistant":
    case "thinking":
      return { ...entry, text: single(entry.text) };
    case "notice":
      return {
        ...entry,
        text: single(entry.text),
        ...optionalProperties(entry.label === undefined ? undefined : { label: single(entry.label) }),
        ...optionalProperties(entry.compactText === undefined ? undefined : { compactText: single(entry.compactText) }),
      };
    case "tool":
      return {
        ...entry,
        name: single(entry.name),
        ...optionalProperties(entry.headline === undefined ? undefined : { headline: single(entry.headline) }),
        ...optionalProperties(entry.state === undefined ? undefined : { state: single(entry.state) }),
        ...optionalProperties(entry.summary === undefined ? undefined : { summary: single(entry.summary) }),
        ...optionalProperties(entry.input === undefined ? undefined : { input: single(entry.input) }),
        ...optionalProperties(entry.output === undefined ? undefined : { output: single(entry.output) }),
        ...optionalProperties(entry.details === undefined ? undefined : {
          details: entry.details.map((detail) => ({
            ...detail,
            label: single(detail.label),
            value: single(detail.value),
          })),
        }),
      };
  }
}

function lineWidth(columns: number): number {
  return Math.max(0, usableWidth(columns) - 1);
}

function frameRule(label: string, columns: number, horizontal: string): string {
  const width = lineWidth(columns);
  if (width === 0) return "";
  if (label === "" || width < 6) return horizontal.repeat(width);
  const safeLabel = truncateCells(label, width - 4);
  const prefix = `${horizontal} ${safeLabel} `;
  return `${prefix}${horizontal.repeat(Math.max(0, width - cellWidth(prefix)))}`;
}

function entryEqual(left: OhmTuiTranscriptEntry, right: OhmTuiTranscriptEntry): boolean {
  if (left === right) return true;
  if (left.kind !== right.kind || left.id !== right.id) return false;
  if (left.kind === "user" || left.kind === "assistant") {
    return right.kind === left.kind && left.text === right.text;
  }
  if (left.kind === "thinking") {
    return right.kind === "thinking"
      && left.status === right.status
      && left.text === right.text
      && left.expanded === right.expanded;
  }
  if (left.kind === "notice") {
    return right.kind === "notice"
      && left.tone === right.tone
      && left.label === right.label
      && left.text === right.text
      && left.compactText === right.compactText
      && left.expandable === right.expandable
      && left.expanded === right.expanded
      && left.truncated === right.truncated;
  }
  if (right.kind !== "tool") return false;
  if (
    left.name !== right.name
    || left.status !== right.status
    || left.headline !== right.headline
    || left.state !== right.state
    || left.summary !== right.summary
    || left.input !== right.input
    || left.output !== right.output
    || left.expanded !== right.expanded
    || left.truncated !== right.truncated
    || left.details?.length !== right.details?.length
  ) return false;
  return (left.details ?? []).every((detail, index) => {
    const candidate = right.details?.[index];
    return candidate !== undefined
      && detail.label === candidate.label
      && detail.value === candidate.value
      && detail.kind === candidate.kind
      && detail.markdown === candidate.markdown
      && detail.preview === candidate.preview
      && detail.tail === candidate.tail;
  });
}

function optionsEqual(left: EntryRenderOptions, right: EntryRenderOptions): boolean {
  return left.thinkingExpanded === right.thinkingExpanded
    && left.toolDetailsExpanded === right.toolDetailsExpanded
    && left.toolExpandKeyHint === right.toolExpandKeyHint
    && left.hyperlinks === right.hyperlinks
    && left.codeBlockIndent === right.codeBlockIndent
    && left.presentation.theme === right.presentation.theme
    && left.presentation.unicode === right.presentation.unicode;
}

function renderUserMessage(text: string, columns: number, presentation: NativePresentation): string[] {
  const horizontalPadding = columns >= 3 ? 1 : 0;
  const contentWidth = Math.max(1, columns - horizontalPadding * 2);
  const content = presentation.theme === undefined
    ? wrapComposerText(text === "" ? " " : text, contentWidth).map((line) => line.trimEnd())
    : wrapNativeText(text === "" ? " " : text, contentWidth);
  if (presentation.theme === undefined || !presentation.theme.ansi) {
    return [
      "",
      ...content.map((line) => `${" ".repeat(horizontalPadding)}${line}`),
      "",
    ];
  }
  return [
    " ".repeat(columns),
    ...content.map((line) => padCells(`${" ".repeat(horizontalPadding)}${line}`, columns)),
    " ".repeat(columns),
  ].map((line) => themed(presentation.theme, "userMessage", line));
}

function renderThinking(
  entry: Extract<OhmTuiTranscriptEntry, { readonly kind: "thinking" }>,
  columns: number,
  expanded: boolean,
  presentation: NativePresentation,
): string[] {
  const headerLines = wrapPresentedText(
    `${entry.status === "active" ? presentation.glyphs.thinkingActive : presentation.glyphs.thinkingCompleted} Thinking`,
    columns,
    presentation,
  ).map((line) => themed(presentation.theme, "accent", line));
  if (!expanded || entry.text === "") return headerLines;
  const indent = columns >= 4 ? 2 : 0;
  return [
    ...headerLines,
    ...wrapPresentedText(entry.text, Math.max(1, columns - indent), presentation).map((line) =>
      line === "" ? "" : `${" ".repeat(indent)}${themed(presentation.theme, "muted", line)}`),
  ];
}

interface ToolStatusPresentation {
  readonly role: ThemeRole;
  readonly icon: string;
  readonly label: string;
}

function statusPresentation(status: OhmTuiToolStatus, presentation: NativePresentation): ToolStatusPresentation {
  switch (status) {
    case "pending": return { role: "toolPending", icon: presentation.glyphs.pending, label: "pending" };
    case "running": return { role: "toolRunning", icon: presentation.glyphs.running, label: "running" };
    case "completed": return { role: "toolSuccess", icon: presentation.glyphs.success, label: "done" };
    case "error": return { role: "toolError", icon: presentation.glyphs.failure, label: "failed" };
    case "in_doubt": return { role: "warning", icon: presentation.glyphs.unknown, label: "outcome unknown" };
    case "unknown": return { role: "warning", icon: presentation.glyphs.unknown, label: "in doubt" };
  }
}

const COLLAPSED_TOOL_DETAIL_ROWS = 4;
const EXPANDED_TOOL_DETAIL_ROWS = 120;
const MAX_TOOL_DETAIL_WRAP_CACHE_ENTRIES = 8_192;
const MAX_TOOL_DETAIL_WRAP_CACHE_BYTES = 8 * 1024 * 1024;

interface BoundedToolDetailRows<Line> {
  readonly rows: readonly Line[];
  readonly collapseChanges: boolean;
}

interface CachedToolDetailWrap<Line> {
  readonly width: number;
  readonly variant: string;
  readonly count: number;
  readonly head: readonly Line[];
  readonly tail: readonly Line[];
  readonly bytes: number;
}

class ToolDetailWrapCache<Line> {
  readonly #values = new Map<string, CachedToolDetailWrap<Line>[]>();
  readonly #lru = new Map<CachedToolDetailWrap<Line>, string>();
  #bytes = 0;

  has(value: string, width: number, variant: string): boolean {
    return this.#values.get(value)?.some((entry) => entry.width === width && entry.variant === variant) === true;
  }

  get(value: string, width: number, variant: string, render: () => readonly Line[]): CachedToolDetailWrap<Line> {
    const retained = this.#values.get(value)?.find((entry) => entry.width === width && entry.variant === variant);
    if (retained !== undefined) {
      this.#lru.delete(retained);
      this.#lru.set(retained, value);
      return retained;
    }
    const rows = render();
    const head = rows.slice(0, EXPANDED_TOOL_DETAIL_ROWS);
    const tail = rows.slice(-EXPANDED_TOOL_DETAIL_ROWS);
    const bytes = Buffer.byteLength(value, "utf8") + Buffer.byteLength(JSON.stringify([head, tail]), "utf8");
    const created = { width, variant, count: rows.length, head, tail, bytes };
    if (bytes > MAX_TOOL_DETAIL_WRAP_CACHE_BYTES) return created;
    while (
      this.#lru.size >= MAX_TOOL_DETAIL_WRAP_CACHE_ENTRIES
      || this.#bytes + bytes > MAX_TOOL_DETAIL_WRAP_CACHE_BYTES
    ) {
      const oldest = this.#lru.entries().next().value;
      if (oldest === undefined) break;
      const [entry, source] = oldest;
      this.#lru.delete(entry);
      const variants = this.#values.get(source);
      if (variants !== undefined) {
        const index = variants.indexOf(entry);
        if (index >= 0) variants.splice(index, 1);
        if (variants.length === 0) this.#values.delete(source);
      }
      this.#bytes = Math.max(0, this.#bytes - entry.bytes);
    }
    const selected = this.#values.get(value);
    if (selected === undefined) this.#values.set(value, [created]);
    else selected.push(created);
    this.#lru.set(created, value);
    this.#bytes += bytes;
    return created;
  }

  clear(): void {
    this.#values.clear();
    this.#lru.clear();
    this.#bytes = 0;
  }
}

/** @internal Controller-scoped native tool-detail wrap state. */
export class OhmNativeToolDetailCache {
  readonly #plain = new ToolDetailWrapCache<string>();
  readonly #markdown = new ToolDetailWrapCache<MarkdownRenderedLine>();

  hasPlain(value: string, width: number): boolean {
    return this.#plain.has(value, width, "plain");
  }

  getPlain(value: string, width: number, render: () => readonly string[]): CachedToolDetailWrap<string> {
    return this.#plain.get(value, width, "plain", render);
  }

  hasMarkdown(value: string, width: number, codeBlockIndent: string): boolean {
    return this.#markdown.has(value, width, codeBlockIndent);
  }

  getMarkdown(
    value: string,
    width: number,
    codeBlockIndent: string,
    render: () => readonly MarkdownRenderedLine[],
  ): CachedToolDetailWrap<MarkdownRenderedLine> {
    return this.#markdown.get(value, width, codeBlockIndent, render);
  }

  clear(): void {
    this.#plain.clear();
    this.#markdown.clear();
  }
}

/** @internal Creates bounded tool-detail wrap state for one native view/controller. */
export function internalCreateOhmNativeToolDetailCache(): OhmNativeToolDetailCache {
  return new OhmNativeToolDetailCache();
}

function toolDetailContentWidth(columns: number): number {
  const indent = columns >= 5 ? 2 : 0;
  const contentIndent = columns >= 7 ? 4 : indent;
  return Math.max(1, columns - contentIndent);
}

function renderMarkdownToolDetailSource(
  source: string,
  width: number,
  codeBlockIndent: string,
): MarkdownRenderedLine[] {
  return renderMarkdownMessageLines(
    "",
    source,
    width,
    "assistant",
    undefined,
    { codeBlockIndent },
  );
}

/** @internal Populates the exact bounded wrap cache used by expanded native tool details. */
export function internalPrewarmOhmNativeToolDetail(
  detail: OhmTuiToolDetail,
  columns: number,
  codeBlockIndent: string,
  cache: OhmNativeToolDetailCache,
): boolean {
  const width = toolDetailContentWidth(columns);
  if (detail.markdown === true) {
    const retained = cache.hasMarkdown(detail.value, width, codeBlockIndent);
    cache.getMarkdown(
      detail.value,
      width,
      codeBlockIndent,
      () => renderMarkdownToolDetailSource(detail.value, width, codeBlockIndent),
    );
    return !retained;
  }
  const retained = cache.hasPlain(detail.value, width);
  cache.getPlain(
    detail.value,
    width,
    () => wrapNativeText(detail.value, width),
  );
  return !retained;
}

function boundedToolDetailLines(
  detail: OhmTuiToolDetail,
  width: number,
  expanded: boolean,
  ellipsis: string,
  cache: OhmNativeToolDetailCache,
): BoundedToolDetailRows<string> {
  const maximum = expanded ? EXPANDED_TOOL_DETAIL_ROWS : COLLAPSED_TOOL_DETAIL_ROWS;
  const selectedWidth = Math.max(1, width);
  const wrapped = cache.getPlain(
    detail.value,
    selectedWidth,
    () => wrapNativeText(detail.value, selectedWidth),
  );
  const collapseChanges = wrapped.count > COLLAPSED_TOOL_DETAIL_ROWS;
  if (wrapped.count <= maximum) return { rows: wrapped.head.slice(0, wrapped.count), collapseChanges };
  const marker = truncateCells(
    detail.tail === true
      ? `${ellipsis} earlier ${wrapped.count - maximum + 1} rows hidden`
      : `${ellipsis} ${wrapped.count - maximum + 1} more rows`,
    selectedWidth,
    ellipsis,
  );
  return {
    rows: detail.tail === true
      ? [marker, ...wrapped.tail.slice(-(maximum - 1))]
      : [...wrapped.head.slice(0, maximum - 1), marker],
    collapseChanges,
  };
}

function leadingPhysicalRows(value: string, maximum: number): string {
  if (maximum <= 0) return "";
  let end = 0;
  for (let row = 0; row < maximum; row += 1) {
    const newline = value.indexOf("\n", end);
    if (newline < 0) return value;
    if (row === maximum - 1) return value.slice(0, newline);
    end = newline + 1;
  }
  return value;
}

function trailingPhysicalRows(value: string, maximum: number): string {
  if (maximum <= 0) return "";
  let start = value.length;
  for (let row = 0; row < maximum; row += 1) {
    const newline = value.lastIndexOf("\n", start - 1);
    if (newline < 0) return value;
    if (row === maximum - 1) return value.slice(newline + 1);
    start = newline;
  }
  return value;
}

function boundedMarkdownToolDetailLines(
  detail: OhmTuiToolDetail,
  width: number,
  expanded: boolean,
  ellipsis: string,
  codeBlockIndent: string,
  cache: OhmNativeToolDetailCache,
): BoundedToolDetailRows<MarkdownRenderedLine> {
  const maximum = expanded ? EXPANDED_TOOL_DETAIL_ROWS : COLLAPSED_TOOL_DETAIL_ROWS;
  const available = maximum - 1;
  const headRows = Math.ceil(available * 2 / 3);
  const tailRows = available - headRows;
  const selectedWidth = Math.max(1, width);
  const render = (source: string): MarkdownRenderedLine[] =>
    renderMarkdownToolDetailSource(source, selectedWidth, codeBlockIndent);
  const complete = cache.getMarkdown(
    detail.value,
    selectedWidth,
    codeBlockIndent,
    () => render(detail.value),
  );
  const collapseChanges = complete.count > COLLAPSED_TOOL_DETAIL_ROWS;
  if (complete.count <= maximum) {
    return { rows: complete.head.slice(0, complete.count), collapseChanges };
  }
  const sourceBytes = Buffer.byteLength(detail.value, "utf8");
  const smallEnough = sourceBytes + complete.count * selectedWidth <= maximum * selectedWidth;
  if (smallEnough) {
    const marker = truncateCells(`${ellipsis} ${complete.count - available} rows omitted`, selectedWidth, ellipsis);
    return {
      rows: [
        ...complete.head.slice(0, headRows),
        { text: marker, role: "muted", spans: [{ text: marker, role: "muted" }] },
        ...(tailRows === 0 ? [] : complete.tail.slice(-tailRows)),
      ],
      collapseChanges,
    };
  }
  const head = render(byteTruncate(
    leadingPhysicalRows(detail.value, headRows),
    Math.max(1, selectedWidth * Math.max(1, headRows)),
  )).slice(0, headRows);
  const tail = tailRows === 0 ? [] : render(byteTail(
    trailingPhysicalRows(detail.value, tailRows),
    Math.max(1, selectedWidth * Math.max(1, tailRows)),
  )).slice(-tailRows);
  const marker = truncateCells(`${ellipsis} retained Markdown shortened; ending follows`, selectedWidth, ellipsis);
  return {
    rows: [
      ...head,
      { text: marker, role: "muted", spans: [{ text: marker, role: "muted" }] },
      ...tail,
    ],
    collapseChanges,
  };
}

function markdownToolDetailText(
  line: MarkdownRenderedLine,
  presentation: NativePresentation,
  hyperlinks: boolean,
  error: boolean,
): string {
  return line.spans.map((span) => {
    const rendered = error && presentation.theme !== undefined
      ? presentation.theme.fg("error", span.text)
      : themed(presentation.theme, span.role ?? line.role, span.text);
    return hyperlinks && span.hyperlink !== undefined
      ? trustedTerminalHyperlink(rendered, span.hyperlink)
      : rendered;
  }).join("");
}

function toolDetailRole(detail: OhmTuiToolDetail, line: string): ThemeRole {
  if (detail.kind === "error") return "error";
  if (detail.kind === "progress") return "info";
  if (detail.kind === "metadata") return "muted";
  if (detail.kind === "diff") {
    if (line.startsWith("+") && !line.startsWith("+++")) return "success";
    if (line.startsWith("-") && !line.startsWith("---")) return "error";
    return "code";
  }
  if (detail.kind === "source" || detail.kind === "input") return "code";
  return "assistant";
}

function renderToolDetail(
  detail: OhmTuiToolDetail,
  columns: number,
  expanded: boolean,
  options: EntryRenderOptions,
): BoundedToolDetailRows<string> {
  const indent = columns >= 5 ? 2 : 0;
  const contentIndent = columns >= 7 ? 4 : indent;
  const width = toolDetailContentWidth(columns);
  const presentation = options.presentation;
  let body: readonly string[];
  let collapseChanges: boolean;
  if (detail.markdown === true) {
    const bounded = boundedMarkdownToolDetailLines(
      detail,
      width,
      expanded,
      presentation.glyphs.ellipsis,
      options.codeBlockIndent,
      options.toolDetailCache,
    );
    body = bounded.rows.map((line) => markdownToolDetailText(
        line,
        presentation,
        options.hyperlinks,
        detail.kind === "error",
      ));
    collapseChanges = bounded.collapseChanges;
  } else {
    const bounded = boundedToolDetailLines(
      detail,
      width,
      expanded,
      presentation.glyphs.ellipsis,
      options.toolDetailCache,
    );
    body = bounded.rows.map((line) => {
        const role = toolDetailRole(detail, line);
        return role === "error" && presentation.theme !== undefined
          ? presentation.theme.fg("error", line)
          : themed(presentation.theme, role, line);
      });
    collapseChanges = bounded.collapseChanges;
  }
  return {
    rows: [
      ...wrapPresentedText(`${presentation.glyphs.branch} ${detail.label}`, Math.max(1, columns - indent), presentation).map((line) =>
        `${" ".repeat(indent)}${themed(presentation.theme, "muted", line)}`),
      ...body.map((line) => `${" ".repeat(contentIndent)}${line}`),
    ],
    collapseChanges,
  };
}

function toolNameRole(name: string): ThemeRole {
  if (["read", "grep", "find", "ls"].includes(name)) return "info";
  if (["edit", "write", "apply_patch"].includes(name)) return "accent";
  return "title";
}

function toolBackground(status: OhmTuiToolStatus): ThemeBg | undefined {
  if (status === "pending" || status === "running") return "toolPendingBg";
  return status === "completed" ? "toolSuccessBg" : undefined;
}

function paintToolRows(
  lines: readonly string[],
  columns: number,
  status: OhmTuiToolStatus,
  theme: Theme | undefined,
): string[] {
  const background = toolBackground(status);
  if (theme?.ansi !== true || background === undefined) return [...lines];
  return lines.map((line) => theme.bg(background, truncateToWidth(line, columns, "", true)));
}

function renderTool(entry: OhmTuiToolEntry, columns: number, options: EntryRenderOptions): string[] {
  const presentation = options.presentation;
  const status = statusPresentation(entry.status, presentation);
  const completed = entry.status === "completed";
  const iconRole = completed ? "success" : status.role;
  const stateRole = completed ? "muted" : status.role;
  const nameRole = completed ? "assistant" : toolNameRole(entry.name);
  const indent = columns >= 4 ? 2 : 0;
  const selectedExpanded = entry.expanded ?? options.toolDetailsExpanded;
  const fallbackDetails: OhmTuiToolDetail[] = [
    ...(entry.input === undefined || entry.input === "" ? [] : [{ kind: "input" as const, label: "Input", value: entry.input }]),
    ...(entry.output === undefined || entry.output === "" ? [] : [{ kind: "output" as const, label: "Output", value: entry.output }]),
  ];
  const details = entry.details ?? fallbackDetails;
  const visibleDetails = selectedExpanded ? details : details.filter((detail) => detail.preview === true);
  const headline = entry.headline ?? entry.summary;
  const state = entry.state ?? status.label;
  const name = entry.name || "tool";
  const headerText = (color: ThemeColor, role: ThemeRole, value: string): string => {
    if (presentation.theme === undefined) return value;
    if (completed) return presentation.theme.fg(color, value);
    if (role === status.role && (entry.status === "pending" || entry.status === "running")) {
      return presentation.theme.fg(entry.status === "running" ? "toolTitle" : "toolOutput", value);
    }
    return entry.status === "error" && role === status.role
      ? presentation.theme.fg("error", value)
      : themed(presentation.theme, role, value);
  };
  const iconText = headerText("success", iconRole, status.icon);
  const nameText = headerText("text", nameRole, ` ${name}`);
  const stateText = headerText("muted", stateRole, `${presentation.separator}${state}`);
  const fullHeader = `${status.icon} ${name}${presentation.separator}${state}`;
  const output: string[] = [];
  if (cellWidth(fullHeader) > columns) {
    const compactName = truncateCells(
      name,
      Math.max(1, columns - cellWidth(`${status.icon} `)),
      presentation.glyphs.ellipsis,
    );
    output.push(...wrapComposerText(`${status.icon} ${compactName}`, columns).map((line) => {
      const selected = presentation.theme?.ansi === true ? line : line.trimEnd();
      if (!selected.startsWith(status.icon)) return headerText("text", nameRole, selected);
      return joinStyledRuns([
        iconText,
        headerText("text", nameRole, selected.slice(status.icon.length)),
      ]);
    }));
    output.push(...wrapPresentedText(state, Math.max(1, columns - indent), presentation).map((line) =>
      `${" ".repeat(indent)}${headerText("muted", stateRole, line)}`));
  } else {
    output.push(joinStyledRuns([iconText, nameText, stateText]));
  }
  if (headline !== undefined && headline !== "") {
    const prefix = `${presentation.glyphs.branch} `;
    const lines = wrapPresentedText(`${prefix}${headline}`, Math.max(1, columns - indent), presentation);
    output.push(...lines.map((line) => `${" ".repeat(indent)}${themed(presentation.theme, "muted", line)}`));
  }
  let expansionChanges = details.some((detail) => detail.preview !== true);
  for (const detail of visibleDetails) {
    const rendered = renderToolDetail(detail, columns, selectedExpanded, options);
    output.push(...rendered.rows);
    expansionChanges ||= rendered.collapseChanges;
  }
  const safeHint = options.toolExpandKeyHint?.replaceAll(/\s*\n\s*/gu, " ").trim();
  if (expansionChanges && safeHint !== undefined && safeHint !== "") {
    output.push(...wrapPresentedText(
      `${presentation.glyphs.ellipsis} ${safeHint} ${selectedExpanded ? "collapse" : "details"}`,
      Math.max(1, columns - indent),
      presentation,
    ).map((line) => `${" ".repeat(indent)}${themed(presentation.theme, "muted", line)}`));
  }
  return paintToolRows(output, columns, entry.status, presentation.theme);
}

const COLLAPSED_RETAINED_NOTICE_ROWS = 20;
const EXPANDED_RETAINED_NOTICE_ROWS = 120;

interface RetainedNoticeLine {
  readonly text: string;
  readonly marker: boolean;
}

function boundedRetainedNoticeLines(
  value: string,
  width: number,
  maximum: number,
  truncated: boolean,
  ellipsis: string,
  preserveTrailing: boolean,
): RetainedNoticeLine[] {
  if (value === "") return truncated ? [{ text: `${ellipsis} retained text shortened`, marker: true }] : [];
  const lines = wrapNativeText(value, Math.max(1, width), preserveTrailing);
  if (lines.length <= maximum && !truncated) return lines.map((text) => ({ text, marker: false }));
  const available = Math.max(0, maximum - 1);
  if (lines.length <= available) {
    return [
      ...lines.map((text) => ({ text, marker: false })),
      { text: `${ellipsis} retained text shortened`, marker: true },
    ];
  }
  const headRows = Math.ceil(available * 2 / 3);
  const tailRows = available - headRows;
  const head = lines.slice(0, headRows);
  const tail = tailRows === 0 ? [] : lines.slice(-tailRows);
  const omitted = Math.max(0, lines.length - head.length - tail.length);
  const marker = omitted > 0
    ? `${ellipsis} ${omitted} rows omitted${truncated ? "; retained text shortened" : ""}`
    : `${ellipsis} retained text shortened`;
  return [
    ...head.map((text) => ({ text, marker: false })),
    { text: marker, marker: true },
    ...tail.map((text) => ({ text, marker: false })),
  ];
}

function renderNotice(
  entry: Extract<OhmTuiTranscriptEntry, { readonly kind: "notice" }>,
  columns: number,
  options: EntryRenderOptions,
): string[] {
  const presentation = options.presentation;
  const notice = entry.tone === "warning"
    ? { role: "warning" as const, prefix: "! warning" }
    : entry.tone === "error"
      ? { role: "error" as const, prefix: `${presentation.glyphs.failure} error` }
      : { role: "muted" as const, prefix: presentation.glyphs.pending };
  const selectedExpanded = entry.expanded ?? options.toolDetailsExpanded;
  const selectedText = entry.expandable === true && !selectedExpanded && entry.compactText !== undefined
    ? entry.compactText
    : entry.text;
  const safeHint = options.toolExpandKeyHint?.replaceAll(/\s*\n\s*/gu, " ").trim();
  const expandMarker = entry.expandable !== true || safeHint === undefined || safeHint === ""
    ? undefined
    : `${presentation.glyphs.ellipsis} ${safeHint} ${selectedExpanded ? "collapse" : "details"}`;
  const indent = columns >= 4 ? 2 : 0;
  const maximumRows = entry.expandable === true && selectedExpanded
    ? EXPANDED_RETAINED_NOTICE_ROWS
    : COLLAPSED_RETAINED_NOTICE_ROWS;
  const body = boundedRetainedNoticeLines(
    selectedText,
    Math.max(1, columns - indent),
    Math.max(1, maximumRows - (expandMarker === undefined ? 0 : 1)),
    entry.truncated === true,
    presentation.glyphs.ellipsis,
    presentation.theme?.ansi === true,
  );
  const inline = entry.label === undefined ? body[0] : undefined;
  const rest = inline === undefined ? body : body.slice(1);
  const plainPrefix = truncateCells(notice.prefix, columns);
  const plainBody = entry.label === undefined
    ? inline === undefined ? "" : ` ${inline.text}`
    : ` ${entry.label}`;
  const selectedBody = truncateCells(plainBody, Math.max(0, columns - cellWidth(plainPrefix)));
  const header = `${themed(presentation.theme, notice.role, plainPrefix)}${themed(
    presentation.theme,
    inline?.marker === true ? "muted" : "assistant",
    selectedBody,
  )}`;
  return [
    header,
    ...rest.map((line) => `${" ".repeat(indent)}${themed(
      presentation.theme,
      line.marker ? "muted" : "assistant",
      truncateCells(line.text, Math.max(1, columns - indent)),
    )}`),
    ...(expandMarker === undefined ? [] : [
      `${" ".repeat(indent)}${themed(
        presentation.theme,
        "muted",
        truncateCells(expandMarker, Math.max(1, columns - indent)),
      )}`,
    ]),
  ];
}

function renderEntry(entry: OhmTuiTranscriptEntry, columns: number, options: EntryRenderOptions): string[] {
  switch (entry.kind) {
    case "user": return renderUserMessage(entry.text, columns, options.presentation);
    case "assistant": return wrapPresentedText(entry.text, columns, options.presentation).map((line) =>
      themed(options.presentation.theme, "assistant", line));
    case "thinking": return renderThinking(
      entry,
      columns,
      entry.expanded ?? options.thinkingExpanded,
      options.presentation,
    );
    case "tool": return renderTool(entry, columns, options);
    case "notice": return renderNotice(entry, columns, options);
  }
}

class NativeTranscriptEntryComponent implements Component {
  #entry: OhmTuiTranscriptEntry;
  #options: EntryRenderOptions;
  #cached: { readonly width: number; readonly lines: string[] } | undefined;
  renderCount = 0;

  constructor(entry: OhmTuiTranscriptEntry, options: EntryRenderOptions) {
    this.#entry = entry;
    this.#options = options;
  }

  get kind(): OhmTuiTranscriptEntry["kind"] {
    return this.#entry.kind;
  }

  update(entry: OhmTuiTranscriptEntry, options: EntryRenderOptions): void {
    if (entryEqual(this.#entry, entry) && optionsEqual(this.#options, options)) return;
    this.#entry = entry;
    this.#options = options;
    this.invalidate();
  }

  render(width: number): string[] {
    const columns = usableWidth(width);
    if (this.#cached?.width === columns) return this.#cached.lines;
    const selected = columns === 1
      ? singleCellEntry(this.#entry, this.#options.presentation.glyphs.ellipsis)
      : this.#entry;
    const lines = renderEntry(selected, columns, this.#options);
    this.#cached = { width: columns, lines };
    this.renderCount += 1;
    return lines;
  }

  invalidate(): void {
    this.#cached = undefined;
  }
}

class NativeTranscriptComponent implements Component {
  readonly children: NativeTranscriptEntryComponent[] = [];
  readonly #byKey = new Map<string, NativeTranscriptEntryComponent>();

  update(entries: readonly OhmTuiTranscriptEntry[], options: EntryRenderOptions): void {
    const selected: NativeTranscriptEntryComponent[] = [];
    const live = new Set<string>();
    for (const entry of entries) {
      const key = `${entry.kind}:${entry.id}`;
      live.add(key);
      let component = this.#byKey.get(key);
      if (component === undefined) {
        component = new NativeTranscriptEntryComponent(entry, options);
        this.#byKey.set(key, component);
      } else {
        component.update(entry, options);
      }
      selected.push(component);
    }
    for (const key of this.#byKey.keys()) {
      if (!live.has(key)) this.#byKey.delete(key);
    }
    this.children.splice(0, this.children.length, ...selected);
  }

  render(width: number): string[] {
    const lines: string[] = [];
    this.children.forEach((component, index) => {
      lines.push(...component.render(width));
      const next = this.children[index + 1];
      if (next !== undefined && (component.kind !== "tool" || next.kind !== "tool")) lines.push("");
    });
    return lines;
  }

  invalidate(): void {
    for (const child of this.children) child.invalidate();
  }

  renderCounts(): readonly number[] {
    return this.children.map((child) => child.renderCount);
  }

  renderBlocks(width: number): readonly string[][] {
    return this.children.map((child) => [...child.render(width)]);
  }
}

function rowBudget(value: number | undefined, minimum: number): number | undefined {
  if (value === undefined) return undefined;
  return Number.isFinite(value) ? Math.max(minimum, Math.trunc(value)) : minimum;
}

class NativeQueueComponent implements Component {
  #snapshot: OhmTuiSnapshot;
  #maximumRows: number | undefined;
  #presentation: NativePresentation;

  constructor(snapshot: OhmTuiSnapshot, maximumRows: number | undefined, presentation: NativePresentation) {
    this.#snapshot = snapshot;
    this.#maximumRows = maximumRows;
    this.#presentation = presentation;
  }

  update(snapshot: OhmTuiSnapshot, maximumRows: number | undefined, presentation: NativePresentation): void {
    this.#snapshot = snapshot;
    this.#maximumRows = maximumRows;
    this.#presentation = presentation;
  }

  render(width: number): string[] {
    if (this.#snapshot.queuedMessages.length === 0) return [];
    const columns = usableWidth(width);
    const budget = rowBudget(this.#maximumRows, 0);
    if (budget === 0) return [];
    const visible = budget === undefined
      ? this.#snapshot.queuedMessages
      : this.#snapshot.queuedMessages.slice(-budget);
    const omitted = this.#snapshot.queuedMessages.length - visible.length;
    const indent = columns >= 4 ? 2 : 0;
    const labelSource = omitted === 0
      ? `Queued${this.#presentation.separator}${this.#snapshot.queuedMessages.length}`
      : `Queued${this.#presentation.separator}${this.#snapshot.queuedMessages.length}${this.#presentation.separator}${omitted} earlier`;
    const header = truncateCells(
      columns === 1 ? singleCellText(labelSource, this.#presentation.glyphs.ellipsis) : labelSource,
      columns,
    );
    const lines = [
      "",
      columns === 1 && this.#presentation.theme?.ansi === true
        ? header
        : themed(this.#presentation.theme, "muted", header),
    ];
    for (const message of visible) {
      const source = columns === 1
        ? singleCellText(message.text, this.#presentation.glyphs.ellipsis)
        : message.text;
      const selected = budget === undefined ? source : source.replaceAll(/\s*\n\s*/gu, " ");
      const wrapped = budget === undefined
        ? wrapPresentedText(selected, Math.max(1, columns - indent), this.#presentation)
        : [truncateCells(selected, Math.max(1, columns - indent))];
      lines.push(...wrapped.map((line) => `${" ".repeat(indent)}${themed(this.#presentation.theme, "assistant", line)}`));
    }
    return lines;
  }

  invalidate(): void {}
}

function composerText(
  snapshot: OhmTuiSnapshot,
  columns: number,
  markCursor: boolean,
  presentation: NativePresentation,
): string {
  const value = snapshot.composer.value;
  const placeholder = snapshot.composer.placeholder ?? "";
  const prefix = columns >= 3 ? `${presentation.glyphs.user} ` : "";
  if (!markCursor) return `${prefix}${value || placeholder}`;
  if (value === "") {
    const emptyCursorCell = prefix === "" && placeholder === "" ? CURSOR_CELL : "";
    return `${prefix}${CURSOR_SENTINEL}${placeholder}${emptyCursorCell}`;
  }
  const graphemes = splitGraphemes(value);
  const cursor = Math.max(0, Math.min(graphemes.length, snapshot.composer.cursor ?? graphemes.length));
  if (cursor === graphemes.length) return `${prefix}${value}${CURSOR_SENTINEL}`;
  graphemes.splice(cursor, 0, CURSOR_SENTINEL);
  return `${prefix}${graphemes.join("")}`;
}

function boundedComposerText(
  snapshot: OhmTuiSnapshot,
  columns: number,
  maximumRows: number | undefined,
  presentation: NativePresentation,
): string {
  const budget = rowBudget(maximumRows, 1);
  const source = composerText(snapshot, columns, true, presentation);
  if (budget === undefined) return source;
  const lines = wrapTextWithAnsi(source, columns);
  let cursorLine = lines.findIndex((line) => line.includes(CURSOR_SENTINEL));
  if (cursorLine < 0) throw new Error("Composer cursor layout failed");
  const marker = lines[cursorLine]!.indexOf(CURSOR_SENTINEL);
  if (cellWidth(lines[cursorLine]!.slice(0, marker)) >= columns) {
    lines[cursorLine] = lines[cursorLine]!.replace(CURSOR_SENTINEL, "");
    cursorLine += 1;
    lines[cursorLine] = `${CURSOR_SENTINEL}${lines[cursorLine] ?? ""}`;
  }
  const maximumStart = Math.max(0, lines.length - budget);
  const start = Math.min(maximumStart, Math.max(0, cursorLine - Math.floor((budget - 1) / 2)));
  return lines.slice(start, start + budget).join("\n");
}

function boundedPrompt(prompt: string | undefined, columns: number, maximumRows: number | undefined): string | undefined {
  if (prompt === undefined || prompt === "") return undefined;
  const budget = rowBudget(maximumRows, 0);
  if (budget === 0) return undefined;
  if (budget === undefined) return prompt;
  return wrapTextWithAnsi(prompt, columns).slice(-budget).join("\n");
}

class NativeComposerComponent implements Component {
  #snapshot: OhmTuiSnapshot;
  #composerRows: number | undefined;
  #promptRows: number | undefined;
  #editorPaddingX: number | undefined;
  #presentation: NativePresentation;

  constructor(props: OhmNativeViewProps, snapshot: OhmTuiSnapshot, presentation: NativePresentation) {
    this.#snapshot = snapshot;
    this.#composerRows = props.composerRows;
    this.#promptRows = props.promptRows;
    this.#editorPaddingX = props.editorPaddingX;
    this.#presentation = presentation;
  }

  update(props: OhmNativeViewProps, snapshot: OhmTuiSnapshot, presentation: NativePresentation): void {
    this.#snapshot = snapshot;
    this.#composerRows = props.composerRows;
    this.#promptRows = props.promptRows;
    this.#editorPaddingX = props.editorPaddingX;
    this.#presentation = presentation;
  }

  render(width: number): string[] {
    const columns = usableWidth(width);
    const snapshot = columns === 1
      ? {
          ...this.#snapshot,
          composer: {
            ...this.#snapshot.composer,
            value: singleCellText(this.#snapshot.composer.value, this.#presentation.glyphs.ellipsis),
            ...optionalProperties(this.#snapshot.composer.placeholder === undefined ? undefined : {
              placeholder: singleCellText(this.#snapshot.composer.placeholder, this.#presentation.glyphs.ellipsis),
            }),
            ...optionalProperties(this.#snapshot.composer.label === undefined ? undefined : {
              label: singleCellText(this.#snapshot.composer.label, this.#presentation.glyphs.ellipsis),
            }),
            ...optionalProperties(this.#snapshot.composer.prompt === undefined ? undefined : {
              prompt: singleCellText(this.#snapshot.composer.prompt, this.#presentation.glyphs.ellipsis),
            }),
            ...optionalProperties(this.#snapshot.composer.mode === undefined ? undefined : {
              mode: singleCellText(this.#snapshot.composer.mode, this.#presentation.glyphs.ellipsis),
            }),
          },
        }
      : this.#snapshot;
    const requestedPadding = Number.isFinite(this.#editorPaddingX)
      ? Math.max(0, Math.min(3, Math.trunc(this.#editorPaddingX ?? 0)))
      : 0;
    const padding = Math.min(requestedPadding, Math.floor((columns - 1) / 2));
    const contentColumns = Math.max(1, columns - padding * 2);
    const label = snapshot.composer.label || "Ask ohm";
    const mode = snapshot.composer.mode === undefined || snapshot.composer.mode === ""
      ? ""
      : `${this.#presentation.separator}${snapshot.composer.mode}`;
    const prompt = boundedPrompt(snapshot.composer.prompt, contentColumns, this.#promptRows);
    const editor = boundedComposerText(
      snapshot,
      contentColumns,
      this.#composerRows,
      this.#presentation,
    );
    const promptLines = prompt === undefined
      ? []
      : wrapPresentedText(prompt, contentColumns, this.#presentation);
    const output = [
      "",
      themed(
        this.#presentation.theme,
        "border",
        `${COMPOSER_START_SENTINEL}${frameRule(`${label}${mode}`, columns, this.#presentation.glyphs.horizontal)}`,
      ),
    ];
    if (prompt !== undefined) {
      output.push(...promptLines.map((line) =>
        `${" ".repeat(padding)}${themed(this.#presentation.theme, "title", line)}`));
    }
    const editorLines = wrapComposerText(editor, contentColumns);
    output.push(...editorLines.map((line) =>
      `${" ".repeat(padding)}${themed(
        this.#presentation.theme,
        snapshot.composer.value === "" ? "muted" : "editorActive",
        this.#presentation.theme?.ansi === true ? line : line.trimEnd(),
      )}`));
    output.push(themed(
      this.#presentation.theme,
      "border",
      `${frameRule("", columns, this.#presentation.glyphs.horizontal)}${COMPOSER_END_SENTINEL}`,
    ));
    return output;
  }

  invalidate(): void {}
}

function compactNumber(value: number): string {
  const rounded = Math.round(value);
  if (rounded < 1_000) return String(rounded);
  if (rounded < 1_000_000) return `${(rounded / 1_000).toFixed(rounded < 10_000 ? 1 : 0)}k`;
  return `${(rounded / 1_000_000).toFixed(rounded < 10_000_000 ? 1 : 0)}m`;
}

function contextLabel(telemetry: OhmTuiTelemetrySnapshot): string | undefined {
  const used = telemetry.contextTokens;
  const window = telemetry.contextWindowTokens;
  if (used === undefined && window === undefined) return undefined;
  if (used !== undefined && window !== undefined && window > 0) {
    return `ctx ${Math.min(999, used / window * 100).toFixed(1)}%/${compactNumber(window)}`;
  }
  return `ctx ${compactNumber(used ?? window ?? 0)}`;
}

interface ConnectionPresentation {
  readonly role: ThemeRole;
  readonly label: string;
}

function connectionPresentation(connection: OhmTuiStatusSnapshot["connection"]): ConnectionPresentation {
  switch (connection) {
    case "connected": return { role: "success", label: "connected" };
    case "connecting": return { role: "warning", label: "connecting" };
    case "offline": return { role: "muted", label: "offline" };
    case "error": return { role: "error", label: "connection error" };
  }
}

class NativeStatusComponent implements Component {
  #snapshot: OhmTuiSnapshot;
  #presentation: NativePresentation;

  constructor(snapshot: OhmTuiSnapshot, presentation: NativePresentation) {
    this.#snapshot = snapshot;
    this.#presentation = presentation;
  }

  update(snapshot: OhmTuiSnapshot, presentation: NativePresentation): void {
    this.#snapshot = snapshot;
    this.#presentation = presentation;
  }

  render(width: number): string[] {
    const columns = usableWidth(width);
    const connection = connectionPresentation(this.#snapshot.status.connection);
    const left = [
      this.#snapshot.status.model,
      this.#snapshot.status.reasoning,
      this.#snapshot.status.activity,
    ].filter((value): value is string => value !== undefined && value !== "");
    const metrics = [
      contextLabel(this.#snapshot.telemetry),
      this.#snapshot.telemetry.inputTokens === undefined ? undefined : `in ${compactNumber(this.#snapshot.telemetry.inputTokens)}`,
      this.#snapshot.telemetry.outputTokens === undefined ? undefined : `out ${compactNumber(this.#snapshot.telemetry.outputTokens)}`,
      this.#snapshot.telemetry.cacheReadTokens === undefined || this.#snapshot.telemetry.cacheReadTokens === 0
        ? undefined
        : `R${compactNumber(this.#snapshot.telemetry.cacheReadTokens)}`,
      this.#snapshot.telemetry.cacheWriteTokens === undefined || this.#snapshot.telemetry.cacheWriteTokens === 0
        ? undefined
        : `W${compactNumber(this.#snapshot.telemetry.cacheWriteTokens)}`,
      this.#snapshot.telemetry.cacheHitPercent === undefined
        ? undefined
        : `cache hit ${this.#snapshot.telemetry.cacheHitPercent.toFixed(1)}%`,
      this.#snapshot.telemetry.cost === undefined
        || (this.#snapshot.telemetry.cost === 0 && this.#snapshot.telemetry.subscription !== true)
        ? undefined
        : `$${this.#snapshot.telemetry.cost.toFixed(3)}${this.#snapshot.telemetry.subscription === true ? " (sub)" : ""}`,
    ].filter((value): value is string => value !== undefined);
    const maximum = lineWidth(columns);
    const identity = truncateCells([connection.label, ...left].join(this.#presentation.separator), maximum);
    const metricLines: string[] = [];
    const metricWidth = Math.max(1, maximum - (columns >= 4 ? 2 : 0));
    let metricLine = "";
    for (const metric of metrics) {
      const candidate = metricLine === "" ? metric : `${metricLine}${this.#presentation.separator}${metric}`;
      if (metricLine !== "" && cellWidth(candidate) > metricWidth) {
        metricLines.push(metricLine);
        metricLine = metric;
      } else {
        metricLine = candidate;
      }
    }
    if (metricLine !== "") metricLines.push(metricLine);
    const metricSummary = metricLines.join(this.#presentation.separator);
    const combined = [identity, metricSummary].filter(Boolean).join(this.#presentation.separator);
    const combinedFits = cellWidth(combined) <= maximum;
    const icon = this.#presentation.theme === undefined && this.#presentation.unicode
      ? this.#presentation.glyphs.connected
      : this.#snapshot.status.connection === "connected"
        ? this.#presentation.glyphs.connected
        : this.#snapshot.status.connection === "connecting"
          ? this.#presentation.glyphs.pending
          : this.#snapshot.status.connection === "error"
            ? this.#presentation.glyphs.failure
            : this.#presentation.glyphs.unknown;
    const selectedIdentity = maximum === 0 ? "" : combinedFits ? combined : identity;
    const iconWidth = cellWidth(icon);
    const showIcon = selectedIdentity !== ""
      && iconWidth > 0
      && iconWidth + 1 + cellWidth(selectedIdentity) <= columns;
    const bodyWidth = Math.max(0, columns - (showIcon ? iconWidth + 1 : 0));
    const body = truncateCells(selectedIdentity, bodyWidth);
    const output = [
      "",
      joinStyledRuns([
        showIcon ? themed(this.#presentation.theme, connection.role, icon) : "",
        themed(
          this.#presentation.theme,
          "muted",
          `${showIcon ? " " : ""}${body}`,
        ),
      ]),
    ];
    if (!combinedFits && metricLines.length > 0) {
      const indent = columns >= 4 ? 2 : 0;
      output.push(...metricLines.flatMap((line) => wrapPresentedText(
        line,
        Math.max(1, columns - indent),
        this.#presentation,
      ).map((part) =>
        `${" ".repeat(indent)}${themed(this.#presentation.theme, "muted", part)}`)));
    }
    return output;
  }

  invalidate(): void {}
}

/**
 * A retained, controller-scoped renderer for ohm's rich shell.
 *
 * It intentionally owns no terminal input or output. The existing controller
 * remains responsible for scheduling, scrolling, selection, images, and row
 * diffs; this component only projects bounded terminal rows and cursor data.
 */
export class OhmNativeView implements Component {
  readonly #transcript = new NativeTranscriptComponent();
  readonly #queue: NativeQueueComponent;
  readonly #composer: NativeComposerComponent;
  readonly #status: NativeStatusComponent;
  readonly #toolDetailCache: OhmNativeToolDetailCache;
  readonly children: readonly Component[];
  #props: OhmNativeViewProps;
  #snapshot: OhmTuiSnapshot;
  #presentation: NativePresentation;

  constructor(
    props: OhmNativeViewProps,
    toolDetailCache: OhmNativeToolDetailCache = internalCreateOhmNativeToolDetailCache(),
  ) {
    this.#props = props;
    this.#toolDetailCache = toolDetailCache;
    this.#snapshot = normalizeOhmTuiSnapshot(props.snapshot);
    this.#presentation = nativePresentation(props.theme, props.unicode);
    this.#queue = new NativeQueueComponent(this.#snapshot, props.queueRows, this.#presentation);
    this.#composer = new NativeComposerComponent(props, this.#snapshot, this.#presentation);
    this.#status = new NativeStatusComponent(this.#snapshot, this.#presentation);
    this.children = [this.#transcript, this.#queue, this.#composer, this.#status];
    this.#reconcile();
  }

  update(props: OhmNativeViewProps): void {
    this.#props = props;
    this.#snapshot = normalizeOhmTuiSnapshot(props.snapshot);
    this.#presentation = nativePresentation(props.theme, props.unicode);
    this.#reconcile();
  }

  #reconcile(): void {
    const options: EntryRenderOptions = {
      thinkingExpanded: this.#props.thinkingExpanded ?? false,
      toolDetailsExpanded: this.#props.toolDetailsExpanded ?? false,
      toolExpandKeyHint: this.#props.toolExpandKeyHint ?? "Ctrl+O",
      hyperlinks: this.#props.hyperlinks ?? false,
      codeBlockIndent: this.#props.codeBlockIndent ?? "",
      presentation: this.#presentation,
      toolDetailCache: this.#toolDetailCache,
    };
    this.#transcript.update(this.#snapshot.transcript, options);
    this.#queue.update(this.#snapshot, this.#props.queueRows, this.#presentation);
    this.#composer.update(this.#props, this.#snapshot, this.#presentation);
    this.#status.update(this.#snapshot, this.#presentation);
  }

  project(): OhmNativeFrameProjection {
    const columns = usableWidth(this.#props.columns);
    const rendered = this.children.flatMap((child) => child.render(columns)).join("\n");
    const marker = rendered.indexOf(CURSOR_SENTINEL);
    if (marker < 0 || rendered.indexOf(CURSOR_SENTINEL, marker + CURSOR_SENTINEL.length) >= 0) {
      throw new Error("Composer cursor projection failed");
    }
    const before = stripAnsi(rendered.slice(0, marker));
    const lines = before.split("\n");
    const column = cellWidth(lines.at(-1) ?? "");
    const cursorStartsNewRow = column >= columns;
    const cursorProjected = cursorStartsNewRow
      ? `${rendered.slice(0, marker)}\n${rendered.slice(marker + CURSOR_SENTINEL.length)}`
      : rendered.replaceAll(CURSOR_SENTINEL, "");
    const composerStart = cursorProjected.indexOf(COMPOSER_START_SENTINEL);
    const composerEnd = cursorProjected.indexOf(COMPOSER_END_SENTINEL);
    if (
      composerStart < 0
      || composerEnd < composerStart
      || cursorProjected.indexOf(COMPOSER_START_SENTINEL, composerStart + COMPOSER_START_SENTINEL.length) >= 0
      || cursorProjected.indexOf(COMPOSER_END_SENTINEL, composerEnd + COMPOSER_END_SENTINEL.length) >= 0
    ) {
      throw new Error("Composer bounds projection failed");
    }
    const composerTop = stripAnsi(cursorProjected.slice(0, composerStart)).split("\n").length - 1;
    const composerBottom = stripAnsi(cursorProjected.slice(0, composerEnd)).split("\n").length;
    const text = cursorProjected
      .replaceAll(COMPOSER_START_SENTINEL, "")
      .replaceAll(COMPOSER_END_SENTINEL, "")
      .replaceAll(CURSOR_CELL, "");
    return {
      text,
      cursor: cursorStartsNewRow
        ? { row: lines.length + 1, column: 1 }
        : { row: lines.length, column: column + 1 },
      composer: { top: composerTop, bottom: composerBottom },
    };
  }

  render(width: number): string[] {
    if (usableWidth(width) !== usableWidth(this.#props.columns)) {
      this.#props = { ...this.#props, columns: usableWidth(width) };
    }
    return this.project().text.split("\n");
  }

  invalidate(): void {
    for (const child of this.children) child.invalidate();
  }

  /** @internal Structural counter used by migration performance tests. */
  transcriptRenderCounts(): readonly number[] {
    return this.#transcript.renderCounts();
  }

  /** @internal Independent entry rows for the rich projector's retained batch path. */
  projectTranscriptEntries(): readonly string[][] {
    return this.#transcript.renderBlocks(usableWidth(this.#props.columns));
  }
}

/** Creates a one-shot native projection for deterministic unit tests. */
export function projectOhmNativeFrame(
  props: OhmNativeViewProps,
  toolDetailCache: OhmNativeToolDetailCache = internalCreateOhmNativeToolDetailCache(),
): OhmNativeFrameProjection {
  return new OhmNativeView(props, toolDetailCache).project();
}

/** Projects independent normalized transcript entries without marker rows. */
export function projectOhmNativeTranscriptEntries(
  props: OhmNativeViewProps,
  toolDetailCache: OhmNativeToolDetailCache = internalCreateOhmNativeToolDetailCache(),
): readonly string[][] {
  return new OhmNativeView(props, toolDetailCache).projectTranscriptEntries();
}

/** Creates one retained view closure suitable for a single TUI controller. */
export function createOhmNativeViewProjector(): (
  props: OhmNativeViewProps,
  toolDetailCache?: OhmNativeToolDetailCache,
) => OhmNativeFrameProjection {
  let view: OhmNativeView | undefined;
  let retainedCache: OhmNativeToolDetailCache | undefined;
  const defaultCache = internalCreateOhmNativeToolDetailCache();
  return (props, toolDetailCache = defaultCache) => {
    if (view === undefined || retainedCache !== toolDetailCache) {
      view = new OhmNativeView(props, toolDetailCache);
      retainedCache = toolDetailCache;
    }
    else view.update(props);
    return view.project();
  };
}
