import { optionalProperties } from "../core/optional-properties.js";
import type { EventEnvelope } from "../core/events.js";
import type { CanonicalMessage, NormalizedUsage } from "../core/types.js";
import { addCompleteNormalizedUsage, addNormalizedUsage } from "../core/usage.js";
import { normalizedCacheHitRate } from "../core/cache-usage.js";
import {
  BOOLEAN_VALUE,
  isObjectValue,
  NUMBER_VALUE,
  STRING_VALUE,
} from "../core/value-schemas.js";
import {
  canonicalMessage,
  canonicalUsage,
  extensionSessionEntries,
  type SessionEntry as ExtensionSessionEntry,
} from "../extensions/session-contract.js";
import type { AgentSessionEvent } from "../service/agent-session.js";
import type { ActiveBranchUsage } from "../storage/session-manager.js";
import type { SessionEntry as CanonicalSessionEntry } from "../storage/types.js";
import type { TuiLatestCacheUsage, TuiSessionSummary, TuiTranscriptItem } from "../tui/types.js";
import { Value } from "typebox/value";

export const INTERACTIVE_TRANSCRIPT_ENTRY_LIMIT = 2_000;
export const INTERACTIVE_TRANSCRIPT_SCAN_LIMIT = 20_000;
export const INTERACTIVE_TRANSCRIPT_SCAN_BYTES = 16 * 1024 * 1024;
export const INTERACTIVE_TRANSCRIPT_SCAN_MS = 100;
const DISPLAY_MESSAGE_ROLES = new Set(["system", "user", "assistant", "tool"]);
const PUBLIC_DISPLAY_MESSAGE_ROLES = new Set(["user", "assistant", "toolResult"]);
const NORMALIZED_USAGE_FIELDS = [
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "cacheWrite1hTokens",
  "reasoningTokens",
  "serverToolCalls",
  "durationMs",
] as const satisfies readonly (keyof NormalizedUsage)[];
type PresentationEntry = CanonicalSessionEntry | ExtensionSessionEntry;

interface LinkedEntryReader<T extends PresentationEntry> {
  getEntry(id: string): T | undefined;
  getLeafEntry(): T | undefined;
}

interface BranchEntryReader<T extends PresentationEntry> extends LinkedEntryReader<T> {
  getBranch(): T[];
}

interface BranchUsageReader {
  getActiveBranchUsage(): ActiveBranchUsage;
}

interface InteractiveTranscriptSession {
  readonly nativeSessionManager?: BranchEntryReader<CanonicalSessionEntry> & BranchUsageReader;
  readonly sessionManager: BranchEntryReader<ExtensionSessionEntry> & Partial<BranchUsageReader>;
}

interface InteractiveTranscriptHistorySession extends InteractiveTranscriptSession {
  readonly sessionId: string;
}

interface InteractiveSessionPresentationSession extends InteractiveTranscriptHistorySession {
  onEvent(listener: (event: EventEnvelope) => void): () => void;
  subscribe(listener: (event: AgentSessionEvent) => void | Promise<void>): () => void;
}

type RecentDisplayEntries =
  | { entries: CanonicalSessionEntry[]; source: "canonical" }
  | { entries: ExtensionSessionEntry[]; source: "public" };

function isDisplayEntry(entry: PresentationEntry): entry is Extract<PresentationEntry, { type: "custom" | "custom_message" }> {
  return entry.type === "custom" || (entry.type === "custom_message" && entry.display === true);
}

function isDisplaySummary(
  entry: PresentationEntry,
): entry is Extract<PresentationEntry, { type: "compaction" | "branch_summary" }> {
  return entry.type === "compaction" || entry.type === "branch_summary";
}

type CanonicalMessageEntry = Extract<CanonicalSessionEntry, { type: "message" }> & { message: CanonicalMessage };

function isSystemEntry(entry: PresentationEntry): entry is CanonicalMessageEntry {
  return entry.type === "message" && "createdAt" in entry.message && entry.message.role === "system";
}

function isInstructionEntry(entry: PresentationEntry): boolean {
  return isSystemEntry(entry)
    && entry.message.purpose === "instructions";
}

function isPresentableEntry(entry: PresentationEntry): boolean {
  return isDisplayEntry(entry)
    || isDisplaySummary(entry)
    || (entry.type === "message" && (
      DISPLAY_MESSAGE_ROLES.has(entry.message.role)
      || PUBLIC_DISPLAY_MESSAGE_ROLES.has(entry.message.role)
      || entry.message.role === "bashExecution"
      || (entry.message.role === "custom" && entry.message.display)
    ));
}

function boundedValueBytes<ValueType>(
  value: ValueType,
  maximum: number,
  deadline: number,
  seen = new Set<object>(),
  depth = 0,
): number {
  if (maximum <= 0) return 0;
  if (performance.now() >= deadline) return maximum;
  if (value === null || value === undefined) return Math.min(maximum, 4);
  if (Value.Check(STRING_VALUE, value)) {
    if (value.length >= maximum) return maximum;
    return Math.min(maximum, Buffer.byteLength(value, "utf8") + 2);
  }
  if (Value.Check(NUMBER_VALUE, value) || Value.Check(BOOLEAN_VALUE, value)) return Math.min(maximum, 16);
  if (!isObjectValue(value) || depth >= 32 || seen.has(value)) return Math.min(maximum, 32);
  seen.add(value);
  let bytes = 2;
  try {
    for (const key of Object.keys(value)) {
      if (bytes >= maximum || performance.now() >= deadline) return maximum;
      const remaining = maximum - bytes;
      bytes += key.length >= remaining
        ? remaining
        : Math.min(remaining, Buffer.byteLength(key, "utf8") + 4);
      if (bytes >= maximum) return maximum;
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) return maximum;
      bytes += boundedValueBytes(
        descriptor.value,
        maximum - bytes,
        deadline,
        seen,
        depth + 1,
      );
    }
  } catch {
    return maximum;
  } finally {
    seen.delete(value);
  }
  return Math.min(maximum, bytes);
}

function scanRecentDisplayEntries<T extends PresentationEntry>(reader: LinkedEntryReader<T>): T[] {
  const selected: T[] = [];
  const deadline = performance.now() + INTERACTIVE_TRANSCRIPT_SCAN_MS;
  let scanned = 0;
  let bytes = 0;
  let compaction: Extract<PresentationEntry, { type: "compaction" }> | undefined;
  let retainedBoundaryReached = false;
  let selectedInstruction = false;
  let entry = reader.getLeafEntry();
  while (
    entry !== undefined
    && selected.length < INTERACTIVE_TRANSCRIPT_ENTRY_LIMIT
    && scanned < INTERACTIVE_TRANSCRIPT_SCAN_LIMIT
    && bytes < INTERACTIVE_TRANSCRIPT_SCAN_BYTES
    && (selected.length === 0 || performance.now() < deadline)
  ) {
    scanned += 1;
    bytes += boundedValueBytes(
      entry,
      INTERACTIVE_TRANSCRIPT_SCAN_BYTES - bytes,
      selected.length === 0 ? Number.POSITIVE_INFINITY : deadline,
    );
    if (compaction === undefined) {
      if (isPresentableEntry(entry)) selected.push(entry);
      if (entry.type === "compaction") compaction = entry;
    } else {
      const system = isSystemEntry(entry);
      if (system) {
        if (!isInstructionEntry(entry) || !selectedInstruction) selected.push(entry);
        if (isInstructionEntry(entry)) selectedInstruction = true;
      } else if (!retainedBoundaryReached && entry.type !== "compaction" && isPresentableEntry(entry)) {
        selected.push(entry);
      }
      if (entry.id === compaction.firstKeptEntryId) retainedBoundaryReached = true;
    }
    entry = entry.parentId === null ? undefined : reader.getEntry(entry.parentId);
  }
  return selected.reverse();
}

function recentDisplayEntries(session: InteractiveTranscriptSession): RecentDisplayEntries {
  const native = session.nativeSessionManager;
  if (native !== undefined) return { entries: scanRecentDisplayEntries(native), source: "canonical" };
  return { entries: scanRecentDisplayEntries(session.sessionManager), source: "public" };
}

export interface InteractiveTranscriptUsageBaseline {
  usage?: NormalizedUsage;
  reportedUsage?: NormalizedUsage;
  latestCacheHitRate?: number;
  latestCacheUsage?: TuiLatestCacheUsage;
}

function hasNormalizedUsageValues(usage: NormalizedUsage): boolean {
  return usage.cost !== undefined || NORMALIZED_USAGE_FIELDS.some((field) => usage[field] !== undefined);
}

function activeBranchUsage(session: InteractiveTranscriptSession): ActiveBranchUsage {
  const native = session.nativeSessionManager;
  if (native !== undefined) return native.getActiveBranchUsage();

  const projectedUsage = session.sessionManager.getActiveBranchUsage;
  if (projectedUsage !== undefined) return projectedUsage.call(session.sessionManager);

  // Keep older embedded session readers source-compatible. Public tool-result
  // batches cannot preserve canonical usage ownership, so this conservative
  // fallback counts their assistant and summary requests only.
  const branch = session.sessionManager.getBranch();
  let aggregate: NormalizedUsage | undefined;
  let reported: NormalizedUsage | undefined;
  let hasUsageObservations = false;
  for (const entry of branch) {
    if (isDisplaySummary(entry)) {
      const usage = entry.usage === undefined
        ? {}
        : canonicalUsage(entry.usage);
      if (entry.fromHook !== true || hasNormalizedUsageValues(usage)) {
        hasUsageObservations = true;
        aggregate = addCompleteNormalizedUsage(aggregate, usage);
        reported = addNormalizedUsage(reported, usage);
      }
      continue;
    }
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role !== "assistant") continue;
    const parsedUsage = message.usage === undefined
      ? undefined
      : canonicalUsage(message.usage);
    const usage = parsedUsage !== undefined && hasNormalizedUsageValues(parsedUsage)
      ? parsedUsage
      : undefined;
    const successfulAssistant = message.stopReason !== "aborted"
      && message.stopReason !== "error";
    if (usage !== undefined || successfulAssistant) {
      hasUsageObservations = true;
      aggregate = addCompleteNormalizedUsage(aggregate, usage ?? {});
      reported = addNormalizedUsage(reported, usage ?? {});
    }
  }
  const usage = aggregate ?? {};
  const reportedUsage = reported ?? {};
  const hasReportedFallback = NORMALIZED_USAGE_FIELDS.some(
    (field) => usage[field] === undefined && reportedUsage[field] !== undefined,
  ) || (usage.cost === undefined && reportedUsage.cost !== undefined);
  return {
    usage,
    ...optionalProperties(hasReportedFallback ? { reportedUsage } : undefined),
    hasUsageObservations,
  };
}

/** Usage shown beside the active transcript, excluding abandoned sibling branches. */
export function interactiveTranscriptUsageBaseline(session: InteractiveTranscriptSession): InteractiveTranscriptUsageBaseline {
  const baseline = activeBranchUsage(session);
  const latestAssistantUsage = baseline.latestAssistantUsage;
  const latestCacheHitRate = latestAssistantUsage === undefined
    ? undefined
    : normalizedCacheHitRate(latestAssistantUsage);
  const latestCacheUsage: TuiLatestCacheUsage | undefined = latestAssistantUsage === undefined || (
    latestAssistantUsage.cacheReadTokens === undefined
    && latestAssistantUsage.cacheWriteTokens === undefined
    && latestAssistantUsage.cacheWrite1hTokens === undefined
  )
    ? undefined
    : {
        ...optionalProperties(latestAssistantUsage.cacheReadTokens === undefined ? undefined : { cacheReadTokens: latestAssistantUsage.cacheReadTokens }),
        ...optionalProperties(latestAssistantUsage.cacheWriteTokens === undefined ? undefined : { cacheWriteTokens: latestAssistantUsage.cacheWriteTokens }),
        ...optionalProperties(latestAssistantUsage.cacheWrite1hTokens === undefined ? undefined : { cacheWrite1hTokens: latestAssistantUsage.cacheWrite1hTokens }),
      };
  return {
    ...optionalProperties(baseline.hasUsageObservations === false ? undefined : { usage: baseline.usage }),
    ...optionalProperties(baseline.hasUsageObservations === false || baseline.reportedUsage === undefined ? undefined : { reportedUsage: baseline.reportedUsage }),
    ...optionalProperties(latestCacheHitRate === undefined ? undefined : { latestCacheHitRate }),
    ...optionalProperties(latestCacheUsage === undefined ? undefined : { latestCacheUsage }),
  };
}

function publicDisplayMessage(entry: Extract<ExtensionSessionEntry, { type: "message" }>): CanonicalMessage | undefined {
  const message = entry.message;
  if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") return undefined;
  let safeMessage: Parameters<typeof canonicalMessage>[0] = message;
  if (message.role === "assistant") {
    const {
      diagnostics: _diagnostics,
      providerState: _providerState,
      responseId: _responseId,
      responseModel: _responseModel,
      ...displayMessage
    } = message;
    safeMessage = { ...displayMessage, api: "extension-stream" };
  }
  const canonical = canonicalMessage(safeMessage);
  if (canonical.role === "bashExecution" || canonical.role === "custom") return undefined;
  return { ...canonical, id: entry.id, createdAt: entry.timestamp };
}

function publicCustomMessage(entry: Extract<ExtensionSessionEntry, { type: "message" }>): TuiTranscriptItem | undefined {
  const message = entry.message;
  if (message.role !== "custom" || !message.display) return undefined;
  return {
    type: "custom_message",
    id: entry.id,
    parentId: entry.parentId,
    timestamp: entry.timestamp,
    customType: message.customType,
    content: structuredClone(message.content),
    display: true,
    ...optionalProperties(message.details === undefined ? undefined : { details: structuredClone(message.details) }),
  };
}

type TranscriptProjection =
  | { kind: "item"; item: TuiTranscriptItem }
  | { id: string; kind: "message"; message: CanonicalMessage; timestamp: string };

function displayUsage(usage: NormalizedUsage | undefined): Omit<NormalizedUsage, "raw"> | undefined {
  if (usage === undefined) return undefined;
  const { raw: _raw, ...display } = usage;
  return display;
}

function projectedDisplayEntries(entries: readonly ExtensionSessionEntry[]): ReadonlyMap<string, TuiTranscriptItem> {
  const projected = new Map<string, TuiTranscriptItem>();
  for (const entry of entries) {
    if (entry.type === "custom" || (entry.type === "custom_message" && entry.display === true)) {
      projected.set(entry.id, entry);
    }
  }
  return projected;
}

function shellProjection(
  entry: Extract<CanonicalSessionEntry | ExtensionSessionEntry, { type: "message" }>,
): TranscriptProjection | undefined {
  const message = entry.message;
  if (message.role !== "bashExecution") return undefined;
  return { kind: "item", item: {
    type: "shell_execution",
    id: entry.id,
    command: message.command,
    output: message.output,
    ...optionalProperties(message.exitCode === undefined ? undefined : { exitCode: message.exitCode }),
    ...optionalProperties(message.isError === undefined ? undefined : { isError: message.isError }),
    cancelled: message.cancelled,
    ...optionalProperties(message.timedOut === undefined ? undefined : { timedOut: message.timedOut }),
    ...optionalProperties(message.signal === undefined ? undefined : { signal: message.signal }),
    truncated: message.truncated,
    ...optionalProperties(message.fullOutputPath === undefined ? undefined : { fullOutputPath: message.fullOutputPath }),
    ...optionalProperties(message.excludeFromContext === undefined ? undefined : { excludeFromContext: message.excludeFromContext }),
  } };
}

function summaryProjection(
  entry: Extract<CanonicalSessionEntry, { type: "compaction" | "branch_summary" }>,
): TranscriptProjection;
function summaryProjection(
  entry: Extract<ExtensionSessionEntry, { type: "compaction" | "branch_summary" }>,
): TranscriptProjection;
function summaryProjection(
  entry: Extract<PresentationEntry, { type: "compaction" | "branch_summary" }>,
): TranscriptProjection {
  const normalizedUsage = entry.usage === undefined
    ? undefined
    : "inputTokens" in entry.usage
      ? entry.usage
      : canonicalUsage(entry.usage);
  const usage = displayUsage(normalizedUsage);
  const summary: TuiSessionSummary = {
    type: "session_summary",
    id: entry.id,
    summaryType: entry.type,
    text: entry.summary,
    ...optionalProperties(entry.type === "compaction" ? { tokensBefore: entry.tokensBefore } : undefined),
    ...optionalProperties(usage === undefined ? undefined : { usage: structuredClone(usage) }),
  };
  return { kind: "item", item: summary };
}

function canonicalTranscriptProjections(entries: readonly CanonicalSessionEntry[]): TranscriptProjection[] {
  const displays = projectedDisplayEntries(extensionSessionEntries(entries));
  return entries.flatMap((entry): TranscriptProjection[] => {
    if (entry.type === "compaction" || entry.type === "branch_summary") return [summaryProjection(entry)];
    if (entry.type === "custom" || (entry.type === "custom_message" && entry.display === true)) {
      const projected = displays.get(entry.id);
      if (projected === undefined) throw new Error("Direct session presentation lost a custom entry projection");
      return [{ kind: "item", item: projected }];
    }
    if (entry.type !== "message") return [];
    const shell = shellProjection(entry);
    if (shell !== undefined) return [shell];
    const message = entry.message;
    if (
      message.role !== "system"
      && message.role !== "user"
      && message.role !== "assistant"
      && message.role !== "tool"
    ) return [];
    return [{ id: entry.id, kind: "message", message, timestamp: entry.timestamp }];
  });
}

function publicTranscriptProjections(entries: readonly ExtensionSessionEntry[]): TranscriptProjection[] {
  const displays = projectedDisplayEntries(entries);
  return entries.flatMap((entry): TranscriptProjection[] => {
    if (entry.type === "compaction" || entry.type === "branch_summary") return [summaryProjection(entry)];
    if (entry.type === "custom" || (entry.type === "custom_message" && entry.display === true)) {
      const projected = displays.get(entry.id);
      if (projected === undefined) throw new Error("Direct session presentation lost a custom entry projection");
      return [{ kind: "item", item: projected }];
    }
    if (entry.type !== "message") return [];
    const shell = shellProjection(entry);
    if (shell !== undefined) return [shell];
    const custom = publicCustomMessage(entry);
    if (custom !== undefined) return [{ kind: "item", item: custom }];
    const message = publicDisplayMessage(entry);
    return message === undefined
      ? []
      : [{ id: entry.id, kind: "message", message, timestamp: entry.timestamp }];
  });
}

/** Projects the active JSONL branch into one stable, ordered terminal history. */
export function interactiveTranscriptHistory(session: InteractiveTranscriptHistorySession): TuiTranscriptItem[] {
  let sequence = 0;
  let parentEventId: string | undefined;
  const recent = recentDisplayEntries(session);
  const projections = recent.source === "canonical"
    ? canonicalTranscriptProjections(recent.entries)
    : publicTranscriptProjections(recent.entries);
  return projections.flatMap((projection): TuiTranscriptItem[] => {
    if (projection.kind === "item") return [projection.item];
    const { id, message, timestamp } = projection;
    const envelope: EventEnvelope = {
      eventId: id,
      threadId: session.sessionId,
      ...optionalProperties(parentEventId === undefined ? undefined : { parentEventId }),
      sequence: ++sequence,
      timestamp,
      schemaVersion: 1,
      event: { type: "message_appended", message },
    };
    parentEventId = id;
    if (message.role !== "assistant") return [envelope];
    return [envelope, {
      eventId: `${id}~assistant-completed`,
      threadId: session.sessionId,
      parentEventId: id,
      sequence: ++sequence,
      timestamp,
      schemaVersion: 1,
      event: {
        type: "assistant_completed",
        finishReason: message.stopReason
          ?? (message.content.some((block) => block.type === "tool_call") ? "tool_calls" : "stop"),
      },
    }];
  });
}

export interface InteractiveSessionPresentationOptions {
  onEnvelope?(event: EventEnvelope): void;
  onSessionEvent?(event: AgentSessionEvent): void;
  preserveTranscript?: boolean;
}

/** Rendering port shared by interactive frontends. */
export interface InteractiveSessionPresentationTerminal {
  render(event: EventEnvelope): void;
  renderSessionEntry(entry: Extract<ExtensionSessionEntry, { type: "custom" | "custom_message" }>): void;
  replaceTranscript(
    items: readonly TuiTranscriptItem[],
    branch?: string,
    options?: { preserveExisting?: boolean },
  ): void;
  setUsageBaseline(
    usage: NormalizedUsage | undefined,
    latestCacheHitRate?: number,
    latestCacheUsage?: TuiLatestCacheUsage,
    reportedUsage?: NormalizedUsage,
  ): void;
}

function unsubscribeInteractiveSessionPresentation(
  unsubscribeSession: () => void,
  unsubscribeEnvelope: () => void,
  failures: unknown[],
  message: string,
): void {
  try {
    unsubscribeSession();
  } catch (error) {
    failures.push(error);
  }
  try {
    unsubscribeEnvelope();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, message);
}

/**
 * Owns history replay plus both live event streams. Subscription begins before
 * the snapshot, so entries appended during resume cannot fall between them.
 */
export function bindInteractiveSessionPresentation(
  session: InteractiveSessionPresentationSession,
  terminal: InteractiveSessionPresentationTerminal,
  options: InteractiveSessionPresentationOptions = {},
): () => void {
  let replaying = true;
  const pending: Array<() => void> = [];
  const deliver = (action: () => void): void => {
    if (replaying) pending.push(action);
    else action();
  };
  const unsubscribeEnvelope = session.onEvent((event) => deliver(() => {
    terminal.render(event);
    options.onEnvelope?.(event);
  }));
  const unsubscribeSession = session.subscribe((event) => deliver(() => {
    if (
      event.type === "entry_appended"
      && (event.entry.type === "custom" || (event.entry.type === "custom_message" && event.entry.display === true))
    ) {
      terminal.renderSessionEntry(event.entry);
    }
    options.onSessionEvent?.(event);
  }));
  try {
    terminal.replaceTranscript(interactiveTranscriptHistory(session), "main", {
      preserveExisting: options.preserveTranscript === true,
    });
    const usage = interactiveTranscriptUsageBaseline(session);
    terminal.setUsageBaseline(
      usage.usage,
      usage.latestCacheHitRate,
      usage.latestCacheUsage,
      usage.reportedUsage,
    );
    replaying = false;
    for (const action of pending) action();
    pending.length = 0;
  } catch (error) {
    unsubscribeInteractiveSessionPresentation(
      unsubscribeSession,
      unsubscribeEnvelope,
      [error],
      "Interactive session presentation failed and cleanup was incomplete",
    );
  }
  return () => {
    replaying = false;
    pending.length = 0;
    unsubscribeInteractiveSessionPresentation(
      unsubscribeSession,
      unsubscribeEnvelope,
      [],
      "Interactive session presentation cleanup failed",
    );
  };
}
