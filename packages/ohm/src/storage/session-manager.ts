import { optionalProperties } from "../core/optional-properties.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  SESSION_V4_VERSION,
  SESSION_V4_MAX_FILE_BYTES,
  SESSION_V4_MAX_RECORD_BYTES,
  SESSION_V4_PRIMARY_BRANCH_ID,
  applySessionV4CommitOwned,
  cloneSessionV4State,
  createSessionV4State,
  parseSessionV4Bytes,
  parseSessionV4Header,
  readSessionV4File,
  readSessionV4FileSync,
  type SessionV4BranchRuntimeState,
  type SessionV4Changes,
  type SessionV4Commit,
  type SessionV4ConversationNode,
  type SessionV4Header,
  type SessionV4Json,
  type SessionV4NodeMetadata,
  type SessionV4OperationState,
  type SessionV4Parent,
  type SessionV4QueueEntryState,
  type SessionV4ReducerState,
  type SessionV4State,
  type SessionV4ThinkingLevel,
  type SessionV4ToolEffectState,
} from "@ohm/kernel/session-v4";
import { getAgentDir, getSessionsDir } from "../config/paths.js";
import { errorCode } from "../core/errors.js";
import { isJsonObject, isJsonValue, type JsonObject } from "../core/json.js";
import type { AdapterError, CanonicalMessage, FinishReason, ImageBlock, NormalizedUsage, TextBlock } from "../core/types.js";
import {
  addCompleteNormalizedUsage,
  addNormalizedUsage,
  isNormalizedUsage,
} from "../core/usage.js";
import { filesystemPathIdentity, sameFilesystemPath } from "../utils/paths.js";
import {
  BOOLEAN_VALUE,
  FUNCTION_VALUE,
  NUMBER_VALUE,
  STRING_VALUE,
} from "../core/value-schemas.js";
import {
  CURRENT_SESSION_VERSION,
  type BashExecutionMessage,
  type BranchSummaryEntry,
  type BranchSummaryMessage,
  type CompactionEntry,
  type CompactionSummaryMessage,
  type CustomEntry,
  type CustomMessage,
  type CustomMessageEntry,
  type PluginSessionProvenance,
  type ModelChangeEntry,
  type NewSessionOptions,
  type PersistedSessionMessage,
  type SessionBranchQuery,
  type SessionContext,
  type SessionContextMessage,
  type SessionEntry,
  type SessionFileIssue,
  type SessionHeader,
  type SessionInfo,
  type SessionListProgress,
  type SessionMessageEntry,
  type SessionScanResult,
  type SessionTreeNode,
  type ThinkingLevelChangeEntry,
} from "./types.js";
import {
  selectSessionBranchEntries,
  validateSessionBranchQuery,
} from "./session-branch-query.js";
import { loadIndexedSessionInfos } from "./session-catalog-index.js";
import { Value } from "typebox/value";
import { SessionStorageJournal } from "./session-storage.js";
import { isSqliteSessionFile, SqliteSessionStorageBackend } from "./sqlite-session-storage.js";
import { acquireSessionWriterLeaseSync } from "./session-writer-lease.js";

const SESSION_READ_NONBLOCK = constants.O_NONBLOCK ?? 0;
const SESSION_READ_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const SESSION_DIRECTORY_SLUG_LENGTH = 80;
const CUSTOM_ENTRY_PLUGIN = "ohm.session.custom";
const CUSTOM_MESSAGE_PLUGIN = "ohm.session.custom-message";
const MESSAGE_CUSTOM_PLUGIN = "ohm.session.message-custom";
const BRANCH_SUMMARY_PLUGIN = "ohm.session.branch-summary";
const TOOLS_CHANGE_CUSTOM_TYPE = "ohm.session.tools-change";
const PRIVATE_SESSION_DIRECTORY_MODE = 0o700;
const ACTIVITY_FINISH_REASONS = [
  "stop", "tool_calls", "length", "context_limit", "content_filter", "refusal",
  "pause", "cancelled", "aborted", "error", "incomplete", "unknown",
] as const satisfies readonly FinishReason[];
const ACTIVITY_ERROR_CATEGORIES = [
  "authentication", "permission", "rate_limit", "invalid_request", "not_found", "overloaded",
  "network", "timeout", "protocol", "cancelled", "provider",
] as const satisfies readonly AdapterError["category"][];

export interface ActiveBranchUsage {
  usage: NormalizedUsage;
  /** Per-field reported lower bounds when one or more observations omit telemetry. */
  reportedUsage?: NormalizedUsage;
  /** False only when the branch has no request or metered-summary observations. Missing request telemetry still counts. */
  hasUsageObservations?: boolean;
  latestAssistantUsage?: NormalizedUsage;
}

/** @internal Lightweight metadata for one-to-many extension session projection. */
export interface SessionEntryProjectionMetadata {
  id: string;
  parentId: string | null;
  projectedEntryCount: number;
}

export interface SessionHistoryPageOptions {
  /** Fixed lineage tip. Omit to use the current active tip. */
  from?: string;
  before?: string;
  after?: string;
  edge?: "oldest";
  limit?: number;
  maxBytes?: number;
}

export interface SessionHistoryPage {
  entries: SessionEntry[];
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
}

export interface SessionHistorySearchOptions {
  /** Limit search to this lineage. Omit to search every stored branch. */
  from?: string;
  before?: string;
  after?: string;
  limit?: number;
  signal?: AbortSignal;
}

export interface SessionHistorySearchResult {
  matches: Array<{ id: string; preview: string }>;
  hasMore: boolean;
  cursor?: string;
}

function historyLimit(value: number | undefined, fallback: number, maximum: number): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) {
    throw new RangeError(`History limit must be between 1 and ${maximum}`);
  }
  return limit;
}

function entryPageRange(offset: number, limit: number, count: number) {
  // Native ordinal APIs historically use slice(offset, offset + limit), including
  // its fractional/NaN/infinite coercion. SQL receives only the resulting bounds.
  const start = Math.min(Math.trunc(offset) || 0, count);
  const end = Math.min(Math.trunc(offset + limit) || 0, count);
  return { offset: start, limit: Math.max(0, end - start) };
}

function historyText(entry: SessionEntry): string {
  if (entry.type === "compaction" || entry.type === "branch_summary") return entry.summary;
  if (entry.type === "custom_message") {
    if (!entry.display) return "";
    return Value.Check(STRING_VALUE, entry.content)
      ? entry.content
      : entry.content.flatMap((block) => block.type === "text" ? [block.text] : []).join(" ");
  }
  if (entry.type !== "message") return "";
  if (entry.message.role === "bashExecution") return `${entry.message.command}\n${entry.message.output}`;
  if (entry.message.role === "custom" && !entry.message.display) return "";
  return messageText(entry.message);
}

export const MAX_SESSION_RECORD_BYTES = SESSION_V4_MAX_RECORD_BYTES;
export const MAX_SESSION_FILE_BYTES = SESSION_V4_MAX_FILE_BYTES;
export const MAX_SESSION_ENTRY_COUNT = 100_000;

interface LoadedSessionState {
  state: SessionV4State;
  committedBytes: number;
}

interface SessionFileHeader {
  header: SessionV4Header;
  modified: number;
}

interface SessionContextMessagePage {
  messages: SessionContextMessage[];
  totalMessages: number;
}

function expandedPath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return path;
}

function absolutePath(path: string): string {
  return resolve(expandedPath(path));
}

function agentDirectory(): string {
  return getAgentDir();
}

function preparePrivateSessionDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: PRIVATE_SESSION_DIRECTORY_MODE });
  if (process.platform !== "win32") chmodSync(path, PRIVATE_SESSION_DIRECTORY_MODE);
}

function sessionsDirectory(): string {
  return getSessionsDir();
}

function uuidV7(): string {
  const time = BigInt(Date.now()).toString(16).padStart(12, "0").slice(-12);
  const random = randomBytes(10).toString("hex");
  const variant = (8 | (Number.parseInt(random[3] ?? "0", 16) & 3)).toString(16);
  return `${time.slice(0, 8)}-${time.slice(8)}-7${random.slice(0, 3)}-${variant}${random.slice(4, 7)}-${random.slice(7, 19)}`;
}

function newSessionId(): string {
  return uuidV7();
}

export function assertValidSessionId(id: string): void {
  if (
    id.length > 256
    || !/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u.test(id)
  ) {
    throw new Error(
      "Session id must use at most 256 letters, numbers, dots, underscores, and hyphens, with a letter or number at each end",
    );
  }
}

function shortEntryId(index: { has(id: string): boolean }): string {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = randomUUID().slice(0, 8);
    if (!index.has(candidate)) return candidate;
  }
  return randomUUID();
}

function commitId(): string {
  return `commit-${randomUUID()}`;
}

function asJson<Input>(value: Input): SessionV4Json {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Session value must be JSON-serializable");
  const parsed: unknown = JSON.parse(serialized);
  if (!isJsonValue(parsed)) throw new Error("Session value must contain JSON data");
  return parsed;
}

function asRecord(value: SessionV4Json): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined;
}

function stringField(value: SessionV4Json | undefined): string | undefined {
  return Value.Check(STRING_VALUE, value) ? value : undefined;
}

function booleanField(value: SessionV4Json | undefined): boolean | undefined {
  return Value.Check(BOOLEAN_VALUE, value) ? value : undefined;
}

function numberField(value: SessionV4Json | undefined): number | undefined {
  return Value.Check(NUMBER_VALUE, value) ? value : undefined;
}

function extensionSessionProvenance(
  value: SessionV4Json | undefined,
): PluginSessionProvenance | undefined {
  const selected = value === undefined ? undefined : asRecord(value);
  if (selected === undefined || selected.schemaVersion !== 1) return undefined;
  const extensionId = stringField(selected.extensionId);
  const sourceSha256 = stringField(selected.sourceSha256);
  const packageVersion = stringField(selected.packageVersion);
  const packageContentSha256 = stringField(selected.packageContentSha256);
  const manifestSha256 = stringField(selected.manifestSha256);
  const sha256Pattern = /^[a-f0-9]{64}$/u;
  if (
    extensionId === undefined
    || extensionId === ""
    || extensionId.includes("\0")
    || sourceSha256 === undefined
    || !sha256Pattern.test(sourceSha256)
    || (selected.packageVersion !== undefined && packageVersion === undefined)
    || (packageVersion !== undefined && (packageVersion === "" || packageVersion.includes("\0")))
    || (selected.packageContentSha256 !== undefined && packageContentSha256 === undefined)
    || (packageContentSha256 !== undefined && !sha256Pattern.test(packageContentSha256))
    || (selected.manifestSha256 !== undefined && manifestSha256 === undefined)
    || (manifestSha256 !== undefined && !sha256Pattern.test(manifestSha256))
  ) return undefined;
  return {
    schemaVersion: 1,
    extensionId,
    sourceSha256,
    ...optionalProperties(packageVersion === undefined ? undefined : { packageVersion }),
    ...optionalProperties(packageContentSha256 === undefined ? undefined : { packageContentSha256 }),
    ...optionalProperties(manifestSha256 === undefined ? undefined : { manifestSha256 }),
  };
}

function thinkingLevel(value: string): SessionV4ThinkingLevel {
  const levels: readonly SessionV4ThinkingLevel[] = [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ];
  const selected = levels.find((level) => level === value);
  if (selected === undefined) {
    throw new Error(`Invalid thinking level: ${value}`);
  }
  return selected;
}

function messageRole(message: PersistedSessionMessage): string {
  return message.role;
}

function isTextImageBlock<Input>(value: Input): value is Input & (TextBlock | ImageBlock) {
  if (!isJsonObject(value)) return false;
  if (value.type === "text") {
    return Value.Check(STRING_VALUE, value.text)
      && (value.textSignature === undefined || Value.Check(STRING_VALUE, value.textSignature));
  }
  if (value.type !== "image") return false;
  return Value.Check(STRING_VALUE, value.mediaType)
    && (value.data === undefined || Value.Check(STRING_VALUE, value.data))
    && (value.url === undefined || Value.Check(STRING_VALUE, value.url));
}

function isStringArray<Input>(value: Input): value is Input & string[] {
  return Array.isArray(value) && value.every((entry) => Value.Check(STRING_VALUE, entry));
}

function isCanonicalContentBlock<Input>(
  value: Input,
): value is Input & CanonicalMessage["content"][number] {
  if (!isJsonObject(value)) return false;
  switch (value.type) {
    case "text":
      return Value.Check(STRING_VALUE, value.text)
        && (value.textSignature === undefined || Value.Check(STRING_VALUE, value.textSignature));
    case "thinking":
      return Value.Check(STRING_VALUE, value.thinking)
        && (value.thinkingSignature === undefined || Value.Check(STRING_VALUE, value.thinkingSignature))
        && (value.redacted === undefined || Value.Check(BOOLEAN_VALUE, value.redacted))
        && (value.visibility === undefined || value.visibility === "summary" || value.visibility === "provider_trace");
    case "image":
      return isTextImageBlock(value);
    case "tool_call":
      return Value.Check(STRING_VALUE, value.callId)
        && Value.Check(STRING_VALUE, value.name)
        && isJsonValue(value.arguments)
        && (value.rawArguments === undefined || Value.Check(STRING_VALUE, value.rawArguments))
        && (value.thoughtSignature === undefined || Value.Check(STRING_VALUE, value.thoughtSignature));
    case "tool_result":
      return Value.Check(STRING_VALUE, value.callId)
        && Value.Check(STRING_VALUE, value.name)
        && Value.Check(STRING_VALUE, value.content)
        && Value.Check(BOOLEAN_VALUE, value.isError)
        && (value.contentBlocks === undefined || (
          Array.isArray(value.contentBlocks) && value.contentBlocks.every(isTextImageBlock)
        ))
        && (value.status === undefined || value.status === "success" || value.status === "warning" || value.status === "error")
        && (value.summary === undefined || Value.Check(STRING_VALUE, value.summary))
        && (value.nextActions === undefined || isStringArray(value.nextActions))
        && (value.images === undefined || (
          Array.isArray(value.images) && value.images.every((entry) => isTextImageBlock(entry) && entry.type === "image")
        ))
        && (value.artifactIds === undefined || isStringArray(value.artifactIds))
        && (value.metadata === undefined || isJsonValue(value.metadata))
        && (value.usage === undefined || isNormalizedUsage(value.usage))
        && (value.addedToolNames === undefined || isStringArray(value.addedToolNames));
    case "provider_opaque":
      return Value.Check(STRING_VALUE, value.provider)
        && Value.Check(STRING_VALUE, value.mediaType)
        && isJsonValue(value.value)
        && (value.serialized === undefined || Value.Check(STRING_VALUE, value.serialized));
    default:
      return false;
  }
}

function isBashExecutionMessage<Input>(value: Input): value is Input & BashExecutionMessage {
  if (!isJsonObject(value) || value.role !== "bashExecution") return false;
  return Value.Check(STRING_VALUE, value.command)
    && Value.Check(STRING_VALUE, value.output)
    && Value.Check(BOOLEAN_VALUE, value.cancelled)
    && Value.Check(BOOLEAN_VALUE, value.truncated)
    && Value.Check(NUMBER_VALUE, value.timestamp)
    && (value.exitCode === undefined || Value.Check(NUMBER_VALUE, value.exitCode))
    && (value.excludeFromContext === undefined || Value.Check(BOOLEAN_VALUE, value.excludeFromContext))
    && (value.fullOutputPath === undefined || Value.Check(STRING_VALUE, value.fullOutputPath))
    && (value.isError === undefined || Value.Check(BOOLEAN_VALUE, value.isError))
    && (value.signal === undefined || Value.Check(STRING_VALUE, value.signal))
    && (value.timedOut === undefined || Value.Check(BOOLEAN_VALUE, value.timedOut));
}

function isCustomMessage<Input>(value: Input): value is Input & CustomMessage {
  if (!isJsonObject(value) || value.role !== "custom") return false;
  return Value.Check(STRING_VALUE, value.customType)
    && Value.Check(BOOLEAN_VALUE, value.display)
    && Value.Check(NUMBER_VALUE, value.timestamp)
    && (
      Value.Check(STRING_VALUE, value.content)
      || (Array.isArray(value.content) && value.content.every(isTextImageBlock))
    )
    && (value.provenance === undefined || extensionSessionProvenance(value.provenance) !== undefined);
}

function isStoredCanonicalMessage<Input>(value: Input): value is Input & CanonicalMessage {
  if (!isJsonObject(value)) return false;
  return Value.Check(STRING_VALUE, value.id)
    && Value.Check(STRING_VALUE, value.createdAt)
    && Value.Check(STRING_VALUE, value.role)
    && isCanonicalRole(value.role)
    && Array.isArray(value.content)
    && value.content.every(isCanonicalContentBlock);
}

function persistedSessionMessage<Input>(value: Input): PersistedSessionMessage | undefined {
  if (isBashExecutionMessage(value) || isCustomMessage(value) || isStoredCanonicalMessage(value)) {
    return structuredClone(value);
  }
  return undefined;
}

function customMessageContent(
  value: SessionV4Json | undefined,
): string | (TextBlock | ImageBlock)[] {
  if (Value.Check(STRING_VALUE, value)) return value;
  if (Array.isArray(value) && value.every(isTextImageBlock)) return structuredClone(value);
  return "";
}

function projectedMessageEntryCount(value: SessionV4Json, fallbackRole?: string): number {
  const stored = asRecord(value);
  const role = stringField(stored?.role) ?? fallbackRole;
  const content = stored?.content ?? (Array.isArray(value) ? value : undefined);
  if (role !== "tool" || !Array.isArray(content)) return 1;
  const count = content.filter((block) => stringField(asRecord(block)?.type) === "tool_result").length;
  return Math.max(1, count);
}

function projectedSessionEntryCount(node: SessionV4ConversationNode): number {
  if (node.nodeType === "message") return projectedMessageEntryCount(node.content, node.role);
  if (node.nodeType === "extension_context" && node.extensionId === MESSAGE_CUSTOM_PLUGIN) {
    return projectedMessageEntryCount(node.context);
  }
  return 1;
}

function isCanonicalRole(role: string): role is CanonicalMessage["role"] {
  return role === "system" || role === "user" || role === "assistant" || role === "tool";
}

export function sessionEntryToV4Node(
  entry: SessionEntry,
  cwd: string,
  operationId?: string,
): SessionV4ConversationNode {
  const base = {
    id: entry.id,
    parentId: entry.parentId,
    createdAt: entry.timestamp,
    ...optionalProperties(operationId === undefined ? undefined : { operationId }),
  };
  switch (entry.type) {
    case "message": {
      const role = messageRole(entry.message);
      if (isCanonicalRole(role)) {
        return {
          ...base,
          nodeType: "message",
          role,
          content: asJson(entry.message),
        };
      }
      if (entry.message.role === "bashExecution") {
        const execution = entry.message;
        return {
          ...base,
          nodeType: "shell",
          command: execution.command === "" ? "<empty>" : execution.command,
          cwd,
          result: asJson(execution),
        };
      }
      return {
        ...base,
        nodeType: "extension_context",
        extensionId: MESSAGE_CUSTOM_PLUGIN,
        context: asJson(entry.message),
      };
    }
    case "thinking_level_change":
      return {
        ...base,
        nodeType: "thinking_change",
        level: thinkingLevel(entry.thinkingLevel),
      };
    case "model_change":
      return {
        ...base,
        nodeType: "model_change",
        provider: entry.provider,
        model: entry.modelId,
      };
    case "compaction":
      return {
        ...base,
        nodeType: "compaction",
        summary: asJson({
          summary: entry.summary,
          firstKeptEntryId: entry.firstKeptEntryId,
          tokensBefore: entry.tokensBefore,
          ...optionalProperties(entry.details === undefined ? undefined : { details: entry.details }),
          ...optionalProperties(entry.fromHook === undefined ? undefined : { fromHook: entry.fromHook }),
          ...optionalProperties(entry.usage === undefined ? undefined : { usage: entry.usage }),
        }),
        retainedNodeIds: [entry.firstKeptEntryId],
      };
    case "branch_summary":
      return {
        ...base,
        nodeType: "extension_context",
        extensionId: BRANCH_SUMMARY_PLUGIN,
        context: asJson({
          fromId: entry.fromId,
          summary: entry.summary,
          ...optionalProperties(entry.details === undefined ? undefined : { details: entry.details }),
          ...optionalProperties(entry.fromHook === undefined ? undefined : { fromHook: entry.fromHook }),
          ...optionalProperties(entry.usage === undefined ? undefined : { usage: entry.usage }),
        }),
      };
    case "custom":
      if (entry.customType === TOOLS_CHANGE_CUSTOM_TYPE) {
        const data = entry.data === undefined ? undefined : asRecord(asJson(entry.data));
        const tools = data?.tools;
        const toolsetFingerprint = stringField(data?.toolsetFingerprint);
        const toolNames = isStringArray(tools) ? tools : undefined;
        if (toolNames === undefined || toolsetFingerprint === undefined) {
          throw new Error("A projected tools change must contain tool names and a toolset fingerprint");
        }
        return {
          ...base,
          nodeType: "tools_change",
          tools: structuredClone(toolNames),
          toolsetFingerprint,
        };
      }
      return {
        ...base,
        nodeType: "extension_state",
        extensionId: CUSTOM_ENTRY_PLUGIN,
        state: asJson({
          customType: entry.customType,
          ...optionalProperties(entry.data === undefined ? undefined : { data: entry.data }),
          ...optionalProperties(entry.provenance === undefined ? undefined : { provenance: entry.provenance }),
        }),
      };
    case "custom_message":
      return {
        ...base,
        nodeType: "extension_context",
        extensionId: CUSTOM_MESSAGE_PLUGIN,
        context: asJson({
          customType: entry.customType,
          content: entry.content,
          display: entry.display,
          ...optionalProperties(entry.details === undefined ? undefined : { details: entry.details }),
          ...optionalProperties(entry.provenance === undefined ? undefined : { provenance: entry.provenance }),
        }),
      };
    case "label":
    case "session_info":
      throw new Error(`${entry.type} is session state, not a conversation node`);
  }
}

function fallbackCanonicalMessage(node: Extract<SessionV4ConversationNode, { nodeType: "message" }>): CanonicalMessage {
  const content = Array.isArray(node.content) && node.content.every(isCanonicalContentBlock)
    ? structuredClone(node.content)
    : [{ type: "text" as const, text: stringField(node.content) ?? JSON.stringify(node.content) }];
  return {
    id: node.id,
    role: node.role,
    content,
    createdAt: node.createdAt,
  };
}

function projectedEntry(node: SessionV4ConversationNode): SessionEntry {
  const base = {
    id: node.id,
    parentId: node.parentId,
    timestamp: node.createdAt,
  };
  switch (node.nodeType) {
    case "message": {
      const message = persistedSessionMessage(node.content) ?? fallbackCanonicalMessage(node);
      return { ...base, type: "message", message };
    }
    case "model_change":
      return {
        ...base,
        type: "model_change",
        provider: node.provider,
        modelId: node.model,
      };
    case "thinking_change":
      return {
        ...base,
        type: "thinking_level_change",
        thinkingLevel: node.level,
      };
    case "tools_change":
      return {
        ...base,
        type: "custom",
        customType: TOOLS_CHANGE_CUSTOM_TYPE,
        data: {
          tools: structuredClone(node.tools),
          toolsetFingerprint: node.toolsetFingerprint,
        },
      };
    case "compaction": {
      const summary = asRecord(node.summary);
      const fromHook = booleanField(summary?.fromHook);
      const usage = boundedStoredUsage(summary?.usage);
      return {
        ...base,
        type: "compaction",
        summary: stringField(summary?.summary) ?? stringField(node.summary) ?? JSON.stringify(node.summary),
        firstKeptEntryId: stringField(summary?.firstKeptEntryId)
          ?? node.retainedNodeIds[0]
          ?? node.parentId
          ?? node.id,
        tokensBefore: numberField(summary?.tokensBefore) ?? 0,
        ...optionalProperties(summary?.details === undefined ? undefined : { details: structuredClone(summary.details) }),
        ...optionalProperties(fromHook === undefined ? undefined : { fromHook }),
        ...optionalProperties(usage === undefined ? undefined : { usage }),
      };
    }
    case "branch_summary": {
      const summary = asRecord(node.summary);
      const fromHook = booleanField(summary?.fromHook);
      const usage = projectedStoredUsage(summary?.usage);
      return {
        ...base,
        type: "branch_summary",
        fromId: node.fromNodeId,
        summary: stringField(summary?.summary) ?? stringField(node.summary) ?? JSON.stringify(node.summary),
        ...optionalProperties(summary?.details === undefined ? undefined : { details: structuredClone(summary.details) }),
        ...optionalProperties(fromHook === undefined ? undefined : { fromHook }),
        ...optionalProperties(usage === undefined ? undefined : { usage }),
      };
    }
    case "extension_context": {
      const value = asRecord(node.context);
      if (node.extensionId === CUSTOM_MESSAGE_PLUGIN && value !== undefined) {
        const provenance = extensionSessionProvenance(value.provenance);
        return {
          ...base,
          type: "custom_message",
          customType: stringField(value.customType) ?? node.extensionId,
          content: customMessageContent(value.content),
          display: booleanField(value.display) ?? false,
          ...optionalProperties(value.details === undefined ? undefined : { details: structuredClone(value.details) }),
          ...optionalProperties(provenance === undefined ? undefined : { provenance }),
        };
      }
      if (node.extensionId === BRANCH_SUMMARY_PLUGIN && value !== undefined) {
        const fromHook = booleanField(value.fromHook);
        const usage = projectedStoredUsage(value.usage);
        return {
          ...base,
          type: "branch_summary",
          fromId: stringField(value.fromId) ?? node.parentId ?? "root",
          summary: stringField(value.summary) ?? "",
          ...optionalProperties(value.details === undefined ? undefined : { details: structuredClone(value.details) }),
          ...optionalProperties(fromHook === undefined ? undefined : { fromHook }),
          ...optionalProperties(usage === undefined ? undefined : { usage }),
        };
      }
      if (node.extensionId === MESSAGE_CUSTOM_PLUGIN && value !== undefined) {
        const message = persistedSessionMessage(value);
        if (message !== undefined) {
          return {
            ...base,
            type: "message",
            message,
          };
        }
      }
      return {
        ...base,
        type: "custom",
        customType: node.extensionId,
        data: structuredClone(node.context),
      };
    }
    case "extension_state": {
      const value = asRecord(node.state);
      if (node.extensionId === CUSTOM_ENTRY_PLUGIN && value !== undefined) {
        const provenance = extensionSessionProvenance(value.provenance);
        return {
          ...base,
          type: "custom",
          customType: stringField(value.customType) ?? node.extensionId,
          ...optionalProperties(value.data === undefined ? undefined : { data: structuredClone(value.data) }),
          ...optionalProperties(provenance === undefined ? undefined : { provenance }),
        };
      }
      return {
        ...base,
        type: "custom",
        customType: node.extensionId,
        data: structuredClone(node.state),
      };
    }
    case "shell": {
      const value = asRecord(node.result);
      const message = persistedSessionMessage(value);
      if (message?.role === "bashExecution") {
        return {
          ...base,
          type: "message",
          message,
        };
      }
      return {
        ...base,
        type: "custom",
        customType: "ohm.session.shell",
        data: {
          command: node.command,
          cwd: node.cwd,
          result: structuredClone(node.result),
        },
      };
    }
  }
}

function boundedStoredUsage<Input>(value: Input): NormalizedUsage | undefined {
  if (!isNormalizedUsage(value)) return undefined;
  return {
    ...optionalProperties(value.inputTokens === undefined ? undefined : { inputTokens: value.inputTokens }),
    ...optionalProperties(value.outputTokens === undefined ? undefined : { outputTokens: value.outputTokens }),
    ...optionalProperties(value.totalTokens === undefined ? undefined : { totalTokens: value.totalTokens }),
    ...optionalProperties(value.cacheReadTokens === undefined ? undefined : { cacheReadTokens: value.cacheReadTokens }),
    ...optionalProperties(value.cacheWriteTokens === undefined ? undefined : { cacheWriteTokens: value.cacheWriteTokens }),
    ...optionalProperties(value.cacheWrite1hTokens === undefined ? undefined : { cacheWrite1hTokens: value.cacheWrite1hTokens }),
    ...optionalProperties(value.reasoningTokens === undefined ? undefined : { reasoningTokens: value.reasoningTokens }),
    ...optionalProperties(value.serverToolCalls === undefined ? undefined : { serverToolCalls: value.serverToolCalls }),
    ...optionalProperties(value.cost === undefined ? undefined : { cost: structuredClone(value.cost) }),
    ...optionalProperties(value.durationMs === undefined ? undefined : { durationMs: value.durationMs }),
  };
}

function projectedStoredUsage<Input>(value: Input): NormalizedUsage | undefined {
  if (!isNormalizedUsage(value)) return undefined;
  return structuredClone(value);
}

function nodeUsage(node: SessionV4ConversationNode): {
  kind: "assistant" | "summary" | "tool";
  meteredWithoutUsage?: boolean;
  stopReason?: unknown;
  usage?: NormalizedUsage;
} | undefined {
  if (node.nodeType === "message") {
    const message = asRecord(node.content);
    const usage = boundedStoredUsage(message?.usage);
    const role = stringField(message?.role) ?? node.role;
    if (role !== "assistant" && (role !== "tool" || usage === undefined)) return undefined;
    return {
      kind: role,
      ...optionalProperties(message?.stopReason === undefined ? undefined : { stopReason: message.stopReason }),
      ...optionalProperties(usage === undefined ? undefined : { usage }),
    };
  }
  if (node.nodeType === "compaction" || node.nodeType === "branch_summary") {
    const summary = asRecord(node.summary);
    const usage = boundedStoredUsage(summary?.usage);
    return {
      kind: "summary",
      ...optionalProperties(summary?.fromHook === true && usage === undefined ? { meteredWithoutUsage: false } : undefined),
      ...optionalProperties(usage === undefined ? undefined : { usage }),
    };
  }
  if (node.nodeType === "extension_context" && node.extensionId === BRANCH_SUMMARY_PLUGIN) {
    const summary = asRecord(node.context);
    const usage = boundedStoredUsage(summary?.usage);
    return {
      kind: "summary",
      ...optionalProperties(summary?.fromHook === true && usage === undefined ? { meteredWithoutUsage: false } : undefined),
      ...optionalProperties(usage === undefined ? undefined : { usage }),
    };
  }
  return undefined;
}

function messageText(message: PersistedSessionMessage): string {
  if (message.role === "bashExecution") return "";
  const content = message.content;
  if (Value.Check(STRING_VALUE, content)) return content;
  return content
    .flatMap((block) => block.type === "text" ? [block.text] : [])
    .join(" ");
}

function isConversationalMessage(message: PersistedSessionMessage): boolean {
  const role = messageRole(message);
  return role === "user" || role === "assistant";
}

function messageActivity(entry: SessionMessageEntry): number | undefined {
  if (!isConversationalMessage(entry.message)) return undefined;
  const numeric = entry.message.timestamp;
  if (Value.Check(NUMBER_VALUE, numeric)) return numeric;
  const parsed = new Date(entry.timestamp).getTime();
  return Number.isNaN(parsed) ? undefined : parsed;
}

function isSystemMessageEntry(
  entry: SessionEntry,
): entry is SessionMessageEntry & { message: CanonicalMessage } {
  return entry.type === "message" && messageRole(entry.message) === "system";
}

function isInstructionMessageEntry(entry: SessionEntry): boolean {
  return isSystemMessageEntry(entry) && entry.message.purpose === "instructions";
}

function pathToLeaf(
  entries: SessionEntry[],
  leafId?: string | null,
  suppliedIndex?: Map<string, SessionEntry>,
): SessionEntry[] {
  if (leafId === null) return [];
  const index = suppliedIndex ?? new Map(entries.map((entry) => [entry.id, entry]));
  let current = leafId === undefined ? entries.at(-1) : index.get(leafId);
  if (current === undefined) current = entries.at(-1);
  if (current === undefined) return [];

  const reversed: SessionEntry[] = [];
  const visited = new Set<string>();
  while (current !== undefined && !visited.has(current.id)) {
    visited.add(current.id);
    reversed.push(current);
    current = current.parentId === null ? undefined : index.get(current.parentId);
  }
  return reversed.reverse();
}

export function getLatestCompactionEntry(entries: SessionEntry[]): CompactionEntry | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type === "compaction") return entry;
  }
  return null;
}

export function buildContextEntries(
  entries: SessionEntry[],
  leafId?: string | null,
  suppliedIndex?: Map<string, SessionEntry>,
): SessionEntry[] {
  const path = pathToLeaf(entries, leafId, suppliedIndex);
  const compaction = getLatestCompactionEntry(path);
  if (compaction === null) return path;
  const compactionIndex = path.findIndex((entry) => entry.id === compaction.id);
  if (compactionIndex < 0) return path;

  const beforeCompaction = path.slice(0, compactionIndex);
  const latestInstructionId = beforeCompaction.findLast(isInstructionMessageEntry)?.id;
  const systemEntries = beforeCompaction.filter((entry) =>
    isSystemMessageEntry(entry)
    && (!isInstructionMessageEntry(entry) || entry.id === latestInstructionId));
  const result: SessionEntry[] = [...systemEntries, compaction];
  let keep = false;
  for (let index = 0; index < compactionIndex; index += 1) {
    const entry = path[index];
    if (entry === undefined) continue;
    if (entry.id === compaction.firstKeptEntryId) keep = true;
    if (keep && entry.type !== "compaction" && !isSystemMessageEntry(entry)) result.push(entry);
  }
  result.push(...path.slice(compactionIndex + 1));
  return result;
}

function customContextMessage(entry: CustomMessageEntry): CustomMessage {
  const base: CustomMessage = {
    role: "custom",
    customType: entry.customType,
    content: entry.content ?? [],
    display: entry.display,
    timestamp: new Date(entry.timestamp).getTime(),
    ...optionalProperties(entry.provenance === undefined ? undefined : { provenance: structuredClone(entry.provenance) }),
  };
  return entry.details === undefined ? base : { ...base, details: entry.details };
}

export function sessionEntryToContextMessages(entry: SessionEntry): SessionContextMessage[] {
  if (entry.type === "message") {
    const message = entry.message;
    const role = messageRole(message);
    const stored = asRecord(asJson(message));
    if (["user", "assistant", "tool", "toolResult"].includes(role) && stored?.content == null) {
      const normalized = persistedSessionMessage({ ...stored, content: [] });
      if (normalized !== undefined) return [normalized];
    }
    return [message];
  }
  if (entry.type === "custom_message") return [customContextMessage(entry)];
  if (entry.type === "branch_summary" && entry.summary !== "") {
    const message: BranchSummaryMessage = {
      role: "branchSummary",
      summary: entry.summary,
      fromId: entry.fromId,
      timestamp: new Date(entry.timestamp).getTime(),
    };
    return [message];
  }
  if (entry.type === "compaction") {
    const message: CompactionSummaryMessage = {
      role: "compactionSummary",
      tokensBefore: entry.tokensBefore,
      summary: entry.summary,
      timestamp: new Date(entry.timestamp).getTime(),
      ...optionalProperties(entry.usage === undefined ? undefined : { usage: structuredClone(entry.usage) }),
    };
    return [message];
  }
  return [];
}

function contextSettings(path: SessionEntry[]): Pick<SessionContext, "thinkingLevel" | "model"> {
  let selectedThinkingLevel = "off";
  let model: SessionContext["model"] = null;
  for (const entry of path) {
    if (entry.type === "thinking_level_change") selectedThinkingLevel = entry.thinkingLevel;
    else if (entry.type === "model_change") model = { provider: entry.provider, modelId: entry.modelId };
  }
  return { thinkingLevel: selectedThinkingLevel, model };
}

export function buildSessionContext(
  entries: SessionEntry[],
  leafId?: string | null,
  suppliedIndex?: Map<string, SessionEntry>,
): SessionContext {
  const settings = contextSettings(pathToLeaf(entries, leafId, suppliedIndex));
  return {
    messages: buildContextEntries(entries, leafId, suppliedIndex).flatMap(sessionEntryToContextMessages),
    thinkingLevel: settings.thinkingLevel,
    model: settings.model,
  };
}

function defaultSessionDirPath(cwd: string, agentDir = agentDirectory()): string {
  const normalized = filesystemPathIdentity(cwd);
  const flattened = normalized
    .replace(/^[/\\]+/u, "")
    .replaceAll(/[/\\:]+/gu, "-")
    .replaceAll(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  const slug = (flattened || "workspace").slice(-SESSION_DIRECTORY_SLUG_LENGTH);
  const identity = createHash("sha256").update(normalized, "utf8").digest("hex");
  const safe = `--${slug}-${identity}--`;
  return join(absolutePath(agentDir), "sessions", safe);
}

export function getDefaultSessionDir(cwd: string, agentDir = agentDirectory()): string {
  const root = absolutePath(agentDir);
  preparePrivateSessionDirectory(root);
  const path = defaultSessionDirPath(cwd, root);
  preparePrivateSessionDirectory(dirname(path));
  preparePrivateSessionDirectory(path);
  return path;
}

function stateFromFile(
  path: string,
  followSymlinks = true,
): LoadedSessionState {
  if (isSqliteSessionFile(path, followSymlinks)) {
    const source = followSymlinks ? realpathSync(path) : path;
    const journal = new SessionStorageJournal(new SqliteSessionStorageBackend(dirname(source)).open(source, { readOnly: true }));
    try {
      // This private replay is closed below before its exclusively owned state escapes.
      const state = journal.detachReadOnlyState();
      if (state.nodes.size > MAX_SESSION_ENTRY_COUNT) throw new Error(`Session entry count exceeds the limit of ${MAX_SESSION_ENTRY_COUNT}: ${path}`);
      return { state, committedBytes: journal.bytes };
    } finally { journal.close(); }
  }
  const result = readSessionV4FileSync(path, { followSymlinks });
  if (result.state.nodes.size > MAX_SESSION_ENTRY_COUNT) {
    throw new Error(`Session entry count exceeds the limit of ${MAX_SESSION_ENTRY_COUNT}: ${path}`);
  }
  return { state: result.state, committedBytes: result.committedBytes };
}

function headerFromFile(path: string): SessionFileHeader {
  if (isSqliteSessionFile(path, false)) {
    const storage = new SqliteSessionStorageBackend(dirname(path)).open(path, { readOnly: true });
    try {
      const details = statSync(path);
      let modified = details.mtimeMs;
      try { modified = Math.max(modified, statSync(`${path}-wal`).mtimeMs); }
      catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
      return { header: storage.read().header, modified };
    } finally { storage.close(); }
  }
  const fd = openSync(
    path,
    constants.O_RDONLY | SESSION_READ_NONBLOCK | SESSION_READ_NOFOLLOW,
  );
  try {
    const details = fstatSync(fd);
    if (!details.isFile()) throw new Error(`Session path is not a regular file: ${path}`);
    if (details.size > MAX_SESSION_FILE_BYTES) {
      throw new Error(`Session file exceeds the limit of ${MAX_SESSION_FILE_BYTES}: ${path}`);
    }
    const chunks: Buffer[] = [];
    let length = 0;
    while (length <= MAX_SESSION_RECORD_BYTES) {
      const chunk = Buffer.allocUnsafe(Math.min(4_096, MAX_SESSION_RECORD_BYTES + 1 - length));
      const count = readSync(fd, chunk, 0, chunk.length, length);
      if (count === 0) throw new Error(`Session header is not LF-terminated: ${path}`);
      const selected = chunk.subarray(0, count);
      const newline = selected.indexOf(0x0a);
      if (newline >= 0) {
        chunks.push(selected.subarray(0, newline));
        const line = Buffer.concat(chunks).toString("utf8");
        const parsed: unknown = JSON.parse(line);
        return { header: parseSessionV4Header(parsed), modified: details.mtimeMs };
      }
      chunks.push(selected);
      length += count;
    }
    throw new Error(`Session header exceeds the limit of ${MAX_SESSION_RECORD_BYTES}: ${path}`);
  } finally {
    closeSync(fd);
  }
}

function projectedHeader(header: SessionV4Header): SessionHeader {
  return {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: header.sessionId,
    timestamp: header.createdAt,
    cwd: header.cwd,
    ...optionalProperties(header.parent === undefined ? undefined : { parentSession: header.parent.sessionId }),
  };
}

function parentFromReference(
  reference: string | undefined,
  childId: string,
): SessionV4Parent | undefined {
  if (reference === undefined) return undefined;
  let sessionId = reference;
  const candidate = absolutePath(reference);
  if (existsSync(candidate)) {
    sessionId = stateFromFile(candidate).state.header.sessionId;
  }
  if (sessionId === childId) throw new Error("A session cannot be its own parent");
  return { sessionId, purpose: "linked" };
}

function createHeader(
  id: string,
  timestamp: string,
  cwd: string,
  parent: SessionV4Parent | undefined,
): SessionV4Header {
  return {
    record: "session",
    version: SESSION_V4_VERSION,
    sessionId: id,
    createdAt: timestamp,
    workspace: cwd,
    cwd,
    ...optionalProperties(parent === undefined ? undefined : { parent }),
  };
}

function comparePath(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameCwd(candidate: string | undefined, cwd: string): boolean {
  return candidate !== undefined && candidate !== "" && sameFilesystemPath(candidate, cwd);
}

class LegacySessionConflictError extends Error {}

function includesJournal(source: SessionV4State, copy: SessionV4State): boolean {
  return isDeepStrictEqual(copy.header, source.header)
    && [...source.commits.values()].every((commit) => isDeepStrictEqual(copy.commits.get(commit.commitId), commit));
}

/** Hide a legacy source only after proving that its complete committed prefix survives. */
function coalesceLegacyCopies(scanned: SessionScanResult): SessionScanResult {
  const byId = new Map<string, SessionInfo[]>();
  for (const session of scanned.sessions) {
    const group = byId.get(session.id) ?? [];
    group.push(session);
    byId.set(session.id, group);
  }
  const hidden = new Set<string>();
  for (const group of byId.values()) {
    if (group.length < 2) continue;
    try {
      const saved = group.filter((session) => isSqliteSessionFile(session.path, false));
      const legacy = group.filter((session) => !saved.includes(session));
      for (const source of legacy) {
        const sourceState = stateFromFile(source.path, false).state;
        if (saved.some((copy) => includesJournal(sourceState, stateFromFile(copy.path, false).state))) hidden.add(source.path);
        else if (saved.length > 0) scanned.invalid.push({ path: source.path, error: "Legacy session conflicts with an existing SQLite session; both copies remain visible" });
      }
    } catch (error) {
      // Concurrent file changes cannot authorize hiding any unverified source.
      for (const session of group) hidden.delete(session.path);
      scanned.invalid.push({ path: group[0]!.path, error: errorText(error) });
    }
  }
  return { sessions: scanned.sessions.filter((session) => !hidden.has(session.path)), invalid: scanned.invalid };
}

export function findMostRecentSession(sessionDir: string, cwd?: string): string | null {
  for (const candidate of recentSessionCandidates(sessionDir, cwd)) {
    try {
      stateFromFile(candidate.path, false);
      return candidate.path;
    } catch {}
  }
  return null;
}

function recentSessionCandidates(sessionDir: string, cwd?: string): Array<{ path: string; modified: number }> {
  const directory = absolutePath(sessionDir);
  try {
    return readdirSync(directory)
      .filter((name) => name.endsWith(".jsonl") || name.endsWith(".sqlite"))
      .map((name) => join(directory, name))
      .flatMap((path) => {
        try {
          const { header, modified } = headerFromFile(path);
          if (cwd !== undefined && !sameCwd(header.cwd, cwd)) return [];
          return [{ path, modified }];
        } catch {
          return [];
        }
      })
      .sort((left, right) => right.modified - left.modified || comparePath(left.path, right.path));
  } catch {
    return [];
  }
}

async function readSessionInfo(path: string, followSymlinks = true): Promise<SessionInfo> {
  const [details, loaded] = await Promise.all([
    stat(path),
    isSqliteSessionFile(path, followSymlinks) ? Promise.resolve(stateFromFile(path, followSymlinks)) : readSessionV4File(path, { followSymlinks }),
  ]);
  const state = loaded.state;
  if (state.nodes.size > MAX_SESSION_ENTRY_COUNT) {
    throw new Error(`Session entry count exceeds the limit of ${MAX_SESSION_ENTRY_COUNT}: ${path}`);
  }
  const entries = [...state.nodes.values()].map(projectedEntry);
  let first = "";
  let lastActivity: number | undefined;
  const searchable: string[] = [];
  let messageCount = 0;
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    messageCount += 1;
    const activity = messageActivity(entry);
    if (activity !== undefined) lastActivity = Math.max(lastActivity ?? 0, activity);
    if (!isConversationalMessage(entry.message)) continue;
    const text = messageText(entry.message);
    if (text === "") continue;
    searchable.push(text);
    if (first === "" && messageRole(entry.message) === "user") first = text;
  }

  const headerTime = new Date(state.header.createdAt).getTime();
  const modified = lastActivity !== undefined && lastActivity > 0
    ? new Date(lastActivity)
    : Number.isNaN(headerTime) ? details.mtime : new Date(headerTime);
  return {
    path,
    id: state.header.sessionId,
    cwd: state.header.cwd,
    created: new Date(state.header.createdAt),
    modified,
    messageCount,
    firstMessage: first || "(no messages)",
    allMessagesText: searchable.join(" "),
    ...optionalProperties(state.name === null ? undefined : { name: state.name }),
    ...optionalProperties(state.header.parent === undefined ? undefined : {
          parentSessionPath: state.header.parent.sessionId,
          ...optionalProperties(state.header.parent.purpose === undefined ? undefined : { parentPurpose: state.header.parent.purpose }),
        }),
  };
}

function errorText<ErrorValue>(error: ErrorValue): string {
  return Error.isError(error) ? error.message : String(error);
}

async function scanDirectory(directory: string, progress?: SessionListProgress): Promise<SessionScanResult> {
  if (!existsSync(directory)) return { sessions: [], invalid: [] };
  try {
    const files = (await readdir(directory))
      .filter((name) => name.endsWith(".jsonl") || name.endsWith(".sqlite"))
      .sort()
      .map((name) => join(directory, name));
    return coalesceLegacyCopies(await loadIndexedSessionInfos(
      directory,
      files,
      async (file) => await readSessionInfo(file, false),
      progress,
    ));
  } catch (error) {
    return { sessions: [], invalid: [{ path: directory, error: errorText(error) }] };
  }
}

function sortSessions(sessions: SessionInfo[]): SessionInfo[] {
  return sessions.sort((left, right) =>
    right.modified.getTime() - left.modified.getTime() || comparePath(left.path, right.path));
}

async function scanAllSessions(
  customDirectory: string | undefined,
  progress?: SessionListProgress,
): Promise<SessionScanResult> {
  if (customDirectory !== undefined) return await scanDirectory(customDirectory, progress);
  const root = sessionsDirectory();
  if (!existsSync(root)) return { sessions: [], invalid: [] };

  let directories: string[];
  try {
    directories = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name))
      .sort(comparePath);
  } catch (error) {
    return { sessions: [], invalid: [{ path: root, error: errorText(error) }] };
  }

  const files: string[] = [];
  const invalid: SessionFileIssue[] = [];
  for (const directory of directories) {
    try {
      files.push(...(await readdir(directory))
        .filter((name) => name.endsWith(".jsonl") || name.endsWith(".sqlite"))
        .sort()
        .map((name) => join(directory, name)));
    } catch (error) {
      invalid.push({ path: directory, error: errorText(error) });
    }
  }

  const scanned = await loadIndexedSessionInfos(
    root,
    files,
    async (file) => await readSessionInfo(file, false),
    progress,
  );
  return coalesceLegacyCopies({ sessions: scanned.sessions, invalid: [...invalid, ...scanned.invalid] });
}

interface SessionManagerInitialization {
  cwd: string;
  sessionDir: string;
  sessionFile?: string;
  persist: boolean;
  journal?: SessionStorageJournal;
  newSessionOptions?: NewSessionOptions;
  snapshotState?: SessionV4State;
  snapshotBytes?: number;
  freshSession?: { header: SessionV4Header };
}

interface SessionV4RecoverySnapshot {
  openOperation: SessionV4State["operations"] extends Map<string, infer T> ? T | null : never;
  queue: Array<SessionV4State["queue"] extends Map<string, infer T> ? T : never>;
  toolEffects: Array<SessionV4State["toolEffects"] extends Map<string, infer T> ? T : never>;
}

interface SessionRecentActivity {
  operations: Array<Pick<SessionV4OperationState, "id" | "status" | "acceptedAt" | "finishedAt"> & {
    finishReason: FinishReason | null;
    errorCategory: AdapterError["category"] | null;
  }>;
  toolEffects: Array<Pick<SessionV4ToolEffectState,
    "id" | "operationId" | "toolName" | "status" | "preparedAt" |
    "lastDispatchedAt" | "recoveryStartedAt" | "finishedAt"
  >>;
}

function primaryBranch(state: SessionV4ReducerState): SessionV4State["branches"] extends Map<string, infer T> ? T : never {
  const branch = state.branches.get(state.primaryBranchId);
  if (branch === undefined) throw new Error(`Session branch ${state.primaryBranchId} is missing`);
  return branch;
}

function labelTimestamps(state: SessionV4ReducerState): Map<string, string> {
  const timestamps = new Map<string, string>();
  for (const commit of state.commits.values()) {
    for (const change of commit.changes) {
      if (change.type !== "node_label") continue;
      if (change.label === null) timestamps.delete(change.nodeId);
      else timestamps.set(change.nodeId, commit.committedAt);
    }
  }
  return timestamps;
}

function nodeMetadata(state: SessionV4ReducerState, id: string): SessionV4NodeMetadata | undefined {
  return state.nodes.getMetadata === undefined ? state.nodes.get(id) : state.nodes.getMetadata(id);
}

function absoluteNodeDepth(
  state: SessionV4ReducerState,
  id: string,
  known: Map<string, number>,
): number {
  const cached = known.get(id);
  if (cached !== undefined) return cached;
  const path: string[] = [];
  const encountered = new Set<string>();
  let cursor = nodeMetadata(state, id);
  let depth = 0;
  while (cursor !== undefined && !encountered.has(cursor.id)) {
    const parentDepth = known.get(cursor.id);
    if (parentDepth !== undefined) {
      depth = parentDepth;
      break;
    }
    encountered.add(cursor.id);
    path.push(cursor.id);
    if (cursor.parentId === null) {
      depth = -1;
      break;
    }
    cursor = nodeMetadata(state, cursor.parentId);
  }
  for (let index = path.length - 1; index >= 0; index -= 1) {
    depth += 1;
    known.set(path[index]!, depth);
  }
  return known.get(id) ?? 0;
}

export class SessionManager {
  private sessionId = "";
  private sessionFile: string | undefined;
  private createdFile = false;
  private readonly sessionDir: string;
  private readonly cwd: string;
  private readonly persist: boolean;
  private readonly snapshotOnly: boolean;
  private writer: SessionStorageJournal | undefined;
  private memoryState: SessionV4State | undefined;
  private logicalFileBytes = 0;
  private entryOrderCache: { ids: string[]; sequence: Map<string, number> } | undefined;
  private historyOrderCache: { nodes: SessionV4ReducerState["nodes"]; tip: string | null; ids: string[] } | undefined;
  private readonly appendListeners = new Set<(entry: Readonly<SessionEntry>) => void>();

  private constructor(initialization: SessionManagerInitialization) {
    this.cwd = absolutePath(initialization.cwd);
    this.sessionDir = initialization.sessionDir === "" ? "" : absolutePath(initialization.sessionDir);
    this.persist = initialization.persist;
    this.snapshotOnly = initialization.snapshotState !== undefined || initialization.journal?.readOnly === true;
    if (initialization.journal !== undefined) {
      const journal = initialization.journal;
      if (journal.inspectState((state) => state.nodes.size) > MAX_SESSION_ENTRY_COUNT) {
        journal.close();
        throw new Error(`Session entry count exceeds the limit of ${MAX_SESSION_ENTRY_COUNT}`);
      }
      this.writer = journal;
      this.sessionId = journal.inspectState((state) => state.header.sessionId);
      this.sessionFile = journal.path;
      this.logicalFileBytes = journal.bytes;
      return;
    }
    if (this.persist && !existsSync(this.sessionDir)) {
      mkdirSync(this.sessionDir, { recursive: true, mode: PRIVATE_SESSION_DIRECTORY_MODE });
    }
    if (initialization.snapshotState !== undefined) {
      this.sessionFile = initialization.sessionFile;
      this.sessionId = initialization.snapshotState.header.sessionId;
      // These private replay maps are owned here; a new read-only state identity
      // lets the reducer's write-only WeakMap indexes be collected without cloning history.
      this.memoryState = { ...initialization.snapshotState };
      this.logicalFileBytes = initialization.snapshotBytes ?? 0;
      return;
    }
    if (initialization.freshSession !== undefined) {
      this.installFresh(initialization.freshSession.header);
      return;
    }
    if (initialization.sessionFile === undefined) this.newSession(initialization.newSessionOptions);
    else this.setFile(initialization.sessionFile);
  }

  /** Runs a synchronous trusted read without exposing the owned state publicly. */
  private inspectState<T>(inspect: (state: SessionV4ReducerState) => T): T {
    if (this.writer !== undefined) return this.writer.inspectState(inspect);
    if (this.memoryState !== undefined) return inspect(this.memoryState);
    throw new Error("Session store is not initialized");
  }

  private releaseWriter(): void {
    const writer = this.writer;
    this.writer = undefined;
    this.entryOrderCache = undefined;
    this.historyOrderCache = undefined;
    writer?.close();
  }

  private adoptCandidate(candidate: SessionManager): void {
    const previousWriter = this.writer;
    this.sessionId = candidate.sessionId;
    this.sessionFile = candidate.sessionFile;
    this.createdFile = candidate.createdFile;
    this.writer = candidate.writer;
    this.memoryState = candidate.memoryState;
    this.logicalFileBytes = candidate.logicalFileBytes;
    this.entryOrderCache = candidate.entryOrderCache;
    this.historyOrderCache = undefined;
    candidate.writer = undefined;
    candidate.memoryState = undefined;
    candidate.entryOrderCache = undefined;
    previousWriter?.close();
  }

  private freshCandidate(header: SessionV4Header): SessionManager {
    return new SessionManager({
      cwd: this.cwd,
      sessionDir: this.sessionDir,
      persist: this.persist,
      freshSession: { header },
    });
  }

  private installFresh(header: SessionV4Header): void {
    if (this.snapshotOnly) throw new Error("A session snapshot is read-only");
    const previousWriter = this.writer;
    if (this.persist) {
      const journal = new SessionStorageJournal(new SqliteSessionStorageBackend(this.sessionDir).create(header));
      this.writer = journal;
      this.memoryState = undefined;
      this.sessionFile = journal.path;
      this.createdFile = true;
      this.logicalFileBytes = journal.bytes;
    } else {
      this.writer = undefined;
      this.memoryState = createSessionV4State(header);
      this.sessionFile = undefined;
      this.logicalFileBytes = Buffer.byteLength(JSON.stringify(header) + "\n", "utf8");
    }
    this.sessionId = header.sessionId;
    this.entryOrderCache = undefined;
    this.historyOrderCache = undefined;
    previousWriter?.close();
  }

  private setFile(path: string, validateCandidate?: (candidate: SessionManager) => void): void {
    const file = absolutePath(path);
    if (this.writer?.path === file) { validateCandidate?.(this); return; }
    const snapshot = this.persist ? undefined : SessionManager.open(file, undefined, undefined, { readOnly: true });
    const candidate = snapshot === undefined ? SessionManager.open(file, this.sessionDir) : snapshot.cloneInMemory();
    snapshot?.closeV4Store();
    const cleanup = candidate.captureCreatedSessionCleanup();
    try { validateCandidate?.(candidate); this.adoptCandidate(candidate); }
    catch (error) {
      try { candidate.closeV4Store(); cleanup(); }
      catch (cleanup) { throw new AggregateError([error, cleanup], "Session replacement validation and cleanup failed"); }
      throw error;
    }
  }

  setSessionFile(path: string, validateCandidate?: (candidate: SessionManager) => void): void {
    if (this.snapshotOnly) throw new Error("A session snapshot is read-only");
    this.setFile(path, validateCandidate);
  }

  newSession(options?: NewSessionOptions): string | undefined {
    if (this.snapshotOnly) throw new Error("A session snapshot is read-only");
    if (options?.id !== undefined) assertValidSessionId(options.id);
    const id = options?.id ?? newSessionId();
    const timestamp = new Date().toISOString();
    const header = createHeader(
      id,
      timestamp,
      this.cwd,
      parentFromReference(options?.parentSession, id),
    );
    this.installFresh(header);
    return this.sessionFile;
  }

  /** @internal Commits one validated atomic session transition. */
  commitChanges(
    changes: SessionV4Changes,
    id = commitId(),
    committedAt = new Date().toISOString(),
  ): SessionV4Commit {
    if (this.snapshotOnly) throw new Error("A session snapshot is read-only");
    const newNodeIds = new Set(
      changes.flatMap((change) => change.type === "conversation_node" ? [change.node.id] : []),
    );
    const before = this.inspectState((state) => {
      let addedNodes = 0;
      for (const nodeId of newNodeIds) if (!state.nodes.has(nodeId)) addedNodes += 1;
      return {
        sequence: state.sequence,
        existing: state.commits.get(id),
        nodeCount: state.nodes.size,
        addedNodes,
      };
    });
    const existing = before.existing;
    if (
      existing !== undefined
      && existing.committedAt === committedAt
      && isDeepStrictEqual(existing.changes, changes)
    ) {
      return structuredClone(existing);
    }
    const candidate: SessionV4Commit = {
      record: "commit",
      sequence: before.sequence + 1,
      commitId: id,
      committedAt,
      changes: structuredClone(changes),
    };
    const recordBytes = Buffer.byteLength(`${JSON.stringify(candidate)}\n`, "utf8");
    if (this.writer === undefined && recordBytes - 1 > MAX_SESSION_RECORD_BYTES) {
      throw new Error(`Session record exceeds the limit of ${MAX_SESSION_RECORD_BYTES}`);
    }
    if (before.nodeCount + before.addedNodes > MAX_SESSION_ENTRY_COUNT) {
      throw new Error(`Session entry count exceeds the limit of ${MAX_SESSION_ENTRY_COUNT}`);
    }
    if (this.writer === undefined && this.logicalFileBytes + recordBytes > MAX_SESSION_FILE_BYTES) {
      throw new Error(`Session file exceeds the limit of ${MAX_SESSION_FILE_BYTES}`);
    }

    let commit: SessionV4Commit;
    let applied: boolean;
    if (this.writer === undefined) {
      if (this.memoryState === undefined) throw new Error("Session store is not initialized");
      applied = applySessionV4CommitOwned(this.memoryState, candidate);
      commit = candidate;
    } else {
      commit = this.writer.append({ commitId: id, committedAt, changes: structuredClone(changes) });
      applied = this.inspectState((state) => state.sequence !== before.sequence);
    }
    if (applied) {
      this.logicalFileBytes += recordBytes;
      const order = this.entryOrderCache;
      if (order !== undefined && order.ids.length === before.nodeCount) {
        for (const change of changes) {
          if (change.type !== "conversation_node" || order.sequence.has(change.node.id)) continue;
          order.sequence.set(change.node.id, order.ids.length);
          order.ids.push(change.node.id);
        }
        if (order.ids.length !== before.nodeCount + before.addedNodes) this.entryOrderCache = undefined;
      }
      for (const change of changes) {
        if (change.type !== "conversation_node") continue;
        const entry = projectedEntry(change.node);
        for (const listener of this.appendListeners) {
          try {
            listener(structuredClone(entry));
          } catch {
            // The commit is durable before observers run.
          }
        }
      }
    }
    return structuredClone(commit);
  }

  /** @internal Returns a detached snapshot for the owning AgentSession. */
  getV4State(): SessionV4State {
    return this.inspectState(cloneSessionV4State);
  }

  /** @internal Detached journal records for runtime reads without cloning unrelated history. */
  getV4Branch(): SessionV4BranchRuntimeState {
    return this.inspectState((state) => structuredClone(primaryBranch(state)));
  }

  /** @internal */
  getV4Operation(id: string): SessionV4OperationState | undefined {
    return this.inspectState((state) => structuredClone(state.operations.get(id)));
  }

  /** @internal */
  getV4Node(id: string): SessionV4ConversationNode | undefined {
    return this.inspectState((state) => structuredClone(state.nodes.get(id)));
  }

  /** @internal */
  hasV4Node(id: string): boolean {
    return this.inspectState((state) => state.nodes.has(id));
  }

  /** @internal */
  getV4OperationNodes(operationId: string): SessionV4ConversationNode[] {
    return this.inspectState((state) => {
      const selected: SessionV4ConversationNode[] = [];
      for (const [id, node] of state.nodes.metadataEntries?.() ?? state.nodes) {
        if (node.operationId === operationId) selected.push(structuredClone(state.nodes.get(id)!));
      }
      return selected;
    });
  }

  /** @internal */
  getV4QueueEntry(id: string): SessionV4QueueEntryState | undefined {
    return this.inspectState((state) => structuredClone(state.queue.get(id)));
  }

  /** @internal */
  getV4QueueEntryForNode(nodeId: string): SessionV4QueueEntryState | undefined {
    return this.inspectState((state) => {
      for (const [id, entry] of state.queue.metadataEntries?.() ?? state.queue) {
        if (entry.targetNodeId === nodeId) return structuredClone(state.queue.get(id));
      }
      return undefined;
    });
  }

  /** @internal Pending queue entries in acceptance order. */
  getV4PendingQueue(): SessionV4QueueEntryState[] {
    return this.inspectState((state) => {
      const selected: SessionV4QueueEntryState[] = [];
      for (const [id, entry] of state.queue.metadataEntries?.() ?? state.queue) {
        if (entry.status === "queued" || entry.status === "claimed") selected.push(structuredClone(state.queue.get(id)!));
      }
      return selected;
    });
  }

  /** @internal */
  getV4ToolEffect(id: string): SessionV4ToolEffectState | undefined {
    return this.inspectState((state) => structuredClone(state.toolEffects.get(id)));
  }

  /** @internal */
  getV4ToolEffects(operationId: string): SessionV4ToolEffectState[] {
    return this.inspectState((state) => {
      const selected: SessionV4ToolEffectState[] = [];
      for (const [id, effect] of state.toolEffects.metadataEntries?.() ?? state.toolEffects) {
        if (effect.operationId === operationId) selected.push(structuredClone(state.toolEffects.get(id)!));
      }
      return selected;
    });
  }

  /** @internal Recent metadata in reverse acceptance/preparation order; each list is capped independently. */
  getRecentActivity(limit = 20): SessionRecentActivity {
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > 100) {
      throw new RangeError("Recent activity limit must be an integer between 0 and 100");
    }
    const activity: SessionRecentActivity = { operations: [], toolEffects: [] };
    if (limit === 0) return activity;
    return this.inspectState((state) => {
      for (const [, operation] of state.operations.metadataEntries?.() ?? state.operations) {
        activity.operations.push({
          id: operation.id,
          status: operation.status,
          acceptedAt: operation.acceptedAt,
          finishedAt: operation.finishedAt,
          finishReason: null,
          errorCategory: null,
        });
        if (activity.operations.length > limit) activity.operations.shift();
      }
      for (const [, effect] of state.toolEffects.metadataEntries?.() ?? state.toolEffects) {
        activity.toolEffects.push({
          id: effect.id,
          operationId: effect.operationId,
          toolName: effect.toolName,
          status: effect.status,
          preparedAt: effect.preparedAt,
          lastDispatchedAt: effect.lastDispatchedAt,
          recoveryStartedAt: effect.recoveryStartedAt,
          finishedAt: effect.finishedAt,
        });
        if (activity.toolEffects.length > limit) activity.toolEffects.shift();
      }
      activity.operations.reverse();
      for (const operation of activity.operations) {
        const detail = state.operations.get(operation.id)?.detail;
        if (!isJsonObject(detail)) continue;
        if (operation.status === "completed") {
          operation.finishReason = ACTIVITY_FINISH_REASONS.find((reason) => reason === detail.finishReason) ?? null;
        }
        const error = detail.error;
        if (operation.status === "failed" && isJsonObject(error)) {
          operation.errorCategory = ACTIVITY_ERROR_CATEGORIES.find((category) => category === error.category) ?? null;
        }
      }
      activity.toolEffects.reverse();
      return activity;
    });
  }

  /** @internal Returns only work that may require recovery after reopening. */
  getV4RecoverySnapshot(): SessionV4RecoverySnapshot {
    return this.inspectState((state) => {
      const branch = primaryBranch(state);
      const openOperation = branch.openOperationId === null
        ? null
        : structuredClone(state.operations.get(branch.openOperationId) ?? null);
      const queue: SessionV4QueueEntryState[] = [];
      for (const [id, entry] of state.queue.metadataEntries?.() ?? state.queue) {
        if (entry.status === "queued" || entry.status === "claimed") queue.push(structuredClone(state.queue.get(id)!));
      }
      const toolEffects: SessionV4ToolEffectState[] = [];
      for (const [id, effect] of state.toolEffects.metadataEntries?.() ?? state.toolEffects) {
        if (openOperation !== null && effect.operationId === openOperation.id) {
          toolEffects.push(structuredClone(state.toolEffects.get(id)!));
        }
      }
      return {
        openOperation,
        queue,
        toolEffects,
      };
    });
  }

  /** @internal Releases the durable writer owned by this manager. */
  closeV4Store(): void {
    this.releaseWriter();
  }

  /** Observes successfully committed conversation entries without exposing mutable storage state. */
  onAppend(listener: (entry: Readonly<SessionEntry>) => void): () => void {
    this.appendListeners.add(listener);
    return () => this.appendListeners.delete(listener);
  }

  private entries(): SessionEntry[] {
    return this.inspectState((state) => [...state.nodes.values()].map(projectedEntry));
  }

  private entryBase<T extends SessionEntry["type"]>(
    type: T,
    options: { nodeId?: string; parentId?: string | null } = {},
  ): { type: T; id: string; parentId: string | null; timestamp: string } {
    return this.inspectState((state) => ({
      type,
      id: options.nodeId ?? shortEntryId(state.nodes),
      parentId: options.parentId === undefined ? primaryBranch(state).headNodeId : options.parentId,
      timestamp: new Date().toISOString(),
    }));
  }

  private appendEntry(entry: SessionEntry, operationId?: string): string {
    const node = sessionEntryToV4Node(entry, this.cwd, operationId);
    this.commitChanges([
      { type: "conversation_node", node },
      { type: "head", branchId: SESSION_V4_PRIMARY_BRANCH_ID, nodeId: node.id },
    ]);
    return node.id;
  }

  isPersisted(): boolean {
    return this.persist;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  /** @internal Capture cleanup for a newly created candidate, never an arbitrary file. */
  captureCreatedSessionCleanup(): () => void {
    const file = this.createdFile ? this.sessionFile : undefined;
    const created = file === undefined ? undefined : lstatSync(file, { bigint: true });
    return () => {
      try {
        if (file !== undefined && created !== undefined) {
          new SqliteSessionStorageBackend(dirname(file)).remove(file, created);
        }
      } catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
    };
  }

  getCwd(): string {
    return this.cwd;
  }

  getSessionDir(): string {
    return this.sessionDir;
  }

  getSessionFile(): string | undefined {
    return this.sessionFile;
  }

  usesDefaultSessionDir(): boolean {
    return sameFilesystemPath(this.sessionDir, defaultSessionDirPath(this.cwd));
  }

  appendMessage(
    message: PersistedSessionMessage,
    options: { nodeId?: string; operationId?: string; parentId?: string | null } = {},
  ): string {
    return this.appendEntry({
      ...this.entryBase("message", options),
      message: structuredClone(message),
    }, options.operationId);
  }

  appendThinkingLevelChange(selectedThinkingLevel: string, operationId?: string): string {
    const entry: ThinkingLevelChangeEntry = {
      ...this.entryBase("thinking_level_change"),
      thinkingLevel: selectedThinkingLevel,
    };
    return this.appendEntry(entry, operationId);
  }

  appendModelChange(provider: string, modelId: string, operationId?: string): string {
    const entry: ModelChangeEntry = { ...this.entryBase("model_change"), provider, modelId };
    return this.appendEntry(entry, operationId);
  }

  appendCompaction<T = unknown>(
    summary: string,
    firstKeptEntryId: string,
    tokensBefore: number,
    details?: T,
    fromHook?: boolean,
    usage?: NormalizedUsage,
    operationId?: string,
  ): string {
    if (!this.inspectState((state) => state.nodes.has(firstKeptEntryId))) {
      throw new Error(`Entry ${firstKeptEntryId} not found`);
    }
    const entry: CompactionEntry<T> = {
      ...this.entryBase("compaction"),
      summary,
      firstKeptEntryId,
      tokensBefore,
      ...optionalProperties(usage === undefined ? undefined : { usage: structuredClone(usage) }),
      ...optionalProperties(details === undefined ? undefined : { details }),
      ...optionalProperties(fromHook === undefined ? undefined : { fromHook }),
    };
    return this.appendEntry(entry, operationId);
  }

  appendCustomEntry<T = unknown>(
    customType: string,
    data?: T,
    operationId?: string,
    provenance?: CustomEntry["provenance"],
  ): string {
    const entry: CustomEntry<T> = {
      ...this.entryBase("custom"),
      customType,
      ...optionalProperties(data === undefined ? undefined : { data }),
      ...optionalProperties(provenance === undefined ? undefined : { provenance: structuredClone(provenance) }),
    };
    return this.appendEntry(entry, operationId);
  }

  appendSessionInfo(name: string): string {
    const normalized = name.replace(/[\r\n]+/gu, " ").trim();
    return this.commitChanges([{ type: "session_name", name: normalized === "" ? null : normalized }]).commitId;
  }

  getSessionName(): string | undefined {
    return this.inspectState((state) => state.name ?? undefined);
  }

  appendCustomMessageEntry<T = unknown>(
    customType: string,
    content: string | (TextBlock | ImageBlock)[],
    display: boolean,
    details?: T,
    options: {
      nodeId?: string;
      operationId?: string;
      parentId?: string | null;
      provenance?: CustomMessageEntry["provenance"];
    } = {},
  ): string {
    const entry: CustomMessageEntry<T> = {
      ...this.entryBase("custom_message", options),
      customType,
      content: structuredClone(content),
      display,
      ...optionalProperties(details === undefined ? undefined : { details }),
      ...optionalProperties(options.provenance === undefined ? undefined : { provenance: structuredClone(options.provenance) }),
    };
    return this.appendEntry(entry, options.operationId);
  }

  getLeafId(): string | null {
    return this.inspectState((state) => primaryBranch(state).headNodeId);
  }

  getLeafEntry(): SessionEntry | undefined {
    return this.inspectState((state) => {
      const leaf = primaryBranch(state).headNodeId;
      const node = leaf === null ? undefined : state.nodes.get(leaf);
      return node === undefined ? undefined : structuredClone(projectedEntry(node));
    });
  }

  getEntry(id: string): SessionEntry | undefined {
    return this.inspectState((state) => {
      const node = state.nodes.get(id);
      return node === undefined ? undefined : structuredClone(projectedEntry(node));
    });
  }

  getChildren(parentId: string): SessionEntry[] {
    return this.inspectState((state) => {
      const selected: SessionEntry[] = [];
      for (const [id, node] of state.nodes.metadataEntries?.() ?? state.nodes) {
        if (node.parentId === parentId) selected.push(structuredClone(projectedEntry(state.nodes.get(id)!)));
      }
      return selected;
    });
  }

  getLabel(id: string): string | undefined {
    return this.inspectState((state) => state.labels.get(id));
  }

  appendLabelChange(targetId: string, label: string | undefined): string {
    if (!this.inspectState((state) => state.nodes.has(targetId))) {
      throw new Error(`Entry ${targetId} not found`);
    }
    const normalized = label?.trim();
    return this.commitChanges([{
      type: "node_label",
      nodeId: targetId,
      label: normalized === undefined || normalized === "" ? null : normalized,
    }]).commitId;
  }

  getBranch(fromId?: string): SessionEntry[] {
    return this.inspectState((state) => {
      const start = fromId ?? primaryBranch(state).headNodeId;
      const newestFirst: SessionEntry[] = [];
      const encountered = new Set<string>();
      for (
        let cursor = start === null ? undefined : state.nodes.get(start);
        cursor !== undefined && !encountered.has(cursor.id);
        cursor = cursor.parentId === null ? undefined : state.nodes.get(cursor.parentId)
      ) {
        encountered.add(cursor.id);
        newestFirst.push(projectedEntry(cursor));
      }
      return structuredClone(newestFirst.toReversed());
    });
  }

  findEntriesOnBranch(query: SessionBranchQuery = {}): SessionEntry[] {
    validateSessionBranchQuery(query);
    const start = query.start === undefined ? this.getLeafId() : query.start;
    if (start === null) return [];
    const path = this.getBranch(start);
    if (path.length === 0) throw new Error(`Entry ${start} not found`);
    return selectSessionBranchEntries(path, query);
  }

  findEntryOnBranch(query: SessionBranchQuery = {}): SessionEntry | undefined {
    return this.findEntriesOnBranch({ ...query, limit: 1 })[0];
  }

  /** Usage on the active lineage without cloning stored message or tool payloads. */
  getActiveBranchUsage(): ActiveBranchUsage {
    return this.inspectState((state) => {
      let aggregate: NormalizedUsage | undefined;
      let reported: NormalizedUsage | undefined;
      let latestAssistantUsage: NormalizedUsage | undefined;
      let latestAssistantObserved = false;
      let hasUsageObservations = false;
      const encountered = new Set<string>();
      const headId = primaryBranch(state).headNodeId;
      for (
        let cursor = headId === null ? undefined : state.nodes.get(headId);
        cursor !== undefined && !encountered.has(cursor.id);
        cursor = cursor.parentId === null ? undefined : state.nodes.get(cursor.parentId)
      ) {
        encountered.add(cursor.id);
        const observed = nodeUsage(cursor);
        if (observed === undefined) continue;
        const successfulAssistant = observed.kind === "assistant"
          && observed.stopReason !== "cancelled"
          && observed.stopReason !== "aborted"
          && observed.stopReason !== "error";
        if (
          observed.usage !== undefined
          || successfulAssistant
          || (observed.kind === "summary" && observed.meteredWithoutUsage !== false)
        ) {
          hasUsageObservations = true;
          aggregate = addCompleteNormalizedUsage(aggregate, observed.usage ?? {});
          reported = addNormalizedUsage(reported, observed.usage ?? {});
        }
        if (
          !latestAssistantObserved
          && successfulAssistant
        ) {
          latestAssistantObserved = true;
          latestAssistantUsage = observed.usage;
        }
      }
      const usage = aggregate ?? {};
      const reportedUsage = reported ?? {};
      const reportedFields = [
        "inputTokens",
        "outputTokens",
        "totalTokens",
        "cacheReadTokens",
        "cacheWriteTokens",
        "cacheWrite1hTokens",
        "reasoningTokens",
        "serverToolCalls",
        "durationMs",
      ] as const;
      const hasReportedFallback = reportedFields.some(
        (field) => usage[field] === undefined && reportedUsage[field] !== undefined,
      ) || (usage.cost === undefined && reportedUsage.cost !== undefined);
      return {
        usage,
        ...optionalProperties(hasReportedFallback ? { reportedUsage } : undefined),
        hasUsageObservations,
        ...optionalProperties(latestAssistantUsage === undefined ? undefined : { latestAssistantUsage }),
      };
    });
  }

  buildContextEntries(): SessionEntry[] {
    return buildContextEntries(this.getBranch());
  }

  buildSessionContext(): SessionContext {
    return buildSessionContext(this.getBranch());
  }

  /** Reads active-lineage model/thinking metadata without projecting message payloads.
   * hasPersistedThinking includes every branch, matching restoration defaults.
   */
  getPersistedSelection(): Pick<SessionContext, "model" | "thinkingLevel"> & { hasPersistedThinking: boolean } {
    const history = this.writer?.getHistoryIndex(false);
    return this.inspectState((state) => {
      const head = primaryBranch(state).headNodeId;
      if (history !== undefined) {
        const selected = head === null ? undefined : history.getNode(head);
        const model = selected?.nearestModelId == null ? undefined : state.nodes.get(selected.nearestModelId);
        const thinking = selected?.nearestThinkingId == null ? undefined : state.nodes.get(selected.nearestThinkingId);
        return {
          model: model?.nodeType === "model_change" ? { provider: model.provider, modelId: model.model } : null,
          thinkingLevel: thinking?.nodeType === "thinking_change" ? thinking.level : "off",
          hasPersistedThinking: history.hasThinkingChange(),
        };
      }
      let model: SessionContext["model"] = null;
      let thinkingLevel: string | undefined;
      for (let node = head === null ? undefined : nodeMetadata(state, head); node !== undefined;
        node = node.parentId === null ? undefined : nodeMetadata(state, node.parentId)) {
        if (model === null && node.nodeType === "model_change") {
          const selected = state.nodes.get(node.id);
          if (selected?.nodeType === "model_change") model = { provider: selected.provider, modelId: selected.model };
        }
        if (thinkingLevel === undefined && node.nodeType === "thinking_change") {
          const selected = state.nodes.get(node.id);
          if (selected?.nodeType === "thinking_change") thinkingLevel = selected.level;
        }
        if (model !== null && thinkingLevel !== undefined) break;
      }
      let hasPersistedThinking = thinkingLevel !== undefined;
      if (!hasPersistedThinking) {
        for (const [, node] of state.nodes.metadataEntries?.() ?? state.nodes) {
          if (node.nodeType !== "thinking_change") continue;
          hasPersistedThinking = true;
          break;
        }
      }
      return { model, thinkingLevel: thinkingLevel ?? "off", hasPersistedThinking };
    });
  }

  getHeader(): SessionHeader {
    return this.inspectState((state) => projectedHeader(state.header));
  }

  getEntries(): SessionEntry[] {
    return structuredClone(this.entries());
  }

  getEntryCount(): number {
    return this.inspectState((state) => state.nodes.size);
  }

  private entryOrder(state: SessionV4ReducerState): { ids: string[]; sequence: Map<string, number> } {
    if (this.entryOrderCache?.ids.length === state.nodes.size) return this.entryOrderCache;
    const ids = [...state.nodes.keys()];
    const sequence = new Map(ids.map((id, index) => [id, index]));
    this.entryOrderCache = { ids, sequence };
    return this.entryOrderCache;
  }

  getEntrySequence(id: string): number | undefined {
    const history = this.writer?.getHistoryIndex();
    if (history !== undefined) return history.getNode(id)?.ordinal;
    return this.inspectState((state) => this.entryOrder(state).sequence.get(id));
  }

  private entryIdsPage(state: SessionV4ReducerState, offset: number, limit: number): string[] {
    const history = this.writer?.getHistoryIndex();
    if (history === undefined) return this.entryOrder(state).ids.slice(offset, offset + limit);
    const range = entryPageRange(offset, limit, state.nodes.size);
    return history.getNodesPage(range.offset, range.limit).map((node) => node.id);
  }

  getEntriesPage(offset: number, limit: number): SessionEntry[] {
    if (offset < 0 || limit < 1) return [];
    return this.inspectState((state) => structuredClone(
      this.entryIdsPage(state, offset, limit)
        .map((id) => projectedEntry(state.nodes.get(id)!)),
    ));
  }

  private historyIds(from: string | null, tailLimit?: number): string[] {
    return this.inspectState((state) => {
      const cache = this.historyOrderCache;
      if (cache?.nodes === state.nodes && cache.tip === from) {
        return tailLimit === undefined ? cache.ids : cache.ids.slice(-tailLimit);
      }
      if (from !== null && !state.nodes.has(from)) throw new Error(`Entry ${from} not found`);
      const ids: string[] = [];
      for (let id = from; id !== null && (tailLimit === undefined || ids.length < tailLimit);) {
        ids.push(id);
        id = nodeMetadata(state, id)!.parentId;
      }
      ids.reverse();
      if (tailLimit === undefined) this.historyOrderCache = { nodes: state.nodes, tip: from, ids };
      return ids;
    });
  }

  /** Pages durable lineage entries without cloning the complete transcript.
   * One entry larger than maxBytes is returned alone so a cursor can always advance.
   */
  getHistoryPage(options: SessionHistoryPageOptions = {}): SessionHistoryPage {
    if (options.before !== undefined && options.after !== undefined) {
      throw new TypeError("History before and after cursors are mutually exclusive");
    }
    if (options.edge !== undefined && (options.edge !== "oldest" || options.before !== undefined || options.after !== undefined)) {
      throw new TypeError("History oldest edge cannot be combined with a cursor");
    }
    const limit = historyLimit(options.limit, 100, 500);
    const maxBytes = historyLimit(options.maxBytes, 256 * 1024, 2 * 1024 * 1024);
    const newest = options.before === undefined && options.after === undefined && options.edge === undefined;
    const cursor = options.before ?? options.after;
    const forward = options.after !== undefined || options.edge === "oldest";
    const from = options.from ?? this.getLeafId();
    const indexed = this.writer?.getHistoryIndex(!newest)?.getHistoryPage(from, {
      direction: options.after !== undefined ? "after" : options.before !== undefined ? "before" : newest ? "newest" : "oldest",
      limit,
      ...optionalProperties(cursor === undefined ? undefined : { cursor }),
    });
    // Memory/detached snapshots keep their existing owned-map path. One extra
    // newest ancestor supplies the boundary without retaining a full lineage.
    const ids = indexed?.ids ?? this.historyIds(from, newest ? limit + 1 : undefined);
    const cursorIndex = indexed !== undefined || cursor === undefined ? -1 : ids.indexOf(cursor);
    if (indexed === undefined && cursor !== undefined && cursorIndex === -1) throw new Error(`History cursor ${cursor} is not on the selected lineage`);
    const start = indexed === undefined
      ? forward ? cursorIndex + 1 : options.before === undefined ? ids.length - 1 : cursorIndex - 1
      : forward ? 0 : ids.length - 1;
    const selected: SessionEntry[] = [];
    let bytes = 0;
    let index = start;
    for (; index >= 0 && index < ids.length && selected.length < limit; index += forward ? 1 : -1) {
      const entry = this.inspectState((state) => projectedEntry(state.nodes.get(ids[index]!)!));
      const size = Buffer.byteLength(JSON.stringify(entry), "utf8");
      if (selected.length > 0 && bytes + size > maxBytes) break;
      selected.push(structuredClone(entry));
      bytes += size;
      if (bytes >= maxBytes) { index += forward ? 1 : -1; break; }
    }
    if (!forward) selected.reverse();
    const first = (indexed?.offset ?? 0) + (selected.length === 0 ? (forward ? start : start + 1) : forward ? start : index + 1);
    const last = selected.length === 0 ? first - 1 : first + selected.length - 1;
    return { entries: selected, hasMoreBefore: first > 0, hasMoreAfter: last < (indexed?.total ?? ids.length) - 1 };
  }

  /** Searches visible stored text, not opaque provider data or hidden extension metadata. */
  async searchHistory(query: string, options: SessionHistorySearchOptions = {}): Promise<SessionHistorySearchResult> {
    options.signal?.throwIfAborted();
    if (query.trim() === "" || query.length > 4096) throw new TypeError("History query must contain 1–4096 characters");
    const limit = historyLimit(options.limit, 50, 200);
    if (options.before !== undefined && options.after !== undefined) throw new TypeError("History search cursors are mutually exclusive");
    const needle = query.toLocaleLowerCase();
    const sessionId = this.sessionId;
    const owner = this.writer;
    const memory = this.memoryState;
    const history = owner?.getHistoryIndex();
    const from = options.from;
    const ids = history === undefined
      ? from === undefined ? this.inspectState((state) => [...this.entryOrder(state).ids]) : this.historyIds(from)
      : undefined;
    const head = from === undefined ? undefined : history?.getNode(from);
    if (history !== undefined && from !== undefined && head === undefined) throw new Error(`Entry ${from} not found`);
    // Fix the initial range; appends during cooperative yields are not part of
    // this scan. Completed metadata batches never hold a SQL cursor across await.
    const total = ids?.length ?? (head === undefined ? this.getEntryCount() : head.depth + 1);
    const forward = options.after !== undefined;
    const selectedCursor = options.before ?? options.after;
    const cursorNode = selectedCursor === undefined ? undefined : history?.getNode(selectedCursor);
    const boundary = selectedCursor === undefined ? total : ids !== undefined ? ids.indexOf(selectedCursor)
      : from === undefined ? cursorNode?.ordinal ?? -1 : cursorNode?.depth ?? -1;
    if (boundary < 0) throw new Error(`History cursor ${selectedCursor} is not in the selected history`);
    if (history !== undefined && from !== undefined && selectedCursor !== undefined
      && history.getHistoryRange(from, boundary, 1).ids[0] !== selectedCursor) {
      throw new Error(`History cursor ${selectedCursor} is not in the selected history`);
    }
    const matches: SessionHistorySearchResult["matches"] = [];
    let batchStart = -1;
    let batch: string[] = [];
    let index = boundary + (forward ? 1 : -1);
    for (; index >= 0 && index < total; index += forward ? 1 : -1) {
      options.signal?.throwIfAborted();
      if (Math.abs(boundary - index) % 128 === 0) await new Promise<void>((resolveValue) => setImmediate(resolveValue));
      options.signal?.throwIfAborted();
      if (this.sessionId !== sessionId || this.writer !== owner || this.memoryState !== memory) {
        throw new Error("Session changed while searching history");
      }
      if (ids === undefined && (index < batchStart || index >= batchStart + batch.length)) {
        batchStart = forward ? index : Math.max(0, index - 127);
        const count = Math.min(128, total - batchStart);
        const current = owner!.getHistoryIndex()!;
        batch = from === undefined ? current.getNodesPage(batchStart, count).map((node) => node.id)
          : current.getHistoryRange(from, batchStart, count).ids;
      }
      const id = ids === undefined ? batch[index - batchStart]! : ids[index]!;
      const text = this.inspectState((state) => historyText(projectedEntry(state.nodes.get(id)!)));
      const at = text.toLocaleLowerCase().indexOf(needle);
      if (at < 0) continue;
      const begin = Math.max(0, at - 80);
      matches.push({ id, preview: text.slice(begin, begin + 320) });
      if (matches.length === limit) { index += forward ? 1 : -1; break; }
    }
    const cursor = matches.at(-1)?.id;
    if (forward) matches.reverse();
    return { matches, hasMore: index >= 0 && index < total, ...optionalProperties(cursor === undefined ? undefined : { cursor }) };
  }

  /** @internal Returns page-index metadata without materializing stored entry payloads. */
  getEntryProjectionMetadataPage(offset: number, limit: number): SessionEntryProjectionMetadata[] {
    if (offset < 0 || limit < 1) return [];
    return this.inspectState((state) => this.entryIdsPage(state, offset, limit)
      .map((id) => {
        const node = state.nodes.get(id)!;
        return {
          id,
          parentId: node.parentId,
          projectedEntryCount: projectedSessionEntryCount(node),
        };
      }));
  }

  getTreeEntryPage(offset: number, limit: number): SessionTreeNode[] {
    if (offset < 0 || limit < 1) return [];
    return this.inspectState((state) => {
      const history = this.writer?.getHistoryIndex();
      if (history !== undefined) {
        const range = entryPageRange(offset, limit, state.nodes.size);
        return history.getNodesPage(range.offset, range.limit).map((node) => ({
          entry: structuredClone(projectedEntry(state.nodes.get(node.id)!)),
          children: [],
          depth: node.depth,
          ...optionalProperties(node.label === null ? undefined : { label: node.label }),
          ...optionalProperties(node.labelTimestamp === null ? undefined : { labelTimestamp: node.labelTimestamp }),
        }));
      }
      const timestamps = labelTimestamps(state);
      const depths = new Map<string, number>();
      return structuredClone(this.entryOrder(state).ids
        .slice(offset, offset + limit)
        .map((id) => {
          const entry = projectedEntry(state.nodes.get(id)!);
          const label = state.labels.get(id);
          const labelTimestamp = timestamps.get(id);
          return {
            entry,
            children: [],
            depth: absoluteNodeDepth(state, id, depths),
            ...optionalProperties(label === undefined ? undefined : { label }),
            ...optionalProperties(labelTimestamp === undefined ? undefined : { labelTimestamp }),
          };
        }));
    });
  }

  /** @internal Returns a cheap cursor revision for paged tree metadata. */
  getTreeRevision(): number {
    return this.inspectState((state) => state.sequence);
  }

  getTreePage(offset: number, limit: number): SessionTreeNode[] {
    const page = this.getTreeEntryPage(offset, limit);
    const nodes = new Map(page.map((node) => [node.entry.id, node]));
    const roots: SessionTreeNode[] = [];
    for (const node of page) {
      const parent = node.entry.parentId === null ? undefined : nodes.get(node.entry.parentId);
      if (parent === undefined || parent === node) roots.push(node);
      else parent.children.push(node);
    }
    return roots;
  }

  getActiveBranchEntryIdsInPage(offset: number, limit: number): string[] {
    if (offset < 0 || limit < 1) return [];
    return this.inspectState((state) => {
      const history = this.writer?.getHistoryIndex();
      if (history !== undefined) {
        const range = entryPageRange(offset, limit, state.nodes.size);
        // Membership historically stops below the raw offset, even when slice
        // includes its truncated ordinal in a fractional page.
        const first = Math.max(range.offset, Math.ceil(offset) || 0);
        return history.getActiveIds(first, Math.max(0, range.offset + range.limit - first), primaryBranch(state).headNodeId);
      }
      const order = this.entryOrder(state);
      const pageIds = order.ids.slice(offset, offset + limit);
      const page = new Set(pageIds);
      const active = new Set<string>();
      const encountered = new Set<string>();
      const head = primaryBranch(state).headNodeId;
      for (
        let cursor = head === null ? undefined : state.nodes.get(head);
        cursor !== undefined && !encountered.has(cursor.id);
        cursor = cursor.parentId === null ? undefined : state.nodes.get(cursor.parentId)
      ) {
        const sequence = order.sequence.get(cursor.id);
        if (sequence !== undefined && sequence < offset) break;
        encountered.add(cursor.id);
        if (page.has(cursor.id)) active.add(cursor.id);
      }
      return pageIds.filter((id) => active.has(id));
    });
  }

  getContextMessagePage(offset: number, limit: number): SessionContextMessagePage {
    const messages = this.buildSessionContext().messages;
    return {
      messages: offset < 0 || limit < 1 ? [] : messages.slice(offset, offset + limit),
      totalMessages: messages.length,
    };
  }

  getTree(): SessionTreeNode[] {
    return this.inspectState((state) => {
      const nodes = new Map<string, SessionTreeNode>();
      const roots: SessionTreeNode[] = [];
      const timestamps = labelTimestamps(state);
      for (const raw of state.nodes.values()) {
        const entry = projectedEntry(raw);
        const label = state.labels.get(entry.id);
        const labelTimestamp = timestamps.get(entry.id);
        nodes.set(entry.id, {
          entry,
          children: [],
          ...optionalProperties(label === undefined ? undefined : { label }),
          ...optionalProperties(labelTimestamp === undefined ? undefined : { labelTimestamp }),
        });
      }
      for (const [, raw] of state.nodes.metadataEntries?.() ?? state.nodes) {
        const node = nodes.get(raw.id);
        if (node === undefined) throw new Error(`Session tree node ${raw.id} is missing`);
        const parent = raw.parentId === null ? undefined : nodes.get(raw.parentId);
        if (parent === undefined || parent === node) roots.push(node);
        else parent.children.push(node);
      }
      return structuredClone(roots);
    });
  }

  branch(branchFromId: string): void {
    if (!this.inspectState((state) => state.nodes.has(branchFromId))) {
      throw new Error(`Entry ${branchFromId} not found`);
    }
    this.commitChanges([{ type: "head", branchId: SESSION_V4_PRIMARY_BRANCH_ID, nodeId: branchFromId }]);
  }

  resetLeaf(): void {
    this.commitChanges([{ type: "head", branchId: SESSION_V4_PRIMARY_BRANCH_ID, nodeId: null }]);
  }

  branchWithSummary<Details>(
    branchFromId: string | null,
    summary: string,
    details?: Details,
    fromHook?: boolean,
    usage?: NormalizedUsage,
  ): string {
    if (branchFromId !== null && !this.inspectState((state) => state.nodes.has(branchFromId))) {
      throw new Error(`Entry ${branchFromId} not found`);
    }
    const entry: BranchSummaryEntry = {
      ...this.entryBase("branch_summary"),
      parentId: branchFromId,
      fromId: branchFromId ?? "root",
      summary,
      ...optionalProperties(usage === undefined ? undefined : { usage: structuredClone(usage) }),
      ...optionalProperties(details === undefined ? undefined : { details }),
      ...optionalProperties(fromHook === undefined ? undefined : { fromHook }),
    };
    const previousHead = this.getLeafId();
    // A root cursor has no node that can satisfy the native range references.
    const node: SessionV4ConversationNode = branchFromId === null || previousHead === null
      ? sessionEntryToV4Node(entry, this.cwd)
      : {
          id: entry.id,
          parentId: branchFromId,
          createdAt: entry.timestamp,
          nodeType: "branch_summary",
          fromNodeId: branchFromId,
          toNodeId: previousHead,
          summary: asJson({
            summary,
            ...optionalProperties(details === undefined ? undefined : { details }),
            ...optionalProperties(fromHook === undefined ? undefined : { fromHook }),
            ...optionalProperties(usage === undefined ? undefined : { usage }),
          }),
        };
    this.commitChanges([
      { type: "head", branchId: SESSION_V4_PRIMARY_BRANCH_ID, nodeId: branchFromId },
      { type: "conversation_node", node },
      { type: "head", branchId: SESSION_V4_PRIMARY_BRANCH_ID, nodeId: node.id },
    ]);
    return node.id;
  }

  createBranchedSession(leafId: string): string | undefined {
    if (this.snapshotOnly) throw new Error("A session snapshot is read-only");
    const branch = this.getBranch(leafId);
    if (branch.length === 0) throw new Error(`Entry ${leafId} not found`);
    const source = this.inspectState((state) => ({
      labels: new Map(
        branch.flatMap((entry) => {
          const label = state.labels.get(entry.id);
          return label === undefined ? [] : [[entry.id, label] as const];
        }),
      ),
      name: state.name,
      sessionId: state.header.sessionId,
    }));
    const timestamp = new Date().toISOString();
    const id = newSessionId();
    const candidate = this.freshCandidate(
      createHeader(id, timestamp, this.cwd, { sessionId: source.sessionId, purpose: "branch" }),
    );
    const cleanup = candidate.captureCreatedSessionCleanup();
    try {
      let parentId: string | null = null;
      for (const sourceEntry of branch) {
        const entry: SessionEntry = { ...structuredClone(sourceEntry), parentId };
        const node = sessionEntryToV4Node(entry, this.cwd);
        candidate.commitChanges([
          { type: "conversation_node", node },
          { type: "head", branchId: SESSION_V4_PRIMARY_BRANCH_ID, nodeId: node.id },
        ]);
        parentId = node.id;
      }
      if (source.name !== null) candidate.commitChanges([{ type: "session_name", name: source.name }]);
      for (const [nodeId, label] of source.labels) {
        candidate.commitChanges([{ type: "node_label", nodeId, label }]);
      }
      this.adoptCandidate(candidate);
      return this.sessionFile;
    } catch (error) {
      const failures = [error];
      try { candidate.closeV4Store(); } catch (closeError) { failures.push(closeError); }
      try { cleanup(); } catch (cleanupError) { failures.push(cleanupError); }
      if (failures.length > 1) throw new AggregateError(failures, "Branched session creation and cleanup failed");
      throw error;
    }
  }

  static create(cwd: string, sessionDir?: string, options?: NewSessionOptions): SessionManager {
    const directory = sessionDir === undefined ? getDefaultSessionDir(cwd) : absolutePath(sessionDir);
    if (sessionDir !== undefined) preparePrivateSessionDirectory(directory);
    return new SessionManager({
      cwd, sessionDir: directory, persist: true,
      ...optionalProperties(options === undefined ? undefined : { newSessionOptions: options }),
    });
  }

  static open(path: string, sessionDir?: string, cwdOverride?: string, options?: { readOnly?: boolean }): SessionManager {
    if (options?.readOnly === true) return SessionManager.openSnapshotManager(path, cwdOverride);
    const file = absolutePath(path);
    if (!existsSync(file)) throw new Error("Session file does not exist: " + file);
    const directory = sessionDir === undefined ? dirname(file) : absolutePath(sessionDir);
    if (!isSqliteSessionFile(file)) return SessionManager.resumeJsonl(file, directory, cwdOverride);
    const journal = new SessionStorageJournal(new SqliteSessionStorageBackend(dirname(file)).open(file));
    try {
      return new SessionManager({
        cwd: cwdOverride ?? journal.inspectState((state) => state.header.cwd),
        sessionDir: directory, persist: true, journal,
      });
    } catch (error) { journal.close(); throw error; }
  }

  /** Each step stages at most 128 validated records. Callers drain it or inject cancellation with throw(). */
  private static *importCandidate(source: SessionV4State, directory: string, cwdOverride?: string): Generator<void, SessionManager> {
    const backend = directory === "" ? undefined : new SqliteSessionStorageBackend(directory);
    const storage = backend?.create(source.header, join(directory, `.ohm-import-${randomUUID()}.tmp`));
    let identity: { dev: bigint; ino: bigint } | undefined;
    try {
      if (storage !== undefined) identity = statSync(storage.path, { bigint: true });
      const memory = storage === undefined
        ? new SessionManager({ cwd: cwdOverride ?? source.header.cwd, sessionDir: "",
          persist: false, freshSession: { header: structuredClone(source.header) } })
        : undefined;
      const batch: SessionV4Commit[] = [];
      const append = (): void => {
        if (storage !== undefined) storage.appendBatch(batch);
        else for (const commit of batch) memory!.commitChanges(commit.changes, commit.commitId, commit.committedAt);
        batch.length = 0;
      };
      for (const commit of source.commits.values()) {
        batch.push(commit);
        if (batch.length === 128) { append(); yield; }
      }
      if (batch.length > 0) append();
      const manager = memory ?? new SessionManager({ cwd: cwdOverride ?? source.header.cwd, sessionDir: directory,
        persist: true, journal: new SessionStorageJournal(storage!) });
      manager.createdFile = storage !== undefined;
      return manager;
    } catch (error) {
      const failures = [error];
      try { storage?.close(); } catch (cleanup) { failures.push(cleanup); }
      try { if (storage !== undefined && identity !== undefined) backend!.remove(storage.path, identity); }
      catch (cleanup) { failures.push(cleanup); }
      if (failures.length > 1) throw new AggregateError(failures, "Session import and cleanup failed");
      throw error;
    }
  }

  private static publishImport(manager: SessionManager): SessionManager {
    if (!manager.persist) return manager;
    const file = manager.getSessionFile();
    if (file === undefined) throw new Error("Session import has no staged database");
    const identity = lstatSync(file, { bigint: true });
    manager.closeV4Store();
    const store = new SqliteSessionStorageBackend(manager.sessionDir);
    const storage = store.publish(file, manager.sessionId);
    try {
      const journal = new SessionStorageJournal(storage);
      const opened = new SessionManager({ cwd: manager.cwd, sessionDir: manager.sessionDir, persist: true, journal });
      opened.createdFile = true;
      return opened;
    } catch (error) {
      const failures = [error];
      try { storage.close(); } catch (cleanup) { failures.push(cleanup); }
      try { store.remove(storage.path, identity); }
      catch (cleanup) { if (errorCode(cleanup) !== "ENOENT") failures.push(cleanup); }
      if (failures.length > 1) throw new AggregateError(failures, "Published session import and cleanup failed");
      throw error;
    }
  }

  private static resumeJsonl(file: string, directory: string, cwdOverride?: string): SessionManager {
    const lease = acquireSessionWriterLeaseSync(file);
    try {
      lease.bindToFile();
      return SessionManager.copyLegacySession(file, directory, cwdOverride);
    } finally { lease.release(); }
  }

  private static copyLegacySession(file: string, directory: string, cwdOverride?: string): SessionManager {
    const source = stateFromFile(file).state;
    const target = new SqliteSessionStorageBackend(directory).pathFor(source.header.sessionId);
    if (existsSync(target)) {
      const current = stateFromFile(target).state;
      if (!includesJournal(source, current)) {
        throw new LegacySessionConflictError(`Legacy session conflicts with an existing SQLite session: ${file}`);
      }
      return SessionManager.open(target, directory, cwdOverride);
    }
    const importing = SessionManager.importCandidate(source, directory, cwdOverride);
    let step = importing.next();
    while (!step.done) step = importing.next();
    const manager = step.value;
    const cleanup = manager.captureCreatedSessionCleanup();
    try {
      return SessionManager.publishImport(manager);
    } catch (error) {
      const failures = [error];
      try { manager.closeV4Store(); } catch (closeError) { failures.push(closeError); }
      try { cleanup(); } catch (cleanupError) { failures.push(cleanupError); }
      if (failures.length > 1) throw new AggregateError(failures, "Legacy session copy and cleanup failed");
      throw error;
    }
  }

  /**
   * Opens an immutable capture of the committed state without acquiring the file's writer slot.
   * The returned reader does not observe commits made after it opens.
   */
  static openSnapshot(path: string, cwdOverride?: string): ReadonlySessionManager {
    return SessionManager.openSnapshotManager(path, cwdOverride);
  }

  private static openSnapshotManager(path: string, cwdOverride?: string): SessionManager {
    const file = absolutePath(path);
    const loaded = stateFromFile(file);
    return new SessionManager({
      cwd: cwdOverride ?? loaded.state.header.cwd,
      sessionDir: dirname(file),
      sessionFile: file,
      persist: true,
      snapshotState: loaded.state,
      snapshotBytes: loaded.committedBytes,
    });
  }

  /** @internal Opens an immutable projection from an already bounded file snapshot. */
  static openSnapshotBytes(path: string, bytes: Uint8Array, cwdOverride?: string): SessionManager {
    const file = absolutePath(path);
    const loaded = parseSessionV4Bytes(bytes);
    if (loaded.state.nodes.size > MAX_SESSION_ENTRY_COUNT) {
      throw new Error(`Session entry count exceeds the limit of ${MAX_SESSION_ENTRY_COUNT}: ${file}`);
    }
    return new SessionManager({
      cwd: cwdOverride ?? loaded.state.header.cwd,
      sessionDir: dirname(file),
      sessionFile: file,
      persist: true,
      snapshotState: loaded.state,
      snapshotBytes: loaded.committedBytes,
    });
  }

  /** @internal Import a validated JSONL snapshot into the selected session directory without
   * changing its header, commit identities, recovery records or opaque provider state.
   */
  static async importJsonl(
    path: string,
    directory: string,
    options: { cwdOverride?: string; signal?: AbortSignal } = {},
  ): Promise<SessionManager> {
    options.signal?.throwIfAborted();
    const source = readSessionV4FileSync(absolutePath(path)).state;
    if (source.nodes.size > MAX_SESSION_ENTRY_COUNT) throw new Error(`Session entry count exceeds the limit of ${MAX_SESSION_ENTRY_COUNT}`);
    const importing = SessionManager.importCandidate(source, directory === "" ? "" : absolutePath(directory), options.cwdOverride);
    let step = importing.next();
    while (!step.done) {
      try {
        await new Promise<void>((resolveValue) => setImmediate(resolveValue));
        options.signal?.throwIfAborted();
      }
      catch (error) { importing.throw(error); throw error; }
      step = importing.next();
    }
    const manager = step.value;
    const cleanup = manager.captureCreatedSessionCleanup();
    try {
      options.signal?.throwIfAborted();
      return SessionManager.publishImport(manager);
    } catch (error) {
      const failures = [error];
      try { manager.closeV4Store(); }
      catch (closeError) { failures.push(closeError); }
      try { cleanup(); }
      catch (cleanupError) { failures.push(cleanupError); }
      if (failures.length > 1) throw new AggregateError(failures, "Session import and cleanup failed");
      throw error;
    }
  }

  static continueRecent(cwd: string, sessionDir?: string): SessionManager {
    const directory = sessionDir === undefined ? getDefaultSessionDir(cwd) : absolutePath(sessionDir);
    if (sessionDir !== undefined) preparePrivateSessionDirectory(directory);
    for (const candidate of recentSessionCandidates(directory, cwd)) {
      try {
        return SessionManager.open(candidate.path, directory, cwd);
      } catch (error) { if (error instanceof LegacySessionConflictError) throw error; }
    }
    return SessionManager.create(cwd, directory);
  }

  static inMemory(cwd = process.cwd(), options?: NewSessionOptions): SessionManager {
    return new SessionManager({
      cwd,
      sessionDir: "",
      persist: false,
      ...optionalProperties(options === undefined ? undefined : { newSessionOptions: options }),
    });
  }

  cloneInMemory(): SessionManager {
    const clone = SessionManager.inMemory(this.cwd);
    clone.sessionId = this.sessionId;
    clone.memoryState = this.inspectState(cloneSessionV4State);
    clone.logicalFileBytes = this.logicalFileBytes;
    return clone;
  }

  static forkFrom(
    sourcePath: string,
    targetCwd: string,
    sessionDir?: string,
    options?: NewSessionOptions,
  ): SessionManager {
    const source = absolutePath(sourcePath);
    const sourceState = stateFromFile(source).state;
    const cwd = absolutePath(targetCwd);
    const directory = sessionDir === undefined ? getDefaultSessionDir(cwd) : absolutePath(sessionDir);
    const target = SessionManager.create(cwd, directory, {
      ...optionalProperties(options?.id === undefined ? undefined : { id: options.id }),
      parentSession: sourceState.header.sessionId,
    });
    const cleanup = target.captureCreatedSessionCleanup();
    try {
      for (const node of sourceState.nodes.values()) {
        const copied = structuredClone(node);
        delete copied.operationId;
        target.commitChanges([
          { type: "conversation_node", node: copied },
          { type: "head", branchId: SESSION_V4_PRIMARY_BRANCH_ID, nodeId: copied.id },
        ]);
      }
      const sourceHead = primaryBranch(sourceState).headNodeId;
      if (sourceHead !== target.getLeafId()) {
        target.commitChanges([{
          type: "head",
          branchId: SESSION_V4_PRIMARY_BRANCH_ID,
          nodeId: sourceHead,
        }]);
      }
      if (sourceState.name !== null) target.commitChanges([{ type: "session_name", name: sourceState.name }]);
      for (const [nodeId, label] of sourceState.labels) {
        target.commitChanges([{ type: "node_label", nodeId, label }]);
      }
      return target;
    } catch (error) {
      const failures = [error];
      try {
        target.closeV4Store();
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
      try { cleanup(); } catch (cleanupError) { failures.push(cleanupError); }
      if (failures.length === 1) throw error;
      throw new AggregateError(failures, "Session fork failed and its candidate could not be removed cleanly");
    }
  }

  static async list(cwd: string, sessionDir?: string, progress?: SessionListProgress): Promise<SessionInfo[]> {
    return (await SessionManager.inspect(cwd, sessionDir, false, progress)).sessions;
  }

  static async inspectFile(path: string): Promise<SessionInfo> {
    return await readSessionInfo(absolutePath(path));
  }

  static async inspect(
    cwd: string,
    sessionDir?: string,
    allWorkspaces = false,
    progress?: SessionListProgress,
  ): Promise<SessionScanResult> {
    if (allWorkspaces) {
      const customDirectory = sessionDir === undefined ? undefined : absolutePath(sessionDir);
      const scanned = await scanAllSessions(customDirectory, progress);
      sortSessions(scanned.sessions);
      scanned.invalid.sort((left, right) => comparePath(left.path, right.path));
      return scanned;
    }

    const directory = sessionDir === undefined ? getDefaultSessionDir(cwd) : absolutePath(sessionDir);
    const scanned = await scanDirectory(directory, progress);
    scanned.sessions = sortSessions(scanned.sessions
      .filter((session) => sameCwd(session.cwd, cwd)));
    scanned.invalid.sort((left, right) => comparePath(left.path, right.path));
    return scanned;
  }

  static async listAll(progress?: SessionListProgress): Promise<SessionInfo[]>;
  static async listAll(sessionDir?: string, progress?: SessionListProgress): Promise<SessionInfo[]>;
  static async listAll(
    sessionDirOrProgress?: string | SessionListProgress,
    progressArgument?: SessionListProgress,
  ): Promise<SessionInfo[]> {
    const customDirectory = Value.Check(STRING_VALUE, sessionDirOrProgress)
      ? absolutePath(sessionDirOrProgress)
      : undefined;
    const progress = Value.Check(FUNCTION_VALUE, sessionDirOrProgress)
      ? sessionDirOrProgress
      : progressArgument;
    const scanned = await scanAllSessions(customDirectory, progress);
    return sortSessions(scanned.sessions);
  }
}

type SessionIdentityReader =
  | "isPersisted"
  | "getSessionId"
  | "getSessionFile"
  | "getCwd"
  | "getSessionDir";

type SessionHistoryReader =
  | "getLeafId"
  | "getLeafEntry"
  | "getEntry"
  | "getBranch"
  | "getHistoryPage"
  | "searchHistory"
  | "findEntriesOnBranch"
  | "findEntryOnBranch"
  | "getActiveBranchUsage"
  | "getEntries"
  | "getTree"
  | "buildContextEntries"
  | "buildSessionContext";

type SessionMetadataReader = "getLabel" | "getHeader" | "getSessionName" | "getPersistedSelection";

export type ReadonlySessionManager = Pick<
  SessionManager,
  SessionIdentityReader | SessionHistoryReader | SessionMetadataReader
>;
