export interface RgbColor { r: number; g: number; b: number }
export type TerminalColorScheme = "dark" | "light";

const ESCAPE = "\x1b";
const BELL = "\x07";
const OSC_11_SOURCE = `${ESCAPE}\\]11;rgb:`;
const OSC_11_PATTERN = new RegExp(
  `${OSC_11_SOURCE}([0-9a-f]{1,4})/([0-9a-f]{1,4})/([0-9a-f]{1,4})(?:${BELL}|${ESCAPE}\\\\)`,
  "iu",
);
const COLOR_SCHEME_PREFIX = `${ESCAPE}[?997;`;

function channel(value: string): number { return Math.round(Number.parseInt(value, 16) / ((16 ** value.length) - 1) * 255); }

export function parseOsc11BackgroundColor(value: string): RgbColor | undefined {
  const matched = OSC_11_PATTERN.exec(value);
  return matched === null ? undefined : { r: channel(matched[1]!), g: channel(matched[2]!), b: channel(matched[3]!) };
}
export function isOsc11BackgroundColorResponse(value: string): boolean { return parseOsc11BackgroundColor(value) !== undefined; }
export function parseTerminalColorSchemeReport(value: string): TerminalColorScheme | undefined {
  const start = value.indexOf(COLOR_SCHEME_PREFIX);
  if (start < 0) return undefined;
  const response = value.slice(start + COLOR_SCHEME_PREFIX.length);
  return response.startsWith("1n") ? "dark" : response.startsWith("2n") ? "light" : undefined;
}
