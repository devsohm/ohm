import { render, type Cls } from "grok-mermaid";

import type { ThemeRole } from "./theme.js";
import { cellWidth, sanitizeTerminalText } from "./unicode.js";

export interface MermaidTerminalSpan {
  text: string;
  role?: ThemeRole;
}

export interface MermaidTerminalLine {
  text: string;
  spans: readonly MermaidTerminalSpan[];
}

const MAX_MERMAID_SOURCE_BYTES = 32 * 1024;
const MAX_MERMAID_SOURCE_LINES = 512;
const MAX_MERMAID_STATEMENTS = 256;
const MAX_MERMAID_RENDERED_LINES = 256;

const ROLE_BY_CLASS = {
  border: "border",
  edge: "accent",
  edgeLabel: "muted",
  none: undefined,
  text: undefined,
  title: "accent",
} satisfies Readonly<Record<Cls, ThemeRole | undefined>>;

function sourceIsBounded(source: string): boolean {
  if (Buffer.byteLength(source, "utf8") > MAX_MERMAID_SOURCE_BYTES) return false;
  const lines = source.split("\n");
  if (lines.length > MAX_MERMAID_SOURCE_LINES) return false;
  let statements = lines.length;
  for (const line of lines) {
    statements += line.match(/;/gu)?.length ?? 0;
    if (statements > MAX_MERMAID_STATEMENTS) return false;
  }
  return true;
}

export function renderMermaidTerminal(source: string, availableWidth: number): readonly MermaidTerminalLine[] | undefined {
  if (!Number.isSafeInteger(availableWidth) || availableWidth < 8 || !sourceIsBounded(source)) return undefined;
  try {
    const rendered = render(source);
    if (
      rendered === null
      || rendered.warnings.length > 0
      || rendered.width > availableWidth
      || rendered.plain.length === 0
      || rendered.plain.length > MAX_MERMAID_RENDERED_LINES
      || rendered.styled.length !== rendered.plain.length
    ) return undefined;

    const lines: MermaidTerminalLine[] = [];
    for (let index = 0; index < rendered.plain.length; index += 1) {
      const plain = rendered.plain[index];
      const styled = rendered.styled[index];
      if (plain === undefined || styled === undefined) return undefined;
      const text = sanitizeTerminalText(plain).replaceAll("\n", " ");
      if (text !== plain || cellWidth(text) > availableWidth) return undefined;
      const spans: MermaidTerminalSpan[] = [];
      for (const span of styled) {
        const spanText = sanitizeTerminalText(span.text).replaceAll("\n", " ");
        if (spanText !== span.text) return undefined;
        const role = ROLE_BY_CLASS[span.cls];
        spans.push(role === undefined ? { text: spanText } : { text: spanText, role });
      }
      if (spans.map((span) => span.text).join("") !== text) return undefined;
      lines.push({ text, spans });
    }
    return lines;
  } catch {
    return undefined;
  }
}
