import { boundedJsonSnapshot } from "@ohm/kernel/runtime/core/bounded-json";
import { Check } from "typebox/value";

import type { JsonObject, JsonValue } from "../core/json.js";
import { FUNCTION_VALUE, isObjectValue, NUMBER_VALUE, STRING_VALUE } from "../core/value-schemas.js";

export const REPLICATED_JSON_STATE_PROTOCOL_VERSION = 1 as const;

export const REPLICATED_JSON_STATE_LIMITS = Object.freeze({
  maxStateBytes: 1024 * 1024,
  maxDeltaBytes: 256 * 1024,
  maxHistoryBytes: 1024 * 1024,
  maxHistoryEntries: 256,
  maxOperationsPerDelta: 256,
  maxPathSegments: 64,
  maxListeners: 64,
  maxValues: 65_536,
  maxContainers: 16_384,
  maxDepth: 64,
});

const UNSAFE_PATH_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

export type ReplicatedJsonStateOperation =
  | {
      readonly type: "replace";
      readonly value: JsonValue;
    }
  | {
      readonly type: "set";
      readonly path: readonly string[];
      readonly value: JsonValue;
    }
  | {
      readonly type: "delete";
      readonly path: readonly string[];
    };

export interface ReplicatedJsonStateSnapshot<T extends JsonValue = JsonValue> {
  readonly protocolVersion: typeof REPLICATED_JSON_STATE_PROTOCOL_VERSION;
  readonly revision: number;
  readonly value: T;
}

export interface ReplicatedJsonStateDelta {
  readonly protocolVersion: typeof REPLICATED_JSON_STATE_PROTOCOL_VERSION;
  readonly baseRevision: number;
  readonly revision: number;
  readonly operations: readonly ReplicatedJsonStateOperation[];
}

export interface ReplicatedJsonStateOptions {
  readonly signal?: AbortSignal;
  readonly maxStateBytes?: number;
  readonly maxDeltaBytes?: number;
  readonly maxHistoryBytes?: number;
  readonly maxHistoryEntries?: number;
  readonly maxListeners?: number;
}

export interface ReplicatedJsonState<T extends JsonValue = JsonValue> {
  readonly closed: boolean;
  snapshot(): ReplicatedJsonStateSnapshot<T>;
  update(operations: readonly ReplicatedJsonStateOperation[]): ReplicatedJsonStateDelta;
  apply(delta: ReplicatedJsonStateDelta): ReplicatedJsonStateSnapshot<T>;
  deltasSince(revision: number): readonly ReplicatedJsonStateDelta[];
  subscribe(listener: (delta: ReplicatedJsonStateDelta) => void): () => void;
  close(): void;
}

interface SelectedLimits {
  maxStateBytes: number;
  maxDeltaBytes: number;
  maxHistoryBytes: number;
  maxHistoryEntries: number;
  maxListeners: number;
}

function isJsonRecord(value: JsonValue): value is JsonObject {
  return !Array.isArray(value) && isObjectValue(value);
}

function positiveLimit(value: number | undefined, fallback: number, maximum: number, label: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > maximum) {
    throw new RangeError(`${label} must be from 1 through ${maximum}`);
  }
  return selected;
}

function selectedLimits(options: ReplicatedJsonStateOptions): SelectedLimits {
  return Object.freeze({
    maxStateBytes: positiveLimit(
      options.maxStateBytes,
      REPLICATED_JSON_STATE_LIMITS.maxStateBytes,
      REPLICATED_JSON_STATE_LIMITS.maxStateBytes,
      "Replicated JSON state byte limit",
    ),
    maxDeltaBytes: positiveLimit(
      options.maxDeltaBytes,
      REPLICATED_JSON_STATE_LIMITS.maxDeltaBytes,
      REPLICATED_JSON_STATE_LIMITS.maxDeltaBytes,
      "Replicated JSON state delta byte limit",
    ),
    maxHistoryBytes: positiveLimit(
      options.maxHistoryBytes,
      REPLICATED_JSON_STATE_LIMITS.maxHistoryBytes,
      REPLICATED_JSON_STATE_LIMITS.maxHistoryBytes,
      "Replicated JSON state history byte limit",
    ),
    maxHistoryEntries: positiveLimit(
      options.maxHistoryEntries,
      REPLICATED_JSON_STATE_LIMITS.maxHistoryEntries,
      REPLICATED_JSON_STATE_LIMITS.maxHistoryEntries,
      "Replicated JSON state history entry limit",
    ),
    maxListeners: positiveLimit(
      options.maxListeners,
      REPLICATED_JSON_STATE_LIMITS.maxListeners,
      REPLICATED_JSON_STATE_LIMITS.maxListeners,
      "Replicated JSON state listener limit",
    ),
  });
}

function snapshotJson<T extends JsonValue>(value: T, label: string, maximumBytes: number): T {
  const bounded = boundedJsonSnapshot(value, {
    label,
    maximumBytes,
    maximumValues: REPLICATED_JSON_STATE_LIMITS.maxValues,
    maximumContainers: REPLICATED_JSON_STATE_LIMITS.maxContainers,
    maximumDepth: REPLICATED_JSON_STATE_LIMITS.maxDepth,
  });
  // SAFETY: the bounded snapshot preserves the input JSON shape while canonicalizing its runtime representation.
  const snapshot = structuredClone(bounded.value) as T;
  const pending: JsonValue[] = [snapshot];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    if ((Array.isArray(current) || isJsonRecord(current)) && !Object.isFrozen(current)) {
      Object.freeze(current);
      pending.push(...Object.values(current));
    }
  }
  return snapshot;
}

function revision(value: JsonValue | undefined, label: string): number {
  if (!Check(NUMBER_VALUE, value) || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function record(value: JsonValue, label: string): JsonObject {
  if (!isJsonRecord(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function exact(value: JsonObject, keys: readonly string[], label: string): void {
  const allowed = new Set(keys);
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected !== undefined) throw new TypeError(`${label}.${unexpected} is not allowed`);
}

function path(value: JsonValue | undefined, label: string, allowEmpty: boolean): readonly string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new TypeError(`${label} must be a non-empty array`);
  }
  if (value.length > REPLICATED_JSON_STATE_LIMITS.maxPathSegments) {
    throw new RangeError(`${label} exceeds ${REPLICATED_JSON_STATE_LIMITS.maxPathSegments} segments`);
  }
  return Object.freeze(value.map((segment, index) => {
    if (
      !Check(STRING_VALUE, segment)
      || segment === ""
      || segment.includes("\0")
      || Buffer.byteLength(segment, "utf8") > 1_024
      || UNSAFE_PATH_SEGMENTS.has(segment)
    ) throw new TypeError(`${label}[${index}] is invalid`);
    return segment;
  }));
}

function requiredJsonValue(value: JsonValue | undefined, label: string): JsonValue {
  if (value === undefined) throw new TypeError(`${label} is required`);
  return value;
}

function operation(value: JsonValue, index: number, maxDeltaBytes: number): ReplicatedJsonStateOperation {
  const label = `Replicated JSON state operation ${index}`;
  const selected = record(value, label);
  if (selected["type"] === "replace") {
    exact(selected, ["type", "value"], label);
    return Object.freeze({
      type: "replace",
      value: snapshotJson(requiredJsonValue(selected["value"], `${label}.value`), `${label} value`, maxDeltaBytes),
    });
  }
  if (selected["type"] === "set") {
    exact(selected, ["type", "path", "value"], label);
    return Object.freeze({
      type: "set",
      path: path(selected["path"], `${label} path`, false),
      value: snapshotJson(requiredJsonValue(selected["value"], `${label}.value`), `${label} value`, maxDeltaBytes),
    });
  }
  if (selected["type"] === "delete") {
    exact(selected, ["type", "path"], label);
    return Object.freeze({
      type: "delete",
      path: path(selected["path"], `${label} path`, false),
    });
  }
  throw new TypeError(`${label}.type is invalid`);
}

function operations(
  values: JsonValue | undefined,
  maxDeltaBytes: number,
): readonly ReplicatedJsonStateOperation[] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new TypeError("Replicated JSON state operations must be a non-empty array");
  }
  if (values.length > REPLICATED_JSON_STATE_LIMITS.maxOperationsPerDelta) {
    throw new RangeError(`Replicated JSON state delta exceeds ${REPLICATED_JSON_STATE_LIMITS.maxOperationsPerDelta} operations`);
  }
  snapshotJson(values, "Replicated JSON state delta operations", maxDeltaBytes);
  const selected = Object.freeze(values.map((value, index) => operation(value, index, maxDeltaBytes)));
  return selected;
}

function cloneForMutation<T extends JsonValue>(value: T): T {
  return structuredClone(value);
}

function arrayIndex(segment: string, length: number, allowEnd: boolean, label: string): number {
  if (!/^(?:0|[1-9]\d*)$/u.test(segment)) throw new TypeError(`${label} is not an array index`);
  const selected = Number(segment);
  const maximum = allowEnd ? length : length - 1;
  if (!Number.isSafeInteger(selected) || selected < 0 || selected > maximum) {
    throw new RangeError(`${label} is outside the array`);
  }
  return selected;
}

interface JsonTarget {
  container: JsonObject | JsonValue[];
  key: string;
}

function containerAt(root: JsonValue, pathValue: readonly string[]): JsonTarget {
  let selected: JsonValue = root;
  for (const [index, segment] of pathValue.slice(0, -1).entries()) {
    if (Array.isArray(selected)) {
      selected = selected[arrayIndex(segment, selected.length, false, `Replicated JSON state path ${index}`)]!;
    } else if (isJsonRecord(selected)) {
      if (!Object.hasOwn(selected, segment)) throw new TypeError(`Replicated JSON state path ${index} is missing`);
      selected = selected[segment]!;
    } else throw new TypeError(`Replicated JSON state path ${index} is not a container`);
  }
  if (Array.isArray(selected) || isJsonRecord(selected)) {
    return { container: selected, key: pathValue.at(-1)! };
  }
  throw new TypeError("Replicated JSON state target parent is not a container");
}

function applyOperations(current: JsonValue, selected: readonly ReplicatedJsonStateOperation[]): JsonValue {
  let result = cloneForMutation(current);
  for (const operationValue of selected) {
    if (operationValue.type === "replace") {
      result = cloneForMutation(operationValue.value);
      continue;
    }
    const { container, key } = containerAt(result, operationValue.path);
    if (Array.isArray(container)) {
      const index = arrayIndex(key, container.length, operationValue.type === "set", "Replicated JSON state target");
      if (operationValue.type === "delete") container.splice(index, 1);
      else if (index === container.length) container.push(cloneForMutation(operationValue.value));
      else container[index] = cloneForMutation(operationValue.value);
    } else if (operationValue.type === "delete") {
      if (!Object.hasOwn(container, key)) throw new TypeError("Replicated JSON state delete target is missing");
      delete container[key];
    } else container[key] = cloneForMutation(operationValue.value);
  }
  return result;
}

function validateDelta<Value>(value: Value, maxDeltaBytes: number): ReplicatedJsonStateDelta {
  const parsed = boundedJsonSnapshot(value, {
    label: "Replicated JSON state delta",
    maximumBytes: maxDeltaBytes,
    maximumValues: REPLICATED_JSON_STATE_LIMITS.maxValues,
    maximumContainers: REPLICATED_JSON_STATE_LIMITS.maxContainers,
    maximumDepth: REPLICATED_JSON_STATE_LIMITS.maxDepth,
  }).value;
  const selected = record(parsed, "Replicated JSON state delta");
  exact(selected, ["protocolVersion", "baseRevision", "revision", "operations"], "Replicated JSON state delta");
  if (selected["protocolVersion"] !== REPLICATED_JSON_STATE_PROTOCOL_VERSION) {
    throw new TypeError("Replicated JSON state protocol version is unsupported");
  }
  const baseRevision = revision(selected["baseRevision"], "Replicated JSON state base revision");
  const nextRevision = revision(selected["revision"], "Replicated JSON state revision");
  if (nextRevision !== baseRevision + 1) throw new TypeError("Replicated JSON state revision must advance by one");
  const selectedOperations = operations(selected["operations"], maxDeltaBytes);
  const delta: ReplicatedJsonStateDelta = Object.freeze({
    protocolVersion: REPLICATED_JSON_STATE_PROTOCOL_VERSION,
    baseRevision,
    revision: nextRevision,
    operations: selectedOperations,
  });
  return delta;
}

/** In-memory replicated state with bounded deltas and deterministic replay. */
export function createReplicatedJsonState<T extends JsonValue>(
  initial: T,
  options: ReplicatedJsonStateOptions = {},
): ReplicatedJsonState<T> {
  const limits = selectedLimits(options);
  let value = snapshotJson(initial, "Replicated JSON state", limits.maxStateBytes);
  let currentRevision = 0;
  let historyBytes = 0;
  const history: Array<{ delta: ReplicatedJsonStateDelta; bytes: number }> = [];
  const listeners = new Set<(delta: ReplicatedJsonStateDelta) => void>();
  let closed = false;
  const assertOpen = (): void => {
    if (closed) throw new Error("Replicated JSON state is closed");
    options.signal?.throwIfAborted();
  };
  const close = (): void => {
    if (closed) return;
    closed = true;
    listeners.clear();
    history.length = 0;
    historyBytes = 0;
    options.signal?.removeEventListener("abort", close);
  };
  options.signal?.addEventListener("abort", close, { once: true });
  if (options.signal?.aborted === true) close();

  const commit = (rawDelta: ReplicatedJsonStateDelta): ReplicatedJsonStateSnapshot<T> => {
    assertOpen();
    const delta = validateDelta(rawDelta, limits.maxDeltaBytes);
    if (delta.baseRevision !== currentRevision) {
      throw new TypeError(`Replicated JSON state expected revision ${currentRevision}, received ${delta.baseRevision}`);
    }
    // SAFETY: T is the caller's stable view of this state handle; every replacement is parsed and bounded as JSON before commit.
    const next = snapshotJson(
      applyOperations(value, delta.operations),
      "Replicated JSON state",
      limits.maxStateBytes,
    ) as T;
    value = next;
    currentRevision = delta.revision;
    const bytes = Buffer.byteLength(JSON.stringify(delta), "utf8");
    history.push({ delta, bytes });
    historyBytes += bytes;
    while (history.length > limits.maxHistoryEntries || historyBytes > limits.maxHistoryBytes) {
      const removed = history.shift();
      if (removed === undefined) break;
      historyBytes -= removed.bytes;
    }
    for (const listener of Array.from(listeners)) {
      try { listener(delta); }
      catch {
        // Replication observers cannot roll back a committed revision or block later observers.
      }
    }
    return Object.freeze({
      protocolVersion: REPLICATED_JSON_STATE_PROTOCOL_VERSION,
      revision: currentRevision,
      value: snapshotJson(value, "Replicated JSON state snapshot", limits.maxStateBytes),
    });
  };

  const state: ReplicatedJsonState<T> = {
    get closed() { return closed; },
    snapshot() {
      assertOpen();
      return Object.freeze({
        protocolVersion: REPLICATED_JSON_STATE_PROTOCOL_VERSION,
        revision: currentRevision,
        value: snapshotJson(value, "Replicated JSON state snapshot", limits.maxStateBytes),
      });
    },
    update(rawOperations: readonly ReplicatedJsonStateOperation[]) {
      assertOpen();
      const delta = validateDelta({
        protocolVersion: REPLICATED_JSON_STATE_PROTOCOL_VERSION,
        baseRevision: currentRevision,
        revision: currentRevision + 1,
        operations: rawOperations,
      }, limits.maxDeltaBytes);
      commit(delta);
      return delta;
    },
    apply(delta: ReplicatedJsonStateDelta) { return commit(delta); },
    deltasSince(valueRevision: number) {
      assertOpen();
      const selected = revision(valueRevision, "Replicated JSON state requested revision");
      if (selected > currentRevision) throw new RangeError("Replicated JSON state requested revision is ahead of the current state");
      if (selected === currentRevision) return Object.freeze([]);
      const first = history[0]?.delta.baseRevision;
      if (first === undefined || selected < first) {
        throw new RangeError("Replicated JSON state requested revision is outside retained history");
      }
      return Object.freeze(history.filter((entry) => entry.delta.revision > selected).map((entry) => entry.delta));
    },
    subscribe(listener: (delta: ReplicatedJsonStateDelta) => void) {
      assertOpen();
      if (!Check(FUNCTION_VALUE, listener)) throw new TypeError("Replicated JSON state listener must be a function");
      if (listeners.size >= limits.maxListeners) {
        throw new RangeError(`Replicated JSON state exceeds ${limits.maxListeners} listeners`);
      }
      listeners.add(listener);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        listeners.delete(listener);
      };
    },
    close,
  };
  return Object.freeze(state);
}
