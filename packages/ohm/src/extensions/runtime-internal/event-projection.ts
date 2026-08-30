import type { AssistantMessage, AssistantMessageEvent } from "@ohm/kernel";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import { isJsonValue, type JsonObject } from "../../core/json.js";
import { optionalProperties } from "../../core/optional-properties.js";
import type {
  AssistantContentBlock,
  CanonicalMessage,
  ImageBlock,
  ToolResultBlock,
} from "../../core/types.js";
import type { SessionEntry } from "../../storage/types.js";
import {
  extensionAssistantEvent,
  extensionAssistantEventFromMessage,
  extensionCanonicalMessages,
  extensionContent,
  extensionMessage,
  extensionMessages,
  extensionSessionEntry,
  extensionToolResultBlock,
} from "../session-contract.js";
import type { RuntimeExtensionEvent } from "../runtime.js";
const DIRECT_EVENT_RECORD_VALUE = Type.Object({}, { additionalProperties: true });
const STRING_VALUE = Type.String();
const NUMBER_VALUE = Type.Number();
const BOOLEAN_VALUE = Type.Boolean();
const NON_NEGATIVE_INTEGER_VALUE = Type.Integer({ minimum: 0 });
const POSITIVE_INTEGER_VALUE = Type.Integer({ minimum: 1 });
const STRING_ARRAY_VALUE = Type.Array(Type.String());
const TOOL_INVOCATION_VALUE = Type.Object({
  callId: Type.String(),
  name: Type.String(),
  input: Type.Unknown(),
  index: NON_NEGATIVE_INTEGER_VALUE,
}, { additionalProperties: true });
const TOOL_RESULT_BLOCK_VALUE = Type.Object({
  content: Type.String(),
  isError: Type.Boolean(),
}, { additionalProperties: true });
const ASSISTANT_STREAM_SNAPSHOT_VALUE = Type.Object({
  role: Type.Literal("assistant"),
  provider: Type.String(),
  model: Type.String(),
  text: Type.Array(Type.Object({
    part: NON_NEGATIVE_INTEGER_VALUE,
    text: Type.String(),
    textSignature: Type.Optional(Type.String()),
  })),
  reasoning: Type.Array(Type.Object({
    part: NON_NEGATIVE_INTEGER_VALUE,
    text: Type.String(),
    visibility: Type.Union([Type.Literal("summary"), Type.Literal("provider_trace")]),
    thinkingSignature: Type.Optional(Type.String()),
    redacted: Type.Optional(Type.Boolean()),
  })),
  toolCalls: Type.Array(Type.Object({
    index: NON_NEGATIVE_INTEGER_VALUE,
    id: Type.Optional(Type.String()),
    name: Type.Optional(Type.String()),
    rawArguments: Type.String(),
    arguments: Type.Optional(Type.Unknown()),
    parseError: Type.Optional(Type.String()),
    thoughtSignature: Type.Optional(Type.String()),
    complete: Type.Boolean(),
  })),
}, { additionalProperties: true });

type AssistantStreamSnapshot = Static<typeof ASSISTANT_STREAM_SNAPSHOT_VALUE>;

interface IndexedAssistantContent {
  readonly index: number;
  readonly content: AssistantContentBlock;
}

interface DirectEventRecord {
  readonly aborted?: unknown;
  readonly action?: unknown;
  readonly args?: unknown;
  readonly arguments?: unknown;
  readonly assistantMessageEvent?: unknown;
  readonly branch?: unknown;
  readonly category?: unknown;
  readonly compactionEntry?: unknown;
  readonly content?: unknown;
  readonly customType?: unknown;
  readonly details?: unknown;
  readonly delta?: unknown;
  readonly display?: unknown;
  readonly errorMessage?: unknown;
  readonly fromExtension?: unknown;
  readonly firstKeptEntryId?: unknown;
  readonly images?: unknown;
  readonly id?: unknown;
  readonly index?: unknown;
  readonly invocation?: unknown;
  readonly isError?: unknown;
  readonly jsonFragment?: unknown;
  readonly kind?: unknown;
  readonly message?: unknown;
  readonly messages?: unknown;
  readonly metadata?: unknown;
  readonly model?: unknown;
  readonly name?: unknown;
  readonly outcome?: unknown;
  readonly part?: unknown;
  readonly parseError?: unknown;
  readonly provider?: unknown;
  readonly phase?: unknown;
  readonly progress?: unknown;
  readonly rawArguments?: unknown;
  readonly reason?: unknown;
  readonly result?: unknown;
  readonly runId?: unknown;
  readonly sourceMessageIds?: unknown;
  readonly sourceThreadId?: unknown;
  readonly step?: unknown;
  readonly summaryEntry?: unknown;
  readonly summary?: unknown;
  readonly systemPrompt?: unknown;
  readonly targetBranch?: unknown;
  readonly targetThreadId?: unknown;
  readonly text?: unknown;
  readonly threadId?: unknown;
  readonly timestamp?: unknown;
  readonly tokensBefore?: unknown;
  readonly toolCallId?: unknown;
  readonly toolName?: unknown;
  readonly partialResult?: unknown;
  readonly preview?: unknown;
  readonly status?: unknown;
  readonly toolResults?: unknown;
  readonly visibility?: unknown;
  readonly type?: unknown;
  readonly willRetry?: unknown;
}

const RUN_SCOPED_EVENTS: ReadonlySet<RuntimeExtensionEvent> = new Set([
  "session_before_compact",
  "session_compact",
  "before_agent_start",
  "agent_start",
  "agent_end",
  "agent_settled",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "tool_call",
  "tool_result",
  "context",
  "before_provider_request",
  "before_provider_headers",
  "after_provider_response",
]);

const REQUESTER_THREAD_EVENTS: ReadonlySet<RuntimeExtensionEvent> = new Set([
  ...RUN_SCOPED_EVENTS,
  "session_start",
  "session_info_changed",
  "session_end",
  "session_before_tree",
  "session_tree",
  "model_select",
  "thinking_level_select",
  "input",
  "event",
]);

export function directEventRecord<T>(value: T): (T & DirectEventRecord) | undefined {
  return Value.Check(DIRECT_EVENT_RECORD_VALUE, value) ? value : undefined;
}

export function freezeRuntimeRunEvent<T>(_event: RuntimeExtensionEvent, value: T): T {
  if (Value.Check(DIRECT_EVENT_RECORD_VALUE, value)) return Object.freeze(value);
  return value;
}

type DirectEventProjector = (selected: DirectEventRecord) => unknown[];

function canonicalStreamMessage(
  selected: DirectEventRecord,
  snapshot: AssistantStreamSnapshot,
): CanonicalMessage {
  const content: IndexedAssistantContent[] = [];
  for (const part of snapshot.text) {
    content.push({
      index: part.part,
      content: {
        type: "text",
        text: part.text,
        ...optionalProperties(part.textSignature === undefined ? undefined : { textSignature: part.textSignature }),
      },
    });
  }
  for (const part of snapshot.reasoning) {
    content.push({
      index: part.part,
      content: {
        type: "thinking",
        thinking: part.text,
        visibility: part.visibility,
        ...optionalProperties(part.thinkingSignature === undefined ? undefined : { thinkingSignature: part.thinkingSignature }),
        ...optionalProperties(part.redacted === undefined ? undefined : { redacted: part.redacted }),
      },
    });
  }
  for (const call of snapshot.toolCalls) {
    if (!call.complete || call.id === undefined || call.name === undefined) continue;
    content.push({
      index: call.index,
      content: {
        type: "tool_call",
        callId: call.id,
        name: call.name,
        arguments: isJsonValue(call.arguments) ? structuredClone(call.arguments) : {},
        rawArguments: call.rawArguments,
        ...optionalProperties(call.thoughtSignature === undefined ? undefined : { thoughtSignature: call.thoughtSignature }),
      },
    });
  }
  content.sort((left, right) => left.index - right.index);
  const runId = Value.Check(STRING_VALUE, selected.runId) ? selected.runId : "run";
  const step = Value.Check(POSITIVE_INTEGER_VALUE, selected.step) ? selected.step : 1;
  return {
    id: `stream-${runId}-${step}`,
    role: "assistant",
    content: content.map((entry) => entry.content),
    createdAt: new Date().toISOString(),
    provider: snapshot.provider,
    model: snapshot.model,
  };
}

function extensionStreamMessage(message: CanonicalMessage): AssistantMessage {
  const projected = extensionMessage(message);
  if (projected.role !== "assistant") throw new TypeError("Assistant stream projection produced a non-assistant message");
  return { ...projected, stopReason: "pending" };
}

function streamIndex<ValueType>(value: ValueType, label: string): number {
  if (!Value.Check(NON_NEGATIVE_INTEGER_VALUE, value)) throw new TypeError(`${label} must be a nonnegative integer`);
  return value;
}

function streamString<ValueType>(value: ValueType, label: string): string {
  if (!Value.Check(STRING_VALUE, value)) throw new TypeError(`${label} must be a string`);
  return value;
}

function extensionStreamUpdate(
  selected: DirectEventRecord,
  message: CanonicalMessage,
  partial: AssistantMessage,
): AssistantMessageEvent {
  let event: JsonObject;
  if (selected.kind === "text") {
    event = {
      type: "text_delta",
      part: streamIndex(selected.part, "Assistant text part"),
      text: streamString(selected.delta, "Assistant text delta"),
    };
  } else if (selected.kind === "reasoning") {
    event = {
      type: "reasoning_delta",
      part: streamIndex(selected.part, "Assistant reasoning part"),
      text: streamString(selected.delta, "Assistant reasoning delta"),
      visibility: selected.visibility === "provider_trace" ? "provider_trace" : "summary",
    };
  } else if (selected.kind === "tool_call_start") {
    event = {
      type: "tool_call_started",
      index: streamIndex(selected.index, "Assistant tool-call index"),
      ...optionalProperties(Value.Check(STRING_VALUE, selected.id) ? { id: selected.id } : undefined),
      ...optionalProperties(Value.Check(STRING_VALUE, selected.name) ? { name: selected.name } : undefined),
    };
  } else if (selected.kind === "tool_call_delta") {
    event = {
      type: "tool_call_delta",
      index: streamIndex(selected.index, "Assistant tool-call index"),
      jsonFragment: streamString(selected.jsonFragment, "Assistant tool-call delta"),
    };
  } else if (selected.kind === "tool_call_end") {
    event = {
      type: "tool_call_completed",
      index: streamIndex(selected.index, "Assistant tool-call index"),
      name: streamString(selected.name, "Assistant tool-call name"),
      rawArguments: streamString(selected.rawArguments, "Assistant tool-call arguments"),
      ...optionalProperties(Value.Check(STRING_VALUE, selected.id) ? { id: selected.id } : undefined),
      ...optionalProperties(isJsonValue(selected.arguments) ? { arguments: selected.arguments } : undefined),
      ...optionalProperties(Value.Check(STRING_VALUE, selected.parseError) ? { parseError: selected.parseError } : undefined),
    };
  } else {
    throw new TypeError("Assistant stream update kind is invalid");
  }
  const projected = extensionAssistantEvent(event, message);
  if (!("partial" in projected)) throw new TypeError("Assistant stream update did not produce a partial message");
  return { ...projected, partial };
}

function projectedCompactionEntry(
  selected: DirectEventRecord,
): ReturnType<typeof extensionSessionEntry> | undefined {
  if (directEventRecord(selected.summary) === undefined) return undefined;
  // SAFETY: the typed native session_compact contract owns the cloned canonical summary message.
  const summary = selected.summary as CanonicalMessage;
  const metadata = directEventRecord(selected.metadata);
  const sourceMessageIds = Value.Check(STRING_ARRAY_VALUE, selected.sourceMessageIds)
    ? selected.sourceMessageIds
    : [];
  const firstKeptEntryId = Value.Check(STRING_VALUE, metadata?.firstKeptEntryId)
    ? metadata.firstKeptEntryId
    : sourceMessageIds[0] ?? summary.id;
  const tokensBefore = Value.Check(NON_NEGATIVE_INTEGER_VALUE, metadata?.tokensBefore)
    ? metadata.tokensBefore
    : 0;
  const summaryText = summary.content
    .filter((block): block is Extract<CanonicalMessage["content"][number], { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  return extensionSessionEntry({
    type: "compaction",
    id: summary.id,
    parentId: sourceMessageIds.at(-1) ?? null,
    timestamp: summary.createdAt,
    summary: summaryText,
    firstKeptEntryId,
    tokensBefore,
    fromHook: selected.fromExtension === true,
    ...optionalProperties(summary.usage === undefined ? undefined : { usage: summary.usage }),
    ...optionalProperties(metadata?.details === undefined ? undefined : { details: metadata.details }),
  });
}

function projectedToolInvocation(selected: DirectEventRecord): Static<typeof TOOL_INVOCATION_VALUE> | undefined {
  return Value.Check(TOOL_INVOCATION_VALUE, selected.invocation) ? selected.invocation : undefined;
}

function projectedToolIdentity(selected: DirectEventRecord): DirectEventRecord {
  const invocation = projectedToolInvocation(selected);
  if (invocation === undefined) return selected;
  return {
    ...selected,
    toolCallId: invocation.callId,
    toolName: invocation.name,
  };
}

function projectedToolStart(selected: DirectEventRecord): DirectEventRecord {
  const invocation = projectedToolInvocation(selected);
  if (invocation === undefined) return selected;
  return { ...projectedToolIdentity(selected), args: invocation.input };
}

function projectedToolUpdate(selected: DirectEventRecord): DirectEventRecord {
  const projected = projectedToolIdentity(selected);
  if (projected === selected || selected.phase !== "progress") return projected;
  return { ...projected, partialResult: selected.progress };
}

function projectedToolEnd(selected: DirectEventRecord): DirectEventRecord {
  const projected = projectedToolIdentity(selected);
  if (projected === selected) return projected;
  const outcome = directEventRecord(selected.outcome);
  if (outcome === undefined) return projected;
  if (outcome.status === "completed" || outcome.status === "failed") {
    const block = Value.Check(TOOL_RESULT_BLOCK_VALUE, outcome.result) ? outcome.result : undefined;
    const isError = Value.Check(BOOLEAN_VALUE, outcome.isError) ? outcome.isError : outcome.status === "failed";
    return {
      ...projected,
      result: block === undefined
        ? { content: Value.Check(STRING_VALUE, outcome.preview) ? outcome.preview : "", isError }
        : { ...block, isError },
      isError,
    };
  }
  const reason = Value.Check(STRING_VALUE, outcome.reason) ? outcome.reason : "Tool execution was interrupted";
  return {
    ...projected,
    result: { content: reason, isError: true },
    isError: true,
  };
}

const EVENT_PROJECTORS = {
  agent_end(selected) {
    if (!Array.isArray(selected.messages)) return [selected];
    // SAFETY: agent_end payloads originate from the typed runtime event map and cloning preserves the message array.
    const messages = selected.messages as CanonicalMessage[];
    return [{ ...selected, messages: extensionCanonicalMessages(messages) }];
  },
  turn_end(selected) {
    if (directEventRecord(selected.message) === undefined) return [selected];
    const timestamp = Value.Check(NUMBER_VALUE, selected.timestamp) ? selected.timestamp : Date.now();
    // SAFETY: turn_end payloads originate from the typed runtime event map and cloning preserves both fields.
    const message = selected.message as CanonicalMessage;
    // SAFETY: the typed turn_end contract owns every element of this cloned tool-results array.
    const blocks = Array.isArray(selected.toolResults) ? selected.toolResults as ToolResultBlock[] : [];
    const toolResults = blocks.map((block) => extensionToolResultBlock(block, { timestamp }));
    return [{ ...selected, message: extensionMessage(message), toolResults }];
  },
  message_start(selected) {
    if (directEventRecord(selected.message) === undefined) return [selected];
    if (Value.Check(ASSISTANT_STREAM_SNAPSHOT_VALUE, selected.message)) {
      const message = canonicalStreamMessage(selected, selected.message);
      return [{ ...selected, message: extensionStreamMessage(message) }];
    }
    // SAFETY: message_start receives the host's cloned canonical message, never listener-authored data.
    const message = selected.message as CanonicalMessage;
    return extensionMessages(message).map((projected) => ({ ...selected, message: projected }));
  },
  message_end(selected) {
    if (directEventRecord(selected.message) === undefined) return [selected];
    // SAFETY: message_end receives the host's cloned canonical message, never listener-authored data.
    const message = selected.message as CanonicalMessage;
    return extensionMessages(message).map((projected) => ({ ...selected, message: projected }));
  },
  message_update(selected) {
    if (directEventRecord(selected.message) === undefined) return [selected];
    if (Value.Check(ASSISTANT_STREAM_SNAPSHOT_VALUE, selected.message)) {
      if (selected.kind === "reasoning" && selected.visibility === "provider_trace") return [];
      const message = canonicalStreamMessage(selected, selected.message);
      const partial = extensionStreamMessage(message);
      return [{
        ...selected,
        message: partial,
        assistantMessageEvent: extensionStreamUpdate(selected, message, partial),
      }];
    }
    const assistantEvent = directEventRecord(selected.assistantMessageEvent);
    if (
      assistantEvent?.visibility === "provider_trace"
      && (
        assistantEvent.type === "reasoning_started"
        || assistantEvent.type === "reasoning_delta"
        || assistantEvent.type === "reasoning_completed"
      )
    ) return [];
    // SAFETY: message_update receives the host's cloned canonical message, never listener-authored data.
    const message = selected.message as CanonicalMessage;
    const projected = extensionMessage(message);
    if (projected.role !== "assistant") {
      throw new TypeError("Assistant update projection produced a non-assistant message");
    }
    return [{
      ...selected,
      message: projected,
      assistantMessageEvent: extensionAssistantEventFromMessage(selected.assistantMessageEvent, projected),
    }];
  },
  tool_execution_start(selected) {
    return [projectedToolStart(selected)];
  },
  tool_execution_update(selected) {
    if (selected.phase === "running") return [];
    return [projectedToolUpdate(selected)];
  },
  tool_execution_end(selected) {
    return [projectedToolEnd(selected)];
  },
  before_agent_start(selected) {
    if (!Array.isArray(selected.images)) return [selected];
    // SAFETY: before_agent_start images come from the typed runtime event map before this projection.
    const images = selected.images as ImageBlock[];
    return [{ ...selected, images: extensionContent(images) }];
  },
  session_tree(selected) {
    if (directEventRecord(selected.summaryEntry) === undefined) return [selected];
    // SAFETY: session_tree owns the cloned summary entry supplied by the session manager.
    const summaryEntry = selected.summaryEntry as SessionEntry;
    return [{ ...selected, summaryEntry: extensionSessionEntry(summaryEntry) }];
  },
  session_compact(selected) {
    const projected = projectedCompactionEntry(selected);
    if (projected !== undefined) return [{ ...selected, compactionEntry: projected }];
    if (directEventRecord(selected.compactionEntry) === undefined) return [selected];
    // SAFETY: session_compact owns the cloned compaction entry supplied by the session manager.
    const compactionEntry = selected.compactionEntry as SessionEntry;
    return [{ ...selected, compactionEntry: extensionSessionEntry(compactionEntry) }];
  },
  session_compact_failed(selected) {
    const projected: DirectEventRecord = {
      reason: selected.reason,
      aborted: selected.aborted,
      willRetry: selected.willRetry,
      fromExtension: selected.fromExtension,
    };
    if (selected.category !== undefined) Object.assign(projected, { category: selected.category });
    if (selected.errorMessage !== undefined) Object.assign(projected, { errorMessage: selected.errorMessage });
    return [projected];
  },
} satisfies Partial<Record<RuntimeExtensionEvent, DirectEventProjector>>;

export function directDispatchEvents<T>(event: RuntimeExtensionEvent, value: T): unknown[] {
  const selected = directEventRecord(value);
  if (selected === undefined) return [value];
  switch (event) {
    case "agent_end": return EVENT_PROJECTORS.agent_end(selected);
    case "turn_end": return EVENT_PROJECTORS.turn_end(selected);
    case "message_start": return EVENT_PROJECTORS.message_start(selected);
    case "message_end": return EVENT_PROJECTORS.message_end(selected);
    case "message_update": return EVENT_PROJECTORS.message_update(selected);
    case "tool_execution_start": return EVENT_PROJECTORS.tool_execution_start(selected);
    case "tool_execution_update": return EVENT_PROJECTORS.tool_execution_update(selected);
    case "tool_execution_end": return EVENT_PROJECTORS.tool_execution_end(selected);
    case "before_agent_start": return EVENT_PROJECTORS.before_agent_start(selected);
    case "session_tree": return EVENT_PROJECTORS.session_tree(selected);
    case "session_compact": return EVENT_PROJECTORS.session_compact(selected);
    case "session_compact_failed": return EVENT_PROJECTORS.session_compact_failed(selected);
    default: return [value];
  }
}

export interface RuntimeRequesterSession {
  threadId: string;
  branch?: string;
  headless?: boolean;
  runId?: string;
  step?: number;
}

export function runtimeRequesterSession<T>(
  event: RuntimeExtensionEvent,
  value: T,
): RuntimeRequesterSession | undefined {
  const record = directEventRecord(value);
  if (record === undefined) return undefined;
  const threadId = event === "session_before_fork"
    ? record.targetThreadId ?? record.sourceThreadId
    : REQUESTER_THREAD_EVENTS.has(event) ? record.threadId : undefined;
  if (!Value.Check(STRING_VALUE, threadId)) return undefined;
  const branch = event === "session_before_fork" ? record.targetBranch : record.branch;
  const selected: RuntimeRequesterSession = { threadId };
  if (Value.Check(STRING_VALUE, branch)) selected.branch = branch;
  if (Value.Check(STRING_VALUE, record.runId)) selected.runId = record.runId;
  if (Value.Check(POSITIVE_INTEGER_VALUE, record.step)) selected.step = record.step;
  return selected;
}
