import { optionalProperties } from "../../core/optional-properties.js";
import { byteTruncate, sanitizeTerminalText, splitGraphemes } from "@ohm/terminal";

import type {
  OhmTuiComposerSnapshot,
  OhmTuiQueuedMessage,
  OhmTuiSnapshot,
  OhmTuiStatusSnapshot,
  OhmTuiTelemetrySnapshot,
  OhmTuiTranscriptEntry,
} from "./types.js";

const BLOCK_TEXT_LIMIT = 64 * 1024;
const DETAIL_TEXT_LIMIT = 128 * 1024;
const TOOL_DETAIL_LIMIT = 32;
const SINGLE_LINE_LIMIT = 512;
const CURSOR_SENTINEL = "\u2063";
const CURSOR_CELL = "\ue000";
const COMPOSER_START_SENTINEL = "\u2061";
const COMPOSER_END_SENTINEL = "\u2062";

interface CleanBlockSelection {
  text: string;
  truncated: boolean;
}

function cleanBlockSelection(value: string, limit = BLOCK_TEXT_LIMIT): CleanBlockSelection {
  const clean = sanitizeTerminalText(value)
    .replaceAll(CURSOR_SENTINEL, "")
    .replaceAll(CURSOR_CELL, "")
    .replaceAll(COMPOSER_START_SENTINEL, "")
    .replaceAll(COMPOSER_END_SENTINEL, "");
  return {
    text: byteTruncate(clean, limit),
    truncated: Buffer.byteLength(clean, "utf8") > limit,
  };
}

function cleanBlock(value: string, limit = BLOCK_TEXT_LIMIT): string {
  return cleanBlockSelection(value, limit).text;
}

function cleanLine(value: string, limit = SINGLE_LINE_LIMIT): string {
  return byteTruncate(sanitizeTerminalText(value), limit)
    .replaceAll(CURSOR_SENTINEL, "")
    .replaceAll(CURSOR_CELL, "")
    .replaceAll(COMPOSER_START_SENTINEL, "")
    .replaceAll(COMPOSER_END_SENTINEL, "")
    .replaceAll(/\s*\n\s*/gu, " ")
    .trim();
}

function cleanEntry(entry: OhmTuiTranscriptEntry): OhmTuiTranscriptEntry {
  const id = cleanLine(entry.id);
  switch (entry.kind) {
    case "user":
    case "assistant":
      return { id, kind: entry.kind, text: cleanBlock(entry.text) };
    case "thinking":
      return {
        id,
        kind: "thinking",
        status: entry.status,
        text: cleanBlock(entry.text),
        ...optionalProperties(entry.expanded === undefined ? undefined : { expanded: entry.expanded }),
      };
    case "notice": {
      const retained = cleanBlockSelection(entry.text, DETAIL_TEXT_LIMIT);
      return {
        id,
        kind: "notice",
        tone: entry.tone,
        text: retained.text,
        ...optionalProperties(entry.label === undefined ? undefined : { label: cleanLine(entry.label) }),
        ...optionalProperties(entry.compactText === undefined ? undefined : { compactText: cleanBlock(entry.compactText) }),
        ...optionalProperties(entry.expandable === undefined ? undefined : { expandable: entry.expandable }),
        ...optionalProperties(entry.expanded === undefined ? undefined : { expanded: entry.expanded }),
        ...optionalProperties(entry.truncated === true || retained.truncated ? { truncated: true } : undefined),
      };
    }
    case "tool":
      return {
        id,
        kind: "tool",
        name: cleanLine(entry.name),
        status: entry.status,
        ...optionalProperties(entry.headline === undefined ? undefined : { headline: cleanLine(entry.headline) }),
        ...optionalProperties(entry.state === undefined ? undefined : { state: cleanLine(entry.state) }),
        ...optionalProperties(entry.summary === undefined ? undefined : { summary: cleanBlock(entry.summary) }),
        ...optionalProperties(entry.input === undefined ? undefined : { input: cleanBlock(entry.input, DETAIL_TEXT_LIMIT) }),
        ...optionalProperties(entry.output === undefined ? undefined : { output: cleanBlock(entry.output, DETAIL_TEXT_LIMIT) }),
        ...optionalProperties(entry.details === undefined ? undefined : {
          details: entry.details.slice(0, TOOL_DETAIL_LIMIT).map((detail) => ({
            kind: detail.kind,
            label: cleanLine(detail.label),
            value: cleanBlock(detail.value, DETAIL_TEXT_LIMIT),
            ...optionalProperties(detail.markdown === undefined ? undefined : { markdown: detail.markdown }),
            ...optionalProperties(detail.preview === undefined ? undefined : { preview: detail.preview }),
            ...optionalProperties(detail.tail === undefined ? undefined : { tail: detail.tail }),
          })),
        }),
        ...optionalProperties(entry.expanded === undefined ? undefined : { expanded: entry.expanded }),
        ...optionalProperties(entry.truncated === undefined ? undefined : { truncated: entry.truncated }),
      };
  }
}

function cleanTranscript(entries: readonly OhmTuiTranscriptEntry[]): OhmTuiTranscriptEntry[] {
  const unique: OhmTuiTranscriptEntry[] = [];
  const positions = new Map<string, number>();
  for (const entry of entries) {
    const clean = cleanEntry(entry);
    const key = `${clean.kind}:${clean.id}`;
    const existing = positions.get(key);
    if (existing === undefined) {
      positions.set(key, unique.length);
      unique.push(clean);
    } else {
      unique[existing] = clean;
    }
  }

  return unique;
}

function cleanQueuedMessage(message: OhmTuiQueuedMessage): OhmTuiQueuedMessage {
  return { id: cleanLine(message.id), text: cleanBlock(message.text) };
}

function cleanComposer(composer: OhmTuiComposerSnapshot): OhmTuiComposerSnapshot {
  const source = splitGraphemes(composer.value);
  const requested = composer.cursor === undefined || !Number.isFinite(composer.cursor)
    ? source.length
    : Math.max(0, Math.trunc(composer.cursor));
  const value = cleanBlock(composer.value);
  const cleanPrefix = cleanBlock(source.slice(0, requested).join(""));
  const cursor = Math.min(splitGraphemes(value).length, splitGraphemes(cleanPrefix).length);
  return {
    value,
    cursor,
    ...optionalProperties(composer.placeholder === undefined ? undefined : { placeholder: cleanLine(composer.placeholder) }),
    ...optionalProperties(composer.label === undefined ? undefined : { label: cleanLine(composer.label) }),
    ...optionalProperties(composer.prompt === undefined ? undefined : { prompt: cleanBlock(composer.prompt) }),
    ...optionalProperties(composer.mode === undefined ? undefined : { mode: cleanLine(composer.mode) }),
  };
}

function cleanStatus(status: OhmTuiStatusSnapshot): OhmTuiStatusSnapshot {
  return {
    connection: status.connection,
    ...optionalProperties(status.model === undefined ? undefined : { model: cleanLine(status.model) }),
    ...optionalProperties(status.reasoning === undefined ? undefined : { reasoning: cleanLine(status.reasoning) }),
    ...optionalProperties(status.activity === undefined ? undefined : { activity: cleanLine(status.activity) }),
  };
}

function finiteNonNegative(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.max(0, value);
}

function cleanTelemetry(telemetry: OhmTuiTelemetrySnapshot): OhmTuiTelemetrySnapshot {
  const contextTokens = finiteNonNegative(telemetry.contextTokens);
  const contextWindowTokens = finiteNonNegative(telemetry.contextWindowTokens);
  const inputTokens = finiteNonNegative(telemetry.inputTokens);
  const outputTokens = finiteNonNegative(telemetry.outputTokens);
  const cacheReadTokens = finiteNonNegative(telemetry.cacheReadTokens);
  const cacheWriteTokens = finiteNonNegative(telemetry.cacheWriteTokens);
  const cacheHitPercent = finiteNonNegative(telemetry.cacheHitPercent);
  const cost = finiteNonNegative(telemetry.cost);
  return {
    ...optionalProperties(contextTokens === undefined ? undefined : { contextTokens }),
    ...optionalProperties(contextWindowTokens === undefined ? undefined : { contextWindowTokens }),
    ...optionalProperties(inputTokens === undefined ? undefined : { inputTokens }),
    ...optionalProperties(outputTokens === undefined ? undefined : { outputTokens }),
    ...optionalProperties(cacheReadTokens === undefined ? undefined : { cacheReadTokens }),
    ...optionalProperties(cacheWriteTokens === undefined ? undefined : { cacheWriteTokens }),
    ...optionalProperties(cacheHitPercent === undefined ? undefined : { cacheHitPercent: Math.min(100, cacheHitPercent) }),
    ...optionalProperties(cost === undefined ? undefined : { cost }),
    ...optionalProperties(telemetry.subscription === true ? { subscription: true } : undefined),
  };
}

export function normalizeOhmTuiSnapshot(snapshot: OhmTuiSnapshot): OhmTuiSnapshot {
  return {
    transcript: cleanTranscript(snapshot.transcript),
    queuedMessages: snapshot.queuedMessages.map(cleanQueuedMessage),
    composer: cleanComposer(snapshot.composer),
    status: cleanStatus(snapshot.status),
    telemetry: cleanTelemetry(snapshot.telemetry),
  };
}
