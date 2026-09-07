import { constants } from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  lstat,
  open,
  rename,
  unlink,
} from "node:fs/promises";
import { join, resolve } from "node:path";

import { boundedJsonSnapshot } from "@ohm/kernel/runtime/core/bounded-json";
import { Check } from "typebox/value";

import { errorCode, errorMessage } from "../core/errors.js";
import { isJsonObject, isJsonValue, type JsonObject, type JsonValue } from "../core/json.js";
import { FUNCTION_VALUE, NUMBER_VALUE, STRING_VALUE, isObjectValue } from "../core/value-schemas.js";
import { withFileLock } from "../storage/file-lock.js";

const STORE_VERSION = 1;
const STORE_FILE = "durable-jobs-v1.json";
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
const MAX_LIST_LIMIT = 256;
const MAX_JSON_VALUES = 8_192;
const MAX_JSON_CONTAINERS = 4_096;
const MAX_JSON_DEPTH = 59;
const DEFAULT_JOB_TIMEOUT_MS = 60 * 60 * 1_000;
const MAX_JOB_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
const JOB_POLL_MS = 100;
const CLOSE_DRAIN_MS = 2_500;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const NON_BLOCKING = constants.O_NONBLOCK ?? 0;
const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const JOB_KIND = /^[a-z][a-z0-9._-]{0,127}$/u;
const ACTIVE_STATES = new Set<PluginJobState>(["starting", "running"]);
const PRUNABLE_STATES = new Set<PluginJobState>(["succeeded", "failed", "cancelled", "timed_out"]);
const LIVE_HOST_TOKENS = new Set<string>();

export type PluginJobId = string;
export type PluginJobState =
  | "starting"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "interrupted";

export interface PluginJobStatus {
  readonly id: PluginJobId;
  readonly kind: string;
  readonly state: PluginJobState;
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

export interface PluginJobStartOptions {
  readonly kind: string;
  readonly idempotencyKey?: string;
  readonly label?: string;
  readonly metadata?: JsonValue;
  readonly timeoutMs?: number;
}

export interface PluginJobListOptions {
  readonly state?: PluginJobState;
  readonly kind?: string;
  readonly limit?: number;
}

export interface PluginJobWaitOptions {
  readonly signal?: AbortSignal;
}

export interface PluginJobContext {
  readonly id: PluginJobId;
  readonly attempt: number;
  readonly signal: AbortSignal;
  replaceMetadata(metadata: JsonValue): Promise<PluginJobStatus>;
}

export type PluginJobOperation = (
  context: PluginJobContext,
) => JsonValue | undefined | Promise<JsonValue | undefined>;

export interface PluginJobService {
  start(options: PluginJobStartOptions, operation: PluginJobOperation): Promise<PluginJobStatus>;
  resume(id: PluginJobId, operation: PluginJobOperation): Promise<PluginJobStatus>;
  cancel(id: PluginJobId): Promise<PluginJobStatus>;
  inspect(id: PluginJobId): Promise<PluginJobStatus>;
  list(options?: PluginJobListOptions): Promise<readonly PluginJobStatus[]>;
  wait(id: PluginJobId, options?: PluginJobWaitOptions): Promise<PluginJobStatus>;
}

type MutablePluginJobStatus = {
  -readonly [Key in keyof PluginJobStatus]: PluginJobStatus[Key];
};

interface StoredJob extends JsonObject {
  id: string;
  owner: string;
  kind: string;
  state: PluginJobState;
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
  readonly settled: Promise<void>;
  readonly settle: () => void;
  timeout?: NodeJS.Timeout;
}

interface DurableJobSupervisorOptions {
  readonly now?: () => number;
}

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

function publicStatus(job: StoredJob): PluginJobStatus {
  const status: MutablePluginJobStatus = {
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

function validateStartOptions(input: PluginJobStartOptions): ValidatedStartOptions {
  if (!isObjectValue(input)) throw new TypeError("Durable job options are required");
  const kind = boundedString(input.kind, "Durable job kind", MAX_KIND_BYTES);
  if (!JOB_KIND.test(kind)) throw new Error("Durable job kind is invalid");
  if (kind.startsWith("ohm.")) throw new Error("Durable job kinds beginning with ohm. are reserved by the host");
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
  state?: PluginJobState;
  kind?: string;
}

function validateListOptions(options: PluginJobListOptions): ValidatedListOptions {
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

/** @internal Host-owned durable lifecycle registry used by plugin API facades. */
export class DurableJobSupervisor {
  readonly #active = new Map<string, ActiveJob>();
  readonly #launching = new Set<string>();
  readonly #boundOwners = new WeakSet<object>();
  readonly #stores = new Map<string, DurableJobStore>();
  readonly #now: () => number;
  readonly #hostToken = randomUUID();
  #closed = false;

  constructor(options: DurableJobSupervisorOptions = {}) {
    this.#now = options.now ?? Date.now;
    LIVE_HOST_TOKENS.add(this.#hostToken);
  }

  jobs(owner: DurableJobOwner): PluginJobService {
    this.#bindOwner(owner);
    const service: PluginJobService = {
      start: async (options, operation) => await this.#start(owner, options, operation),
      resume: async (id, operation) => await this.#resume(owner, id, operation),
      cancel: async (id) => await this.#cancel(owner, id),
      inspect: async (id) => await this.#inspect(owner, id),
      list: async (options = {}) => await this.#list(owner, options),
      wait: async (id, options = {}) => await this.#wait(owner, id, options),
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
        .map(async ([id]) => await this.#terminateActive(id, "interrupted", "Plugin generation stopped while the job was active"));
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
    if (!owner.isActive()) throw new Error("Runtime plugin context is no longer active");
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
    input: PluginJobStartOptions,
    operation: PluginJobOperation,
  ): Promise<PluginJobStatus> {
    this.#assertOwner(owner, true);
    if (!Check(FUNCTION_VALUE, operation)) throw new TypeError("Durable job operation must be a function");
    const options = validateStartOptions(input);
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
          throw new Error(`A plugin cannot exceed ${MAX_ACTIVE_JOBS} active durable jobs`);
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
    if (duplicate !== undefined) return publicStatus(duplicate);
    if (created === undefined) throw new Error("Durable job creation did not produce a record");
    try {
      return await this.#launch(owner, created, operation);
    } finally {
      this.#launching.delete(created.id);
    }
  }

  async #resume(
    owner: DurableJobOwner,
    id: string,
    operation: PluginJobOperation,
  ): Promise<PluginJobStatus> {
    this.#assertOwner(owner, true);
    if (!Check(FUNCTION_VALUE, operation)) throw new TypeError("Durable job operation must be a function");
    const store = this.#store(owner);
    const ownerId = storedOwner(owner);
    let selected: StoredJob | undefined;
    try {
      await store.transaction(async (jobs) => {
        await this.#recover(owner, jobs);
        const job = findOwned(jobs, owner, id);
        if (job.kind.startsWith("ohm.")) {
          throw new Error(`Durable job ${id} has a legacy host-reserved kind and cannot be resumed`);
        }
        if (job.state !== "interrupted") throw new Error(`Durable job ${id} is ${job.state}, not interrupted`);
        if (activeCount(jobs.filter((candidate) => candidate.owner === ownerId)) >= MAX_ACTIVE_JOBS) {
          throw new Error(`A plugin cannot exceed ${MAX_ACTIVE_JOBS} active durable jobs`);
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
      return await this.#launch(owner, selected, operation);
    } finally {
      this.#launching.delete(id);
    }
  }

  async #launch(owner: DurableJobOwner, job: StoredJob, operation: PluginJobOperation): Promise<PluginJobStatus> {
    try {
      this.#assertOwner(owner, true);
    } catch (cause) {
      await this.#interruptUnlaunched(owner, job, cause);
    }
    const controller = new AbortController();
    let resolveCompletion: () => void = () => undefined;
    const completion = new Promise<void>((resolveValue) => { resolveCompletion = resolveValue; });
    let settle: () => void = () => undefined;
    const settled = new Promise<void>((resolveValue) => { settle = resolveValue; });
    const active: ActiveJob = { ownerKey: owner.key, attempt: job.attempt, controller, completion, settled, settle };
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
      settle();
      await this.#interruptUnlaunched(owner, job, cause);
    }
    active.timeout = setTimeout(() => {
      void this.#terminateActive(job.id, "timed_out", `Durable job exceeded ${job.timeoutMs} ms`).catch((cause) => {
        owner.diagnostic?.(`Durable job timeout failed: ${boundedError(cause)}`);
      });
    }, job.timeoutMs);
    void this.#runOperation(owner, job, active, operation)
      .catch((cause) => owner.diagnostic?.(`Durable job settlement failed: ${boundedError(cause)}`))
      .finally(() => { settle(); resolveCompletion(); });
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
    operation: PluginJobOperation,
  ): Promise<void> {
    try {
      const context: PluginJobContext = Object.freeze({
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
          await this.#settle(owner, job.id, job.attempt, "failed", undefined, boundedError(cause));
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
    state: Extract<PluginJobState, "succeeded" | "failed" | "interrupted">,
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

  async #replaceMetadata(owner: DurableJobOwner, id: string, attempt: number, metadata: JsonValue): Promise<PluginJobStatus> {
    const selected = boundedJson(metadata, "Durable job metadata", MAX_METADATA_BYTES);
    let status: PluginJobStatus | undefined;
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
    state: Extract<PluginJobState, "cancelled" | "timed_out" | "interrupted">,
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
    active.settle();
  }

  async #cancel(owner: DurableJobOwner, id: string): Promise<PluginJobStatus> {
    this.#assertOwner(owner, true);
    let status: PluginJobStatus | undefined;
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
      await this.#terminateActive(id, "cancelled", "Durable job cancelled");
    }
    return status;
  }

  async #inspect(owner: DurableJobOwner, id: string): Promise<PluginJobStatus> {
    this.#assertOwner(owner, true);
    let status: PluginJobStatus | undefined;
    await this.#store(owner).transaction(async (jobs) => {
      await this.#recover(owner, jobs);
      status = publicStatus(findOwned(jobs, owner, id));
    }, new Set([id]));
    if (status === undefined) throw new Error("Durable job inspection failed");
    return status;
  }

  async #list(owner: DurableJobOwner, input: PluginJobListOptions): Promise<readonly PluginJobStatus[]> {
    this.#assertOwner(owner, true);
    const options = validateListOptions(input);
    const ownerId = storedOwner(owner);
    let statuses: readonly PluginJobStatus[] = [];
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

  async #wait(owner: DurableJobOwner, id: string, options: PluginJobWaitOptions): Promise<PluginJobStatus> {
    this.#assertOwner(owner, true);
    options.signal?.throwIfAborted();
    for (;;) {
      const current = await this.#inspect(owner, id);
      if (!ACTIVE_STATES.has(current.state)) return current;
      const active = this.#active.get(id);
      if (active !== undefined) {
        if (options.signal === undefined) await active.settled;
        else await withAbort(active.settled, options.signal);
      } else if (options.signal === undefined) {
        await new Promise<void>((resolveValue) => setTimeout(resolveValue, JOB_POLL_MS));
      } else {
        await delay(JOB_POLL_MS, options.signal);
      }
    }
  }
}
