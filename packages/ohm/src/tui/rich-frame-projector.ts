import { createHash } from "node:crypto";

import { optionalProperties } from "../core/optional-properties.js";
import { isStringValue } from "./value-guards.js";

import {
  cellWidth,
  isImageLine,
  sanitizeTerminalText,
  sliceByColumn,
  splitGraphemes,
  stripAnsi,
  truncateToWidth,
  visibleWidth,
} from "@ohm/terminal";

import {
  createOhmNativeViewProjector,
  normalizeOhmTuiSnapshot,
  projectOhmNativeFrame,
  projectOhmNativeTranscriptEntries,
  projectOhmTuiToolEntry,
  type OhmTuiSnapshot,
  type OhmTuiToolEntry,
  type OhmTuiTranscriptEntry,
} from "./native-renderer/index.js";
import {
  createNativeOverlaySnapshot,
  projectNativeOverlay,
} from "./native-renderer/overlay.js";
import {
  projectRuntimeUiBlock,
  projectTuiRuntimeSurfaces,
  projectTuiRawImageReservations,
  type TuiRuntimeOverlayProjection,
  type TuiRuntimeSurfaceBlock,
  type TuiRuntimeSurfaceProjection,
  type TuiRuntimeSurfaceSlot,
} from "./native-renderer/runtime-surfaces.js";
import {
  projectOhmTuiTranscriptContent,
} from "./native-renderer/transcript-content.js";
import {
  OhmTranscriptLayout,
  type OhmTranscriptChunk as RetainedTranscriptChunk,
} from "./native-renderer/transcript-layout.js";
import {
  searchOhmTranscript,
  type OhmTranscriptSearchResult,
} from "./native-renderer/transcript-search.js";
import { TuiController } from "./controller.js";
import {
  INTERNAL_TUI_FRAME_PROJECTOR,
  INTERNAL_TUI_PERSISTENT_POINTER_MAP,
  INTERNAL_TUI_PERSISTENT_POINTER_SOURCE,
  INTERNAL_TUI_TRANSCRIPT_SEARCH,
  type InternalTuiControllerOptions,
  type TuiFrameProjectionRequest,
  type TuiFrameProjector,
  type TuiPersistentPointerMap,
  type TuiProjectedFrame,
} from "./frame-projector.js";
import { elapsedText } from "./model.js";
import {
  MAX_TERMINAL_IMAGE_AGGREGATE_BYTES,
  MAX_TERMINAL_IMAGE_COUNT,
} from "./terminal-image.js";
import type { TranscriptEntry, TuiControllerOptions, TuiViewState } from "./types.js";

function projectedStatus(entry: TranscriptEntry): "pending" | "running" | "completed" | "error" | "in_doubt" {
  if (entry.status === "failed") return "error";
  return entry.status ?? "completed";
}

function projectedCard(entry: TranscriptEntry): OhmTuiTranscriptEntry | undefined {
  if (entry.card === undefined) return undefined;
  const name = entry.card === "skill"
    ? "skill"
    : entry.card === "compaction"
      ? "context"
      : "branch";
  const state = entry.status === "running"
    ? entry.card === "compaction" ? "compacting" : "working"
    : entry.status === "failed"
      ? "failed"
      : entry.status === "in_doubt"
        ? "outcome unknown"
        : entry.card === "skill"
          ? "ready"
          : entry.card === "compaction"
            ? "compacted"
            : "summarized";
  const headline = [
    entry.title,
    entry.compactText,
    entry.summary,
  ].filter((value): value is string => value !== undefined && value !== "").join(" · ");
  const projected: OhmTuiToolEntry = {
    id: entry.id,
    kind: "tool",
    name,
    status: projectedStatus(entry),
    state,
    ...optionalProperties(headline === "" ? undefined : { headline }),
    ...optionalProperties(entry.text === "" ? undefined : {
      details: [{
        label: entry.card === "skill" ? "Instructions" : "Summary",
        value: entry.text,
        kind: entry.card === "skill" ? "source" : "output",
        markdown: true,
      }],
    }),
    ...optionalProperties(entry.expanded === undefined ? undefined : { expanded: entry.expanded }),
  };
  return projected;
}

function transcriptEntry(
  entry: TranscriptEntry,
): OhmTuiTranscriptEntry | undefined {
  const card = projectedCard(entry);
  if (card !== undefined) return card;
  if (entry.kind === "startup") {
    return {
      id: entry.id,
      kind: "notice",
      tone: "status",
      text: entry.text,
      ...optionalProperties(entry.compactText === undefined ? undefined : { compactText: entry.compactText }),
      expandable: true,
      ...optionalProperties(entry.expanded === undefined ? undefined : { expanded: entry.expanded }),
    };
  }
  if (entry.extension !== undefined) {
    const label = entry.extension.customType;
    return {
      id: entry.id,
      kind: "notice",
      tone: entry.kind === "error" ? "error" : entry.kind === "warning" ? "warning" : "status",
      label,
      text: entry.text,
      ...optionalProperties(entry.expandable === true ? { compactText: "", expandable: true } : undefined),
      ...optionalProperties(entry.expanded === undefined ? undefined : { expanded: entry.expanded }),
    };
  }
  if (entry.kind === "user" || entry.kind === "assistant") {
    return { id: entry.id, kind: entry.kind, text: entry.text };
  }
  if (entry.kind === "status" || entry.kind === "warning" || entry.kind === "error") {
    return {
      id: entry.id,
      kind: "notice",
      tone: entry.kind,
      text: entry.text,
      ...optionalProperties(entry.title === undefined ? undefined : { label: entry.title }),
      ...optionalProperties(entry.expandable === true ? { expandable: true } : undefined),
      ...optionalProperties(entry.expanded === undefined ? undefined : { expanded: entry.expanded }),
    };
  }
  if (entry.kind === "tool") return projectOhmTuiToolEntry(entry);
  return undefined;
}

function reasoningSource(entry: TranscriptEntry): string | undefined {
  return entry.sourceMessageId?.trim() === "" ? undefined : entry.sourceMessageId;
}

function liveReasoningPrefix(id: string): string | undefined {
  const match = /^(.*:reasoning:[^:]+):[^:]+$/u.exec(id);
  return match?.[1];
}

function sharesReasoningGroup(previous: TranscriptEntry, next: TranscriptEntry): boolean {
  const previousPrefix = liveReasoningPrefix(previous.id);
  const nextPrefix = liveReasoningPrefix(next.id);
  if (previousPrefix !== undefined && nextPrefix !== undefined && previousPrefix !== nextPrefix) return false;

  const previousSource = reasoningSource(previous);
  const nextSource = reasoningSource(next);
  if (previousSource !== undefined || nextSource !== undefined) {
    return previousSource !== undefined && previousSource === nextSource;
  }
  if (previousPrefix !== undefined && previousPrefix === nextPrefix) return true;
  return previous.streaming === true && next.streaming === true;
}

function projectTranscript(
  entries: readonly TranscriptEntry[],
  hideReasoningBlock: boolean,
): OhmTuiTranscriptEntry[] {
  const projected: OhmTuiTranscriptEntry[] = [];
  let reasoning: TranscriptEntry[] = [];
  const flushReasoning = (): void => {
    const first = reasoning[0];
    if (first === undefined) return;
    projected.push({
      id: first.id,
      kind: "thinking",
      status: reasoning.some((entry) => entry.streaming === true) ? "active" : "completed",
      text: reasoning.map((entry) => entry.text).filter((text) => text !== "").join("\n\n"),
      ...optionalProperties(reasoning.some((entry) => entry.expanded !== undefined)
        ? { expanded: reasoning.some((entry) => entry.expanded === true) }
        : undefined),
    });
    reasoning = [];
  };

  for (const entry of entries) {
    if (entry.kind === "reasoning") {
      if (hideReasoningBlock) continue;
      if (reasoning.some((member) => !sharesReasoningGroup(member, entry))) flushReasoning();
      reasoning.push(entry);
      continue;
    }
    flushReasoning();
    const item = transcriptEntry(entry);
    if (item !== undefined) projected.push(item);
  }
  flushReasoning();
  return projected;
}

function queueId(mode: string, text: string, occurrence: number): string {
  const digest = createHash("sha256").update(mode).update("\0").update(text).digest("base64url");
  return `queue:${digest}:${occurrence}`;
}

function connection(view: TuiViewState): OhmTuiSnapshot["status"]["connection"] {
  if (view.context.provider !== undefined && view.context.model !== undefined) return "connected";
  if (view.context.status === "failed") return "error";
  return view.context.active === true ? "connecting" : "offline";
}

function activity(view: TuiViewState, unicode: boolean): string | undefined {
  const current = view.context.activity;
  if (current === undefined || view.context.active !== true || view.context.workingVisible === false) return undefined;
  const elapsed = Number.isFinite(current.startedAt)
    ? elapsedText(Math.max(0, Date.now() - current.startedAt))
    : undefined;
  const retryDelay = current.retryAt === undefined
    ? undefined
    : `${(Math.max(0, current.retryAt - Date.now()) / 1_000).toFixed(1)}s`;
  const retry = retryDelay === undefined
    ? undefined
    : `${current.attempt === undefined ? "retry" : `attempt ${current.attempt}`} in ${retryDelay}`;
  return [
    current.phase,
    elapsed,
    retry,
    current.cancellable === true ? "Esc to cancel" : undefined,
  ].filter((value): value is string => value !== undefined && value !== "").join(unicode ? " · " : " | ");
}

function hasMarkdown(value: string): boolean {
  return /(?:^|\n)\s{0,3}(?:#{1,6}\s|>|[-+*]\s|\d+[.)]\s|```|~~~|_{3,}\s*$|-{3,}\s*$)/mu.test(value)
    || /(?:\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_|~~[^~\n]+~~|`[^`\n]+`|\[[^\]\n]+\]\([^\n)]+\)|<https?:\/\/[^\s>]+>)/u.test(value)
    || /(?:^|\n)(?: {4}\S|\s*\|.+\|\s*(?:\n|$)|\s*\|?\s*:?-{3,})/u.test(value);
}

function entryNeedsHostTranscript(
  request: Readonly<TuiFrameProjectionRequest>,
  entry: TranscriptEntry,
): boolean {
  const options = request.transcriptOptions;
  if (entry.kind === "tool") {
    const custom = entry.callId === undefined ? undefined : options.toolRenderBlocks?.get(entry.callId);
    return custom?.shell === "self";
  }
  if (entry.kind === "startup" || entry.card !== undefined) return false;
  const sessionOwned = options.sessionRenderBlocks?.has(entry.id) === true;
  if (entry.extension !== undefined && !sessionOwned) return false;
  const markdownOwned = (entry.kind === "user" || entry.kind === "assistant")
    && (options.transformMarkdown !== undefined || hasMarkdown(entry.text));
  const outputPaddingOwned = (entry.kind === "user" || entry.kind === "assistant")
    && request.outputPad !== 1;
  return outputPaddingOwned
    || markdownOwned
    || (entry.kind === "reasoning" && (request.hideReasoningBlock || request.view.hiddenReasoningLabel !== undefined))
    || sessionOwned
    || entry.expandable === true;
}

function snapshotFor(request: Readonly<TuiFrameProjectionRequest>): OhmTuiSnapshot {
  const { view } = request;
  const unicode = request.theme.unicode;

  const transcript: OhmTuiTranscriptEntry[] = [];
  if (view.notice !== undefined) {
    transcript.push({ id: "view:notice", kind: "notice", tone: "status", text: view.notice });
  }
  const queueOccurrences = new Map<string, number>();
  const queuedMessages = (view.queuedMessages ?? []).map((message) => {
    const key = `${message.mode}\0${message.text}`;
    const occurrence = queueOccurrences.get(key) ?? 0;
    queueOccurrences.set(key, occurrence + 1);
    return {
      id: queueId(message.mode, message.text, occurrence),
      text: [
        message.text,
        (message.imageCount ?? message.images?.length ?? 0) === 0
          ? undefined
          : `[${message.imageCount ?? message.images?.length} image${(message.imageCount ?? message.images?.length) === 1 ? "" : "s"}]`,
      ].filter((value): value is string => value !== undefined && value !== "").join(unicode ? " · " : " | "),
    };
  });
  const usage = view.usage;
  const total = usage?.total;
  const currentActivity = activity(view, unicode);
  return {
    transcript,
    queuedMessages,
    composer: {
      value: view.editorText,
      cursor: view.editorCursor,
      placeholder: "Type a message",
      label: view.inputLabel === "you" ? "Ask ohm" : view.inputLabel,
      ...optionalProperties(view.inputPrompt === undefined ? undefined : { prompt: view.inputPrompt }),
      ...optionalProperties(view.inputMode === "follow_up" ? { mode: "follow-up" } : undefined),
    },
    status: {
      connection: connection(view),
      ...optionalProperties(view.context.provider === undefined && view.context.model === undefined ? undefined : { model: [view.context.provider, view.context.model].filter(Boolean).join("/") }),
      ...optionalProperties(view.context.thinking === undefined ? undefined : { reasoning: view.context.thinking }),
      ...optionalProperties(currentActivity === undefined ? undefined : { activity: currentActivity }),
    },
    telemetry: {
      ...optionalProperties(view.context.contextTokens === undefined ? undefined : { contextTokens: view.context.contextTokens }),
      ...optionalProperties(view.context.contextWindowTokens === undefined ? undefined : { contextWindowTokens: view.context.contextWindowTokens }),
      ...optionalProperties(usage?.promptInputTokens === undefined ? undefined : { inputTokens: usage.promptInputTokens }),
      ...optionalProperties(total?.outputTokens === undefined ? undefined : { outputTokens: total.outputTokens }),
      ...optionalProperties(total?.cacheReadTokens === undefined ? undefined : { cacheReadTokens: total.cacheReadTokens }),
      ...optionalProperties(total?.cacheWriteTokens === undefined ? undefined : { cacheWriteTokens: total.cacheWriteTokens }),
      ...optionalProperties(usage?.latestCacheHitRate === undefined ? undefined : { cacheHitPercent: usage.latestCacheHitRate }),
      ...optionalProperties(total?.cost?.total === undefined ? undefined : { cost: total.cost.total }),
      ...optionalProperties(view.context.subscription === true ? { subscription: true } : undefined),
    },
  };
}

function hasValidFrameGeometry(
  frame: TuiProjectedFrame,
  size: Readonly<{ columns: number; rows: number }>,
): boolean {
  const rows = frame.text === "" ? [] : frame.text.split("\n");
  return rows.every((row) => cellWidth(row) <= size.columns)
    && frame.cursor.row >= 1
    && frame.cursor.row <= Math.max(1, rows.length)
    && frame.cursor.column >= 1
    && frame.cursor.column <= size.columns;
}

function fitsViewport(frame: TuiProjectedFrame, size: Readonly<{ columns: number; rows: number }>): boolean {
  const rowCount = frame.text === "" ? 0 : frame.text.split("\n").length;
  return rowCount <= size.rows && hasValidFrameGeometry(frame, size);
}

interface TranscriptChunk {
  readonly host: boolean;
  readonly entries: readonly TranscriptEntry[];
}

interface RichTranscriptRowRange {
  readonly entryIds: readonly string[];
  readonly start: number;
  readonly end: number;
}

interface RichTranscriptWindow {
  readonly lines: readonly string[];
  readonly images: readonly NonNullable<TuiProjectedFrame["images"]>[number][];
}

interface RichTranscriptProjection {
  readonly totalRows: number;
  readonly messageRows: readonly number[];
  readonly ranges: readonly RichTranscriptRowRange[];
  window(start: number, height: number): RichTranscriptWindow;
  search(query: string): OhmTranscriptSearchResult;
}

interface CachedRichTranscriptProjection {
  readonly columns: number;
  readonly theme: TuiFrameProjectionRequest["theme"];
  readonly key: string;
  readonly content: RichTranscriptProjection;
}

interface CachedRichTranscriptChunk {
  readonly entries: readonly TranscriptEntry[];
  readonly fingerprint: string;
  readonly content: LocalTranscriptProjection;
  readonly entryCount: number;
  readonly rows: number;
  readonly bytes: number;
}

interface CachedRichTranscriptPrefix {
  readonly columns: number;
  readonly theme: TuiFrameProjectionRequest["theme"];
  readonly key: string;
  chunks: CachedRichTranscriptChunk[];
  entryCount: number;
  rows: number;
  bytes: number;
}

interface RichTranscriptLayoutCache {
  revision: number;
  layouts: CachedRichTranscriptProjection[];
  prefixes: CachedRichTranscriptPrefix[];
  retained: RetainedRichTranscriptSlot[];
}

interface RetainedRichTranscriptValue {
  readonly request: Readonly<TuiFrameProjectionRequest>;
  readonly shell: OhmTuiSnapshot;
  readonly chunk: TranscriptChunk;
}

interface RetainedRichTranscriptSlot {
  readonly columns: number;
  readonly theme: TuiFrameProjectionRequest["theme"];
  readonly key: string;
  readonly layout: OhmTranscriptLayout<RetainedRichTranscriptValue>;
  revision: number;
  overflow: boolean;
  searchQuery?: string;
  searchResult?: OhmTranscriptSearchResult;
}

// Cover the model's bounded 2,000-entry/2 MiB transcript after wrapping and ANSI styling.
const MAX_RICH_TRANSCRIPT_PREFIX_ENTRIES = 2_000;
const MAX_RICH_TRANSCRIPT_PREFIX_ROWS = 32_768;
const MAX_RICH_TRANSCRIPT_PREFIX_BYTES = 8 * 1024 * 1024;

function createRichTranscriptLayoutCache(): RichTranscriptLayoutCache {
  return { revision: -1, layouts: [], prefixes: [], retained: [] };
}

function richTranscriptLayoutKey(request: Readonly<TuiFrameProjectionRequest>): string {
  const options = request.transcriptOptions;
  return JSON.stringify([
    request.hideReasoningBlock,
    request.view.hiddenReasoningLabel,
    request.outputPad,
    options.outputPad,
    request.codeBlockIndent,
    options.codeBlockIndent,
    options.expandKeyHint,
    options.thinkingKeyHint,
    options.hyperlinks === true,
    options.semanticZones === true,
    options.hiddenReasoningLabel,
    options.hideReasoningBlock,
  ]);
}

function richTranscriptPrefixKey(request: Readonly<TuiFrameProjectionRequest>): string {
  const options = request.transcriptOptions;
  return JSON.stringify([
    request.outputPad,
    options.outputPad,
    request.codeBlockIndent,
    options.codeBlockIndent,
    options.hyperlinks === true,
    options.semanticZones === true,
  ]);
}

function richTranscriptCanReuse(
  request: Readonly<TuiFrameProjectionRequest>,
  entries: readonly TranscriptEntry[],
): request is Readonly<TuiFrameProjectionRequest> & { readonly transcriptRevision: number } {
  const revision = request.transcriptRevision;
  return revision !== undefined
    && Number.isSafeInteger(revision)
    && revision >= 0
    && request.transcriptOptions.transformMarkdown === undefined
    && (request.transcriptOptions.toolRenderBlocks?.size ?? 0) === 0
    && (request.transcriptOptions.sessionRenderBlocks?.size ?? 0) === 0
    && entries.every((entry) => entry.extension === undefined && (entry.images?.length ?? 0) === 0);
}

function transcriptChunks(
  request: Readonly<TuiFrameProjectionRequest>,
  entries: readonly TranscriptEntry[],
): TranscriptChunk[] {
  const chunks: TranscriptChunk[] = [];
  for (let index = 0; index < entries.length;) {
    const entry = entries[index]!;
    if (entry.kind === "reasoning") {
      const reasoning = [entry];
      index += 1;
      while (entries[index]?.kind === "reasoning" && sharesReasoningGroup(entry, entries[index]!)) {
        reasoning.push(entries[index]!);
        index += 1;
      }
      chunks.push({
        host: reasoning.some((candidate) => entryNeedsHostTranscript(request, candidate)),
        entries: reasoning,
      });
      continue;
    }
    chunks.push({ host: entryNeedsHostTranscript(request, entry), entries: [entry] });
    index += 1;
  }
  return chunks;
}

interface TrimmedLines {
  lines: string[];
  leading: number;
}

interface CustomToolProjection {
  readonly callLines: string[] | undefined;
  readonly resultLines: string[] | undefined;
  readonly failed: boolean;
}

interface CursorWindow {
  lines: string[];
  cursorRow: number;
  start: number;
}

interface RichShellBudgets {
  composerRows: number;
  promptRows: number;
  queueRows: number;
}

interface PaintedScrollbar {
  lines: string[];
  thumbTop: number;
  thumbRows: number;
}

interface ProjectionDimensions {
  columns: number;
  rows: number;
}

function trimExactEmptyLines(lines: readonly string[]): TrimmedLines {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start] === "") start += 1;
  while (end > start && lines[end - 1] === "") end -= 1;
  return { lines: lines.slice(start, end), leading: start };
}

interface LocalTranscriptProjection {
  readonly lines: string[];
  readonly images: NonNullable<TuiProjectedFrame["images"]>[number][];
}

function materializedRichTranscriptProjection(
  lines: readonly string[],
  images: readonly NonNullable<TuiProjectedFrame["images"]>[number][],
  messageRows: readonly number[],
  ranges: readonly RichTranscriptRowRange[],
): RichTranscriptProjection {
  let searchQuery: string | undefined;
  let searchResult: OhmTranscriptSearchResult | undefined;
  return {
    totalRows: lines.length,
    messageRows,
    ranges,
    window(start, height) {
      const selectedStart = Math.min(lines.length, Math.max(0, Math.trunc(start)));
      const selectedEnd = Math.min(lines.length, selectedStart + Math.max(0, Math.trunc(height)));
      return {
        lines: lines.slice(selectedStart, selectedEnd),
        images: images
          .filter((image) => image.row >= selectedStart && image.row + image.rows <= selectedEnd)
          .map((image) => ({ ...image, row: image.row - selectedStart })),
      };
    },
    search(query) {
      if (query === searchQuery && searchResult !== undefined) return searchResult;
      searchQuery = query;
      searchResult = searchOhmTranscript({
        totalRows: lines.length,
        window(start, height) { return { rows: lines.slice(start, start + height) }; },
      }, query);
      return searchResult;
    },
  };
}

function richTranscriptPrefix(
  cache: RichTranscriptLayoutCache,
  request: Readonly<TuiFrameProjectionRequest>,
  columns: number,
): CachedRichTranscriptPrefix {
  const key = richTranscriptPrefixKey(request);
  const retainedIndex = cache.prefixes.findIndex((prefix) =>
    prefix.columns === columns
      && prefix.theme === request.theme
      && prefix.key === key);
  if (retainedIndex >= 0) {
    const retained = cache.prefixes.splice(retainedIndex, 1)[0]!;
    cache.prefixes.push(retained);
    return retained;
  }
  const created: CachedRichTranscriptPrefix = {
    columns,
    theme: request.theme,
    key,
    chunks: [],
    entryCount: 0,
    rows: 0,
    bytes: 0,
  };
  cache.prefixes.push(created);
  if (cache.prefixes.length > 2) cache.prefixes.splice(0, cache.prefixes.length - 2);
  return created;
}

function trimRichTranscriptPrefix(prefix: CachedRichTranscriptPrefix, retainedChunks: number): void {
  if (retainedChunks >= prefix.chunks.length) return;
  prefix.chunks.splice(Math.max(0, retainedChunks));
  prefix.entryCount = prefix.chunks.reduce((count, chunk) => count + chunk.entryCount, 0);
  prefix.rows = prefix.chunks.reduce((count, chunk) => count + chunk.rows, 0);
  prefix.bytes = prefix.chunks.reduce((count, chunk) => count + chunk.bytes, 0);
}

function richTranscriptChunkCanCache(chunk: TranscriptChunk): boolean {
  return chunk.entries.every((entry) =>
    entry.extension === undefined
      && entry.streaming !== true
      && entry.status !== "pending"
      && entry.status !== "running");
}

function richTranscriptChunkFingerprint(
  request: Readonly<TuiFrameProjectionRequest>,
  chunk: TranscriptChunk,
): string | undefined {
  try {
    const reasoning = chunk.entries.some((entry) => entry.kind === "reasoning");
    const expandable = chunk.entries.some((entry) => (
      entry.kind === "tool"
      || entry.kind === "startup"
      || entry.expandable === true
    ));
    const inheritsToolExpansion = chunk.entries.some((entry) => (
      entry.kind === "tool"
      || entry.kind === "startup"
      || entry.expandable === true
    ) && entry.expanded === undefined);
    const serialized = JSON.stringify([
      chunk.entries,
      reasoning ? [
        request.thinkingExpanded,
        request.hideReasoningBlock,
        request.view.hiddenReasoningLabel,
        request.transcriptOptions.thinkingKeyHint,
        request.transcriptOptions.hiddenReasoningLabel,
        request.transcriptOptions.hideReasoningBlock,
      ] : undefined,
      expandable ? request.transcriptOptions.expandKeyHint : undefined,
      inheritsToolExpansion ? request.toolDetailsExpanded : undefined,
    ]);
    if (serialized === undefined) return undefined;
    return createHash("sha256").update(serialized, "utf8").digest("base64url");
  } catch {
    return undefined;
  }
}

function richTranscriptChunkMatches(
  cached: CachedRichTranscriptChunk,
  chunk: TranscriptChunk,
  fingerprint: string,
): boolean {
  return cached.fingerprint === fingerprint
    && cached.entries.length === chunk.entries.length
    && cached.entries.every((entry, index) => entry === chunk.entries[index]);
}

function cacheRichTranscriptChunk(
  prefix: CachedRichTranscriptPrefix,
  chunk: TranscriptChunk,
  fingerprint: string,
  content: LocalTranscriptProjection,
): boolean {
  const rows = content.lines.length;
  const bytes = Buffer.byteLength(content.lines.join("\n"), "utf8")
    + Buffer.byteLength(fingerprint, "utf8")
    + chunk.entries.reduce((count, entry) => count + Buffer.byteLength(entry.id, "utf8"), 0);
  const entryCount = chunk.entries.length;
  if (
    prefix.entryCount + entryCount > MAX_RICH_TRANSCRIPT_PREFIX_ENTRIES
    || prefix.rows + rows > MAX_RICH_TRANSCRIPT_PREFIX_ROWS
    || prefix.bytes + bytes > MAX_RICH_TRANSCRIPT_PREFIX_BYTES
  ) return false;
  prefix.chunks.push({
    entries: [...chunk.entries],
    fingerprint,
    content,
    entryCount,
    rows,
    bytes,
  });
  prefix.entryCount += entryCount;
  prefix.rows += rows;
  prefix.bytes += bytes;
  return true;
}

interface ImageProjectionBudget {
  count: number;
  bytes: number;
}

function appendLocalProjection(
  target: LocalTranscriptProjection,
  source: Readonly<LocalTranscriptProjection>,
): void {
  if (source.lines.length === 0) return;
  if (target.lines.length > 0 && target.lines.at(-1) !== "" && source.lines[0] !== "") {
    target.lines.push("");
  }
  const rowOffset = target.lines.length;
  target.lines.push(...source.lines);
  target.images.push(...source.images.map((image) => ({ ...image, row: image.row + rowOffset })));
}

function imageOnlyProjection(
  request: Readonly<TuiFrameProjectionRequest>,
  entries: readonly TranscriptEntry[],
  columns: number,
  budget: ImageProjectionBudget,
): LocalTranscriptProjection {
  const imageEntries = entries.flatMap((entry, entryIndex): TranscriptEntry[] => {
    if (entry.images === undefined || entry.images.length === 0) return [];
    return [{
      id: `${entry.id}:rich-images:${entryIndex}`,
      kind: "assistant",
      text: "",
      images: entry.images,
    }];
  });
  if (imageEntries.length === 0) return { lines: [], images: [] };
  try {
    const {
      toolRenderBlocks: _toolRenderBlocks,
      sessionRenderBlocks: _sessionRenderBlocks,
      transformMarkdown: _transformMarkdown,
      ...imageOptions
    } = request.transcriptOptions;
    const projected = projectOhmTuiTranscriptContent(imageEntries, {
      ...imageOptions,
      ...optionalProperties(request.transcriptOptions.resolveImage === undefined ? undefined : {
        resolveImage: (image, limits) => {
          const fallback = `[Image: ${sanitizeTerminalText(image.block.mediaType)}]`;
          if (budget.count >= MAX_TERMINAL_IMAGE_COUNT) {
            return { fallback: `${fallback} — terminal preview limit reached` };
          }
          const resolved = request.transcriptOptions.resolveImage!(image, limits);
          if (resolved.image === undefined) return resolved;
          if (budget.bytes + resolved.image.bytes > MAX_TERMINAL_IMAGE_AGGREGATE_BYTES) {
            return { fallback: `${resolved.fallback} — terminal preview byte limit reached` };
          }
          budget.count += 1;
          budget.bytes += resolved.image.bytes;
          return resolved;
        },
      }),
      columns,
      theme: request.theme,
    });
    const trimmed = trimExactEmptyLines(projected.block.lines);
    return {
      lines: trimmed.lines,
      images: projected.images
        .map((image) => ({ ...image, row: image.row - trimmed.leading }))
        .filter((image) => image.row >= 0),
    };
  } catch {
    return {
      lines: imageEntries.flatMap((entry) => (entry.images ?? []).map((image) =>
        stripAnsi(truncateToWidth(`[Image: ${sanitizeTerminalText(image.block.mediaType)}]`, columns)))),
      images: [],
    };
  }
}

function withoutTranscriptImages(entries: readonly TranscriptEntry[]): TranscriptEntry[] {
  return entries.map((entry) => {
    if (entry.images === undefined) return entry;
    const { images: _images, ...withoutImages } = entry;
    return withoutImages;
  });
}

function customToolProjection(
  request: Readonly<TuiFrameProjectionRequest>,
  entry: TranscriptEntry,
  columns: number,
): CustomToolProjection {
  const custom = entry.callId === undefined
    ? undefined
    : request.transcriptOptions.toolRenderBlocks?.get(entry.callId);
  if (custom === undefined || custom.shell === "self") {
    return { callLines: undefined, resultLines: undefined, failed: false };
  }
  let failed = false;
  const project = (block: typeof custom.call): string[] | undefined => {
    if (block === undefined) return undefined;
    try {
      return [...projectRuntimeUiBlock(block, {
        columns,
        maxLines: 200,
        theme: request.theme,
      }).lines];
    } catch {
      failed = true;
      return undefined;
    }
  };
  return {
    callLines: project(custom.call),
    resultLines: project(custom.result),
    failed,
  };
}

function nativeTranscriptProjection(
  request: Readonly<TuiFrameProjectionRequest>,
  shell: OhmTuiSnapshot,
  transcript: readonly OhmTuiTranscriptEntry[],
  columns: number,
): LocalTranscriptProjection {
  const chunkFrame = projectOhmNativeFrame({
    snapshot: normalizeOhmTuiSnapshot({ ...shell, transcript, queuedMessages: [] }),
    columns,
    thinkingExpanded: request.thinkingExpanded,
    toolDetailsExpanded: request.toolDetailsExpanded,
    ...optionalProperties(request.transcriptOptions.expandKeyHint === undefined ? undefined : { toolExpandKeyHint: request.transcriptOptions.expandKeyHint }),
    hyperlinks: request.transcriptOptions.hyperlinks === true,
    codeBlockIndent: request.codeBlockIndent,
    theme: request.theme,
    unicode: request.theme.unicode,
  });
  return {
    lines: trimExactEmptyLines(chunkFrame.text.split("\n").slice(0, chunkFrame.composer.top)).lines,
    images: [],
  };
}

function batchNativeChunkProjections(
  request: Readonly<TuiFrameProjectionRequest>,
  shell: OhmTuiSnapshot,
  chunks: readonly Readonly<{ index: number; chunk: TranscriptChunk }>[],
  columns: number,
): Map<number, LocalTranscriptProjection> {
  const selected = chunks.flatMap(({ index, chunk }) => {
    const source = chunk.entries[0];
    if (
      chunk.host
      || chunk.entries.length !== 1
      || source === undefined
      || source.extension !== undefined
      || (source.images?.length ?? 0) > 0
      || (source.kind === "tool" && source.callId !== undefined
        && request.transcriptOptions.toolRenderBlocks?.has(source.callId) === true)
    ) return [];
    const projected = projectTranscript(chunk.entries, request.hideReasoningBlock);
    const entry = projected[0];
    return projected.length === 1 && entry !== undefined ? [{ index, entry }] : [];
  });
  if (selected.length < 2) return new Map();
  try {
    const blocks = projectOhmNativeTranscriptEntries({
      snapshot: normalizeOhmTuiSnapshot({
        ...shell,
        transcript: selected.map(({ entry }) => entry),
        queuedMessages: [],
      }),
      columns,
      thinkingExpanded: request.thinkingExpanded,
      toolDetailsExpanded: request.toolDetailsExpanded,
      ...optionalProperties(request.transcriptOptions.expandKeyHint === undefined ? undefined : { toolExpandKeyHint: request.transcriptOptions.expandKeyHint }),
      hyperlinks: request.transcriptOptions.hyperlinks === true,
      codeBlockIndent: request.codeBlockIndent,
      theme: request.theme,
      unicode: request.theme.unicode,
    });
    if (blocks === undefined || blocks.length !== selected.length) return new Map();
    return new Map(selected.map(({ index }, selectedIndex) => [
      index,
      { lines: trimExactEmptyLines(blocks[selectedIndex]!).lines, images: [] },
    ]));
  } catch {
    return new Map();
  }
}

function nativeReasoningProjection(
  request: Readonly<TuiFrameProjectionRequest>,
  shell: OhmTuiSnapshot,
  entries: readonly TranscriptEntry[],
  columns: number,
): LocalTranscriptProjection | undefined {
  if (entries.length === 0 || entries.some((entry) => entry.kind !== "reasoning")) return undefined;
  const source = entries.map((entry) => entry.text).filter((text) => text !== "").join("\n\n");
  const streaming = entries.some((entry) => entry.streaming === true);
  const expanded = entries.some((entry) => entry.expanded !== undefined)
    ? entries.some((entry) => entry.expanded === true)
    : request.thinkingExpanded;
  if (source === "" || (!hasMarkdown(source) && request.transcriptOptions.transformMarkdown === undefined)) return undefined;
  const indent = columns >= 4 ? 2 : 0;
  const contentWidth = Math.max(1, columns - indent);
  let transformed = source;
  if (request.transcriptOptions.transformMarkdown !== undefined) {
    try {
      const selected = request.transcriptOptions.transformMarkdown(source, {
        messageType: "assistant-thinking",
        isStreaming: streaming,
        availableWidth: contentWidth,
      });
      if (isStringValue(selected)) transformed = selected;
    } catch {
      // Extension display transformations cannot replace the retained reasoning text.
    }
  }
  const headerFrame = projectOhmNativeFrame({
    snapshot: normalizeOhmTuiSnapshot({
      ...shell,
      transcript: [{
        id: entries[0]!.id,
        kind: "thinking",
        status: streaming ? "active" : "completed",
        text: "",
        expanded,
      }],
      queuedMessages: [],
    }),
    columns,
    thinkingExpanded: expanded,
    toolDetailsExpanded: request.toolDetailsExpanded,
    hyperlinks: request.transcriptOptions.hyperlinks === true,
    codeBlockIndent: request.codeBlockIndent,
    theme: request.theme,
    unicode: request.theme.unicode,
  });
  const lines = trimExactEmptyLines(headerFrame.text.split("\n").slice(0, headerFrame.composer.top)).lines;
  if (!expanded) return { lines, images: [] };
  try {
    const {
      transformMarkdown: _transformMarkdown,
      toolRenderBlocks: _toolRenderBlocks,
      sessionRenderBlocks: _sessionRenderBlocks,
      ...markdownOptions
    } = request.transcriptOptions;
    const body = projectOhmTuiTranscriptContent([{
      id: `${entries[0]!.id}:rich-thinking-body`,
      kind: "assistant",
      text: transformed,
      streaming,
    }], {
      ...markdownOptions,
      outputPad: 0,
      columns: contentWidth,
      theme: request.theme,
    });
    const bodyLines = trimEmptyRows(body.block.lines);
    lines.push(...bodyLines.map((line) => `${" ".repeat(indent)}${line}`));
    return { lines, images: [] };
  } catch {
    const fallback = projectTranscript(entries, false);
    const frame = projectOhmNativeFrame({
      snapshot: normalizeOhmTuiSnapshot({ ...shell, transcript: fallback, queuedMessages: [] }),
      columns,
      thinkingExpanded: expanded,
      toolDetailsExpanded: request.toolDetailsExpanded,
      hyperlinks: request.transcriptOptions.hyperlinks === true,
      codeBlockIndent: request.codeBlockIndent,
      theme: request.theme,
      unicode: request.theme.unicode,
    });
    return {
      lines: trimExactEmptyLines(frame.text.split("\n").slice(0, frame.composer.top)).lines,
      images: [],
    };
  }
}

function nativeChunkProjection(
  request: Readonly<TuiFrameProjectionRequest>,
  shell: OhmTuiSnapshot,
  entries: readonly TranscriptEntry[],
  columns: number,
): LocalTranscriptProjection {
  const reasoning = nativeReasoningProjection(request, shell, entries, columns);
  if (reasoning !== undefined) return reasoning;
  const transcript = projectTranscript(entries, request.hideReasoningBlock);
  const tool = entries.length === 1 && entries[0]?.kind === "tool" ? entries[0] : undefined;
  const custom = tool === undefined
    ? { callLines: undefined, resultLines: undefined, failed: false }
    : customToolProjection(request, tool, columns);
  if (transcript.length === 0) return { lines: [], images: [] };
  if (tool === undefined || (custom.callLines === undefined && custom.resultLines === undefined && !custom.failed)) {
    return nativeTranscriptProjection(request, shell, transcript, columns);
  }
  const nativeTool = transcript[0];
  if (nativeTool?.kind !== "tool") return nativeTranscriptProjection(request, shell, transcript, columns);
  const {
    details: _details,
    input: _input,
    output: _output,
    ...withoutDetails
  } = nativeTool;
  const header = nativeTranscriptProjection(request, shell, [{ ...withoutDetails, details: [] }], columns);
  const full = nativeTranscriptProjection(request, shell, transcript, columns);
  const defaultResult = full.lines.slice(Math.min(header.lines.length, full.lines.length));
  const selected: LocalTranscriptProjection = { lines: [...header.lines], images: [] };
  if (custom.callLines !== undefined) {
    appendLocalProjection(selected, { lines: custom.callLines, images: [] });
  }
  appendLocalProjection(selected, {
    lines: custom.resultLines ?? defaultResult,
    images: [],
  });
  if (custom.failed) {
    appendLocalProjection(selected, {
      lines: [stripAnsi(truncateToWidth("… Extension tool renderer unavailable", columns))],
      images: [],
    });
  }
  return selected;
}

function projectTranscriptChunk(
  request: Readonly<TuiFrameProjectionRequest>,
  shell: OhmTuiSnapshot,
  chunk: TranscriptChunk,
  columns: number,
  imageBudget: ImageProjectionBudget,
): LocalTranscriptProjection {
  let local: LocalTranscriptProjection;
  if (chunk.host) {
    try {
      const projected = projectOhmTuiTranscriptContent(withoutTranscriptImages(chunk.entries), {
        ...request.transcriptOptions,
        ...optionalProperties(request.hideReasoningBlock || request.view.hiddenReasoningLabel !== undefined ? { hiddenReasoningLabel: request.view.hiddenReasoningLabel ?? "Thinking..." } : undefined),
        columns,
        theme: request.theme,
      });
      const trimmed = trimExactEmptyLines(projected.block.lines);
      local = {
        lines: trimmed.lines,
        images: projected.images
          .map((image) => ({ ...image, row: image.row - trimmed.leading }))
          .filter((image) => image.row >= 0),
      };
    } catch {
      local = nativeChunkProjection(request, shell, chunk.entries, columns);
    }
  } else {
    local = nativeChunkProjection(request, shell, chunk.entries, columns);
  }
  appendLocalProjection(local, imageOnlyProjection(request, chunk.entries, columns, imageBudget));
  return local;
}

function projectMixedTranscript(
  request: Readonly<TuiFrameProjectionRequest>,
  shell: OhmTuiSnapshot,
  entries: readonly TranscriptEntry[],
  columns: number,
  prefix?: CachedRichTranscriptPrefix,
): RichTranscriptProjection {
  const lines: string[] = [];
  const images: NonNullable<TuiProjectedFrame["images"]>[number][] = [];
  const messageRows: number[] = [];
  const ranges: RichTranscriptRowRange[] = [];
  const imageBudget: ImageProjectionBudget = { count: 0, bytes: 0 };
  const chunks = transcriptChunks(request, entries);
  let reusePrefix = prefix !== undefined;
  let prefixEligible = prefix !== undefined;
  interface TranscriptChunkPlan {
    readonly chunk: TranscriptChunk;
    readonly fingerprint: string | undefined;
    readonly index: number;
    readonly retained: LocalTranscriptProjection | undefined;
  }
  const plans = chunks.map((chunk, index): TranscriptChunkPlan => {
    let local: LocalTranscriptProjection | undefined;
    const cacheable = prefixEligible && richTranscriptChunkCanCache(chunk);
    const fingerprint = cacheable ? richTranscriptChunkFingerprint(request, chunk) : undefined;
    if (reusePrefix && fingerprint !== undefined) {
      const retained = prefix?.chunks[index];
      if (retained !== undefined && richTranscriptChunkMatches(retained, chunk, fingerprint)) {
        local = retained.content;
      } else {
        if (prefix !== undefined) trimRichTranscriptPrefix(prefix, index);
        reusePrefix = false;
      }
    } else if (reusePrefix) {
      if (prefix !== undefined) trimRichTranscriptPrefix(prefix, index);
      reusePrefix = false;
    }
    if (fingerprint === undefined) prefixEligible = false;
    return { chunk, fingerprint, index, retained: local };
  });
  const batched = batchNativeChunkProjections(
    request,
    shell,
    plans.filter((plan) => plan.retained === undefined),
    columns,
  );
  let extendPrefix = prefix !== undefined;
  for (const { chunk, fingerprint, index, retained } of plans) {
    let local = retained ?? batched.get(index);
    if (local === undefined) {
      local = projectTranscriptChunk(request, shell, chunk, columns, imageBudget);
    }
    if (retained === undefined) {
      if (extendPrefix && fingerprint !== undefined && prefix !== undefined) {
        extendPrefix = cacheRichTranscriptChunk(prefix, chunk, fingerprint, local);
      } else {
        extendPrefix = false;
      }
    }
    if (local.lines.length === 0) continue;
    if (lines.length > 0 && lines.at(-1) !== "" && local.lines[0] !== "") lines.push("");
    const start = lines.length;
    const rowOffset = lines.length;
    lines.push(...local.lines);
    const end = lines.length;
    ranges.push({
      entryIds: chunk.entries.map((entry) => entry.id),
      start,
      end,
    });
    if (chunk.entries.some((entry) => entry.kind === "user")) messageRows.push(start);
    for (const image of local.images) {
      const row = image.row + rowOffset;
      if (row >= 0) images.push({ ...image, row });
    }
  }
  if (prefix !== undefined && chunks.length < prefix.chunks.length) {
    trimRichTranscriptPrefix(prefix, chunks.length);
  }
  return materializedRichTranscriptProjection(lines, images, messageRows, ranges);
}

function retainedTranscriptSources(
  request: Readonly<TuiFrameProjectionRequest>,
  shell: OhmTuiSnapshot,
  entries: readonly TranscriptEntry[],
): RetainedTranscriptChunk<RetainedRichTranscriptValue>[] | undefined {
  const selected: RetainedTranscriptChunk<RetainedRichTranscriptValue>[] = [];
  for (const chunk of transcriptChunks(request, entries)) {
    const fingerprint = richTranscriptChunkFingerprint(request, chunk);
    if (fingerprint === undefined) return undefined;
    const itemKeys = chunk.entries.map((entry) => `entry:${entry.id}`);
    const entryIds = chunk.entries.map((entry) => entry.id);
    selected.push({
      key: `chunk:${createHash("sha256").update(JSON.stringify(itemKeys), "utf8").digest("base64url")}`,
      itemKeys,
      entryIds,
      fingerprint,
      value: { request, shell, chunk },
      ...optionalProperties(chunk.entries.some((entry) => entry.kind === "user") ? { isUserPrompt: true } : undefined),
    });
  }
  return selected;
}

function createRetainedTranscriptSlot(
  columns: number,
  request: Readonly<TuiFrameProjectionRequest>,
  key: string,
): RetainedRichTranscriptSlot {
  const slot: RetainedRichTranscriptSlot = {
    columns,
    theme: request.theme,
    key,
    revision: -1,
    overflow: false,
    layout: new OhmTranscriptLayout<RetainedRichTranscriptValue>((source) => {
      const local = projectTranscriptChunk(
        source.value.request,
        source.value.shell,
        source.value.chunk,
        columns,
        { count: 0, bytes: 0 },
      );
      return {
        rows: local.lines,
        ...optionalProperties(local.lines.length === 0 ? undefined : {
          entryRanges: [{ entryIds: source.entryIds, start: 0, end: local.lines.length }],
        }),
        ...optionalProperties(
          source.isUserPrompt === true && local.lines.length > 0 ? { promptRows: [0] } : undefined,
        ),
      };
    }, { interChunkGapRows: 1 }),
  };
  return slot;
}

function retainedRichTranscriptProjection(
  cache: RichTranscriptLayoutCache,
  request: Readonly<TuiFrameProjectionRequest> & { readonly transcriptRevision: number },
  shell: OhmTuiSnapshot,
  entries: readonly TranscriptEntry[],
  columns: number,
): RichTranscriptProjection | undefined {
  const key = richTranscriptPrefixKey(request);
  let slotIndex = cache.retained.findIndex((candidate) =>
    candidate.columns === columns
      && candidate.theme === request.theme
      && candidate.key === key);
  let slot = slotIndex < 0 ? undefined : cache.retained[slotIndex];
  if (slot === undefined) {
    slot = createRetainedTranscriptSlot(columns, request, key);
    cache.retained.push(slot);
    if (cache.retained.length > 2) cache.retained.splice(0, cache.retained.length - 2);
  } else if (slotIndex + 1 < cache.retained.length) {
    cache.retained.splice(slotIndex, 1);
    cache.retained.push(slot);
  }
  if (slot.revision !== request.transcriptRevision) {
    const sources = retainedTranscriptSources(request, shell, entries);
    if (sources === undefined) return undefined;
    try {
      slot.layout.reconcile(sources, columns, key);
      slot.overflow = slot.layout.totalRows > MAX_RICH_TRANSCRIPT_PREFIX_ROWS
        || slot.layout.totalBytes > MAX_RICH_TRANSCRIPT_PREFIX_BYTES;
      if (slot.overflow) slot.layout.clear();
      slot.revision = request.transcriptRevision;
      delete slot.searchQuery;
      delete slot.searchResult;
    } catch {
      slot.layout.clear();
      slot.overflow = true;
      slot.revision = request.transcriptRevision;
    }
  }
  if (slot.overflow) return undefined;
  return {
    totalRows: slot.layout.totalRows,
    messageRows: slot.layout.promptRows,
    ranges: slot.layout.ranges,
    window(start, height) {
      return { lines: slot.layout.window(start, height).rows, images: [] };
    },
    search(query) {
      if (query === slot.searchQuery && slot.searchResult !== undefined) return slot.searchResult;
      slot.searchQuery = query;
      slot.searchResult = searchOhmTranscript({
        totalRows: slot.layout.totalRows,
        window(start, height) { return { rows: slot.layout.window(start, height).rows }; },
      }, query);
      return slot.searchResult;
    },
  };
}

function projectCachedMixedTranscript(
  cache: RichTranscriptLayoutCache | undefined,
  request: Readonly<TuiFrameProjectionRequest>,
  shell: OhmTuiSnapshot,
  entries: readonly TranscriptEntry[],
  columns: number,
): RichTranscriptProjection {
  if (cache === undefined || !richTranscriptCanReuse(request, entries)) {
    return projectMixedTranscript(request, shell, entries, columns);
  }
  const retained = retainedRichTranscriptProjection(cache, request, shell, entries, columns);
  if (retained !== undefined) return retained;
  if (cache.revision !== request.transcriptRevision) {
    cache.revision = request.transcriptRevision;
    cache.layouts = [];
  }
  const key = richTranscriptLayoutKey(request);
  const cachedLayout = cache.layouts.find((layout) =>
    layout.columns === columns
      && layout.theme === request.theme
      && layout.key === key);
  if (cachedLayout !== undefined) return cachedLayout.content;
  const content = projectMixedTranscript(
    request,
    shell,
    entries,
    columns,
    richTranscriptPrefix(cache, request, columns),
  );
  cache.layouts.push({ columns, theme: request.theme, key, content });
  if (cache.layouts.length > 2) cache.layouts.splice(0, cache.layouts.length - 2);
  return content;
}

function blockLines(block: TuiRuntimeSurfaceBlock | undefined): string[] {
  return block === undefined ? [] : [...block.lines];
}

interface RichPersistentPointerSourceRow {
  readonly token: object;
  readonly localRow: number;
  readonly localColumn: number;
}

interface RichSlotProjection {
  readonly lines: string[];
  readonly pointerRows: Array<RichPersistentPointerSourceRow | undefined>;
}

function slotProjection(slot: TuiRuntimeSurfaceSlot, columns: number, unicode = true): RichSlotProjection {
  const content = slot.blocks.flatMap((block) => block.lines.map((line, index) => {
    const source = block[INTERNAL_TUI_PERSISTENT_POINTER_SOURCE];
    const localRow = source?.rows[index];
    return {
      line,
      pointer: source === undefined || localRow === undefined ? undefined : {
        token: source.token,
        localRow,
        localColumn: 0,
      },
    };
  }));
  const omitted = slot.omittedLines === 0
    ? []
    : [stripAnsi(truncateToWidth(`${unicode ? "…" : "..."} ${slot.omittedLines} earlier extension rows`, columns))];
  return {
    lines: [...omitted, ...content.map(({ line }) => line)],
    pointerRows: [...omitted.map(() => undefined), ...content.map(({ pointer }) => pointer)],
  };
}

function boundedSlotProjection(
  slot: TuiRuntimeSurfaceSlot,
  columns: number,
  maximumRows: number,
  unicode = true,
): RichSlotProjection {
  const budget = Math.max(0, Math.trunc(maximumRows));
  if (budget === 0) return { lines: [], pointerRows: [] };
  const projection = slotProjection(slot, columns, unicode);
  if (slot.omittedLines === 0 && projection.lines.length <= budget) return projection;
  const visibleRows = Math.max(0, budget - 1);
  const contentStart = slot.omittedLines === 0 ? 0 : 1;
  const contentLines = projection.lines.slice(contentStart);
  const contentPointers = projection.pointerRows.slice(contentStart);
  const visibleLines = visibleRows === 0 ? [] : contentLines.slice(-visibleRows);
  const visiblePointers = visibleRows === 0 ? [] : contentPointers.slice(-visibleRows);
  const omittedRows = Math.max(0, slot.omittedLines + contentLines.length - visibleLines.length);
  return {
    lines: [stripAnsi(truncateToWidth(sanitizeTerminalText(
      `${unicode ? "…" : "..."} ${omittedRows} earlier extension rows`,
    ), columns)), ...visibleLines],
    pointerRows: [undefined, ...visiblePointers],
  };
}

function slotLines(slot: TuiRuntimeSurfaceSlot, columns: number, unicode = true): string[] {
  return slotProjection(slot, columns, unicode).lines;
}

function slotSourceRows(slot: TuiRuntimeSurfaceSlot): number {
  return slot.omittedLines + slot.blocks.reduce((total, block) => total + block.lines.length, 0);
}

function trimEmptyRows(lines: readonly string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && stripAnsi(lines[start]!).trim() === "") start += 1;
  while (end > start && stripAnsi(lines[end - 1]!).trim() === "") end -= 1;
  return lines.slice(start, end);
}

function cursorWindow(
  lines: readonly string[],
  cursorRow: number,
  maximumRows: number,
): CursorWindow {
  const budget = Math.max(1, Math.min(lines.length, Math.trunc(maximumRows)));
  const selectedCursor = Math.max(0, Math.min(lines.length - 1, cursorRow));
  const start = Math.min(
    Math.max(0, lines.length - budget),
    Math.max(0, selectedCursor - Math.floor((budget - 1) / 2)),
  );
  return {
    lines: lines.slice(start, start + budget),
    cursorRow: selectedCursor - start,
    start,
  };
}

function composeRuntimeOverlayLine(
  base: string,
  overlay: TuiRuntimeOverlayProjection,
  lineIndex: number,
  columns: number,
): string {
  const source = truncateToWidth(overlay.block.lines[lineIndex] ?? "", overlay.width);
  const opaque = overlay.block.source === "raw" || overlay.block.fill[lineIndex] === true;
  const painted = opaque ? overlay.width : visibleWidth(source);
  if (painted === 0) return base;
  const plane = `${base}${" ".repeat(Math.max(0, columns - visibleWidth(base)))}`;
  const left = sliceByColumn(plane, 0, overlay.column);
  const fill = opaque
    ? " ".repeat(Math.max(0, overlay.width - visibleWidth(source)))
    : "";
  const right = sliceByColumn(plane, overlay.column + painted, Math.max(0, columns - overlay.column - painted));
  return truncateToWidth(`${left}${source}${fill}${right}`, columns);
}

function paintRuntimeOverlays(
  lines: string[],
  overlays: readonly TuiRuntimeOverlayProjection[],
  columns: number,
): string[] {
  const selected = [...lines];
  for (const overlay of overlays) {
    while (selected.length < overlay.row + overlay.height) selected.push("");
    for (let index = 0; index < overlay.height; index += 1) {
      const target = overlay.row + index;
      selected[target] = composeRuntimeOverlayLine(selected[target] ?? "", overlay, index, columns);
    }
  }
  return selected;
}

function inputImageLines(view: TuiViewState, columns: number, unicode: boolean): string[] {
  if (view.inputImages === undefined || view.inputImages.length === 0) return [];
  const labels = view.inputImages.map((image) => {
    const dimensions = image.width === undefined || image.height === undefined
      ? ""
      : ` ${image.width}x${image.height}`;
    return `${sanitizeTerminalText(stripAnsi(image.label)).replaceAll(/\s+/gu, " ").trim()} (${image.mediaType}${dimensions})`;
  });
  const separator = unicode ? " · " : " | ";
  return [stripAnsi(truncateToWidth(`Attachments${separator}${labels.join(separator)}`, columns))];
}

function paintBackgroundCells(
  lines: string[],
  cells: TuiViewState["backgroundCells"],
  images: readonly NonNullable<TuiProjectedFrame["images"]>[number][],
  rawImageReservations: readonly {
    readonly row: number;
    readonly column: number;
    readonly rows: number;
    readonly columns: number;
  }[],
  columns: number,
  rows: number,
  theme: TuiFrameProjectionRequest["theme"],
): string[] {
  if (cells === undefined || cells.length === 0) return lines;
  const selected = [...lines];
  const occupiedWidths = Array.from({ length: rows }, (_, row) => visibleWidth(selected[row] ?? ""));
  const imageOccupies = (row: number, column: number): boolean => images.some((image) => (
    row >= image.row
    && row < image.row + image.rows
    && column >= image.column
    && column < image.column + image.columns
  )) || rawImageReservations.some((image) => (
    row >= image.row
    && row < image.row + image.rows
    && column >= image.column
    && column < image.column + image.columns
  )) || isImageLine(selected[row] ?? "");
  for (const cell of cells) {
    if (cell.row < 0 || cell.row >= rows || cell.column < 0 || cell.column >= columns) continue;
    if (cell.column < (occupiedWidths[cell.row] ?? 0) || imageOccupies(cell.row, cell.column)) continue;
    while (selected.length <= cell.row) selected.push("");
    const base = selected[cell.row] ?? "";
    const plane = `${base}${" ".repeat(Math.max(0, columns - visibleWidth(base)))}`;
    selected[cell.row] = [
      sliceByColumn(plane, 0, cell.column, true),
      theme.codes.muted,
      cell.text,
      theme.codes.muted === "" ? "" : "\u001b[0m",
      sliceByColumn(plane, cell.column + 1, columns - cell.column - 1, true),
    ].join("");
  }
  return selected;
}

const RICH_TRANSCRIPT_ANCHOR = Symbol.for("ohm.tui.rich-transcript-anchor");

interface RichTranscriptViewportAnchor {
  readonly entryId: string;
  readonly renderedRow: number;
  readonly row: number;
}

interface RichTranscriptAnchorState {
  readonly ranges: readonly RichTranscriptRowRange[];
  readonly viewport?: RichTranscriptViewportAnchor;
}

type RichProjectedFrame = TuiProjectedFrame & {
  readonly [RICH_TRANSCRIPT_ANCHOR]?: RichTranscriptAnchorState;
};

type RichShellFrame = TuiProjectedFrame & {
  readonly composer: { readonly top: number; readonly bottom: number };
};

type TuiPersistentPointerRow = TuiPersistentPointerMap["rows"][number];

const MAX_POINTER_SEGMENTS = 1_000;

function pointerSegmentsAfterMask(
  left: number,
  right: number,
  masks: readonly Readonly<{ left: number; right: number }>[],
): Array<{ left: number; right: number }> {
  let selected = [{ left, right }];
  for (const mask of masks) {
    selected = selected.flatMap((segment) => {
      if (mask.right <= segment.left || mask.left >= segment.right) return [segment];
      return [
        ...(mask.left > segment.left ? [{ left: segment.left, right: Math.min(segment.right, mask.left) }] : []),
        ...(mask.right < segment.right ? [{ left: Math.max(segment.left, mask.right), right: segment.right }] : []),
      ];
    });
  }
  return selected.filter((segment) => segment.right > segment.left);
}

function runtimeOverlayPointerMasks(
  overlays: readonly TuiRuntimeOverlayProjection[],
  columns: number,
): ReadonlyMap<number, readonly Readonly<{ left: number; right: number }>[]> {
  const masks = new Map<number, Array<{ left: number; right: number }>>();
  for (const overlay of overlays) {
    for (let index = 0; index < overlay.height; index += 1) {
      const source = truncateToWidth(overlay.block.lines[index] ?? "", overlay.width);
      const opaque = overlay.block.source === "raw" || overlay.block.fill[index] === true;
      const painted = opaque ? overlay.width : visibleWidth(source);
      const left = Math.max(0, Math.min(columns, overlay.column));
      const right = Math.max(left, Math.min(columns, overlay.column + painted));
      if (right <= left) continue;
      const row = overlay.row + index;
      const current = masks.get(row) ?? [];
      current.push({ left, right });
      masks.set(row, current);
    }
  }
  return masks;
}

function persistentPointerRows(
  projection: RichSlotProjection,
  top: number,
  columns: number,
): TuiPersistentPointerRow[] {
  return projection.pointerRows.flatMap((source, index): TuiPersistentPointerRow[] => source === undefined
    ? []
    : [{
        row: top + index,
        left: 0,
        right: columns,
        token: source.token,
        localRow: source.localRow,
        localColumn: source.localColumn,
      }]);
}

function maskedPersistentPointerMap(
  pointer: TuiPersistentPointerMap | undefined,
  overlays: readonly TuiRuntimeOverlayProjection[],
  columns: number,
): TuiPersistentPointerMap | undefined {
  if (pointer === undefined) return undefined;
  const masks = runtimeOverlayPointerMasks(overlays, columns);
  const rows = pointer.rows.flatMap((row): TuiPersistentPointerRow[] =>
    pointerSegmentsAfterMask(row.left, row.right, masks.get(row.row) ?? [])
      .map((segment) => ({
        ...row,
        ...segment,
        localColumn: row.localColumn + segment.left - row.left,
      }))).slice(0, MAX_POINTER_SEGMENTS);
  return rows.length === 0 ? undefined : { rows };
}

function cropPersistentPointerMap(
  pointer: TuiPersistentPointerMap | undefined,
  start: number,
  rows: number,
): TuiPersistentPointerMap | undefined {
  if (pointer === undefined) return undefined;
  const selected = pointer.rows
    .filter((row) => row.row >= start && row.row < start + rows)
    .map((row) => ({ ...row, row: row.row - start }));
  return selected.length === 0 ? undefined : { rows: selected };
}

function richShellBudgets(rows: number): RichShellBudgets {
  const flexibleRows = Math.max(1, Math.trunc(rows) - 4);
  const composerRows = Math.max(1, Math.min(6, Math.ceil(flexibleRows / 2)));
  const remaining = Math.max(0, flexibleRows - composerRows);
  const promptRows = Math.min(4, Math.ceil(remaining / 2));
  return {
    composerRows,
    promptRows,
    queueRows: Math.min(4, Math.max(0, remaining - promptRows)),
  };
}

function richViewportAnchor(
  ranges: readonly RichTranscriptRowRange[],
  start: number,
): RichTranscriptViewportAnchor | undefined {
  const containing = ranges.find((range) => start >= range.start && start < range.end);
  if (containing !== undefined) {
    return {
      entryId: containing.entryIds[0]!,
      renderedRow: start - containing.start,
      row: 0,
    };
  }
  const next = ranges.find((range) => range.start >= start);
  return next === undefined
    ? undefined
    : { entryId: next.entryIds[0]!, renderedRow: 0, row: next.start - start };
}

function paintTranscriptScrollbar(
  lines: string[],
  top: number,
  viewportRows: number,
  totalRows: number,
  startRow: number,
  columns: number,
  theme: TuiFrameProjectionRequest["theme"],
  hovered: boolean,
): PaintedScrollbar {
  const selected = [...lines];
  const total = Math.max(1, totalRows);
  const thumbRows = Math.max(
    1,
    Math.min(viewportRows, Math.round(viewportRows * Math.min(1, viewportRows / total))),
  );
  const maximumStart = Math.max(0, totalRows - viewportRows);
  const thumbStart = maximumStart === 0
    ? 0
    : Math.round(startRow / maximumStart * Math.max(0, viewportRows - thumbRows));
  for (let index = 0; index < viewportRows; index += 1) {
    const row = top + index;
    while (selected.length <= row) selected.push("");
    if (isImageLine(selected[row] ?? "")) continue;
    const truncated = truncateToWidth(selected[row] ?? "", Math.max(0, columns - 1));
    const base = theme.ansi ? truncated : stripAnsi(truncated);
    const marker = index >= thumbStart && index < thumbStart + thumbRows
      ? theme.unicode ? "█" : "#"
      : theme.unicode ? "│" : "|";
    const role: "accent" | "scrollbar" | "muted" = index >= thumbStart && index < thumbStart + thumbRows
      ? hovered ? "accent" : "scrollbar"
      : "muted";
    const roleCode = theme.codes[role];
    selected[row] = `${base}${" ".repeat(Math.max(0, columns - 1 - visibleWidth(base)))}${roleCode}${marker}${roleCode === "" ? "" : "\u001b[0m"}`;
  }
  return { lines: selected, thumbTop: top + thumbStart, thumbRows };
}

interface TranscriptSearchQueryWindow {
  readonly text: string;
  readonly cursorColumn: number;
}

interface TranscriptSearchPresentation {
  readonly line: string;
  readonly cursorColumn: number;
}

function transcriptSearchQueryWindow(query: string, cursor: number, width: number): TranscriptSearchQueryWindow {
  const graphemes = splitGraphemes(query);
  const selectedCursor = Math.max(0, Math.min(graphemes.length, Math.trunc(cursor)));
  const budget = Math.max(1, Math.trunc(width));
  let start = selectedCursor;
  let beforeCells = 0;
  while (start > 0) {
    const next = Math.max(0, cellWidth(graphemes[start - 1]!));
    if (beforeCells + next > budget - 1) break;
    start -= 1;
    beforeCells += next;
  }
  const selected: string[] = [];
  let cells = 0;
  for (let index = start; index < graphemes.length; index += 1) {
    const grapheme = graphemes[index]!;
    const graphemeCells = Math.max(0, cellWidth(grapheme));
    if (cells + graphemeCells > budget) break;
    selected.push(grapheme);
    cells += graphemeCells;
  }
  return {
    text: `${selected.join("")}${" ".repeat(Math.max(0, budget - cells))}`,
    cursorColumn: Math.max(0, Math.min(budget - 1, beforeCells)),
  };
}

function selectedTranscriptSearchMatch(
  result: OhmTranscriptSearchResult,
  requested: number | undefined,
  anchorRow: number | undefined,
): number | undefined {
  if (result.matches.length === 0) return undefined;
  if (requested !== undefined && Number.isSafeInteger(requested)) {
    return Math.max(0, Math.min(result.matches.length - 1, requested));
  }
  if (anchorRow === undefined || !Number.isSafeInteger(anchorRow)) return 0;
  let selected = 0;
  let distance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < result.matches.length; index += 1) {
    const match = result.matches[index]!;
    const next = anchorRow < match.startRow
      ? match.startRow - anchorRow
      : anchorRow > match.endRow
        ? anchorRow - match.endRow
        : 0;
    if (next < distance) {
      distance = next;
      selected = index;
      if (next === 0) break;
    }
  }
  return selected;
}

function transcriptSearchPresentation(
  query: string,
  cursor: number,
  result: OhmTranscriptSearchResult,
  selectedMatch: number | undefined,
  columns: number,
  theme: TuiFrameProjectionRequest["theme"],
  unicode: boolean,
): TranscriptSearchPresentation {
  const width = Math.max(1, columns);
  const symbols = unicode ? { search: "?", previous: "‹", next: "›", close: "×" }
    : { search: "?", previous: "<", next: ">", close: "x" };
  const spacedControls = width >= 10;
  const controls = spacedControls
    ? `${symbols.previous} ${symbols.next} ${symbols.close}`
    : `${symbols.previous}${symbols.next}${symbols.close}`;
  const controlWidth = cellWidth(controls);
  const prefix = width >= controlWidth + 3 ? `${symbols.search} ` : "";
  const count = selectedMatch === undefined
    ? `0/${result.matches.length}${result.truncated ? "+" : ""}`
    : `${selectedMatch + 1}/${result.matches.length}${result.truncated ? "+" : ""}`;
  const countText = width - cellWidth(prefix) - controlWidth >= cellWidth(count) + 3 ? ` ${count} ` : "";
  const queryWidth = Math.max(0, width - cellWidth(prefix) - cellWidth(countText) - controlWidth);
  const window = queryWidth === 0
    ? { text: "", cursorColumn: 0 }
    : transcriptSearchQueryWindow(query, cursor, queryWidth);
  const plain = truncateToWidth(`${prefix}${window.text}${countText}${controls}`, width, "", true);
  return {
    line: theme.ansi ? `${theme.codes.accent}${plain}\u001b[0m` : plain,
    cursorColumn: Math.max(0, Math.min(width - 1, cellWidth(prefix) + window.cursorColumn)),
  };
}

function highlightedTranscriptLine(
  line: string,
  spans: readonly { readonly startColumn: number; readonly endColumn: number; readonly selected: boolean }[],
  theme: TuiFrameProjectionRequest["theme"],
): string {
  if (spans.length === 0 || !theme.ansi) return line;
  const ordered = [...spans]
    .filter((span) => span.endColumn > span.startColumn)
    .sort((left, right) => left.startColumn - right.startColumn || Number(right.selected) - Number(left.selected));
  const merged: Array<{ startColumn: number; endColumn: number; selected: boolean }> = [];
  for (const span of ordered) {
    const previous = merged.at(-1);
    if (previous !== undefined && span.startColumn <= previous.endColumn) {
      previous.endColumn = Math.max(previous.endColumn, span.endColumn);
      previous.selected ||= span.selected;
    } else merged.push({ ...span });
  }
  let column = 0;
  let output = "";
  for (const span of merged) {
    output += sliceByColumn(line, column, Math.max(0, span.startColumn - column), true);
    const selected = stripAnsi(sliceByColumn(line, span.startColumn, span.endColumn - span.startColumn, true));
    output += `\u001b[0m${span.selected ? theme.codes.selection : theme.getBgAnsi("selectedBg")}${span.selected ? "\u001b[1m" : ""}${selected}\u001b[0m`;
    column = span.endColumn;
  }
  output += sliceByColumn(line, column, Math.max(0, visibleWidth(line) - column), true);
  return output;
}

function withRichSurfaces(
  frame: RichShellFrame,
  view: TuiViewState,
  size: Readonly<{ columns: number; rows: number }>,
  theme: TuiFrameProjectionRequest["theme"],
  unicode: boolean,
  transcriptContent?: RichTranscriptProjection,
  scrollbarVisible = false,
  scrollbarHovered = false,
): TuiProjectedFrame | undefined {
  const bounds = frame.composer;
  let surfaces: TuiRuntimeSurfaceProjection;
  try {
    surfaces = projectTuiRuntimeSurfaces(view, { ...size, theme, unicode });
  } catch {
    return undefined;
  }
  const base = frame.text === "" ? [] : frame.text.split("\n");
  let shellMain = base.slice(0, bounds.top);
  const baseEditor = base.slice(bounds.top, bounds.bottom);
  let baseStatus = base.slice(bounds.bottom);
  let headerProjection = slotProjection(surfaces.header, size.columns, unicode);
  let footerProjection = slotProjection(surfaces.footer, size.columns, unicode);
  let widgetProjection = slotProjection(surfaces.widget, size.columns, unicode);
  let widgetBelowProjection = slotProjection(surfaces.widgetBelow, size.columns, unicode);
  let header = headerProjection.lines;
  let footer = footerProjection.lines;
  let widget = widgetProjection.lines;
  let widgetBelow = widgetBelowProjection.lines;
  let extensionStatus = blockLines(surfaces.extensionStatus);
  let working = blockLines(surfaces.working);
  let attachments = inputImageLines(view, size.columns, unicode);
  const overlay = view.overlay;
  const transcriptSearchResult = view.transcriptSearch === undefined || transcriptContent === undefined
    || overlay !== undefined || surfaces.runtime !== undefined
    ? undefined
    : transcriptContent.search(view.transcriptSearch.query);
  const transcriptSearchSelected = transcriptSearchResult === undefined || view.transcriptSearch === undefined
    ? undefined
    : selectedTranscriptSearchMatch(
        transcriptSearchResult,
        view.transcriptSearch.selectedMatch,
        view.transcriptSearch.anchorRow,
      );
  const transcriptSearch = transcriptSearchResult === undefined || view.transcriptSearch === undefined
    ? undefined
    : transcriptSearchPresentation(
        view.transcriptSearch.query,
        view.transcriptSearch.cursor,
        transcriptSearchResult,
        transcriptSearchSelected,
        size.columns,
        theme,
        unicode,
      );
  if (
    transcriptContent !== undefined
    && overlay === undefined
    && surfaces.runtime === undefined
    && transcriptContent.totalRows > 0
    && baseStatus[0] === ""
  ) {
    const fixedWithoutStatus = header.length + shellMain.length + footer.length + extensionStatus.length
      + working.length + widget.length + attachments.length + (transcriptSearch === undefined ? baseEditor.length : 1)
      + widgetBelow.length;
    const available = size.rows - fixedWithoutStatus - baseStatus.length;
    if (available < Math.min(2, transcriptContent.totalRows)) baseStatus = baseStatus.slice(1);
  }
  let main = surfaces.runtime === undefined ? shellMain : blockLines(surfaces.runtime);
  let editor = transcriptSearch === undefined
    ? surfaces.editor === undefined ? baseEditor : blockLines(surfaces.editor)
    : [transcriptSearch.line];
  if (transcriptSearch === undefined && surfaces.editor !== undefined && editor.length === 0) editor = [""];
  let editorCursorRow = transcriptSearch === undefined
    ? surfaces.editor?.cursor?.row ?? frame.cursor.row - bounds.top - 1
    : 0;
  const editorCursorColumn = transcriptSearch === undefined
    ? surfaces.editor?.cursor?.column === undefined
      ? frame.cursor.column
      : surfaces.editor.cursor.column + 1
    : transcriptSearch.cursorColumn + 1;
  let inlineOverlay: string[] = [];
  let transcriptStart = 0;
  let transcriptEnd = 0;
  let transcriptViewportRows = 0;
  let transcriptPadding = 0;
  let transcriptImages: NonNullable<TuiProjectedFrame["images"]>[number][] = [];
  let selectedCursor: TuiProjectedFrame["cursor"] | undefined;
  let compactFixedSurfaces = false;

  if (overlay?.inline === true) {
    const available = Math.max(1, size.rows - header.length - shellMain.length - footer.length
      - extensionStatus.length - working.length - widget.length - editor.length - widgetBelow.length - baseStatus.length);
    const projected = projectNativeOverlay({
      snapshot: createNativeOverlaySnapshot(overlay),
      columns: size.columns,
      rows: available,
      theme,
      unicode,
    });
    inlineOverlay = projected.text === "" ? [] : projected.text.split("\n");
  } else if (overlay !== undefined) {
    const available = Math.max(1, size.rows - header.length - footer.length - baseStatus.length);
    const projected = projectNativeOverlay({
      snapshot: createNativeOverlaySnapshot(overlay),
      columns: size.columns,
      rows: available,
      theme,
      unicode,
    });
    main = projected.text === "" ? [] : projected.text.split("\n");
    editor = [];
    selectedCursor = {
      row: header.length + (projected.cursor?.row ?? 1),
      column: projected.cursor?.column ?? 1,
    };
  }

  let runtimeCursorRow = surfaces.runtime?.cursor?.row;
  if (transcriptContent !== undefined && overlay === undefined) {
    const runtimeRows = surfaces.runtime === undefined ? undefined : blockLines(surfaces.runtime);
    const totalRows = runtimeRows?.length ?? transcriptContent.totalRows;
    let shellSeparatorRows = runtimeRows === undefined
      && totalRows > 0
      && shellMain.length > 0
      && shellMain[0] !== ""
      ? 1
      : 0;
    let fixedRows = header.length + shellMain.length + footer.length + extensionStatus.length + working.length
      + widget.length + attachments.length + editor.length + widgetBelow.length + inlineOverlay.length
      + shellSeparatorRows + (surfaces.footer.replacement === false ? baseStatus.length : 0);
    if (runtimeRows !== undefined) fixedRows -= shellMain.length;
    if (fixedRows + Math.min(2, totalRows) > size.rows) {
      compactFixedSurfaces = true;
      shellSeparatorRows = 0;
      let remaining = size.rows;

      const status = surfaces.footer.replacement === false ? trimEmptyRows(baseStatus) : [];
      const editorMinimum = editor.length === 0 ? 0 : 1;
      const statusRows = status.length > 0 && remaining > editorMinimum ? 1 : 0;
      const editorRows = Math.min(editor.length, Math.max(editorMinimum, remaining - statusRows));
      remaining -= editorRows;
      baseStatus = statusRows === 0 ? [] : [status[0]!];
      remaining -= baseStatus.length;
      if (editorRows > 0 && editor.length > editorRows) {
        const cropped = cursorWindow(editor, editorCursorRow, editorRows);
        editor = cropped.lines;
        editorCursorRow = cropped.cursorRow;
      }

      const coreMain = runtimeRows === undefined ? trimEmptyRows(shellMain) : [];
      const optionalSlots = [
        { name: "header" as const, slot: surfaces.header },
        { name: "widget" as const, slot: surfaces.widget },
        { name: "widgetBelow" as const, slot: surfaces.widgetBelow },
        { name: "footer" as const, slot: surfaces.footer },
      ].filter(({ slot }) => slotSourceRows(slot) > 0);
      const transcriptReserve = Math.min(2, totalRows, remaining);
      const slotBudgets = new Map<(typeof optionalSlots)[number]["name"], number>();
      let reservable = Math.max(0, remaining - transcriptReserve);
      for (const { name } of optionalSlots) {
        if (reservable === 0) break;
        slotBudgets.set(name, 1);
        reservable -= 1;
      }
      const optionalSingleRows = [extensionStatus, working, attachments].filter((lines) => lines.length > 0).length;
      const optionalSingleReserve = Math.min(optionalSingleRows, reservable);
      reservable -= optionalSingleReserve;

      const mainRows = Math.min(coreMain.length, reservable);
      shellMain = mainRows === 0 ? [] : coreMain.slice(-mainRows);
      remaining -= shellMain.length;

      let singleRemaining = optionalSingleReserve;
      const keepSingle = (lines: string[]): string[] => {
        if (lines.length === 0 || singleRemaining === 0) return [];
        singleRemaining -= 1;
        return [lines.at(-1)!];
      };
      extensionStatus = keepSingle(extensionStatus);
      working = keepSingle(working);
      attachments = keepSingle(attachments);
      remaining -= extensionStatus.length + working.length + attachments.length;
      remaining -= [...slotBudgets.values()].reduce((total, rows) => total + rows, 0);

      for (const { name, slot } of optionalSlots) {
        const current = slotBudgets.get(name) ?? 0;
        if (current === 0 || remaining <= transcriptReserve) continue;
        if (slotLines(slot, size.columns, unicode).length > current) {
          slotBudgets.set(name, current + 1);
          remaining -= 1;
        }
      }
      if (totalRows === 0) {
        let grew = true;
        while (remaining > 0 && grew) {
          grew = false;
          for (const { name, slot } of optionalSlots) {
            if (remaining === 0) break;
            const current = slotBudgets.get(name) ?? 0;
            if (current >= slotLines(slot, size.columns, unicode).length) continue;
            slotBudgets.set(name, current + 1);
            remaining -= 1;
            grew = true;
          }
        }
      }
      headerProjection = boundedSlotProjection(surfaces.header, size.columns, slotBudgets.get("header") ?? 0, unicode);
      widgetProjection = boundedSlotProjection(surfaces.widget, size.columns, slotBudgets.get("widget") ?? 0, unicode);
      widgetBelowProjection = boundedSlotProjection(surfaces.widgetBelow, size.columns, slotBudgets.get("widgetBelow") ?? 0, unicode);
      footerProjection = boundedSlotProjection(surfaces.footer, size.columns, slotBudgets.get("footer") ?? 0, unicode);
      header = headerProjection.lines;
      widget = widgetProjection.lines;
      widgetBelow = widgetBelowProjection.lines;
      footer = footerProjection.lines;
      fixedRows = header.length + shellMain.length + footer.length + extensionStatus.length + working.length
        + widget.length + attachments.length + editor.length + widgetBelow.length + baseStatus.length;
    }
    transcriptViewportRows = Math.max(0, size.rows - fixedRows);
    let selected: string[];
    if (runtimeRows !== undefined && runtimeCursorRow !== undefined && transcriptViewportRows > 0) {
      const window = cursorWindow(runtimeRows, runtimeCursorRow, transcriptViewportRows);
      selected = window.lines;
      transcriptStart = window.start;
      transcriptEnd = window.start + window.lines.length;
      runtimeCursorRow = window.cursorRow;
    } else {
      if (runtimeRows !== undefined) runtimeCursorRow = undefined;
      const maximumOffset = Math.max(0, totalRows - transcriptViewportRows);
      const selectedOffset = runtimeRows === undefined
        ? Math.min(maximumOffset, Math.max(0, Math.trunc(view.transcriptOffset)))
        : 0;
      transcriptEnd = Math.max(0, totalRows - selectedOffset);
      transcriptStart = Math.max(0, transcriptEnd - transcriptViewportRows);
      if (runtimeRows === undefined) {
        const window = transcriptContent.window(transcriptStart, transcriptEnd - transcriptStart);
        selected = [...window.lines];
        transcriptImages = [...window.images];
      } else {
        selected = runtimeRows.slice(transcriptStart, transcriptEnd);
      }
      if (runtimeRows !== undefined && transcriptStart > 0 && transcriptViewportRows > 0) {
        const visibleRows = Math.max(0, transcriptViewportRows - 1);
        transcriptStart = Math.max(0, transcriptEnd - visibleRows);
        const marker = `${unicode ? "…" : "..."} ${transcriptStart} earlier extension rows`;
        selected = [
          stripAnsi(truncateToWidth(sanitizeTerminalText(marker), size.columns)),
          ...runtimeRows.slice(transcriptStart, transcriptEnd),
        ];
      }
    }
    if (runtimeRows === undefined && transcriptSearchResult !== undefined && selected.length > 0) {
      let matchIndex = 0;
      while (matchIndex < transcriptSearchResult.matches.length
        && transcriptSearchResult.matches[matchIndex]!.endRow < transcriptStart) matchIndex += 1;
      const spansByRow = new Map<number, Array<{ startColumn: number; endColumn: number; selected: boolean }>>();
      for (; matchIndex < transcriptSearchResult.matches.length; matchIndex += 1) {
        const match = transcriptSearchResult.matches[matchIndex]!;
        if (match.startRow >= transcriptEnd) break;
        for (const span of match.spans) {
          if (span.row < transcriptStart || span.row >= transcriptEnd) continue;
          const spans = spansByRow.get(span.row) ?? [];
          spans.push({
            startColumn: span.startColumn,
            endColumn: span.endColumn,
            selected: matchIndex === transcriptSearchSelected,
          });
          spansByRow.set(span.row, spans);
        }
      }
      selected = selected.map((line, index) => highlightedTranscriptLine(
        line,
        spansByRow.get(transcriptStart + index) ?? [],
        theme,
      ));
    }
    transcriptPadding = runtimeRows === undefined && scrollbarVisible
      ? Math.max(0, transcriptViewportRows - selected.length)
      : 0;
    main = runtimeRows === undefined
      ? [
          ...Array.from({ length: transcriptPadding }, () => ""),
          ...selected,
          ...(!compactFixedSurfaces && selected.length > 0 && shellMain.length > 0 && shellMain[0] !== "" ? [""] : []),
          ...shellMain,
        ]
      : selected;
  }

  const beforeEditor = [...header, ...main, ...extensionStatus, ...working, ...widget, ...attachments];
  if (selectedCursor === undefined) {
    if (surfaces.runtime !== undefined && runtimeCursorRow !== undefined) {
      selectedCursor = {
        row: header.length + runtimeCursorRow + 1,
        column: (surfaces.runtime.cursor?.column ?? 0) + 1,
      };
    } else {
      selectedCursor = {
        row: beforeEditor.length + editorCursorRow + 1,
        column: editorCursorColumn,
      };
    }
  }
  let lines = [
    ...beforeEditor,
    ...editor,
    ...widgetBelow,
    ...inlineOverlay,
    ...footer,
    ...(surfaces.footer.replacement === false ? baseStatus : []),
  ];
  const persistentRows = [
    ...persistentPointerRows(headerProjection, 0, size.columns),
    ...persistentPointerRows(
      widgetProjection,
      header.length + main.length + extensionStatus.length + working.length,
      size.columns,
    ),
    ...persistentPointerRows(widgetBelowProjection, beforeEditor.length + editor.length, size.columns),
    ...persistentPointerRows(
      footerProjection,
      beforeEditor.length + editor.length + widgetBelow.length + inlineOverlay.length,
      size.columns,
    ),
  ].slice(0, MAX_POINTER_SEGMENTS);
  let persistentPointer: TuiPersistentPointerMap | undefined = persistentRows.length === 0
    ? undefined
    : { rows: persistentRows };
  let images = transcriptContent === undefined
    || overlay !== undefined
    || surfaces.runtime !== undefined
    || surfaces.overlays.length > 0
    ? []
    : transcriptImages
        .map((image) => ({
          ...image,
          row: image.row + header.length + transcriptPadding,
        }))
        .filter((image) => image.row >= 0 && image.row + image.rows <= lines.length);
  let scrollbar: { thumbTop: number; thumbRows: number } | undefined;
  if (
    scrollbarVisible
    && transcriptContent !== undefined
    && overlay === undefined
    && surfaces.runtime === undefined
    && transcriptViewportRows > 0
    && size.columns > 0
  ) {
    const painted = paintTranscriptScrollbar(
      lines,
      header.length,
      transcriptViewportRows,
      transcriptContent.totalRows,
      transcriptStart,
      size.columns,
      theme,
      scrollbarHovered,
    );
    lines = painted.lines;
    scrollbar = { thumbTop: painted.thumbTop, thumbRows: painted.thumbRows };
  }
  const rawImageReservations = projectTuiRawImageReservations(lines, size.columns);
  lines = paintBackgroundCells(
    lines,
    view.backgroundCells,
    images,
    rawImageReservations,
    size.columns,
    size.rows,
    theme,
  );
  lines = paintRuntimeOverlays(lines, surfaces.overlays, size.columns);
  persistentPointer = maskedPersistentPointerMap(persistentPointer, surfaces.overlays, size.columns);
  if (surfaces.focusedOverlay?.cursor !== undefined) {
    selectedCursor = {
      row: surfaces.focusedOverlay.cursor.row + 1,
      column: surfaces.focusedOverlay.cursor.column + 1,
    };
  }
  if (selectedCursor === undefined) return undefined;
  let emergencyCrop = false;
  if (lines.length > size.rows || selectedCursor.row < 1 || selectedCursor.row > lines.length) {
    emergencyCrop = true;
    const cursorIndex = Math.max(0, Math.min(lines.length - 1, selectedCursor.row - 1));
    const start = Math.min(
      Math.max(0, lines.length - size.rows),
      Math.max(0, cursorIndex - Math.floor((size.rows - 1) / 2)),
    );
    lines = lines.slice(start, start + size.rows);
    selectedCursor = {
      row: cursorIndex - start + 1,
      column: Math.max(1, Math.min(size.columns, selectedCursor.column)),
    };
    images = images
      .filter((image) => image.row >= start && image.row + image.rows <= start + size.rows)
      .map((image) => ({ ...image, row: image.row - start }));
    persistentPointer = cropPersistentPointerMap(persistentPointer, start, size.rows);
  }
  const navigation = emergencyCrop || transcriptContent === undefined || overlay !== undefined || surfaces.runtime !== undefined
    ? undefined
    : {
        totalRows: transcriptContent.totalRows,
        startRow: transcriptStart,
        viewportRows: transcriptViewportRows,
        messageRows: transcriptContent.messageRows,
        ...optionalProperties(transcriptPadding + transcriptEnd - transcriptStart === 0 ? undefined : {
              pointerRegion: {
                top: header.length,
                bottom: header.length + transcriptPadding + transcriptEnd - transcriptStart - 1,
                ...optionalProperties(scrollbar === undefined ? undefined : {
                      scrollbar: {
                        column: size.columns - 1,
                        thumbTop: scrollbar.thumbTop,
                        thumbRows: scrollbar.thumbRows,
                      },
                    }),
              },
            }),
      } satisfies NonNullable<TuiProjectedFrame["transcriptNavigation"]>;
  const anchor = transcriptContent === undefined || navigation === undefined
    ? undefined
    : richViewportAnchor(transcriptContent.ranges, transcriptStart);
  const selected: RichProjectedFrame = {
    text: lines.join("\n"),
    cursor: selectedCursor,
    ...optionalProperties(images.length === 0 ? undefined : { images }),
    ...optionalProperties(navigation === undefined ? undefined : { transcriptNavigation: navigation }),
    ...optionalProperties(transcriptContent === undefined || navigation === undefined ? undefined : {
          [RICH_TRANSCRIPT_ANCHOR]: {
            ranges: transcriptContent.ranges,
            ...optionalProperties(anchor === undefined ? undefined : { viewport: anchor }),
          },
        }),
    ...optionalProperties(persistentPointer === undefined ? undefined : {
      [INTERNAL_TUI_PERSISTENT_POINTER_MAP]: persistentPointer,
    }),
    ...optionalProperties(transcriptSearchResult === undefined ? undefined : {
      [INTERNAL_TUI_TRANSCRIPT_SEARCH]: {
        query: view.transcriptSearch!.query,
        matches: transcriptSearchResult.matches,
        ...optionalProperties(transcriptSearchSelected === undefined ? undefined : {
          selectedMatch: transcriptSearchSelected,
        }),
        truncated: transcriptSearchResult.truncated,
      },
    }),
  };
  return selected;
}

function coreSurfaceView(view: TuiViewState): TuiViewState {
  const selected: TuiViewState = { ...view, context: { ...view.context } };
  const context = selected.context;
  delete context.extensionHeaders;
  delete context.extensionFooters;
  delete context.widgets;
  delete context.workingMessage;
  context.extensionStatus = "Extension UI unavailable; core view preserved";
  for (const key of [
    "runtimeHeaderComponents",
    "runtimeFooterComponents",
    "runtimeWidgetComponents",
    "runtimeWidgetBelowComponents",
    "runtimeHeaderReplacement",
    "runtimeFooterReplacement",
    "rawHeaderComponents",
    "rawFooterComponents",
    "rawWidgetComponents",
    "rawWidgetBelowComponents",
    "rawHeaderReplacement",
    "rawFooterReplacement",
    "editorBlock",
    "rawEditorBlock",
    "runtimeComponent",
    "rawRuntimeComponent",
    "runtimeOverlays",
    "rawRuntimeOverlays",
    "runtimeOverlay",
    "workingIndicator",
    "backgroundCells",
  ] as const) delete selected[key];
  return selected;
}

function withSafeRichSurfaces(
  frame: RichShellFrame,
  request: Readonly<TuiFrameProjectionRequest>,
  transcriptContent: RichTranscriptProjection,
  scrollbarVisible: boolean,
  scrollbarHovered: boolean,
): TuiProjectedFrame | undefined {
  const projected = withRichSurfaces(
    frame,
    request.view,
    request.size,
    request.theme,
    request.theme.unicode,
    transcriptContent,
    scrollbarVisible,
    scrollbarHovered,
  );
  if (projected !== undefined) return projected;
  return withRichSurfaces(
    frame,
    coreSurfaceView(request.view),
    request.size,
    request.theme,
    request.theme.unicode,
    transcriptContent,
    scrollbarVisible,
    scrollbarHovered,
  );
}

function recoveryDimensions(size: Readonly<{ columns: number; rows: number }>): ProjectionDimensions {
  return {
    columns: Number.isSafeInteger(size.columns) && size.columns > 0 ? Math.min(500, size.columns) : 80,
    rows: Number.isSafeInteger(size.rows) && size.rows > 0 ? Math.min(200, size.rows) : 24,
  };
}

function boundedRecoveryFrame(
  frame: RichShellFrame,
  request: Readonly<TuiFrameProjectionRequest>,
): TuiProjectedFrame {
  const size = recoveryDimensions(request.size);
  const lines = (frame.text === "" ? [""] : frame.text.split("\n"))
    .map((line) => truncateToWidth(line, size.columns));
  const composerTop = Math.max(0, Math.min(lines.length, frame.composer.top));
  const fixed = lines.slice(composerTop);
  if (fixed.length < size.rows) {
    const transcript = lines.slice(0, composerTop);
    const viewportRows = Math.max(0, size.rows - fixed.length);
    const maximumOffset = Math.max(0, transcript.length - viewportRows);
    const offset = Math.min(maximumOffset, Math.max(0, Math.trunc(request.view.transcriptOffset)));
    const end = Math.max(0, transcript.length - offset);
    const start = Math.max(0, end - viewportRows);
    const selectedTranscript = transcript.slice(start, end);
    const selectedLines = [...selectedTranscript, ...fixed];
    const cursor = {
      row: Math.max(1, Math.min(selectedLines.length, selectedTranscript.length + frame.cursor.row - composerTop)),
      column: Math.max(1, Math.min(size.columns, frame.cursor.column)),
    };
    return {
      text: selectedLines.join("\n"),
      cursor,
      transcriptNavigation: {
        totalRows: transcript.length,
        startRow: start,
        viewportRows,
        messageRows: [],
        ...optionalProperties(selectedTranscript.length === 0 ? undefined : {
          pointerRegion: { top: 0, bottom: selectedTranscript.length - 1 },
        }),
      },
    };
  }
  const cursorIndex = Math.max(0, Math.min(lines.length - 1, frame.cursor.row - 1));
  const start = Math.min(
    Math.max(0, lines.length - size.rows),
    Math.max(0, cursorIndex - Math.floor((size.rows - 1) / 2)),
  );
  const selected = lines.slice(start, start + size.rows);
  return {
    text: selected.join("\n"),
    cursor: {
      row: Math.max(1, Math.min(selected.length, cursorIndex - start + 1)),
      column: Math.max(1, Math.min(size.columns, frame.cursor.column)),
    },
  };
}

function minimalRecoveryFrame(request: Readonly<TuiFrameProjectionRequest>): TuiProjectedFrame {
  const size = recoveryDimensions(request.size);
  const value = sanitizeTerminalText(request.view.editorText).replaceAll("\n", " ");
  const text = truncateToWidth(`${request.theme.unicode ? "›" : ">"} ${value}`, size.columns);
  const beforeCursor = splitGraphemes(value).slice(0, request.view.editorCursor).join("");
  return {
    text,
    cursor: {
      row: 1,
      column: Math.max(1, Math.min(size.columns, cellWidth(`${request.theme.unicode ? "›" : ">"} ${beforeCursor}`) + 1)),
    },
  };
}

function projectRichRecoveryFrame(request: Readonly<TuiFrameProjectionRequest>): TuiProjectedFrame {
  try {
    const size = recoveryDimensions(request.size);
    const snapshot = snapshotFor(request);
    const hidden = request.hideReasoningBlock
      && request.view.transcript.some((entry) => entry.kind === "reasoning")
      ? [{
          id: "rich-recovery:hidden-reasoning",
          kind: "notice" as const,
          tone: "status" as const,
          text: request.view.hiddenReasoningLabel ?? "Thinking...",
        }]
      : [];
    const imageFallbacks = request.view.transcript.flatMap((entry) => (entry.images ?? []).map((image, index) => ({
      id: `${entry.id}:rich-recovery-image:${index}`,
      kind: "notice" as const,
      tone: "status" as const,
      text: `[Image: ${sanitizeTerminalText(image.block.mediaType)}]`,
    })));
    const full = projectOhmNativeFrame({
      snapshot: normalizeOhmTuiSnapshot({
        ...snapshot,
        transcript: [
          ...snapshot.transcript,
          ...projectTranscript(request.view.transcript, request.hideReasoningBlock),
          ...hidden,
          ...imageFallbacks,
          {
            id: "rich-recovery:notice",
            kind: "notice",
            tone: "warning",
            text: "Display extension unavailable; core view preserved",
          },
        ],
      }),
      columns: size.columns,
      thinkingExpanded: request.thinkingExpanded,
      toolDetailsExpanded: request.toolDetailsExpanded,
      ...optionalProperties(request.transcriptOptions.expandKeyHint === undefined ? undefined : { toolExpandKeyHint: request.transcriptOptions.expandKeyHint }),
      hyperlinks: request.transcriptOptions.hyperlinks === true,
      codeBlockIndent: request.codeBlockIndent,
      editorPaddingX: request.editorPaddingX,
      theme: request.theme,
      unicode: request.theme.unicode,
      ...richShellBudgets(size.rows),
    });
    return boundedRecoveryFrame(full, request);
  } catch {
    return minimalRecoveryFrame(request);
  }
}

function projectRichTuiFrameInternal(
  request: Readonly<TuiFrameProjectionRequest>,
  transcriptCache?: RichTranscriptLayoutCache,
  shellProjector: typeof projectOhmNativeFrame = projectOhmNativeFrame,
): TuiProjectedFrame {
  try {
    const snapshot = normalizeOhmTuiSnapshot(snapshotFor(request));
    const noticeTranscript = snapshot.transcript.filter((entry) => entry.kind === "notice" && entry.id === "view:notice");
    const render = (transcriptColumns: number, scrollbarVisible: boolean): TuiProjectedFrame | undefined => {
      const transcriptContent = projectCachedMixedTranscript(
        transcriptCache,
        request,
        snapshot,
        request.view.transcript,
        transcriptColumns,
      );
      const shellBudgets = richShellBudgets(request.size.rows);
      const shellStatus = { ...snapshot.status };
      if (!request.view.context.workingMessage?.trim()) delete shellStatus.activity;
      return withSafeRichSurfaces(shellProjector({
        snapshot: {
          ...snapshot,
          status: shellStatus,
          transcript: noticeTranscript,
        },
        columns: request.size.columns,
        thinkingExpanded: request.thinkingExpanded,
        toolDetailsExpanded: request.toolDetailsExpanded,
        hyperlinks: request.transcriptOptions.hyperlinks === true,
        codeBlockIndent: request.codeBlockIndent,
        editorPaddingX: request.editorPaddingX,
        theme: request.theme,
        unicode: request.theme.unicode,
        ...shellBudgets,
      }), request, transcriptContent, scrollbarVisible,
      "fullscreenScrollbarHovered" in request.transcriptOptions
        && request.transcriptOptions.fullscreenScrollbarHovered === true);
    };
    const usable = (frame: TuiProjectedFrame): boolean => fitsViewport(frame, request.size);
    const scrollbarMode = "fullscreenScrollbar" in request.transcriptOptions
      ? request.transcriptOptions.fullscreenScrollbar
      : undefined;
    const scrollbarHovered = "fullscreenScrollbarHovered" in request.transcriptOptions
      && request.transcriptOptions.fullscreenScrollbarHovered === true;
    const reserveScrollbar = request.size.columns > 1
      && scrollbarMode === "always";
    let selected = render(request.size.columns - (reserveScrollbar ? 1 : 0), reserveScrollbar);
    if (selected === undefined || !usable(selected)) return projectRichRecoveryFrame(request);
    if (
      request.size.columns > 1
      && scrollbarMode === "auto"
      && scrollbarHovered
      && selected.transcriptNavigation !== undefined
      && selected.transcriptNavigation.totalRows > selected.transcriptNavigation.viewportRows
    ) {
      selected = render(request.size.columns - 1, true);
      if (selected === undefined || !usable(selected)) return projectRichRecoveryFrame(request);
    }
    return selected;
  } catch {
    return projectRichRecoveryFrame(request);
  }
}

export const projectRichTuiFrame: TuiFrameProjector = (request) => projectRichTuiFrameInternal(request);

/** @internal Creates one controller-scoped projector with bounded retained layout state. */
export function internalCreateRichTuiFrameProjector(): TuiFrameProjector {
  const transcriptCache = createRichTranscriptLayoutCache();
  const shellProjector = createOhmNativeViewProjector();
  return (request) => projectRichTuiFrameInternal(request, transcriptCache, shellProjector);
}

/** Constructs the shipping interactive controller with the rich frame as its sole projector. */
export function createRichTuiController(options: TuiControllerOptions = {}): TuiController {
  const selected: InternalTuiControllerOptions = {
    ...options,
    [INTERNAL_TUI_FRAME_PROJECTOR]: internalCreateRichTuiFrameProjector(),
  };
  return new TuiController(selected);
}
