import type { Theme, ThemeRole } from "../theme.js";

interface ParsedStyle {
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
  strikethrough: boolean;
  foreground: string;
  background: string;
}

interface ColorSequence {
  value: string;
  next: number;
}

function defaultStyle(): ParsedStyle {
  return {
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    inverse: false,
    strikethrough: false,
    foreground: "",
    background: "",
  };
}

function colorSequence(parameters: readonly number[], index: number): ColorSequence {
  const mode = parameters[index + 1];
  if (mode === 5 && parameters[index + 2] !== undefined) {
    return { value: parameters.slice(index, index + 3).join(";"), next: index + 2 };
  }
  if (mode === 2 && parameters.slice(index + 2, index + 5).length === 3) {
    return { value: parameters.slice(index, index + 5).join(";"), next: index + 4 };
  }
  return { value: String(parameters[index]), next: index };
}

function parseStyle(code: string): ParsedStyle {
  const selected = defaultStyle();
  for (const sequence of code.split("\u001b[").slice(1)) {
    const terminator = sequence.indexOf("m");
    if (terminator === -1) continue;
    const parameters = sequence.slice(0, terminator).split(";")
      .map((value) => Number.parseInt(value || "0", 10));
    for (let index = 0; index < parameters.length; index += 1) {
      const value = parameters[index]!;
      if (value === 0) {
        Object.assign(selected, defaultStyle());
      } else if (value === 1) selected.bold = true;
      else if (value === 2) selected.dim = true;
      else if (value === 3) selected.italic = true;
      else if (value === 4) selected.underline = true;
      else if (value === 7) selected.inverse = true;
      else if (value === 9) selected.strikethrough = true;
      else if (value === 22) { selected.bold = false; selected.dim = false; }
      else if (value === 23) selected.italic = false;
      else if (value === 24) selected.underline = false;
      else if (value === 27) selected.inverse = false;
      else if (value === 29) selected.strikethrough = false;
      else if (value === 39) selected.foreground = "";
      else if (value === 49) selected.background = "";
      else if (value === 38) {
        const color = colorSequence(parameters, index);
        selected.foreground = color.value;
        index = color.next;
      } else if (value === 48) {
        const color = colorSequence(parameters, index);
        selected.background = color.value;
        index = color.next;
      } else if ((value >= 30 && value <= 37) || (value >= 90 && value <= 97)) {
        selected.foreground = String(value);
      } else if ((value >= 40 && value <= 47) || (value >= 100 && value <= 107)) {
        selected.background = String(value);
      }
    }
  }
  return selected;
}

/** Canonicalizes one semantic theme role without a renderer-specific ANSI pass. */
export function nativeStyle(theme: Theme, role: ThemeRole, value: string): string {
  if (!theme.ansi || value === "") return value;
  const selected = parseStyle(theme.codes[role]);
  const open = [
    selected.bold ? "\u001b[1m" : "",
    selected.dim ? "\u001b[2m" : "",
    selected.italic ? "\u001b[3m" : "",
    selected.underline ? "\u001b[4m" : "",
    selected.inverse ? "\u001b[7m" : "",
    selected.strikethrough ? "\u001b[9m" : "",
    selected.foreground === "" ? "" : `\u001b[${selected.foreground}m`,
    selected.background === "" ? "" : `\u001b[${selected.background}m`,
  ].join("");
  const close = [
    selected.background === "" ? "" : "\u001b[49m",
    selected.foreground === "" ? "" : "\u001b[39m",
    selected.strikethrough ? "\u001b[29m" : "",
    selected.inverse ? "\u001b[27m" : "",
    selected.underline ? "\u001b[24m" : "",
    selected.italic ? "\u001b[23m" : "",
    selected.bold || selected.dim ? "\u001b[22m" : "",
  ].join("");
  return `${open}${value}${close}`;
}
