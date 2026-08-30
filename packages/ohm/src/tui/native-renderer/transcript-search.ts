import { cellWidth, splitGraphemes, stripAnsi } from "@ohm/terminal";

const DEFAULT_SEARCH_WINDOW_ROWS = 256;
const DEFAULT_MAXIMUM_MATCHES = 50_000;
const MAXIMUM_SEARCH_WINDOW_ROWS = 4_096;
const MAXIMUM_SEARCH_MATCHES = 100_000;

export interface OhmTranscriptSearchSource {
  readonly totalRows: number;
  window(start: number, height: number): { readonly rows: readonly string[] };
}

export interface OhmTranscriptSearchSpan {
  readonly row: number;
  readonly startColumn: number;
  readonly endColumn: number;
}

export interface OhmTranscriptSearchMatch {
  readonly startRow: number;
  readonly endRow: number;
  readonly spans: readonly OhmTranscriptSearchSpan[];
}

export interface OhmTranscriptSearchResult {
  readonly normalizedQuery: string;
  readonly matches: readonly OhmTranscriptSearchMatch[];
  readonly truncated: boolean;
}

export interface OhmTranscriptSearchOptions {
  readonly maximumMatches?: number;
  readonly windowRows?: number;
}

interface SearchLocation {
  readonly row: number;
  readonly startColumn: number;
  readonly endColumn: number;
}

function positiveBoundedInteger(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${label} must be between 1 and ${maximum}`);
  }
  return value;
}

function normalizedTokens(value: string): string[] {
  const tokens: string[] = [];
  let whitespace = true;
  for (const grapheme of splitGraphemes(value)) {
    if (/^\s+$/u.test(grapheme)) {
      if (!whitespace) tokens.push(" ");
      whitespace = true;
      continue;
    }
    tokens.push(...Array.from(grapheme.toLowerCase()));
    whitespace = false;
  }
  if (tokens.at(-1) === " ") tokens.pop();
  return tokens;
}

function failureTable(pattern: readonly string[]): number[] {
  const table = Array.from({ length: pattern.length }, () => 0);
  for (let index = 1, prefix = 0; index < pattern.length; index += 1) {
    while (prefix > 0 && pattern[index] !== pattern[prefix]) prefix = table[prefix - 1]!;
    if (pattern[index] === pattern[prefix]) prefix += 1;
    table[index] = prefix;
  }
  return table;
}

function matchFromLocations(locations: readonly (SearchLocation | undefined)[]): OhmTranscriptSearchMatch | undefined {
  const spans: OhmTranscriptSearchSpan[] = [];
  for (const location of locations) {
    if (location === undefined || location.endColumn <= location.startColumn) continue;
    const previous = spans.at(-1);
    if (
      previous !== undefined
      && previous.row === location.row
      && location.startColumn <= previous.endColumn
    ) {
      spans[spans.length - 1] = {
        ...previous,
        endColumn: Math.max(previous.endColumn, location.endColumn),
      };
    } else spans.push(location);
  }
  const first = spans[0];
  const last = spans.at(-1);
  return first === undefined || last === undefined
    ? undefined
    : { startRow: first.row, endRow: last.row, spans };
}

/** Searches the bounded rendered transcript without constructing one unbounded corpus string. */
export function searchOhmTranscript(
  source: OhmTranscriptSearchSource,
  query: string,
  options: OhmTranscriptSearchOptions = {},
): OhmTranscriptSearchResult {
  if (!Number.isSafeInteger(source.totalRows) || source.totalRows < 0) {
    throw new RangeError("Transcript search row count must be a non-negative safe integer");
  }
  const pattern = normalizedTokens(query);
  const normalizedQuery = pattern.join("");
  if (pattern.length === 0 || source.totalRows === 0) {
    return { normalizedQuery: "", matches: [], truncated: false };
  }
  const maximumMatches = positiveBoundedInteger(
    options.maximumMatches ?? DEFAULT_MAXIMUM_MATCHES,
    MAXIMUM_SEARCH_MATCHES,
    "Transcript search match limit",
  );
  const windowRows = positiveBoundedInteger(
    options.windowRows ?? DEFAULT_SEARCH_WINDOW_ROWS,
    MAXIMUM_SEARCH_WINDOW_ROWS,
    "Transcript search window size",
  );
  const failure = failureTable(pattern);
  const recent = Array.from<(SearchLocation | undefined)>({ length: pattern.length });
  const matches: OhmTranscriptSearchMatch[] = [];
  let recentCount = 0;
  let recentNext = 0;
  let prefix = 0;
  let truncated = false;
  let previousWasWhitespace = true;

  const emit = (token: string, location: SearchLocation | undefined): boolean => {
    recent[recentNext] = location;
    recentNext = (recentNext + 1) % recent.length;
    recentCount = Math.min(recent.length, recentCount + 1);
    while (prefix > 0 && token !== pattern[prefix]) prefix = failure[prefix - 1]!;
    if (token === pattern[prefix]) prefix += 1;
    if (prefix !== pattern.length || recentCount < pattern.length) return false;
    const ordered = Array.from({ length: pattern.length }, (_, index) =>
      recent[(recentNext + index) % recent.length]);
    const match = matchFromLocations(ordered);
    prefix = failure[prefix - 1]!;
    if (match === undefined) return false;
    if (matches.length < maximumMatches) {
      matches.push(match);
      return false;
    }
    truncated = true;
    return true;
  };

  search: for (let start = 0; start < source.totalRows; start += windowRows) {
    const height = Math.min(windowRows, source.totalRows - start);
    const rows = source.window(start, height).rows.slice(0, height);
    for (let localRow = 0; localRow < rows.length; localRow += 1) {
      const row = start + localRow;
      if (row > 0 && !previousWasWhitespace) {
        if (emit(" ", undefined)) break search;
        previousWasWhitespace = true;
      }
      let column = 0;
      for (const grapheme of splitGraphemes(stripAnsi(rows[localRow] ?? ""))) {
        const width = Math.max(0, cellWidth(grapheme));
        if (/^\s+$/u.test(grapheme)) {
          if (!previousWasWhitespace && emit(" ", undefined)) break search;
          previousWasWhitespace = true;
        } else {
          const location = { row, startColumn: column, endColumn: column + width };
          for (const token of Array.from(grapheme.toLowerCase())) {
            if (emit(token, location)) break search;
          }
          previousWasWhitespace = false;
        }
        column += width;
      }
    }
    if (rows.length < height) break;
  }
  return { normalizedQuery, matches, truncated };
}
