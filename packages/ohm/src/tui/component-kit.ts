import {
  isBooleanValue,
  isFunctionValue,
  isRecordValue,
  isSafeIntegerValue,
  isStringMember,
  isStringValue,
  type RuntimeRecord,
} from "./value-guards.js";
import { optionalProperties } from "../core/optional-properties.js";
import {
  DEFAULT_RUNTIME_UI_MAX_BYTES,
  DEFAULT_RUNTIME_UI_MAX_LINES,
  sanitizeRuntimeUiBlock,
  sanitizeRuntimeUiRenderContext,
  type RuntimeUiBlock,
  type RuntimeUiLine,
  type RuntimeUiRenderContext,
  type RuntimeUiSpan,
} from "./components.js";
import { renderMarkdownMessageLines } from "./markdown.js";
import { THEME_ROLES, type ThemeRole } from "./theme.js";
import { cellWidth, sanitizeTerminalText, truncateCells, wrapCells } from "./unicode.js";

const MAX_VIEW_WIDTH = 500;
const OMITTED_LINE: RuntimeUiLine = Object.freeze({
  spans: Object.freeze([{ text: "…", role: "muted" as const }]),
});

/** A render-only view that can be returned wherever a RuntimeUiComponent is expected. */
export interface RuntimeUiView {
  render(context: RuntimeUiRenderContext): RuntimeUiBlock;
}

export interface RuntimeUiTextOptions {
  role?: ThemeRole;
  wrap?: boolean;
  fill?: boolean;
  maxLines?: number;
}

export interface RuntimeUiStackOptions {
  gap?: number;
  maxLines?: number;
}

export interface RuntimeUiPanelOptions {
  title?: string;
  borderRole?: ThemeRole;
  titleRole?: ThemeRole;
  padding?: 0 | 1;
  maxLines?: number;
}

export interface RuntimeUiMarkdownOptions {
  role?: ThemeRole;
  maxLines?: number;
}

function record<Value>(value: Value, keys: readonly string[], label: string): RuntimeRecord {
  if (value === undefined) return {};
  if (!isRecordValue(value)) throw new TypeError(`${label} must be an object`);
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  if (unknown.length > 0) throw new TypeError(`${label} contains unknown keys: ${unknown.join(", ")}`);
  return value;
}

function source<Value>(value: Value, label: string): string {
  if (!isStringValue(value)) throw new TypeError(`${label} must be a string`);
  if (Buffer.byteLength(value, "utf8") > DEFAULT_RUNTIME_UI_MAX_BYTES) {
    throw new RangeError(`${label} exceeds ${DEFAULT_RUNTIME_UI_MAX_BYTES} bytes`);
  }
  return value;
}

function role<Value>(value: Value, label: string): ThemeRole | undefined {
  if (value === undefined) return undefined;
  if (!isStringMember(value, THEME_ROLES)) throw new TypeError(`${label} is invalid`);
  return value;
}

function boolean<Value>(value: Value, fallback: boolean, label: string): boolean {
  if (value === undefined) return fallback;
  if (!isBooleanValue(value)) throw new TypeError(`${label} must be boolean`);
  return value;
}

function maxLines<Value>(value: Value, label: string): number {
  if (value === undefined) return DEFAULT_RUNTIME_UI_MAX_LINES;
  if (!isSafeIntegerValue(value) || value < 1 || value > DEFAULT_RUNTIME_UI_MAX_LINES) {
    throw new RangeError(`${label} must be a safe integer between 1 and ${DEFAULT_RUNTIME_UI_MAX_LINES}`);
  }
  return value;
}

function isRuntimeUiView<Value>(value: Value): value is Value & RuntimeUiView {
  return isRecordValue(value) && isFunctionValue(value.render);
}

function view<Value>(value: Value, label: string): RuntimeUiView {
  if (!isRuntimeUiView(value)) {
    throw new TypeError(`${label} must provide render()`);
  }
  return value;
}

function derivedContext(context: RuntimeUiRenderContext, width: number, height: number): RuntimeUiRenderContext {
  return sanitizeRuntimeUiRenderContext({
    ...context,
    width,
    height,
  });
}

function createView(render: (context: RuntimeUiRenderContext) => RuntimeUiBlock): RuntimeUiView {
  return Object.freeze({
    render(value: RuntimeUiRenderContext): RuntimeUiBlock {
      const input = sanitizeRuntimeUiRenderContext(value);
      const context = derivedContext(
        input,
        Math.min(input.width, MAX_VIEW_WIDTH),
        Math.min(input.height, DEFAULT_RUNTIME_UI_MAX_LINES),
      );
      const rendered = render(context);
      const selected = context.focused || rendered.cursor === undefined
        ? rendered
        : { lines: rendered.lines };
      return sanitizeRuntimeUiBlock(selected, {
        width: context.width,
        maxLines: context.height,
      });
    },
  });
}

function clippedLines(lines: readonly RuntimeUiLine[], maximum: number): readonly RuntimeUiLine[] {
  if (lines.length <= maximum) return lines;
  const retained = maximum === 1 ? [] : lines.slice(0, maximum - 1);
  return [...retained, OMITTED_LINE];
}

function renderChild(child: RuntimeUiView, context: RuntimeUiRenderContext, maximum: number): RuntimeUiBlock {
  const selectedContext = derivedContext(context, context.width, Math.max(1, maximum));
  const rendered = sanitizeRuntimeUiBlock(child.render(selectedContext), { width: context.width });
  if (rendered.lines.length <= maximum) return rendered;
  const retained = maximum === 1 ? 0 : maximum - 1;
  return sanitizeRuntimeUiBlock({
    lines: clippedLines(rendered.lines, maximum),
    ...optionalProperties(rendered.cursor !== undefined && rendered.cursor.row < retained ? { cursor: rendered.cursor } : undefined),
  }, { width: context.width, maxLines: maximum });
}

/** Creates bounded, cell-aware text lines. */
export function uiText(value: string, options: RuntimeUiTextOptions = {}): RuntimeUiView {
  const text = source(value, "UI text");
  const input = record(options, ["role", "wrap", "fill", "maxLines"], "UI text options");
  const selectedRole = role(input.role, "UI text role");
  const wrap = boolean(input.wrap, true, "UI text wrap");
  const fill = boolean(input.fill, false, "UI text fill");
  const limit = maxLines(input.maxLines, "UI text maxLines");

  return createView((context) => {
    const safe = sanitizeTerminalText(text);
    const values = wrap
      ? wrapCells(safe, context.width)
      : safe.split("\n").map((line) => truncateCells(line, context.width));
    const lines = clippedLines(values.map((line): RuntimeUiLine => ({
      spans: line === "" ? [] : [{ text: line, ...optionalProperties(selectedRole === undefined ? undefined : { role: selectedRole }) }],
      ...optionalProperties(fill ? { fill: true } : undefined),
    })), Math.min(limit, context.height));
    return { lines };
  });
}

/** Vertically composes render-only views without transferring lifecycle ownership. */
export function uiStack(children: readonly RuntimeUiView[], options: RuntimeUiStackOptions = {}): RuntimeUiView {
  if (!Array.isArray(children)) throw new TypeError("UI stack children must be an array");
  if (children.length > DEFAULT_RUNTIME_UI_MAX_LINES) {
    throw new RangeError(`UI stack exceeds ${DEFAULT_RUNTIME_UI_MAX_LINES} children`);
  }
  const selectedChildren = Object.freeze(children.map((child, index) => view(child, `UI stack child ${index}`)));
  const input = record(options, ["gap", "maxLines"], "UI stack options");
  const gap = input.gap === undefined ? 0 : input.gap;
  if (!isSafeIntegerValue(gap) || gap < 0 || gap >= DEFAULT_RUNTIME_UI_MAX_LINES) {
    throw new RangeError(`UI stack gap must be a safe integer between 0 and ${DEFAULT_RUNTIME_UI_MAX_LINES - 1}`);
  }
  const limit = maxLines(input.maxLines, "UI stack maxLines");

  return createView((context) => {
    const maximum = Math.min(limit, context.height);
    const lines: RuntimeUiLine[] = [];
    let cursor: RuntimeUiBlock["cursor"];
    for (const child of selectedChildren) {
      const separator = lines.length === 0 ? 0 : gap;
      const available = maximum - lines.length - separator;
      if (available <= 0) break;
      const rendered = renderChild(child, derivedContext(context, context.width, available), available);
      if (rendered.lines.length === 0) continue;
      for (let index = 0; index < separator; index += 1) lines.push({ spans: [] });
      const offset = lines.length;
      lines.push(...rendered.lines);
      if (cursor === undefined && rendered.cursor !== undefined) {
        cursor = { row: offset + rendered.cursor.row, column: rendered.cursor.column };
      }
    }
    return {
      lines,
      ...optionalProperties(cursor === undefined ? undefined : { cursor }),
    };
  });
}

function borderLine(
  width: number,
  left: string,
  horizontal: string,
  right: string,
  title: string | undefined,
  borderRole: ThemeRole,
  titleRole: ThemeRole,
): RuntimeUiLine {
  if (width === 1) return { spans: [{ text: left, role: borderRole }] };
  const interior = width - 2;
  if (title === undefined || title === "" || interior === 0) {
    return { spans: [{ text: `${left}${horizontal.repeat(interior)}${right}`, role: borderRole }] };
  }
  const padded = interior >= 3;
  const selected = truncateCells(title, padded ? interior - 2 : interior, "");
  const before = padded && selected !== "" ? " " : "";
  const after = padded && selected !== "" ? " " : "";
  const remainder = Math.max(0, interior - cellWidth(before) - cellWidth(selected) - cellWidth(after));
  const spans: RuntimeUiSpan[] = [
    { text: `${left}${before}`, role: borderRole },
    ...(selected === "" ? [] : [{ text: selected, role: titleRole }]),
    { text: `${after}${horizontal.repeat(remainder)}${right}`, role: borderRole },
  ];
  return { spans };
}

/** Wraps a view in a compact Unicode- or ASCII-aware semantic panel. */
export function uiPanel(child: RuntimeUiView, options: RuntimeUiPanelOptions = {}): RuntimeUiView {
  const selectedChild = view(child, "UI panel child");
  const input = record(options, ["title", "borderRole", "titleRole", "padding", "maxLines"], "UI panel options");
  const title = input.title === undefined ? undefined : source(input.title, "UI panel title");
  const borderRole = role(input.borderRole, "UI panel borderRole") ?? "border";
  const titleRole = role(input.titleRole, "UI panel titleRole") ?? "title";
  const padding = input.padding ?? 1;
  if (padding !== 0 && padding !== 1) throw new RangeError("UI panel padding must be 0 or 1");
  const limit = maxLines(input.maxLines, "UI panel maxLines");

  return createView((context) => {
    const maximum = Math.min(limit, context.height);
    const unicode = context.theme.unicode;
    const glyphs = unicode
      ? { topLeft: "┌", topRight: "┐", bottomLeft: "└", bottomRight: "┘", horizontal: "─", vertical: "│" }
      : { topLeft: "+", topRight: "+", bottomLeft: "+", bottomRight: "+", horizontal: "-", vertical: "|" };
    const safeTitle = title === undefined ? undefined : sanitizeTerminalText(title).replaceAll("\n", " ");
    const top = borderLine(context.width, glyphs.topLeft, glyphs.horizontal, glyphs.topRight, safeTitle, borderRole, titleRole);
    if (maximum === 1 || context.width === 1) return { lines: [top] };
    if (context.width === 2) {
      return {
        lines: [
          top,
          { spans: [{ text: `${glyphs.bottomLeft}${glyphs.bottomRight}`, role: borderRole }] },
        ],
      };
    }

    const actualPadding = Math.min(padding, Math.max(0, Math.floor((context.width - 3) / 2)));
    const contentWidth = Math.max(1, context.width - 2 - actualPadding * 2);
    const childHeight = Math.max(0, maximum - 2);
    const rendered: RuntimeUiBlock = childHeight === 0
      ? { lines: [] }
      : renderChild(selectedChild, derivedContext(context, contentWidth, childHeight), childHeight);
    const lines: RuntimeUiLine[] = [top];
    for (const line of rendered.lines) {
      const used = line.spans.reduce((total, span) => total + cellWidth(span.text), 0);
      lines.push({
        spans: [
          { text: glyphs.vertical, role: borderRole },
          ...(actualPadding === 0 ? [] : [{ text: " ".repeat(actualPadding) }]),
          ...line.spans,
          { text: " ".repeat(Math.max(0, contentWidth - used) + actualPadding) },
          { text: glyphs.vertical, role: borderRole },
        ],
      });
    }
    lines.push({ spans: [{ text: `${glyphs.bottomLeft}${glyphs.horizontal.repeat(context.width - 2)}${glyphs.bottomRight}`, role: borderRole }] });

    const childCursor = "cursor" in rendered ? rendered.cursor : undefined;
    return {
      lines,
      ...optionalProperties(childCursor === undefined ? undefined : { cursor: { row: childCursor.row + 1, column: childCursor.column + actualPadding + 1 } }),
    };
  });
}

/** Renders bounded Markdown through the same parser used by the transcript. */
export function uiMarkdown(value: string, options: RuntimeUiMarkdownOptions = {}): RuntimeUiView {
  const markdown = source(value, "UI Markdown");
  const input = record(options, ["role", "maxLines"], "UI Markdown options");
  const fallbackRole = role(input.role, "UI Markdown role") ?? "assistant";
  const limit = maxLines(input.maxLines, "UI Markdown maxLines");

  return createView((context) => {
    const rendered = renderMarkdownMessageLines("", markdown, context.width, fallbackRole);
    const lines = rendered.map((line): RuntimeUiLine => ({
      spans: line.spans.map((span) => ({
        text: span.text,
        role: span.role ?? line.role,
      })),
    }));
    return { lines: clippedLines(lines, Math.min(limit, context.height)) };
  });
}
