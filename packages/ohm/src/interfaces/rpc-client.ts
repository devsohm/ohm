import { optionalProperties } from "../core/optional-properties.js";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import type { Api, ImageContent, Model } from "@ohm/models";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { isJsonObject, type JsonValue } from "../core/json.js";
import type { CompactionResult } from "../extensions/direct.js";
import type {
  ExtensionWireServiceDescriptor,
  ExtensionWireServiceRequest,
  ExtensionWireServiceResponse,
} from "../extensions/wire-services.js";
import type {
  PortablePresentationActionRequest,
  PortablePresentationActionResult,
  PortablePresentationEvent,
} from "./portable-presentation.js";
import { terminateProcessTreeAsync } from "../process/process-tree.js";
import type { ProviderModelThinkingLevel } from "../providers/models.js";
import type {
  AgentSessionBashResult,
  AgentSessionEvent,
  AgentSessionStats,
} from "../service/agent-session.js";
import { boundedRpcErrorMessage } from "./rpc-error.js";
import { attachJsonlLineReader, serializeJsonLine } from "./rpc.js";
import type {
  RpcBashExecutionUpdate,
  RpcAgentMessage,
  RpcCommand,
  RpcEntryPage,
  RpcExtensionErrorEvent,
  RpcExtensionUiRequest,
  RpcExtensionUiResponse,
  RpcMessagePage,
  RpcRecoveryResolution,
  RpcRecoveryResult,
  RpcRecoveryStatus,
  RpcResponse,
  RpcSessionState,
  RpcSessionTreeNode,
  RpcSlashCommand,
  RpcTreePage,
} from "./rpc-protocol.js";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type RpcCommandBody = DistributiveOmit<RpcCommand, "id">;
type RpcCommandType = RpcCommand["type"];

const RPC_RESPONSE_ENVELOPE_VALUE = Type.Object({
  type: Type.Literal("response"),
  id: Type.String(),
  command: Type.String(),
  success: Type.Boolean(),
  error: Type.Optional(Type.String()),
  data: Type.Optional(Type.Unknown()),
}, { additionalProperties: true });
const STRING_VALUE = Type.String();
const BOOLEAN_VALUE = Type.Boolean();

export interface RpcClientOptions {
  args?: string[];
  model?: string;
  provider?: string;
  env?: Record<string, string>;
  cwd?: string;
  /** Path to the compiled CLI entry point. */
  cliPath?: string;
}

export type RpcStreamEvent =
  | AgentSessionEvent
  | RpcBashExecutionUpdate
  | RpcExtensionUiRequest
  | RpcExtensionErrorEvent
  | PortablePresentationEvent;
export type RpcEventListener = (event: RpcStreamEvent) => void;

interface PendingRequest {
  command: RpcCommandType;
  timer: NodeJS.Timeout;
  resolve(response: RpcResponse): void;
  reject(error: Error): void;
}

interface RequestTicket {
  id: string;
  promise: Promise<RpcResponse>;
}

interface TreeFragmentWork {
  fragment: RpcSessionTreeNode;
  declaredParentId?: string;
}

interface EntryPageCursor {
  since?: string;
  afterSequence?: number;
  limit: number;
}

interface EventCollection {
  promise: Promise<RpcStreamEvent[]>;
  dispose(): void;
}

type RetainedRpcPage = RpcEntryPage | RpcTreePage | RpcMessagePage;

type ClientPhase = "stopped" | "starting" | "running" | "stopping" | "exited";
type InternalEventListener = (event: RpcStreamEvent, bytes: number) => void;

const RPC_REQUEST_TIMEOUT_MS = 30_000;
const RPC_WRITE_TIMEOUT_MS = 30_000;
const RPC_STOP_GRACE_MS = 1_000;
const RPC_KILL_WAIT_MS = 1_000;
const RPC_MAX_PENDING_REQUESTS = 64;
const RPC_MAX_EVENT_WAITERS = 256;
const RPC_MAX_COLLECTED_EVENTS = 4_096;
const RPC_MAX_COLLECTED_EVENT_BYTES = 32 * 1024 * 1024;
const RPC_MAX_AGGREGATE_ITEMS = 32_768;
const RPC_MAX_AGGREGATE_BYTES = 32 * 1024 * 1024;
const RPC_HISTORY_PAGE_SIZE = 2_048;
const RPC_STDERR_MAX_BYTES = 64 * 1024;
const RPC_STDERR_TRUNCATION_MARKER = "[stderr truncated]\n";
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const RPC_DATA_COMMANDS = new Set<RpcCommandType>([
  "clear_queue",
  "new_session",
  "get_state",
  "get_recovery_status",
  "recover_interrupted_run",
  "set_model",
  "cycle_model",
  "get_available_models",
  "cycle_thinking_level",
  "get_available_thinking_levels",
  "compact",
  "bash",
  "get_session_stats",
  "export_html",
  "switch_session",
  "fork",
  "clone",
  "get_fork_messages",
  "get_entries",
  "get_tree",
  "get_last_assistant_text",
  "get_messages",
  "get_commands",
  "get_portable_presentations",
  "presentation_action",
  "get_extension_wire_services",
  "extension_wire_request",
]);

function validateTimeout(timeout: number): void {
  if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > MAX_TIMER_DELAY_MS) {
    throw new RangeError(`timeout must be an integer from 0 to ${MAX_TIMER_DELAY_MS}`);
  }
}

function isCorrelatedRpcResponse<ValueType>(value: ValueType): value is ValueType & RpcResponse & { id: string } {
  if (!Value.Check(RPC_RESPONSE_ENVELOPE_VALUE, value)) return false;
  return value.success || Value.Check(STRING_VALUE, value.error);
}

function safeFailure<SourceType>(prefix: string, source: SourceType, stderr: BoundedStderr): Error {
  const detail = boundedRpcErrorMessage(source);
  const diagnostic = boundedRpcErrorMessage(stderr.text());
  return new Error(boundedRpcErrorMessage(
    `${prefix}: ${detail}. Diagnostic stderr tail: ${diagnostic === "" ? "(empty)" : diagnostic}`,
  ));
}

class BoundedStderr {
  #buffer: Buffer = Buffer.alloc(0);
  #truncated = false;

  clear(): void {
    this.#buffer = Buffer.alloc(0);
    this.#truncated = false;
  }

  append(data: Buffer | string): void {
    const incoming = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
    const maximum = RPC_STDERR_MAX_BYTES - Buffer.byteLength(RPC_STDERR_TRUNCATION_MARKER, "utf8");
    if (incoming.byteLength >= maximum) {
      const discarded = this.#buffer.byteLength > 0 || incoming.byteLength > maximum;
      this.#buffer = this.#utf8Tail(incoming, maximum);
      this.#truncated ||= discarded;
      return;
    }
    const combined = Buffer.concat(
      [this.#buffer, incoming],
      this.#buffer.byteLength + incoming.byteLength,
    );
    if (combined.byteLength <= maximum) {
      this.#buffer = combined;
      return;
    }
    this.#buffer = this.#utf8Tail(combined, maximum);
    this.#truncated = true;
  }

  text(): string {
    return `${this.#truncated ? RPC_STDERR_TRUNCATION_MARKER : ""}${this.#buffer.toString("utf8")}`;
  }

  #utf8Tail(value: Buffer, maximum: number): Buffer {
    let start = value.byteLength - maximum;
    while (start < value.byteLength && (value[start]! & 0xc0) === 0x80) start += 1;
    return Buffer.from(value.subarray(start));
  }
}

class BoundedRequestBroker {
  readonly #pending = new Map<string, PendingRequest>();
  #nextId = 0;

  constructor(
    readonly maximumPending: number,
    readonly timeoutMs: number,
    readonly diagnostic: () => string,
  ) {}

  get size(): number { return this.#pending.size; }

  open(command: RpcCommandType): RequestTicket {
    if (this.#pending.size >= this.maximumPending) {
      throw new Error(`RPC client cannot exceed ${this.maximumPending} pending requests`);
    }
    const id = this.#allocateId();
    const promise = new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(
          `No ${command} response arrived within ${this.timeoutMs} ms. Diagnostic stderr tail: ${this.diagnostic()}`,
        ));
      }, this.timeoutMs);
      this.#pending.set(id, { command, timer, resolve, reject });
    });
    return { id, promise };
  }

  accept(response: RpcResponse & { id: string }): Error | undefined {
    const pending = this.#pending.get(response.id);
    if (pending === undefined) return undefined;
    this.#pending.delete(response.id);
    clearTimeout(pending.timer);
    if (response.command !== pending.command) {
      const error = new Error(`RPC response command did not match ${pending.command}`);
      pending.reject(error);
      return error;
    }
    const hasData = "data" in response;
    if (response.success ? hasData !== RPC_DATA_COMMANDS.has(pending.command) : hasData) {
      const error = new Error(`RPC response data did not match ${pending.command}`);
      pending.reject(error);
      return error;
    }
    pending.resolve(response);
    return undefined;
  }

  has(id: string): boolean { return this.#pending.has(id); }

  reject(id: string, error: Error): void {
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #allocateId(): string {
    do {
      this.#nextId = this.#nextId === Number.MAX_SAFE_INTEGER ? 1 : this.#nextId + 1;
    } while (this.#pending.has(`req_${this.#nextId}`));
    return `req_${this.#nextId}`;
  }
}

class AggregateBudget {
  #count = 0;
  #bytes = 0;

  constructor(readonly pageMethod: "getEntriesPage" | "getTreePage" | "getMessagesPage") {}

  assertExpectedCount(count: number): void {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error(`RPC history reported an invalid aggregate item count for ${this.pageMethod}`);
    }
    if (count > RPC_MAX_AGGREGATE_ITEMS) this.#overflow();
  }

  add(count: number, bytes: number): void {
    if (!Number.isSafeInteger(count) || count < 0 || this.#count + count > RPC_MAX_AGGREGATE_ITEMS) {
      this.#overflow();
    }
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > RPC_MAX_AGGREGATE_BYTES - this.#bytes) {
      this.#overflow();
    }
    this.#count += count;
    this.#bytes += bytes;
  }

  #overflow(): never {
    throw new Error(
      `RPC history exceeds the aggregate retention limit; use ${this.pageMethod}() to consume bounded pages`,
    );
  }
}

function validateTotal(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
}

function validateLeafId(value: string | null, command: string): void {
  if (value !== null && !Value.Check(STRING_VALUE, value)) {
    throw new Error(`${command} response has an invalid leafId`);
  }
}

function validateCursorPage(
  command: "get_tree" | "get_messages",
  cursor: string | undefined,
  nextCursor: string | null,
  hasMore: boolean,
  seen: Set<string>,
): string | undefined {
  if (!Value.Check(BOOLEAN_VALUE, hasMore)) throw new Error(`${command} response has an invalid hasMore flag`);
  if (!hasMore) {
    if (nextCursor !== null) throw new Error(`${command} terminal response retained a continuation cursor`);
    return undefined;
  }
  if (!Value.Check(STRING_VALUE, nextCursor) || nextCursor === "") {
    throw new Error(`${command} response is missing its continuation cursor`);
  }
  if (nextCursor === cursor || seen.has(nextCursor)) {
    throw new Error(`${command} response did not advance its continuation cursor`);
  }
  seen.add(nextCursor);
  return nextCursor;
}

function flattenTreeFragments(fragments: readonly RpcSessionTreeNode[]): Map<string, RpcSessionTreeNode> {
  const nodes = new Map<string, RpcSessionTreeNode>();
  const pending: TreeFragmentWork[] = fragments.map((fragment) => ({ fragment }));
  while (pending.length > 0) {
    const work = pending.pop();
    if (work === undefined) throw new Error("get_tree response work queue changed unexpectedly");
    const { fragment, declaredParentId } = work;
    if (!isJsonObject(fragment) || !isJsonObject(fragment.entry) || !Array.isArray(fragment.children)) {
      throw new Error("get_tree response contains an invalid tree node");
    }
    const entry = fragment.entry;
    const id = entry["id"];
    const parentId = entry["parentId"];
    const timestamp = entry["timestamp"];
    if (!Value.Check(STRING_VALUE, id) || id === "") {
      throw new Error("get_tree response contains an invalid entry ID");
    }
    if (parentId !== null && !Value.Check(STRING_VALUE, parentId)) {
      throw new Error("get_tree response contains an invalid parent ID");
    }
    if (!Value.Check(STRING_VALUE, timestamp) || !Number.isFinite(Date.parse(timestamp))) {
      throw new Error("get_tree response contains an invalid timestamp");
    }
    if (declaredParentId !== undefined && parentId !== declaredParentId) {
      throw new Error("get_tree response contradicts a nested parent");
    }
    if (nodes.has(id)) throw new Error("get_tree response contains a duplicate entry ID");
    nodes.set(id, {
      entry: fragment.entry,
      children: [],
      ...optionalProperties(fragment.label === undefined ? undefined : { label: fragment.label }),
      ...optionalProperties(fragment.labelTimestamp === undefined ? undefined : { labelTimestamp: fragment.labelTimestamp }),
    });
    for (const child of fragment.children) {
      pending.push({ fragment: child, declaredParentId: id });
    }
  }
  return nodes;
}

function assembleSessionTree(fragments: readonly RpcSessionTreeNode[], expectedCount: number): RpcSessionTreeNode[] {
  const nodes = flattenTreeFragments(fragments);
  if (nodes.size !== expectedCount) {
    throw new Error(`get_tree response assembled ${nodes.size} entries but reported ${expectedCount}`);
  }
  const states = new Map<string, "visiting" | "visited">();
  for (const id of nodes.keys()) {
    if (states.get(id) === "visited") continue;
    const path: string[] = [];
    let current: string | null = id;
    while (current !== null) {
      const state = states.get(current);
      if (state === "visiting") throw new Error("get_tree response contains a parent cycle");
      if (state === "visited") break;
      const node = nodes.get(current);
      if (node === undefined) throw new Error("get_tree response is missing a parent entry");
      states.set(current, "visiting");
      path.push(current);
      current = node.entry.parentId;
    }
    for (const visited of path) states.set(visited, "visited");
  }

  const roots: RpcSessionTreeNode[] = [];
  for (const node of nodes.values()) {
    const parentId = node.entry.parentId;
    if (parentId === null) roots.push(node);
    else {
      const parent = nodes.get(parentId);
      if (parent === undefined) throw new Error("get_tree response is missing a parent entry");
      parent.children.push(node);
    }
  }
  const pending = roots.slice();
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) throw new Error("get_tree response work queue changed unexpectedly");
    node.children.sort((left, right) =>
      Date.parse(left.entry.timestamp) - Date.parse(right.entry.timestamp));
    pending.push(...node.children);
  }
  return roots;
}

export class RpcClient {
  #process: ChildProcess | undefined;
  #phase: ClientPhase = "stopped";
  #stopReading: (() => void) | undefined;
  #stopPromise: Promise<void> | undefined;
  readonly #listeners = new Set<InternalEventListener>();
  readonly #disconnectListeners = new Set<(error: Error) => void>();
  readonly #responseBytes = new WeakMap<object, number>();
  readonly #stderr = new BoundedStderr();
  readonly #broker = new BoundedRequestBroker(
    RPC_MAX_PENDING_REQUESTS,
    RPC_REQUEST_TIMEOUT_MS,
    () => boundedRpcErrorMessage(this.#stderr.text()) || "(empty)",
  );
  #activeEventWaiters = 0;
  #exitError: Error | undefined;
  readonly #options: RpcClientOptions;

  constructor(options: RpcClientOptions = {}) {
    this.#options = options;
  }

  get started(): boolean {
    return this.#phase === "starting" || this.#phase === "running" || this.#phase === "stopping";
  }
  get pendingRequestCount(): number { return this.#broker.size; }

  async start(): Promise<void> {
    if (this.#process !== undefined) {
      if (this.#phase !== "exited") throw new Error("The RPC client has already been started");
      await this.stop();
    }
    this.#phase = "starting";
    this.#exitError = undefined;
    this.#stderr.clear();
    const cliPath = this.#options.cliPath ?? fileURLToPath(new URL("../bin/ohm.js", import.meta.url));
    const args = [cliPath, "--mode", "rpc"];
    if (this.#options.provider !== undefined) args.push("--provider", this.#options.provider);
    if (this.#options.model !== undefined) args.push("--model", this.#options.model);
    if (this.#options.args !== undefined) args.push(...this.#options.args);

    let child: ChildProcess;
    try {
      child = spawn(process.execPath, args, {
        cwd: this.#options.cwd,
        env: { ...process.env, ...this.#options.env },
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      this.#phase = "stopped";
      throw safeFailure("Failed to spawn the agent subprocess", error, this.#stderr);
    }
    this.#process = child;
    child.stderr?.on("data", (data: Buffer | string) => {
      if (this.#process === child) this.#stderr.append(data);
    });
    child.once("exit", (code, signal) => {
      if (this.#process !== child) return;
      if (this.#phase !== "stopping") this.#phase = "exited";
      this.#signalDisconnect(this.#createProcessExitError(code, signal));
    });
    child.once("error", (source) => {
      if (this.#process !== child) return;
      if (this.#phase !== "stopping") this.#phase = "exited";
      this.#signalDisconnect(safeFailure("Agent subprocess failed", source, this.#stderr));
    });
    child.stdin?.on("error", (source) => {
      if (this.#process !== child) return;
      this.#signalDisconnect(
        this.#exitError ?? safeFailure("Writing to the agent subprocess failed", source, this.#stderr),
      );
    });
    if (child.stdout === null) {
      const error = new Error("The agent subprocess has no readable stdout stream");
      this.#signalDisconnect(error);
      await this.stop();
      throw error;
    }
    this.#stopReading = attachJsonlLineReader(
      child.stdout,
      (line) => this.#handleLine(child, line),
      (source) => this.#protocolFailure(child, "The agent emitted an invalid RPC record", source),
    );

    try {
      await this.#waitForSpawn(child);
      if (this.#process !== child || this.#phase !== "starting" || this.#exitError !== undefined) {
        throw this.#exitError ?? new Error("The RPC client stopped before its transport became ready");
      }
      this.#phase = "running";
    } catch (error) {
      const selected = this.#exitError ?? safeFailure("Agent subprocess startup failed", error, this.#stderr);
      await this.stop();
      throw selected;
    }
  }

  async stop(): Promise<void> {
    if (this.#stopPromise !== undefined) return await this.#stopPromise;
    const child = this.#process;
    if (child === undefined) {
      this.#phase = "stopped";
      return;
    }
    this.#phase = "stopping";
    const operation = this.#stopChild(child);
    this.#stopPromise = operation;
    try {
      await operation;
    } finally {
      if (this.#process === child) this.#process = undefined;
      this.#stopReading?.();
      this.#stopReading = undefined;
      this.#phase = "stopped";
      this.#stopPromise = undefined;
    }
  }

  onEvent(listener: RpcEventListener): () => void {
    return this.#subscribeEvent((event) => listener(event));
  }

  getStderr(): string { return this.#stderr.text(); }

  async prompt(message: string, images?: readonly ImageContent[], streamingBehavior?: "steer" | "followUp"): Promise<void> {
    await this.#send({
      type: "prompt",
      message,
      ...optionalProperties(images === undefined ? undefined : { images: [...images] }),
      ...optionalProperties(streamingBehavior === undefined ? undefined : { streamingBehavior }),
    });
  }

  async steer(message: string, images?: readonly ImageContent[]): Promise<void> {
    await this.#send({ type: "steer", message, ...optionalProperties(images === undefined ? undefined : { images: [...images] }) });
  }

  async followUp(message: string, images?: readonly ImageContent[]): Promise<void> {
    await this.#send({ type: "follow_up", message, ...optionalProperties(images === undefined ? undefined : { images: [...images] }) });
  }

  async abort(): Promise<void> { await this.#send({ type: "abort" }); }

  async clearQueue(): Promise<{ steering: string[]; followUp: string[] }> {
    return this.#data(await this.#send({ type: "clear_queue" }));
  }

  async newSession(parentSession?: string): Promise<{ cancelled: boolean }> {
    return this.#data(await this.#send({ type: "new_session", ...optionalProperties(parentSession === undefined ? undefined : { parentSession }) }));
  }

  async getState(): Promise<RpcSessionState> { return this.#data(await this.#send({ type: "get_state" })); }

  async invokePortablePresentationAction(
    request: PortablePresentationActionRequest,
  ): Promise<PortablePresentationActionResult> {
    return this.#data(await this.#send({ type: "presentation_action", ...request }));
  }

  async listPortablePresentations(): Promise<readonly PortablePresentationEvent[]> {
    return this.#data<{ presentations: readonly PortablePresentationEvent[] }>(
      await this.#send({ type: "get_portable_presentations" }),
    ).presentations;
  }

  async listExtensionWireServices(): Promise<readonly ExtensionWireServiceDescriptor[]> {
    return this.#data<{ services: readonly ExtensionWireServiceDescriptor[] }>(
      await this.#send({ type: "get_extension_wire_services" }),
    ).services;
  }

  async invokeExtensionWireService(
    request: ExtensionWireServiceRequest,
  ): Promise<ExtensionWireServiceResponse> {
    return this.#data(await this.#send({ type: "extension_wire_request", request }));
  }

  async getRecoveryStatus(): Promise<RpcRecoveryStatus | null> {
    return this.#data(await this.#send({ type: "get_recovery_status" }));
  }

  async recoverInterruptedRun(
    resolutions?: readonly RpcRecoveryResolution[],
  ): Promise<RpcRecoveryResult> {
    return this.#data(await this.#send({
      type: "recover_interrupted_run",
      ...optionalProperties(resolutions === undefined ? undefined : { resolutions: [...resolutions] }),
    }));
  }

  async setModel(provider: string, modelId: string): Promise<Model<Api>> {
    return this.#data(await this.#send({ type: "set_model", provider, modelId }));
  }

  async cycleModel(): Promise<{
    model: Model<Api>;
    thinkingLevel: ProviderModelThinkingLevel;
    isScoped: boolean;
  } | null> {
    return this.#data(await this.#send({ type: "cycle_model" }));
  }

  async getAvailableModels(): Promise<Model<Api>[]> {
    return this.#data<{ models: Model<Api>[] }>(
      await this.#send({ type: "get_available_models" }),
    ).models;
  }

  async setThinkingLevel(level: ProviderModelThinkingLevel): Promise<void> {
    await this.#send({ type: "set_thinking_level", level });
  }

  async cycleThinkingLevel(): Promise<{ level: ProviderModelThinkingLevel } | null> {
    return this.#data(await this.#send({ type: "cycle_thinking_level" }));
  }

  async getAvailableThinkingLevels(): Promise<ProviderModelThinkingLevel[]> {
    return this.#data<{ levels: ProviderModelThinkingLevel[] }>(
      await this.#send({ type: "get_available_thinking_levels" }),
    ).levels;
  }

  async setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void> {
    await this.#send({ type: "set_steering_mode", mode });
  }

  async setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void> {
    await this.#send({ type: "set_follow_up_mode", mode });
  }

  async compact(customInstructions?: string): Promise<CompactionResult> {
    return this.#data(await this.#send({ type: "compact", ...optionalProperties(customInstructions === undefined ? undefined : { customInstructions }) }));
  }

  async setAutoCompaction(enabled: boolean): Promise<void> {
    await this.#send({ type: "set_auto_compaction", enabled });
  }

  async setAutoRetry(enabled: boolean): Promise<void> { await this.#send({ type: "set_auto_retry", enabled }); }
  async abortRetry(): Promise<void> { await this.#send({ type: "abort_retry" }); }

  async bash(command: string, excludeFromContext?: boolean): Promise<AgentSessionBashResult> {
    return this.#data(await this.#send({ type: "bash", command, ...optionalProperties(excludeFromContext === undefined ? undefined : { excludeFromContext }) }));
  }

  async abortBash(): Promise<void> { await this.#send({ type: "abort_bash" }); }
  async getSessionStats(): Promise<AgentSessionStats> { return this.#data(await this.#send({ type: "get_session_stats" })); }

  async exportHtml(outputPath?: string): Promise<{ path: string }> {
    return this.#data(await this.#send({ type: "export_html", ...optionalProperties(outputPath === undefined ? undefined : { outputPath }) }));
  }

  async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
    return this.#data(await this.#send({ type: "switch_session", sessionPath }));
  }

  async fork(entryId: string): Promise<{ text: string; cancelled: boolean }> {
    return this.#data(await this.#send({ type: "fork", entryId }));
  }

  async clone(): Promise<{ cancelled: boolean }> { return this.#data(await this.#send({ type: "clone" })); }

  async getForkMessages(): Promise<Array<{ entryId: string; text: string }>> {
    return this.#data<{ messages: Array<{ entryId: string; text: string }> }>(
      await this.#send({ type: "get_fork_messages" }),
    ).messages;
  }

  async getEntriesPage(
    cursor?: string | { since?: string; afterSequence?: number; limit?: number },
  ): Promise<RpcEntryPage> {
    const options = Value.Check(STRING_VALUE, cursor) ? { since: cursor } : cursor;
    return this.#data(await this.#send({ type: "get_entries", ...options }));
  }

  async getEntries(since?: string): Promise<{ entries: RpcEntryPage["entries"]; leafId: string | null }> {
    const budget = new AggregateBudget("getEntriesPage");
    const entries: RpcEntryPage["entries"] = [];
    const ids = new Set<string>();
    let next: EntryPageCursor = since === undefined
      ? { afterSequence: 0, limit: RPC_HISTORY_PAGE_SIZE }
      : { since, limit: RPC_HISTORY_PAGE_SIZE };
    let leafId: string | null | undefined;
    let totalEntries: number | undefined;
    let expectedCount: number | undefined;
    for (;;) {
      const page = await this.getEntriesPage(next);
      if (!Array.isArray(page.entries)) throw new Error("get_entries response has an invalid entries array");
      validateLeafId(page.leafId, "get_entries");
      validateTotal(page.totalEntries, "get_entries totalEntries");
      validateTotal(page.sequenceStart, "get_entries sequenceStart");
      validateTotal(page.nextSequence, "get_entries nextSequence");
      if (!Value.Check(BOOLEAN_VALUE, page.hasMore)) throw new Error("get_entries response has an invalid hasMore flag");
      if (page.entries.length === 0) {
        if (page.sequenceStart !== page.nextSequence) {
          throw new Error("get_entries empty response has inconsistent sequence bounds");
        }
      } else if (page.sequenceStart + page.entries.length - 1 !== page.nextSequence) {
        throw new Error("get_entries response has inconsistent sequence bounds");
      }
      if (next.afterSequence !== undefined && page.nextSequence !== next.afterSequence + page.entries.length) {
        throw new Error("get_entries response does not match its requested continuation sequence");
      }
      if (page.hasMore !== (page.nextSequence < page.totalEntries)) {
        throw new Error("get_entries response has inconsistent continuation metadata");
      }
      if (leafId === undefined) {
        leafId = page.leafId;
        totalEntries = page.totalEntries;
        const startOffset = page.entries.length === 0 ? page.nextSequence : page.sequenceStart - 1;
        expectedCount = page.totalEntries - startOffset;
        budget.assertExpectedCount(expectedCount);
      } else if (page.leafId !== leafId || page.totalEntries !== totalEntries) {
        throw new Error("get_entries history changed while pagination was in progress");
      }
      budget.add(page.entries.length, this.#retainedBytes(page));
      for (const entry of page.entries) {
        if (!isJsonObject(entry) || !Value.Check(STRING_VALUE, entry["id"]) || entry["id"] === "") {
          throw new Error("get_entries response contains an invalid entry ID");
        }
        if (ids.has(entry["id"])) throw new Error("get_entries response contains a duplicate entry ID");
        ids.add(entry["id"]);
        entries.push(entry);
      }
      if (!page.hasMore) {
        if (entries.length !== expectedCount) {
          throw new Error(`get_entries response assembled ${entries.length} entries but expected ${expectedCount}`);
        }
        return { entries, leafId: leafId ?? null };
      }
      const previousSequence = next.afterSequence
        ?? (page.entries.length === 0 ? page.nextSequence : page.sequenceStart - 1);
      if (page.nextSequence <= previousSequence) {
        throw new Error("get_entries response did not advance its continuation sequence");
      }
      next = { afterSequence: page.nextSequence, limit: RPC_HISTORY_PAGE_SIZE };
    }
  }

  async getTreePage(options: { cursor?: string; limit?: number } = {}): Promise<RpcTreePage> {
    return this.#data(await this.#send({ type: "get_tree", ...options }));
  }

  async getTree(): Promise<{ tree: RpcSessionTreeNode[]; leafId: string | null }> {
    const budget = new AggregateBudget("getTreePage");
    const fragments: RpcSessionTreeNode[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let leafId: string | null | undefined;
    let totalEntries: number | undefined;
    for (;;) {
      const page = await this.getTreePage(cursor === undefined ? {} : { cursor });
      if (!Array.isArray(page.tree)) throw new Error("get_tree response has an invalid tree array");
      validateLeafId(page.leafId, "get_tree");
      validateTotal(page.totalEntries, "get_tree totalEntries");
      const pageNodeCount = flattenTreeFragments(page.tree).size;
      if (leafId === undefined) {
        leafId = page.leafId;
        totalEntries = page.totalEntries;
        budget.assertExpectedCount(totalEntries);
      } else if (page.leafId !== leafId || page.totalEntries !== totalEntries) {
        throw new Error("get_tree history changed while pagination was in progress");
      }
      budget.add(pageNodeCount, this.#retainedBytes(page));
      fragments.push(...page.tree);
      const continuation = validateCursorPage("get_tree", cursor, page.nextCursor, page.hasMore, cursors);
      if (continuation === undefined) {
        const count = totalEntries ?? 0;
        const tree = assembleSessionTree(fragments, count);
        if (leafId !== null && leafId !== undefined && !flattenTreeFragments(tree).has(leafId)) {
          throw new Error("get_tree response is missing its leaf entry");
        }
        return { tree, leafId: leafId ?? null };
      }
      cursor = continuation;
    }
  }

  async getLastAssistantText(): Promise<string | null> {
    return this.#data<{ text: string | null }>(await this.#send({ type: "get_last_assistant_text" })).text;
  }

  async setSessionName(name: string): Promise<void> { await this.#send({ type: "set_session_name", name }); }

  async getMessagesPage(options: { cursor?: string; limit?: number } = {}): Promise<RpcMessagePage> {
    return this.#data(await this.#send({ type: "get_messages", ...options }));
  }

  async getMessages(): Promise<RpcAgentMessage[]> {
    const budget = new AggregateBudget("getMessagesPage");
    const messages: RpcAgentMessage[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let totalMessages: number | undefined;
    for (;;) {
      const page = await this.getMessagesPage(cursor === undefined ? {} : { cursor });
      if (!Array.isArray(page.messages)) throw new Error("get_messages response has an invalid messages array");
      validateTotal(page.totalMessages, "get_messages totalMessages");
      if (totalMessages === undefined) {
        totalMessages = page.totalMessages;
        budget.assertExpectedCount(totalMessages);
      } else if (page.totalMessages !== totalMessages) {
        throw new Error("get_messages history changed while pagination was in progress");
      }
      budget.add(page.messages.length, this.#retainedBytes(page));
      messages.push(...page.messages);
      const continuation = validateCursorPage("get_messages", cursor, page.nextCursor, page.hasMore, cursors);
      if (continuation === undefined) {
        if (messages.length !== totalMessages) {
          throw new Error(`get_messages response assembled ${messages.length} messages but reported ${totalMessages}`);
        }
        return messages;
      }
      cursor = continuation;
    }
  }

  async getCommands(): Promise<RpcSlashCommand[]> {
    return this.#data<{ commands: RpcSlashCommand[] }>(await this.#send({ type: "get_commands" })).commands;
  }

  async respondToExtensionUi(response: RpcExtensionUiResponse): Promise<void> {
    const input = this.#writableInput();
    let line: string;
    try {
      line = serializeJsonLine(response);
    } catch (error) {
      throw safeFailure("Could not serialize the extension UI response", error, this.#stderr);
    }
    try {
      await this.#writeLine(input, line);
    } catch (error) {
      const failure = this.#exitError
        ?? safeFailure("Writing the extension UI response failed", error, this.#stderr);
      this.#signalDisconnect(failure);
      throw failure;
    }
  }

  waitForIdle(timeout = 60_000): Promise<void> {
    validateTimeout(timeout);
    if (this.#exitError !== undefined) return Promise.reject(this.#exitError);
    this.#acquireEventWaiter();
    return new Promise((resolve, reject) => {
      let settled = false;
      let unsubscribeEvent = (): void => {};
      let unsubscribeDisconnect = (): void => {};
      const cleanup = (): void => {
        clearTimeout(timer);
        unsubscribeEvent();
        unsubscribeDisconnect();
        this.#releaseEventWaiter();
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(
          `The agent did not become idle within ${timeout} ms. Diagnostic stderr tail: ${boundedRpcErrorMessage(this.#stderr.text())}`,
        ));
      }, timeout);
      unsubscribeEvent = this.#subscribeEvent((event) => {
        if (event.type !== "agent_settled" || settled) return;
        settled = true;
        cleanup();
        resolve();
      });
      unsubscribeDisconnect = this.#onDisconnect((error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      });
    });
  }

  collectEvents(timeout = 60_000): Promise<RpcStreamEvent[]> {
    return this.#startEventCollection(timeout).promise;
  }

  async promptAndWait(message: string, images?: readonly ImageContent[], timeout = 60_000): Promise<RpcStreamEvent[]> {
    const collection = this.#startEventCollection(timeout);
    void collection.promise.catch(() => undefined);
    try {
      await this.prompt(message, images);
    } catch (error) {
      collection.dispose();
      throw error;
    }
    return await collection.promise;
  }

  #startEventCollection(timeout: number): EventCollection {
    validateTimeout(timeout);
    if (this.#exitError !== undefined) {
      return { promise: Promise.reject(this.#exitError), dispose: () => undefined };
    }
    this.#acquireEventWaiter();
    let dispose = (): void => {};
    const promise = new Promise<RpcStreamEvent[]>((resolve, reject) => {
      const events: RpcStreamEvent[] = [];
      let bytes = 0;
      let settled = false;
      let unsubscribeEvent = (): void => {};
      let unsubscribeDisconnect = (): void => {};
      const cleanup = (): void => {
        clearTimeout(timer);
        unsubscribeEvent();
        unsubscribeDisconnect();
        this.#releaseEventWaiter();
      };
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const timer = setTimeout(() => {
        fail(new Error(
          `Event collection exceeded ${timeout} ms. Diagnostic stderr tail: ${boundedRpcErrorMessage(this.#stderr.text())}`,
        ));
      }, timeout);
      unsubscribeEvent = this.#subscribeEvent((event, eventBytes) => {
        if (
          events.length >= RPC_MAX_COLLECTED_EVENTS
          || eventBytes > RPC_MAX_COLLECTED_EVENT_BYTES - bytes
        ) {
          fail(new Error(
            "Event collection exceeded its retention limit; use onEvent() to consume events incrementally",
          ));
          return;
        }
        events.push(event);
        bytes += eventBytes;
        if (event.type === "agent_settled") {
          settled = true;
          cleanup();
          resolve(events);
        }
      });
      unsubscribeDisconnect = this.#onDisconnect(fail);
      dispose = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(events);
      };
    });
    return { promise, dispose: () => dispose() };
  }

  #handleLine(child: ChildProcess, line: string): void {
    if (this.#process !== child) return;
    let parsed: JsonValue;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      this.#protocolFailure(child, "The agent emitted invalid JSON", error);
      return;
    }
    if (!isJsonObject(parsed) || !Value.Check(STRING_VALUE, parsed["type"])) {
      this.#protocolFailure(child, "The agent emitted an invalid RPC record", "record envelope is invalid");
      return;
    }
    if (parsed["type"] === "response") {
      const id = parsed["id"];
      if (!Value.Check(STRING_VALUE, id) || !this.#broker.has(id)) return;
      if (!isCorrelatedRpcResponse(parsed)) {
        this.#protocolFailure(child, "The agent emitted an invalid RPC response", "response envelope is invalid");
        return;
      }
      if (parsed.success && "data" in parsed && isJsonObject(parsed.data)) {
        this.#responseBytes.set(parsed.data, Buffer.byteLength(line, "utf8"));
      }
      const mismatch = this.#broker.accept(parsed);
      if (mismatch !== undefined) {
        this.#protocolFailure(child, "The agent emitted a mismatched RPC response", mismatch);
      }
      return;
    }
    // SAFETY: Event envelopes are produced by ohm's version-matched RPC
    // server. Keeping their payload open preserves forward-compatible events;
    // every consumer still branches on the validated string discriminator.
    const event = parsed as RpcStreamEvent;
    const bytes = Buffer.byteLength(line, "utf8");
    const listeners = [...this.#listeners];
    for (const listener of listeners) {
      try { listener(event, bytes); }
      catch { /* One consumer must not prevent delivery to the others. */ }
    }
  }

  #subscribeEvent(listener: InternalEventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #acquireEventWaiter(): void {
    if (this.#activeEventWaiters >= RPC_MAX_EVENT_WAITERS) {
      throw new Error(`RPC client cannot exceed ${RPC_MAX_EVENT_WAITERS} concurrent event waiters`);
    }
    this.#activeEventWaiters += 1;
  }

  #releaseEventWaiter(): void {
    this.#activeEventWaiters -= 1;
  }

  #protocolFailure<SourceType>(child: ChildProcess, prefix: string, source: SourceType): void {
    if (this.#process !== child) return;
    const error = safeFailure(prefix, source, this.#stderr);
    this.#signalDisconnect(error);
    void this.stop().catch(() => undefined);
  }

  #createProcessExitError(code: number | null, signal: NodeJS.Signals | null): Error {
    return safeFailure(
      "Agent subprocess ended",
      `code=${code} and signal=${signal}`,
      this.#stderr,
    );
  }

  #onDisconnect(listener: (error: Error) => void): () => void {
    if (this.#exitError !== undefined) {
      listener(this.#exitError);
      return () => undefined;
    }
    this.#disconnectListeners.add(listener);
    return () => this.#disconnectListeners.delete(listener);
  }

  #signalDisconnect(error: Error): void {
    this.#exitError ??= error;
    const selected = this.#exitError;
    this.#broker.rejectAll(selected);
    const listeners = [...this.#disconnectListeners];
    this.#disconnectListeners.clear();
    for (const listener of listeners) listener(selected);
  }

  #writableInput(): NonNullable<ChildProcess["stdin"]> {
    const child = this.#process;
    const input = child?.stdin;
    if (child === undefined || input === null || input === undefined || this.#phase === "stopped") {
      throw new Error("Start the RPC client before sending a command");
    }
    if (this.#phase !== "running" || this.#exitError !== undefined) {
      throw this.#exitError ?? new Error("The RPC client transport is not running");
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      const error = this.#createProcessExitError(child.exitCode, child.signalCode);
      this.#signalDisconnect(error);
      throw error;
    }
    if (input.destroyed || !input.writable) {
      const error = safeFailure(
        "The agent subprocess input stream is not writable",
        "input stream is closed",
        this.#stderr,
      );
      this.#signalDisconnect(error);
      throw error;
    }
    return input;
  }

  async #send(command: RpcCommandBody): Promise<RpcResponse> {
    const input = this.#writableInput();
    const ticket = this.#broker.open(command.type);
    void ticket.promise.catch(() => undefined);
    let line: string;
    try {
      // SAFETY: RpcCommandBody is the exact distributive omission of `id` from
      // RpcCommand, and this method restores only that missing correlated ID.
      line = serializeJsonLine({ ...command, id: ticket.id } as RpcCommand);
    } catch (error) {
      const failure = safeFailure(`Could not serialize the ${command.type} command`, error, this.#stderr);
      this.#broker.reject(ticket.id, failure);
      return await ticket.promise;
    }
    try {
      await this.#writeLine(input, line);
    } catch (error) {
      const failure = this.#exitError
        ?? safeFailure(`Writing the ${command.type} command failed`, error, this.#stderr);
      this.#broker.reject(ticket.id, failure);
      this.#signalDisconnect(failure);
      throw failure;
    }
    return await ticket.promise;
  }

  async #writeLine(input: NonNullable<ChildProcess["stdin"]>, line: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let unsubscribeDisconnect = (): void => {};
      const cleanup = (): void => {
        clearTimeout(timer);
        unsubscribeDisconnect();
      };
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error === undefined) resolve();
        else reject(error);
      };
      const timer = setTimeout(
        () => finish(new Error(`RPC stream write exceeded ${RPC_WRITE_TIMEOUT_MS} ms`)),
        RPC_WRITE_TIMEOUT_MS,
      );
      unsubscribeDisconnect = this.#onDisconnect((error) => finish(error));
      if (settled) return;
      try {
        input.write(line, (error) => finish(error ?? undefined));
      } catch (error) {
        finish(new Error(boundedRpcErrorMessage(error)));
      }
    });
  }

  #data<T>(response: RpcResponse): T {
    if (!response.success) throw new Error(boundedRpcErrorMessage(response.error));
    if (!("data" in response)) throw new Error(`RPC ${response.command} response omitted its data payload`);
    // SAFETY: Each public client method fixes T to the data shape paired with
    // the command sent through #send; the broker rejects command mismatches.
    return response.data as T;
  }

  #retainedBytes(value: RetainedRpcPage): number {
    const bytes = this.#responseBytes.get(value);
    if (bytes === undefined) throw new Error("RPC response retention metadata is missing");
    return bytes;
  }

  async #waitForSpawn(child: ChildProcess): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        child.off("spawn", onSpawn);
        child.off("error", onError);
        child.off("exit", onExit);
      };
      const onSpawn = (): void => { cleanup(); resolve(); };
      const onError = (error: Error): void => { cleanup(); reject(error); };
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        cleanup();
        reject(this.#createProcessExitError(code, signal));
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
      child.once("exit", onExit);
    });
  }

  async #stopChild(child: ChildProcess): Promise<void> {
    const stopped = new Error("The RPC client was stopped");
    this.#signalDisconnect(stopped);
    this.#stopReading?.();
    this.#stopReading = undefined;
    const wasRunning = child.exitCode === null && child.signalCode === null;
    if (wasRunning && process.platform === "win32") {
      // taskkill /T /F is already the hard, whole-tree Windows termination.
      // Invoke it only while Node still observes the root as live, then wait;
      // never reuse the root PID in a second taskkill call after it can exit.
      await this.#terminateTree(child, "SIGTERM");
      await this.#waitForExit(child, RPC_STOP_GRACE_MS);
    } else if (wasRunning) {
      await this.#terminateTree(child, "SIGTERM");
      const exited = await this.#waitForExit(child, RPC_STOP_GRACE_MS);
      if (!exited) {
        await this.#terminateTree(child, "SIGKILL");
        await this.#waitForExit(child, RPC_KILL_WAIT_MS);
      } else {
        // The detached group can outlive its leader on POSIX. A final group
        // signal reaps those descendants without targeting a reusable root PID.
        await this.#terminateTree(child, "SIGKILL");
      }
    } else if (process.platform !== "win32") {
      // An exited detached leader can still have live descendants in its group.
      await this.#terminateTree(child, "SIGKILL");
    }
    child.stdin?.destroy();
    child.stdout?.destroy();
    child.stderr?.destroy();
  }

  async #terminateTree(child: ChildProcess, signal: NodeJS.Signals): Promise<void> {
    if (child.pid === undefined) {
      try { child.kill(signal); } catch {}
      return;
    }
    await terminateProcessTreeAsync(child.pid, signal);
  }

  async #waitForExit(child: ChildProcess, timeout: number): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (exited: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.off("exit", onExit);
        resolve(exited);
      };
      const onExit = (): void => finish(true);
      const timer = setTimeout(() => finish(false), timeout);
      child.once("exit", onExit);
    });
  }
}
