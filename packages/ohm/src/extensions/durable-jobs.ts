import { constants } from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type { ImageContent } from "@ohm/models";
import { boundedJsonSnapshot } from "@ohm/kernel/runtime/core/bounded-json";
import { Check } from "typebox/value";
import {
  SESSION_V4_MAX_RECORD_BYTES,
  SESSION_V4_VERSION,
  parseSessionV4Header,
} from "@ohm/kernel/session-v4";

import { errorCode, errorMessage } from "../core/errors.js";
import { isJsonObject, isJsonValue, type JsonObject, type JsonValue } from "../core/json.js";
import type { ThinkingLevel } from "../core/settings-manager.js";
import { FUNCTION_VALUE, NUMBER_VALUE, STRING_VALUE, isObjectValue } from "../core/value-schemas.js";
import { RpcClient, type RpcClientOptions } from "../interfaces/rpc-client.js";
import type { RpcSessionState } from "../interfaces/rpc-protocol.js";
import { assertCanonicalDirectoryCreationPath } from "../config/canonical-path.js";
import { withFileLock } from "../storage/file-lock.js";

const STORE_VERSION = 1;
const STORE_FILE = "durable-jobs-v1.json";
const CHILD_SESSION_DIRECTORY = "child-sessions";
const MAX_STORE_BYTES = 1024 * 1024;
const MAX_JOBS = 256;
const MAX_ACTIVE_JOBS = 8;
const MAX_ID_BYTES = 128;
const MAX_KEY_BYTES = 256;
const MAX_KIND_BYTES = 128;
const MAX_LABEL_BYTES = 512;
const MAX_ERROR_BYTES = 8 * 1024;
const MAX_METADATA_BYTES = 64 * 1024;
const MAX_RESULT_BYTES = 64 * 1024;
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_LIST_LIMIT = 256;
const MAX_JSON_VALUES = 8_192;
const MAX_JSON_CONTAINERS = 4_096;
const MAX_JSON_DEPTH = 59;
const DEFAULT_JOB_TIMEOUT_MS = 60 * 60 * 1_000;
const MAX_JOB_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
const RPC_POLL_MS = 100;
const CLOSE_DRAIN_MS = 2_500;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const NON_BLOCKING = constants.O_NONBLOCK ?? 0;
const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const JOB_KIND = /^[a-z][a-z0-9._-]{0,127}$/u;
const ACTIVE_STATES = new Set<ExtensionJobState>(["starting", "running"]);
const PRUNABLE_STATES = new Set<ExtensionJobState>(["succeeded", "failed", "cancelled", "timed_out"]);
const LIVE_HOST_TOKENS = new Set<string>();

export type ExtensionJobId = string;
export type ExtensionJobState =
  | "starting"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "interrupted";

export interface ExtensionJobStatus {
  readonly id: ExtensionJobId;
  readonly kind: string;
  readonly state: ExtensionJobState;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly attempt: number;
  readonly timeoutMs: number;
  readonly idempotencyKey?: string;
  readonly label?: string;
  readonly metadata?: JsonValue;
  readonly result?: JsonValue;
  readonly error?: string;
}

export interface ExtensionJobStartOptions {
  readonly kind: string;
  readonly idempotencyKey?: string;
  readonly label?: string;
  readonly metadata?: JsonValue;
  readonly timeoutMs?: number;
}

export interface ExtensionJobListOptions {
  readonly state?: ExtensionJobState;
  readonly kind?: string;
  readonly limit?: number;
}

export interface ExtensionJobWaitOptions {
  readonly signal?: AbortSignal;
}

export interface ExtensionJobContext {
  readonly id: ExtensionJobId;
  readonly attempt: number;
  readonly signal: AbortSignal;
  replaceMetadata(metadata: JsonValue): Promise<ExtensionJobStatus>;
}

export type ExtensionJobOperation = (
  context: ExtensionJobContext,
) => JsonValue | undefined | Promise<JsonValue | undefined>;

export interface ExtensionJobService {
  start(options: ExtensionJobStartOptions, operation: ExtensionJobOperation): Promise<ExtensionJobStatus>;
  resume(id: ExtensionJobId, operation: ExtensionJobOperation): Promise<ExtensionJobStatus>;
  cancel(id: ExtensionJobId): Promise<ExtensionJobStatus>;
  inspect(id: ExtensionJobId): Promise<ExtensionJobStatus>;
  list(options?: ExtensionJobListOptions): Promise<readonly ExtensionJobStatus[]>;
  wait(id: ExtensionJobId, options?: ExtensionJobWaitOptions): Promise<ExtensionJobStatus>;
}

export interface ExtensionChildSessionStartOptions {
  readonly idempotencyKey?: string;
  readonly label?: string;
  readonly cwd?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly thinkingLevel?: ThinkingLevel;
  readonly tools?: readonly string[];
  readonly excludeTools?: readonly string[];
  readonly noBuiltinTools?: boolean;
  readonly noContextFiles?: boolean;
  readonly systemPrompt?: string;
  readonly appendSystemPrompt?: string;
  readonly timeoutMs?: number;
}

export interface ExtensionChildSessionStatus extends ExtensionJobStatus {
  readonly kind: "ohm.child-session";
  readonly sessionId?: string;
  readonly sessionFile?: string;
}

export interface ExtensionChildSessionService {
  spawn(options?: ExtensionChildSessionStartOptions): Promise<ExtensionChildSessionStatus>;
  reattach(id: ExtensionJobId): Promise<ExtensionChildSessionStatus>;
  prompt(id: ExtensionJobId, message: string, images?: readonly ImageContent[]): Promise<void>;
  steer(id: ExtensionJobId, message: string, images?: readonly ImageContent[]): Promise<void>;
  followUp(id: ExtensionJobId, message: string, images?: readonly ImageContent[]): Promise<void>;
  cancel(id: ExtensionJobId): Promise<ExtensionChildSessionStatus>;
  inspect(id: ExtensionJobId): Promise<ExtensionChildSessionStatus>;
  list(options?: Omit<ExtensionJobListOptions, "kind">): Promise<readonly ExtensionChildSessionStatus[]>;
  state(id: ExtensionJobId): Promise<RpcSessionState>;
}

type MutableExtensionJobStatus = {
  -readonly [Key in keyof ExtensionJobStatus]: ExtensionJobStatus[Key];
};

type MutableExtensionChildSessionStatus = {
  -readonly [Key in keyof ExtensionChildSessionStatus]: ExtensionChildSessionStatus[Key];
};

type MutableExtensionJobStartOptions = {
  -readonly [Key in keyof ExtensionJobStartOptions]: ExtensionJobStartOptions[Key];
};

interface StoredJob extends JsonObject {
  id: string;
  owner: string;
  kind: string;
  state: ExtensionJobState;
  createdAt: number;
  updatedAt: number;
  attempt: number;
  timeoutMs: number;
  idempotencyKey?: string;
  label?: string;
  metadata?: JsonValue;
  result?: JsonValue;
  error?: string;
  host?: StoredHostOwner;
}

interface StoredHostOwner extends JsonObject {
  pid: number;
  token: string;
}

interface StoredPayload extends JsonObject {
  version: 1;
  jobs: StoredJob[];
}

interface StoredEnvelope extends JsonObject {
  checksum: string;
  payload: StoredPayload;
}

interface DurableJobOwner {
  readonly key: object;
  readonly id: string;
  readonly root: string;
  readonly workspace: string;
  readonly projectTrusted: () => boolean;
  readonly signal: AbortSignal;
  isActive(): boolean;
  isCommitted(): boolean;
  diagnostic?(message: string): void;
}

interface ActiveJob {
  readonly ownerKey: object;
  readonly attempt: number;
  readonly controller: AbortController;
  readonly completion: Promise<void>;
  timeout?: NodeJS.Timeout;
}

interface StartResult {
  readonly status: ExtensionJobStatus;
  readonly created: boolean;
}

interface RpcClientLike {
  readonly started: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  prompt(message: string, images?: readonly ImageContent[]): Promise<void>;
  steer(message: string, images?: readonly ImageContent[]): Promise<void>;
  followUp(message: string, images?: readonly ImageContent[]): Promise<void>;
  abort(): Promise<void>;
  getState(): Promise<RpcSessionState>;
}

interface DurableJobSupervisorOptions {
  readonly rpcClientFactory?: (options: RpcClientOptions) => RpcClientLike;
  readonly now?: () => number;
}

interface ChildSessionMetadata extends JsonObject {
  readonly schemaVersion: 1;
  readonly cwd: string;
  readonly args: string[];
  readonly sessionDirectory: string;
  readonly sessionId?: string;
  readonly sessionFile?: string;
}

class InterruptedJobError extends Error {}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function boundedString(value: JsonValue | undefined, label: string, maximum: number): string {
  if (!Check(STRING_VALUE, value) || value === "" || value.includes("\0") || byteLength(value) > maximum) {
    throw new TypeError(`${label} must be non-empty, contain no NUL, and be at most ${maximum} bytes`);
  }
  return value;
}

function boundedOptionalString(value: JsonValue | undefined, label: string, maximum: number): string | undefined {
  return value === undefined ? undefined : boundedString(value, label, maximum);
}

function boundedInteger(value: JsonValue | undefined, label: string, maximum: number): number {
  if (!Check(NUMBER_VALUE, value) || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${label} must be an integer from 1 through ${maximum}`);
  }
  return value;
}

function boundedJson(value: JsonValue, label: string, maximum: number): JsonValue {
  const snapshot = boundedJsonSnapshot(value, {
    label,
    maximumBytes: maximum,
    maximumValues: MAX_JSON_VALUES,
    maximumContainers: MAX_JSON_CONTAINERS,
    maximumDepth: MAX_JSON_DEPTH,
  });
  const cloned: unknown = JSON.parse(snapshot.serialized);
  if (!isJsonValue(cloned)) throw new Error(`${label} snapshot was not JSON-safe`);
  return cloned;
}

function boundedError(cause: unknown): string {
  const text = errorMessage(cause) || "Durable job failed";
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= MAX_ERROR_BYTES) return text;
  let end = MAX_ERROR_BYTES;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function checksum(payload: JsonValue | undefined): string {
  const serialized = JSON.stringify(payload);
  if (serialized === undefined) throw new Error("Durable job store payload is not serializable");
  return createHash("sha256").update(serialized).digest("hex");
}

function ownProperty(record: Readonly<JsonObject>, key: string): JsonValue | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function validateStoredHost(value: JsonValue | undefined): StoredHostOwner | undefined {
  if (value === undefined) return undefined;
  if (!isJsonObject(value)) {
    throw new Error("Durable job store contains an invalid host owner");
  }
  const pid = boundedInteger(ownProperty(value, "pid"), "Durable job host pid", Number.MAX_SAFE_INTEGER);
  const token = boundedString(ownProperty(value, "token"), "Durable job host token", MAX_ID_BYTES);
  if (!JOB_ID.test(token)) throw new Error("Durable job store contains an invalid host token");
  return { pid, token };
}

function validateStoredJob(value: JsonValue): StoredJob {
  if (!isJsonObject(value)) {
    throw new Error("Durable job store contains an invalid job record");
  }
  const id = boundedString(ownProperty(value, "id"), "Durable job id", MAX_ID_BYTES);
  if (!JOB_ID.test(id)) throw new Error("Durable job store contains an invalid job id");
  const owner = boundedString(ownProperty(value, "owner"), "Durable job owner", MAX_ID_BYTES);
  const kind = boundedString(ownProperty(value, "kind"), "Durable job kind", MAX_KIND_BYTES);
  if (!JOB_KIND.test(kind)) throw new Error("Durable job store contains an invalid job kind");
  const state = ownProperty(value, "state");
  if (
    state !== "starting" && state !== "running" && state !== "succeeded" && state !== "failed"
    && state !== "cancelled" && state !== "timed_out" && state !== "interrupted"
  ) throw new Error("Durable job store contains an invalid job state");
  const createdAt = boundedInteger(ownProperty(value, "createdAt"), "Durable job createdAt", Number.MAX_SAFE_INTEGER);
  const updatedAt = boundedInteger(ownProperty(value, "updatedAt"), "Durable job updatedAt", Number.MAX_SAFE_INTEGER);
  const attempt = boundedInteger(ownProperty(value, "attempt"), "Durable job attempt", Number.MAX_SAFE_INTEGER);
  const timeoutMs = boundedInteger(ownProperty(value, "timeoutMs"), "Durable job timeoutMs", MAX_JOB_TIMEOUT_MS);
  const idempotencyKey = boundedOptionalString(ownProperty(value, "idempotencyKey"), "Durable job idempotencyKey", MAX_KEY_BYTES);
  const label = boundedOptionalString(ownProperty(value, "label"), "Durable job label", MAX_LABEL_BYTES);
  const metadataValue = ownProperty(value, "metadata");
  const resultValue = ownProperty(value, "result");
  const metadata = metadataValue === undefined ? undefined : boundedJson(metadataValue, "Durable job metadata", MAX_METADATA_BYTES);
  const result = resultValue === undefined ? undefined : boundedJson(resultValue, "Durable job result", MAX_RESULT_BYTES);
  const storedError = boundedOptionalString(ownProperty(value, "error"), "Durable job error", MAX_ERROR_BYTES);
  const host = validateStoredHost(ownProperty(value, "host"));
  const job: StoredJob = {
    id,
    owner,
    kind,
    state,
    createdAt,
    updatedAt,
    attempt,
    timeoutMs,
  };
  if (idempotencyKey !== undefined) job.idempotencyKey = idempotencyKey;
  if (label !== undefined) job.label = label;
  if (metadata !== undefined) job.metadata = metadata;
  if (result !== undefined) job.result = result;
  if (storedError !== undefined) job.error = storedError;
  if (host !== undefined) job.host = host;
  return job;
}

function validatePayload(value: JsonValue): StoredPayload {
  if (!isJsonObject(value)) {
    throw new Error("Durable job store payload is invalid");
  }
  if (ownProperty(value, "version") !== STORE_VERSION) throw new Error("Durable job store version is unsupported");
  const jobsValue = ownProperty(value, "jobs");
  if (!Array.isArray(jobsValue) || jobsValue.length > MAX_JOBS) {
    throw new Error("Durable job store job list is invalid");
  }
  const jobs = jobsValue.map(validateStoredJob);
  if (new Set(jobs.map((job) => job.id)).size !== jobs.length) {
    throw new Error("Durable job store contains duplicate job ids");
  }
  return { version: STORE_VERSION, jobs };
}

function validateEnvelope(value: JsonValue): StoredPayload {
  if (!isJsonObject(value)) {
    throw new Error("Durable job store envelope is invalid");
  }
  const expected = ownProperty(value, "checksum");
  if (!Check(STRING_VALUE, expected) || !/^[a-f0-9]{64}$/u.test(expected)) {
    throw new Error("Durable job store checksum is invalid");
  }
  const storedPayload = ownProperty(value, "payload");
  if (checksum(storedPayload) !== expected) throw new Error("Durable job store checksum does not match its payload");
  if (storedPayload === undefined) throw new Error("Durable job store payload is missing");
  return validatePayload(storedPayload);
}

function publicStatus(job: StoredJob): ExtensionJobStatus {
  const status: MutableExtensionJobStatus = {
    id: job.id,
    kind: job.kind,
    state: job.state,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    attempt: job.attempt,
    timeoutMs: job.timeoutMs,
  };
  if (job.idempotencyKey !== undefined) status.idempotencyKey = job.idempotencyKey;
  if (job.label !== undefined) status.label = job.label;
  if (job.metadata !== undefined) status.metadata = boundedJson(job.metadata, "Durable job metadata", MAX_METADATA_BYTES);
  if (job.result !== undefined) status.result = boundedJson(job.result, "Durable job result", MAX_RESULT_BYTES);
  if (job.error !== undefined) status.error = job.error;
  return Object.freeze(status);
}

function pathInside(root: string, target: string): boolean {
  const local = relative(root, target);
  return local === "" || (local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local));
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return errorCode(cause) !== "ESRCH";
  }
}

function encodedEnvelope(payload: StoredPayload): Buffer {
  const envelope: StoredEnvelope = { checksum: checksum(payload), payload };
  return Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`, "utf8");
}

function evictionIndex(jobs: readonly StoredJob[], protectedIds: ReadonlySet<string>): number {
  const candidates = jobs
    .map((job, index) => ({ job, index }))
    .filter(({ job }) => !protectedIds.has(job.id) && (PRUNABLE_STATES.has(job.state) || job.state === "interrupted"))
    .sort((left, right) => {
      const stateOrder = Number(left.job.state === "interrupted") - Number(right.job.state === "interrupted");
      return stateOrder
        || left.job.updatedAt - right.job.updatedAt
        || left.job.createdAt - right.job.createdAt
        || left.job.id.localeCompare(right.job.id);
    });
  return candidates[0]?.index ?? -1;
}

function fitPayload(payload: StoredPayload, protectedIds: ReadonlySet<string>): Buffer {
  let bytes = encodedEnvelope(payload);
  while (bytes.byteLength > MAX_STORE_BYTES) {
    const index = evictionIndex(payload.jobs, protectedIds);
    if (index < 0) throw new RangeError(`Durable job store exceeds ${MAX_STORE_BYTES} bytes`);
    payload.jobs.splice(index, 1);
    bytes = encodedEnvelope(payload);
  }
  return bytes;
}

async function canonicalDirectory(path: string, label: string): Promise<string> {
  const canonical = await realpath(resolve(path));
  const information = await lstat(canonical);
  if (!information.isDirectory() || information.isSymbolicLink()) throw new Error(`${label} must be a canonical directory`);
  return canonical;
}

async function syncDirectory(path: string): Promise<void> {
  let descriptor;
  try {
    descriptor = await open(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
    await descriptor.sync();
  } catch (cause) {
    const code = errorCode(cause);
    if (process.platform !== "win32" || !["EISDIR", "EINVAL", "EPERM"].includes(String(code))) throw cause;
  } finally {
    await descriptor?.close();
  }
}

class DurableJobStore {
  readonly #root: string;
  readonly #path: string;

  constructor(root: string) {
    this.#root = resolve(root);
    this.#path = join(this.#root, STORE_FILE);
  }

  async transaction<Value>(
    operation: (jobs: StoredJob[]) => Value | Promise<Value>,
    protectedIds: ReadonlySet<string> = new Set(),
  ): Promise<Value> {
    return await withFileLock(this.#path, async () => {
      const payload = await this.#read();
      const before = JSON.stringify(payload.jobs);
      const result = await operation(payload.jobs);
      if (JSON.stringify(payload.jobs) !== before) await this.#write(payload, protectedIds);
      return result;
    });
  }

  async #read(): Promise<StoredPayload> {
    let information;
    try {
      information = await lstat(this.#path);
    } catch (cause) {
      const code = errorCode(cause);
      if (code === "ENOENT") return { version: STORE_VERSION, jobs: [] };
      throw cause;
    }
    if (!information.isFile() || information.isSymbolicLink()) throw new Error("Durable job store is not a regular file");
    if (information.size > MAX_STORE_BYTES) throw new RangeError(`Durable job store exceeds ${MAX_STORE_BYTES} bytes`);
    const descriptor = await open(this.#path, constants.O_RDONLY | NO_FOLLOW | NON_BLOCKING);
    try {
      const opened = await descriptor.stat();
      if (!opened.isFile() || opened.size > MAX_STORE_BYTES) throw new Error("Durable job store changed while opening");
      const bytes = await descriptor.readFile();
      if (bytes.byteLength > MAX_STORE_BYTES) throw new RangeError(`Durable job store exceeds ${MAX_STORE_BYTES} bytes`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(bytes.toString("utf8"));
      } catch (cause) {
        throw new Error("Durable job store contains invalid JSON", { cause });
      }
      if (!isJsonValue(parsed)) throw new Error("Durable job store must contain JSON data");
      return validateEnvelope(parsed);
    } finally {
      await descriptor.close();
    }
  }

  async #write(payload: StoredPayload, protectedIds: ReadonlySet<string>): Promise<void> {
    const bytes = fitPayload(payload, protectedIds);
    const temporary = join(this.#root, `.${STORE_FILE}.${randomBytes(12).toString("hex")}.tmp`);
    let descriptor;
    try {
      descriptor = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NO_FOLLOW, 0o600);
      await descriptor.writeFile(bytes);
      await descriptor.chmod(0o600);
      await descriptor.sync();
      await descriptor.close();
      descriptor = undefined;
      await rename(temporary, this.#path);
      await syncDirectory(this.#root);
    } finally {
      await descriptor?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
    }
  }
}

interface ValidatedStartOptions {
  kind: string;
  timeoutMs: number;
  idempotencyKey?: string;
  label?: string;
  metadata?: JsonValue;
}

function validateStartOptions(input: ExtensionJobStartOptions, reserved = false): ValidatedStartOptions {
  if (!isObjectValue(input)) throw new TypeError("Durable job options are required");
  const kind = boundedString(input.kind, "Durable job kind", MAX_KIND_BYTES);
  if (!JOB_KIND.test(kind)) throw new Error("Durable job kind is invalid");
  if (!reserved && kind.startsWith("ohm.")) throw new Error("Durable job kinds beginning with ohm. are reserved by the host");
  const idempotencyKey = boundedOptionalString(input.idempotencyKey, "Durable job idempotencyKey", MAX_KEY_BYTES);
  const label = boundedOptionalString(input.label, "Durable job label", MAX_LABEL_BYTES);
  const metadata = input.metadata === undefined ? undefined : boundedJson(input.metadata, "Durable job metadata", MAX_METADATA_BYTES);
  const timeoutMs = input.timeoutMs === undefined
    ? DEFAULT_JOB_TIMEOUT_MS
    : boundedInteger(input.timeoutMs, "Durable job timeoutMs", MAX_JOB_TIMEOUT_MS);
  const options: ValidatedStartOptions = { kind, timeoutMs };
  if (idempotencyKey !== undefined) options.idempotencyKey = idempotencyKey;
  if (label !== undefined) options.label = label;
  if (metadata !== undefined) options.metadata = metadata;
  return options;
}

interface ValidatedListOptions {
  limit: number;
  state?: ExtensionJobState;
  kind?: string;
}

function validateListOptions(options: ExtensionJobListOptions): ValidatedListOptions {
  const limit = options.limit === undefined ? MAX_LIST_LIMIT : boundedInteger(options.limit, "Durable job list limit", MAX_LIST_LIMIT);
  if (options.state !== undefined && !ACTIVE_STATES.has(options.state) && !PRUNABLE_STATES.has(options.state) && options.state !== "interrupted") {
    throw new Error("Durable job list state is invalid");
  }
  const kind = options.kind === undefined ? undefined : boundedString(options.kind, "Durable job list kind", MAX_KIND_BYTES);
  const selected: ValidatedListOptions = { limit };
  if (options.state !== undefined) selected.state = options.state;
  if (kind !== undefined) selected.kind = kind;
  return selected;
}

function activeCount(jobs: readonly StoredJob[]): number {
  return jobs.filter((job) => ACTIVE_STATES.has(job.state)).length;
}

function pruneForInsert(jobs: StoredJob[]): void {
  while (jobs.length >= MAX_JOBS) {
    const index = evictionIndex(jobs, new Set());
    if (index < 0) throw new Error(`Durable job store cannot exceed ${MAX_JOBS} retained jobs`);
    jobs.splice(index, 1);
  }
}

function findOwned(jobs: readonly StoredJob[], owner: DurableJobOwner, id: string): StoredJob {
  boundedString(id, "Durable job id", MAX_ID_BYTES);
  const job = jobs.find((candidate) => candidate.id === id && candidate.owner === storedOwner(owner));
  if (job === undefined) throw new Error(`Unknown durable job: ${id}`);
  return job;
}

function storedOwner(owner: DurableJobOwner): string {
  return createHash("sha256").update(owner.id, "utf8").digest("hex");
}

function withAbort<Value>(operation: Promise<Value>, signal: AbortSignal): Promise<Value> {
  signal.throwIfAborted();
  return new Promise<Value>((resolveValue, rejectValue) => {
    const abort = (): void => rejectValue(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolveValue, rejectValue).finally(() => signal.removeEventListener("abort", abort));
  });
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise<void>((resolveValue, rejectValue) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolveValue();
    }, milliseconds);
    const abort = (): void => {
      clearTimeout(timer);
      rejectValue(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** @internal Host-owned durable lifecycle registry used by extension API facades. */
export class DurableJobSupervisor {
  readonly #active = new Map<string, ActiveJob>();
  readonly #launching = new Set<string>();
  readonly #boundOwners = new WeakSet<object>();
  readonly #stores = new Map<string, DurableJobStore>();
  readonly #clients = new Map<string, RpcClientLike>();
  readonly #rpcClientFactory: (options: RpcClientOptions) => RpcClientLike;
  readonly #now: () => number;
  readonly #hostToken = randomUUID();
  #closed = false;

  constructor(options: DurableJobSupervisorOptions = {}) {
    this.#rpcClientFactory = options.rpcClientFactory ?? ((rpcOptions) => new RpcClient(rpcOptions));
    this.#now = options.now ?? Date.now;
    LIVE_HOST_TOKENS.add(this.#hostToken);
  }

  jobs(owner: DurableJobOwner): ExtensionJobService {
    this.#bindOwner(owner);
    const service: ExtensionJobService = {
      start: async (options, operation) => (await this.#start(owner, options, operation, false)).status,
      resume: async (id, operation) => (await this.#resume(owner, id, operation)).status,
      cancel: async (id) => await this.#cancel(owner, id),
      inspect: async (id) => await this.#inspect(owner, id),
      list: async (options = {}) => await this.#list(owner, options),
      wait: async (id, options = {}) => await this.#wait(owner, id, options),
    };
    return Object.freeze(service);
  }

  childSessions(owner: DurableJobOwner): ExtensionChildSessionService {
    this.#bindOwner(owner);
    const service: ExtensionChildSessionService = {
      spawn: async (options = {}) => await this.#spawnChild(owner, options),
      reattach: async (id) => await this.#reattachChild(owner, id),
      prompt: async (id, message, images) => await this.#childCommand(owner, id, "prompt", message, images),
      steer: async (id, message, images) => await this.#childCommand(owner, id, "steer", message, images),
      followUp: async (id, message, images) => await this.#childCommand(owner, id, "followUp", message, images),
      cancel: async (id) => {
        this.#childStatus(await this.#inspect(owner, id));
        return this.#childStatus(await this.#cancel(owner, id));
      },
      inspect: async (id) => this.#childStatus(await this.#inspect(owner, id)),
      list: async (options = {}) => (await this.#list(owner, { ...options, kind: "ohm.child-session" })).map((job) => this.#childStatus(job)),
      state: async (id) => await this.#childState(owner, id),
    };
    return Object.freeze(service);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const operations = [...this.#active.keys()].map(async (id) => await this.#terminateActive(id, "interrupted", "Host stopped while the job was active"));
    let results: PromiseSettledResult<void>[] = [];
    try {
      results = await Promise.allSettled(operations);
      const completions = [...this.#active.values()].map((active) => active.completion);
      if (completions.length > 0) {
        const drain = new AbortController();
        try {
          await Promise.race([
            Promise.allSettled(completions).then(() => undefined),
            delay(CLOSE_DRAIN_MS, drain.signal),
          ]);
        } finally {
          drain.abort();
        }
      }
    } finally {
      LIVE_HOST_TOKENS.delete(this.#hostToken);
    }
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length > 0) {
      throw new AggregateError(failures, "Durable job shutdown could not persist every interruption");
    }
  }

  #hostOwner(): StoredHostOwner {
    return { pid: process.pid, token: this.#hostToken };
  }

  #ownedByLiveHost(job: StoredJob): boolean {
    if (job.host === undefined) return false;
    if (job.host.pid === process.pid) return LIVE_HOST_TOKENS.has(job.host.token);
    return processIsAlive(job.host.pid);
  }

  #ownedByThisHost(job: StoredJob): boolean {
    return job.host?.pid === process.pid && job.host.token === this.#hostToken;
  }

  #store(owner: DurableJobOwner): DurableJobStore {
    let store = this.#stores.get(owner.root);
    if (store === undefined) {
      store = new DurableJobStore(owner.root);
      this.#stores.set(owner.root, store);
    }
    return store;
  }

  #bindOwner(owner: DurableJobOwner): void {
    if (this.#closed) throw new Error("Durable job supervisor is closed");
    if (this.#boundOwners.has(owner.key)) return;
    this.#boundOwners.add(owner.key);
    const interrupt = (): void => {
      const operations = [...this.#active.entries()]
        .filter(([, active]) => active.ownerKey === owner.key)
        .map(async ([id]) => await this.#terminateActive(id, "interrupted", "Extension generation stopped while the job was active"));
      void Promise.allSettled(operations).then((results) => {
        for (const result of results) {
          if (result.status === "rejected") owner.diagnostic?.(`Durable job interruption failed: ${boundedError(result.reason)}`);
        }
      });
    };
    owner.signal.addEventListener("abort", interrupt, { once: true });
    if (owner.signal.aborted) interrupt();
  }

  #assertOwner(owner: DurableJobOwner, write = false): void {
    if (this.#closed) throw new Error("Durable job supervisor is closed");
    if (!owner.isActive()) throw new Error("Runtime extension context is no longer active");
    if (write && !owner.isCommitted()) throw new Error("Durable jobs cannot start or mutate before activation commits");
  }

  async #recover(owner: DurableJobOwner, jobs: StoredJob[]): Promise<void> {
    const now = this.#now();
    const ownerId = storedOwner(owner);
    for (const job of jobs) {
      if (
        job.owner !== ownerId
        || !ACTIVE_STATES.has(job.state)
        || this.#active.has(job.id)
        || this.#launching.has(job.id)
      ) continue;
      const ownedByThisHost = this.#ownedByThisHost(job);
      if (!ownedByThisHost && this.#ownedByLiveHost(job)) continue;
      job.state = "interrupted";
      job.updatedAt = now;
      job.error = ownedByThisHost
        ? "Host could not persist the job's terminal state"
        : "Previous host stopped while the job was active";
      delete job.host;
    }
  }

  async #start(
    owner: DurableJobOwner,
    input: ExtensionJobStartOptions,
    operation: ExtensionJobOperation,
    reserved: boolean,
  ): Promise<StartResult> {
    this.#assertOwner(owner, true);
    if (!Check(FUNCTION_VALUE, operation)) throw new TypeError("Durable job operation must be a function");
    const options = validateStartOptions(input, reserved);
    const store = this.#store(owner);
    const ownerId = storedOwner(owner);
    let created: StoredJob | undefined;
    let duplicate: StoredJob | undefined;
    const protectedIds = new Set<string>();
    try {
      await store.transaction(async (jobs) => {
        await this.#recover(owner, jobs);
        if (options.idempotencyKey !== undefined) {
          duplicate = jobs.find((job) => job.owner === ownerId && job.idempotencyKey === options.idempotencyKey);
          if (duplicate !== undefined) {
            if (duplicate.kind !== options.kind) throw new Error("Durable job idempotency key was already used for another kind");
            return;
          }
        }
        if (activeCount(jobs.filter((job) => job.owner === ownerId)) >= MAX_ACTIVE_JOBS) {
          throw new Error(`An extension cannot exceed ${MAX_ACTIVE_JOBS} active durable jobs`);
        }
        pruneForInsert(jobs);
        const now = this.#now();
        const job: StoredJob = {
          id: randomUUID(),
          owner: ownerId,
          kind: options.kind,
          state: "starting",
          createdAt: now,
          updatedAt: now,
          attempt: 1,
          timeoutMs: options.timeoutMs,
          host: this.#hostOwner(),
        };
        if (options.idempotencyKey !== undefined) job.idempotencyKey = options.idempotencyKey;
        if (options.label !== undefined) job.label = options.label;
        if (options.metadata !== undefined) job.metadata = options.metadata;
        created = job;
        this.#launching.add(job.id);
        jobs.push(job);
        protectedIds.add(job.id);
      }, protectedIds);
    } catch (cause) {
      if (created !== undefined) this.#launching.delete(created.id);
      throw cause;
    }
    if (duplicate !== undefined) return { status: publicStatus(duplicate), created: false };
    if (created === undefined) throw new Error("Durable job creation did not produce a record");
    try {
      return { status: await this.#launch(owner, created, operation), created: true };
    } finally {
      this.#launching.delete(created.id);
    }
  }

  async #resume(
    owner: DurableJobOwner,
    id: string,
    operation: ExtensionJobOperation,
    reservedKind?: "ohm.child-session",
  ): Promise<StartResult> {
    this.#assertOwner(owner, true);
    if (!Check(FUNCTION_VALUE, operation)) throw new TypeError("Durable job operation must be a function");
    const store = this.#store(owner);
    const ownerId = storedOwner(owner);
    let selected: StoredJob | undefined;
    try {
      await store.transaction(async (jobs) => {
        await this.#recover(owner, jobs);
        const job = findOwned(jobs, owner, id);
        if (reservedKind === undefined && job.kind.startsWith("ohm.")) {
          throw new Error(`Durable job ${id} has a host-reserved kind and must use its specialized API`);
        }
        if (reservedKind !== undefined && job.kind !== reservedKind) {
          throw new Error(`Durable job ${id} is not a ${reservedKind} job`);
        }
        if (job.state !== "interrupted") throw new Error(`Durable job ${id} is ${job.state}, not interrupted`);
        if (activeCount(jobs.filter((candidate) => candidate.owner === ownerId)) >= MAX_ACTIVE_JOBS) {
          throw new Error(`An extension cannot exceed ${MAX_ACTIVE_JOBS} active durable jobs`);
        }
        job.state = "starting";
        job.updatedAt = this.#now();
        job.attempt += 1;
        job.host = this.#hostOwner();
        delete job.result;
        delete job.error;
        selected = { ...job };
        this.#launching.add(job.id);
      }, new Set([id]));
    } catch (cause) {
      this.#launching.delete(id);
      throw cause;
    }
    if (selected === undefined) throw new Error("Durable job resume did not select a record");
    try {
      return { status: await this.#launch(owner, selected, operation), created: true };
    } finally {
      this.#launching.delete(id);
    }
  }

  async #launch(owner: DurableJobOwner, job: StoredJob, operation: ExtensionJobOperation): Promise<ExtensionJobStatus> {
    try {
      this.#assertOwner(owner, true);
    } catch (cause) {
      await this.#interruptUnlaunched(owner, job, cause);
    }
    const controller = new AbortController();
    let resolveCompletion: () => void = () => undefined;
    const completion = new Promise<void>((resolveValue) => { resolveCompletion = resolveValue; });
    const active: ActiveJob = { ownerKey: owner.key, attempt: job.attempt, controller, completion };
    this.#active.set(job.id, active);
    try {
      await this.#store(owner).transaction((jobs) => {
        const stored = findOwned(jobs, owner, job.id);
        if (stored.state !== "starting" || stored.attempt !== job.attempt) throw new Error("Durable job changed while it was starting");
        if (stored.host?.token !== this.#hostToken || stored.host.pid !== process.pid) {
          throw new Error("Durable job host ownership changed while it was starting");
        }
        stored.state = "running";
        stored.updatedAt = this.#now();
      }, new Set([job.id]));
    } catch (cause) {
      this.#active.delete(job.id);
      resolveCompletion();
      await this.#interruptUnlaunched(owner, job, cause);
    }
    active.timeout = setTimeout(() => {
      void this.#terminateActive(job.id, "timed_out", `Durable job exceeded ${job.timeoutMs} ms`).catch((cause) => {
        owner.diagnostic?.(`Durable job timeout failed: ${boundedError(cause)}`);
      });
    }, job.timeoutMs);
    void this.#runOperation(owner, job, active, operation)
      .catch((cause) => owner.diagnostic?.(`Durable job settlement failed: ${boundedError(cause)}`))
      .finally(resolveCompletion);
    return await this.#inspect(owner, job.id);
  }

  async #interruptUnlaunched(owner: DurableJobOwner, job: StoredJob, cause: unknown): Promise<never> {
    try {
      await this.#settle(owner, job.id, job.attempt, "interrupted", undefined, boundedError(cause));
    } catch (persistenceFailure) {
      throw new AggregateError(
        [cause, persistenceFailure],
        "Durable job launch failed and its interruption could not be persisted",
        { cause },
      );
    }
    throw cause;
  }

  async #runOperation(
    owner: DurableJobOwner,
    job: StoredJob,
    active: ActiveJob,
    operation: ExtensionJobOperation,
  ): Promise<void> {
    try {
      const context: ExtensionJobContext = Object.freeze({
        id: job.id,
        attempt: job.attempt,
        signal: active.controller.signal,
        replaceMetadata: async (metadata: JsonValue) => await this.#replaceMetadata(owner, job.id, job.attempt, metadata),
      });
      let result: JsonValue | undefined;
      try {
        const value = await operation(context);
        active.controller.signal.throwIfAborted();
        result = value === undefined ? undefined : boundedJson(value, "Durable job result", MAX_RESULT_BYTES);
      } catch (cause) {
        if (!active.controller.signal.aborted) {
          const state = cause instanceof InterruptedJobError ? "interrupted" : "failed";
          await this.#settle(owner, job.id, job.attempt, state, undefined, boundedError(cause));
        }
        return;
      }
      await this.#settle(owner, job.id, job.attempt, "succeeded", result);
    } finally {
      if (active.timeout !== undefined) clearTimeout(active.timeout);
      if (this.#active.get(job.id) === active) this.#active.delete(job.id);
    }
  }

  async #settle(
    owner: DurableJobOwner,
    id: string,
    attempt: number,
    state: Extract<ExtensionJobState, "succeeded" | "failed" | "interrupted">,
    result?: JsonValue,
    failure?: string,
  ): Promise<void> {
    await this.#store(owner).transaction((jobs) => {
      const job = findOwned(jobs, owner, id);
      if (job.attempt !== attempt || !ACTIVE_STATES.has(job.state)) return;
      job.state = state;
      job.updatedAt = this.#now();
      delete job.host;
      if (result === undefined) delete job.result;
      else job.result = result;
      if (failure === undefined) delete job.error;
      else job.error = failure;
    }, new Set([id]));
  }

  async #replaceMetadata(owner: DurableJobOwner, id: string, attempt: number, metadata: JsonValue): Promise<ExtensionJobStatus> {
    const selected = boundedJson(metadata, "Durable job metadata", MAX_METADATA_BYTES);
    let status: ExtensionJobStatus | undefined;
    await this.#store(owner).transaction((jobs) => {
      const job = findOwned(jobs, owner, id);
      if (job.attempt !== attempt || !ACTIVE_STATES.has(job.state)) throw new Error("Durable job is no longer active");
      job.metadata = selected;
      job.updatedAt = this.#now();
      status = publicStatus(job);
    }, new Set([id]));
    if (status === undefined) throw new Error("Durable job metadata update failed");
    return status;
  }

  async #terminateActive(
    id: string,
    state: Extract<ExtensionJobState, "cancelled" | "timed_out" | "interrupted">,
    message: string,
  ): Promise<void> {
    const active = this.#active.get(id);
    if (active === undefined) return;
    let failure: unknown;
    try {
      for (const store of this.#stores.values()) {
        let changed = false;
        await store.transaction((jobs) => {
          const job = jobs.find((candidate) => candidate.id === id && candidate.attempt === active.attempt);
          if (job === undefined || !ACTIVE_STATES.has(job.state)) return;
          job.state = state;
          job.updatedAt = this.#now();
          job.error = message;
          delete job.host;
          changed = true;
        }, new Set([id]));
        if (changed) break;
      }
    } catch (cause) {
      failure = cause;
    } finally {
      if (active.timeout !== undefined) clearTimeout(active.timeout);
      active.controller.abort(new Error(message));
    }
    if (failure !== undefined) throw failure;
  }

  async #cancel(owner: DurableJobOwner, id: string): Promise<ExtensionJobStatus> {
    this.#assertOwner(owner, true);
    let status: ExtensionJobStatus | undefined;
    let localActive = false;
    await this.#store(owner).transaction(async (jobs) => {
      await this.#recover(owner, jobs);
      const job = findOwned(jobs, owner, id);
      localActive = this.#active.has(id);
      if (ACTIVE_STATES.has(job.state) && !localActive && this.#ownedByLiveHost(job)) {
        throw new Error(`Durable job ${id} is owned by another live host`);
      }
      if (job.state === "interrupted" || ACTIVE_STATES.has(job.state)) {
        job.state = "cancelled";
        job.updatedAt = this.#now();
        job.error = "Durable job cancelled";
        delete job.host;
      }
      status = publicStatus(job);
    }, new Set([id]));
    if (status === undefined) throw new Error("Durable job cancellation failed");
    if (localActive) {
      await this.#clients.get(id)?.abort().catch(() => undefined);
      await this.#terminateActive(id, "cancelled", "Durable job cancelled");
    }
    return status;
  }

  async #inspect(owner: DurableJobOwner, id: string): Promise<ExtensionJobStatus> {
    this.#assertOwner(owner, true);
    let status: ExtensionJobStatus | undefined;
    await this.#store(owner).transaction(async (jobs) => {
      await this.#recover(owner, jobs);
      status = publicStatus(findOwned(jobs, owner, id));
    }, new Set([id]));
    if (status === undefined) throw new Error("Durable job inspection failed");
    return status;
  }

  async #list(owner: DurableJobOwner, input: ExtensionJobListOptions): Promise<readonly ExtensionJobStatus[]> {
    this.#assertOwner(owner, true);
    const options = validateListOptions(input);
    const ownerId = storedOwner(owner);
    let statuses: readonly ExtensionJobStatus[] = [];
    await this.#store(owner).transaction(async (jobs) => {
      await this.#recover(owner, jobs);
      statuses = jobs
        .filter((job) => job.owner === ownerId)
        .filter((job) => options.state === undefined || job.state === options.state)
        .filter((job) => options.kind === undefined || job.kind === options.kind)
        .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
        .slice(0, options.limit)
        .map(publicStatus);
    });
    return Object.freeze(statuses);
  }

  async #wait(owner: DurableJobOwner, id: string, options: ExtensionJobWaitOptions): Promise<ExtensionJobStatus> {
    this.#assertOwner(owner, true);
    options.signal?.throwIfAborted();
    for (;;) {
      const current = await this.#inspect(owner, id);
      if (!ACTIVE_STATES.has(current.state)) return current;
      const active = this.#active.get(id);
      if (active !== undefined) {
        if (options.signal === undefined) await active.completion;
        else await withAbort(active.completion, options.signal);
      } else if (options.signal === undefined) {
        await new Promise<void>((resolveValue) => setTimeout(resolveValue, RPC_POLL_MS));
      } else {
        await delay(RPC_POLL_MS, options.signal);
      }
    }
  }

  async #spawnChild(owner: DurableJobOwner, input: ExtensionChildSessionStartOptions): Promise<ExtensionChildSessionStatus> {
    this.#assertOwner(owner, true);
    const metadata = await this.#newChildMetadata(owner, input);
    let readyResolve: () => void = () => undefined;
    let readyReject: (cause: unknown) => void = () => undefined;
    const ready = new Promise<void>((resolveValue, rejectValue) => {
      readyResolve = resolveValue;
      readyReject = rejectValue;
    });
    void ready.catch(() => undefined);
    const options: MutableExtensionJobStartOptions = {
      kind: "ohm.child-session",
      metadata,
    };
    if (input.idempotencyKey !== undefined) options.idempotencyKey = input.idempotencyKey;
    if (input.label !== undefined) options.label = input.label;
    if (input.timeoutMs !== undefined) options.timeoutMs = input.timeoutMs;
    const launched = await this.#start(
      owner,
      options,
      async (context) => await this.#runChild(owner, context, metadata, readyResolve, readyReject),
      true,
    );
    if (launched.created) {
      await ready;
      return this.#childStatus(await this.#inspect(owner, launched.status.id));
    }
    return await this.#awaitChildSpawn(owner, launched.status.id);
  }

  async #awaitChildSpawn(owner: DurableJobOwner, id: string): Promise<ExtensionChildSessionStatus> {
    for (;;) {
      const current = this.#childStatus(await this.#inspect(owner, id));
      if (!ACTIVE_STATES.has(current.state) || (current.sessionId !== undefined && current.sessionFile !== undefined)) {
        return current;
      }
      await delay(RPC_POLL_MS, owner.signal);
    }
  }

  async #reattachChild(owner: DurableJobOwner, id: string): Promise<ExtensionChildSessionStatus> {
    this.#assertOwner(owner, true);
    const current = this.#childStatus(await this.#inspect(owner, id));
    if (current.state !== "interrupted") throw new Error(`Child session ${id} is ${current.state}, not interrupted`);
    const metadata = await this.#validatedChildMetadata(owner, current.metadata, true);
    let readyResolve: () => void = () => undefined;
    let readyReject: (cause: unknown) => void = () => undefined;
    const ready = new Promise<void>((resolveValue, rejectValue) => {
      readyResolve = resolveValue;
      readyReject = rejectValue;
    });
    void ready.catch(() => undefined);
    await this.#resume(
      owner,
      id,
      async (context) => await this.#runChild(owner, context, metadata, readyResolve, readyReject, true),
      "ohm.child-session",
    );
    await ready;
    return this.#childStatus(await this.#inspect(owner, id));
  }

  async #runChild(
    owner: DurableJobOwner,
    context: ExtensionJobContext,
    metadata: ChildSessionMetadata,
    ready: () => void,
    rejectReady: (cause: unknown) => void,
    reattaching = false,
  ): Promise<undefined> {
    const args = [...metadata.args];
    if (metadata.sessionFile !== undefined) args.push("--session", metadata.sessionFile);
    args.push("--session-dir", metadata.sessionDirectory, "--no-extensions", owner.projectTrusted() ? "--approve" : "--no-approve");
    const client = this.#rpcClientFactory({ cwd: metadata.cwd, args });
    this.#clients.set(context.id, client);
    try {
      context.signal.throwIfAborted();
      await client.start();
      const state = await client.getState();
      const sessionId = boundedString(state.sessionId, "Child session id", MAX_ID_BYTES);
      const sessionFile = await this.#canonicalSessionFile(metadata.sessionDirectory, state.sessionFile, sessionId);
      await context.replaceMetadata({
        ...metadata,
        sessionId,
        sessionFile,
      });
      ready();
      while (client.started) await delay(RPC_POLL_MS, context.signal);
      throw new InterruptedJobError("Child session RPC transport exited unexpectedly");
    } catch (cause) {
      rejectReady(cause);
      if (reattaching && !context.signal.aborted && !(cause instanceof InterruptedJobError)) {
        throw new InterruptedJobError(`Child session reattachment failed: ${boundedError(cause)}`, { cause });
      }
      throw cause;
    } finally {
      if (this.#clients.get(context.id) === client) this.#clients.delete(context.id);
      await client.stop().catch(() => undefined);
    }
  }

  async #newChildMetadata(owner: DurableJobOwner, input: ExtensionChildSessionStartOptions): Promise<ChildSessionMetadata> {
    if (!isObjectValue(input)) throw new TypeError("Child session options must be an object");
    const workspace = await canonicalDirectory(owner.workspace, "Child session workspace");
    const requestedCwd = input.cwd === undefined ? workspace : resolve(workspace, input.cwd);
    const cwd = await canonicalDirectory(requestedCwd, "Child session cwd");
    if (!pathInside(workspace, cwd)) throw new Error("Child session cwd must stay inside the host workspace");
    const sessionDirectory = await this.#childSessionDirectory(owner.root);
    const args: string[] = [];
    const provider = boundedOptionalString(input.provider, "Child session provider", 256);
    const model = boundedOptionalString(input.model, "Child session model", 512);
    const systemPrompt = boundedOptionalString(input.systemPrompt, "Child session systemPrompt", MAX_TEXT_BYTES);
    const appendSystemPrompt = boundedOptionalString(input.appendSystemPrompt, "Child session appendSystemPrompt", MAX_TEXT_BYTES);
    if (systemPrompt !== undefined && appendSystemPrompt !== undefined) {
      throw new Error("Child session systemPrompt and appendSystemPrompt are mutually exclusive");
    }
    if (provider !== undefined) args.push("--provider", provider);
    if (model !== undefined) args.push("--model", model);
    if (input.thinkingLevel !== undefined) {
      if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(input.thinkingLevel)) {
        throw new Error("Child session thinkingLevel is invalid");
      }
      args.push("--thinking", input.thinkingLevel);
    }
    this.#pushNameList(args, "--tools", input.tools);
    this.#pushNameList(args, "--exclude-tools", input.excludeTools);
    if (input.noBuiltinTools === true) args.push("--no-builtin-tools");
    if (input.noContextFiles === true) args.push("--no-context-files");
    if (systemPrompt !== undefined) args.push("--system-prompt", systemPrompt);
    if (appendSystemPrompt !== undefined) args.push("--append-system-prompt", appendSystemPrompt);
    return { schemaVersion: STORE_VERSION, cwd, args, sessionDirectory };
  }

  #pushNameList(args: string[], flag: string, values: readonly string[] | undefined): void {
    if (values === undefined) return;
    if (!Array.isArray(values) || values.length > 128) throw new Error(`${flag} cannot exceed 128 entries`);
    const selected = values.map((value) => boundedString(value, flag, 256));
    if (selected.some((value) => value.includes(","))) throw new Error(`${flag} entries cannot contain commas`);
    if (selected.length > 0) args.push(flag, selected.join(","));
  }

  async #childSessionDirectory(root: string): Promise<string> {
    const selected = join(resolve(root), CHILD_SESSION_DIRECTORY);
    await assertCanonicalDirectoryCreationPath(selected);
    await mkdir(selected, { recursive: true, mode: 0o700 });
    const information = await lstat(selected);
    if (!information.isDirectory() || information.isSymbolicLink()) {
      throw new Error("Child session directory must be a canonical directory");
    }
    const canonical = await realpath(selected);
    if (canonical !== selected) throw new Error("Child session directory must be canonical");
    if (!pathInside(resolve(root), canonical)) throw new Error("Child session directory escaped its extension data root");
    if (process.platform !== "win32") await chmod(canonical, 0o700);
    return canonical;
  }

  async #canonicalSessionFile(directory: string, value: string | undefined, expectedSessionId: string): Promise<string> {
    if (value === undefined) throw new Error("Child RPC session did not create a persistent V4 session file");
    const canonicalDirectoryPath = await canonicalDirectory(directory, "Child session directory");
    const canonical = await realpath(resolve(value));
    const information = await lstat(canonical);
    if (!information.isFile() || information.isSymbolicLink() || !pathInside(canonicalDirectoryPath, canonical)) {
      throw new Error("Child RPC session file is outside its host-owned session directory");
    }
    const descriptor = await open(canonical, constants.O_RDONLY | NO_FOLLOW | NON_BLOCKING);
    try {
      const chunks: Buffer[] = [];
      let total = 0;
      for (;;) {
        const chunk = Buffer.allocUnsafe(Math.min(4 * 1024, SESSION_V4_MAX_RECORD_BYTES + 1 - total));
        const read = await descriptor.read(chunk, 0, chunk.byteLength, total);
        if (read.bytesRead === 0) throw new Error("Child V4 session header is not LF-terminated");
        const selected = chunk.subarray(0, read.bytesRead);
        const newline = selected.indexOf(0x0a);
        if (newline >= 0) {
          chunks.push(selected.subarray(0, newline));
          break;
        }
        chunks.push(selected);
        total += read.bytesRead;
        if (total >= SESSION_V4_MAX_RECORD_BYTES) throw new Error("Child V4 session header exceeds its record bound");
      }
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!isJsonValue(parsed)) throw new Error("Child V4 session header is not JSON-safe");
      const header = parseSessionV4Header(parsed);
      if (header.version !== SESSION_V4_VERSION || header.sessionId !== expectedSessionId) {
        throw new Error("Child V4 session identity does not match its durable job record");
      }
    } finally {
      await descriptor.close();
    }
    return canonical;
  }

  async #validatedChildMetadata(owner: DurableJobOwner, value: JsonValue | undefined, requireSession: boolean): Promise<ChildSessionMetadata> {
    if (!isJsonObject(value)) {
      throw new Error("Child session metadata is missing");
    }
    if (ownProperty(value, "schemaVersion") !== STORE_VERSION) throw new Error("Child session metadata version is unsupported");
    const workspace = await canonicalDirectory(owner.workspace, "Child session workspace");
    const cwd = await canonicalDirectory(boundedString(ownProperty(value, "cwd"), "Child session cwd", 16 * 1024), "Child session cwd");
    if (!pathInside(workspace, cwd)) throw new Error("Child session cwd escaped the host workspace");
    const sessionDirectory = await this.#childSessionDirectory(owner.root);
    if (resolve(boundedString(ownProperty(value, "sessionDirectory"), "Child session directory", 16 * 1024)) !== sessionDirectory) {
      throw new Error("Child session metadata belongs to another session directory");
    }
    const argsValue = ownProperty(value, "args");
    if (!Array.isArray(argsValue) || argsValue.length > 256) throw new Error("Child session arguments are invalid");
    const args = argsValue.map((argument) => boundedString(argument, "Child session argument", MAX_TEXT_BYTES));
    const sessionId = boundedOptionalString(ownProperty(value, "sessionId"), "Child session id", MAX_ID_BYTES);
    const rawSessionFile = boundedOptionalString(ownProperty(value, "sessionFile"), "Child session file", 16 * 1024);
    let sessionFile: string | undefined;
    if (rawSessionFile !== undefined) {
      if (sessionId === undefined) throw new Error("Child session file has no matching session id");
      sessionFile = await this.#canonicalSessionFile(sessionDirectory, rawSessionFile, sessionId);
    }
    if (requireSession && (sessionId === undefined || sessionFile === undefined)) {
      throw new Error("Interrupted child session has no persistent session identity to reattach");
    }
    const metadata = {
      schemaVersion: STORE_VERSION,
      cwd,
      args,
      sessionDirectory,
    } satisfies ChildSessionMetadata;
    if (sessionId === undefined) return metadata;
    if (sessionFile === undefined) return { ...metadata, sessionId };
    return { ...metadata, sessionId, sessionFile };
  }

  #childStatus(status: ExtensionJobStatus): ExtensionChildSessionStatus {
    if (status.kind !== "ohm.child-session") throw new Error(`Durable job ${status.id} is not a child session`);
    let sessionId: string | undefined;
    let sessionFile: string | undefined;
    const metadata = status.metadata;
    if (isJsonObject(metadata)) {
      const storedId = ownProperty(metadata, "sessionId");
      const storedFile = ownProperty(metadata, "sessionFile");
      if (Check(STRING_VALUE, storedId)) sessionId = storedId;
      if (Check(STRING_VALUE, storedFile)) sessionFile = storedFile;
    }
    const childStatus: MutableExtensionChildSessionStatus = {
      ...status,
      kind: "ohm.child-session",
    };
    if (sessionId !== undefined) childStatus.sessionId = sessionId;
    if (sessionFile !== undefined) childStatus.sessionFile = sessionFile;
    return Object.freeze(childStatus);
  }

  async #child(owner: DurableJobOwner, id: string): Promise<RpcClientLike> {
    const status = this.#childStatus(await this.#inspect(owner, id));
    if (status.state !== "running") throw new Error(`Child session ${id} is ${status.state}; reattach it before sending input`);
    const client = this.#clients.get(id);
    if (client === undefined || !client.started) throw new Error(`Child session ${id} has no attached RPC transport`);
    return client;
  }

  async #childCommand(
    owner: DurableJobOwner,
    id: string,
    command: "prompt" | "steer" | "followUp",
    message: string,
    images: readonly ImageContent[] | undefined,
  ): Promise<void> {
    this.#assertOwner(owner, true);
    const selectedMessage = boundedString(message, "Child session message", MAX_TEXT_BYTES);
    const client = await this.#child(owner, id);
    if (command === "prompt") await client.prompt(selectedMessage, images);
    else if (command === "steer") await client.steer(selectedMessage, images);
    else await client.followUp(selectedMessage, images);
  }

  async #childState(owner: DurableJobOwner, id: string): Promise<RpcSessionState> {
    this.#assertOwner(owner, true);
    return await (await this.#child(owner, id)).getState();
  }
}

export type { RpcSessionState } from "../interfaces/rpc-protocol.js";
