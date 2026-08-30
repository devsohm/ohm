import { isProxy } from "node:util/types";
import { Type } from "typebox";
import { Check } from "typebox/value";

import {
	BOOLEAN_VALUE,
	FUNCTION_VALUE,
	isObjectValue,
  NUMBER_VALUE,
  STRING_VALUE,
} from "../../internal/value-schemas.js";

const BUILTIN_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/\b((?:https?|wss?):\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@"],
  [/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, "$1[REDACTED]"],
  [/(x-api-key\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]"],
  [/(api[_-]?key\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]"],
  [/(access_token|refresh_token|id_token)=([^&\s]+)/gi, "$1=[REDACTED]"],
  [/([?&](?:code|client_secret|password|secret|token)=)[^&#\s]+/gi, "$1[REDACTED]"],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g, "[REDACTED]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[REDACTED]"],
  [/\bxox[baprs]-[A-Za-z0-9-]{16,}\b/g, "[REDACTED]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]"],
];

const SENSITIVE_KEY = /^(?:(?:access|refresh|id)[_-]?token|token|secret|password|passwd|api[_-]?key|authorization)$/iu;
const MAX_STRUCTURED_VALUES = 10_000;
const MAX_STRUCTURED_DEPTH = 64;
const TRUNCATED_VALUE = "[Truncated]";

interface StructuredArrayEntry {
  key: number;
  descriptor: PropertyDescriptor;
}

interface StructuredObjectEntry {
  key: string;
  descriptor: PropertyDescriptor;
}

type StructuredEntries =
  | { array: true; entries: StructuredArrayEntry[] }
  | { array: false; entries: StructuredObjectEntry[] };

const BIGINT_VALUE = Type.BigInt();
const SYMBOL_VALUE = Type.Symbol();

export type RedactedValue =
  | null
  | undefined
  | boolean
  | number
  | bigint
  | symbol
  | string
  | RedactedValue[]
  | RedactedObject;

export interface RedactedObject {
  [key: string]: RedactedValue;
}

function structuredEntries<Value extends object>(value: Value, maximumEntries: number): StructuredEntries | undefined {
  try {
    if (isProxy(value)) return undefined;
    const array = Array.isArray(value);
    const prototype: object | null = Object.getPrototypeOf(value);
    if ((array && prototype !== Array.prototype)
      || (!array && prototype !== Object.prototype && prototype !== null)) return undefined;

    if (array) {
      const lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, "length");
      const length = lengthDescriptor !== undefined && "value" in lengthDescriptor
        ? lengthDescriptor.value
        : undefined;
      if (!Check(NUMBER_VALUE, length) || !Number.isSafeInteger(length) || length < 0 || length > maximumEntries) {
        return undefined;
      }
      const keys = Reflect.ownKeys(value);
      if (keys.length !== length + 1) return undefined;
		const entries: StructuredArrayEntry[] = [];
      let elements = 0;
      for (const key of keys) {
        if (key === "length") continue;
        if (!Check(STRING_VALUE, key)) return undefined;
        const index = Number(key);
        if (!Number.isSafeInteger(index) || index < 0 || index >= length || String(index) !== key) {
          return undefined;
        }
        const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
        if (descriptor?.enumerable !== true) return undefined;
        entries[index] = { key: index, descriptor };
        elements += 1;
      }
      return elements === length ? { array: true, entries } : undefined;
    }

    const keys = Reflect.ownKeys(value);
    if (keys.length > maximumEntries) return undefined;
    const entries: StructuredObjectEntry[] = [];
    for (const key of keys) {
      if (!Check(STRING_VALUE, key)) return undefined;
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (descriptor?.enumerable !== true) return undefined;
      entries.push({ key, descriptor });
    }
    return { array: false, entries };
  } catch {
    return undefined;
  }
}

export const MIN_REDACTABLE_SECRET_CHARACTERS = 4;

export function assertRedactableSecret(secret: string, label = "Secret"): void {
  if (secret.length < MIN_REDACTABLE_SECRET_CHARACTERS) {
    throw new TypeError(`${label} must contain at least ${MIN_REDACTABLE_SECRET_CHARACTERS} characters`);
  }
}

export interface SecretRedactorOptions {
  maxSecrets?: number;
  maxSecretBytes?: number;
  maxTotalBytes?: number;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive integer`);
  return value;
}

export class SecretRedactor {
  readonly #secrets = new Set<string>();
  readonly #maxSecrets: number;
  readonly #maxSecretBytes: number;
  readonly #maxTotalBytes: number;
  #orderedSecrets: readonly string[] | undefined;
  #totalBytes = 0;

  constructor(options: SecretRedactorOptions = {}) {
    this.#maxSecrets = positiveInteger(options.maxSecrets ?? 4096, "maxSecrets");
    this.#maxSecretBytes = positiveInteger(options.maxSecretBytes ?? 64 * 1024, "maxSecretBytes");
    this.#maxTotalBytes = positiveInteger(options.maxTotalBytes ?? 4 * 1024 * 1024, "maxTotalBytes");
    if (this.#maxSecretBytes > this.#maxTotalBytes) {
      throw new TypeError("maxSecretBytes must not exceed maxTotalBytes");
    }
  }

  register(secret: string | undefined): void {
    if (secret === undefined || secret.length < MIN_REDACTABLE_SECRET_CHARACTERS || this.#secrets.has(secret)) return;
    const bytes = Buffer.byteLength(secret, "utf8");
    if (bytes > this.#maxSecretBytes) throw new Error("Secret exceeded redactor item capacity");
    if (this.#secrets.size >= this.#maxSecrets || this.#totalBytes + bytes > this.#maxTotalBytes) {
      throw new Error("Secret redactor capacity exceeded");
    }
    this.#secrets.add(secret);
    this.#orderedSecrets = undefined;
    this.#totalBytes += bytes;
  }

  registerAll(secrets: Iterable<string | undefined>): void {
    for (const secret of secrets) this.register(secret);
  }

  redact(text: string): string {
    let result = text;
    const secrets = this.#orderedSecrets ??= [...this.#secrets].sort((left, right) => right.length - left.length);
    for (const secret of secrets) result = result.replaceAll(secret, "[REDACTED]");
    for (const [pattern, replacement] of BUILTIN_PATTERNS) {
      result = result.replace(pattern, replacement);
    }
    return result;
  }

  containsSecretValue<Value>(value: Value): boolean {
    const pending = [value];
    const visited = new WeakSet<object>();
    let remaining = MAX_STRUCTURED_VALUES;
    while (pending.length > 0) {
      if (remaining <= 0) return true;
      remaining -= 1;
      const item = pending.pop();
      if (Check(STRING_VALUE, item)) {
        if (this.redact(item) !== item) return true;
        continue;
      }
      if (Check(FUNCTION_VALUE, item)) return true;
		if (!isObjectValue(item) || visited.has(item)) continue;
      visited.add(item);
      const selected = structuredEntries(item, remaining);
      if (selected === undefined) return true;
      for (const { key, descriptor } of selected.entries) {
        if (Check(STRING_VALUE, key) && this.redact(key) !== key) return true;
        if (!("value" in descriptor)) return true;
        pending.push(descriptor.value);
      }
    }
    return false;
  }

  redactValue<Value>(value: Value): RedactedValue {
    return this.#redactStructuredValue(value, false);
  }

  /** @internal Redacts values and omits secret-bearing keys inside arbitrary payload maps. */
  redactPayloadValue<Value>(value: Value): RedactedValue {
    return this.#redactStructuredValue(value, true);
  }

  #redactStructuredValue<Value>(value: Value, omitSecretKeys: boolean): RedactedValue {
    const active = new WeakSet<object>();
    let remaining = MAX_STRUCTURED_VALUES;
    const visit = <Item>(item: Item, depth: number): RedactedValue => {
      if (remaining <= 0) return TRUNCATED_VALUE;
      remaining -= 1;
      if (Check(STRING_VALUE, item)) return this.redact(item);
      if (Check(FUNCTION_VALUE, item)) return TRUNCATED_VALUE;
      if (item === null) return null;
      if (item === undefined) return undefined;
      if (Check(BOOLEAN_VALUE, item)) return item;
      if (Check(NUMBER_VALUE, item)) return item;
      if (Check(BIGINT_VALUE, item)) return item;
      if (Check(SYMBOL_VALUE, item)) return item;
		if (!isObjectValue(item)) return TRUNCATED_VALUE;
      if (active.has(item)) return "[Circular]";
      if (depth >= MAX_STRUCTURED_DEPTH) return TRUNCATED_VALUE;
      const selected = structuredEntries(item, remaining);
      if (selected === undefined) return TRUNCATED_VALUE;
      active.add(item);
      try {
        if (selected.array) {
			const redacted: RedactedValue[] = [];
          for (const { key, descriptor } of selected.entries) {
            redacted[key] = "value" in descriptor
              ? visit(descriptor.value, depth + 1)
              : "[Accessor]";
          }
          return redacted;
        }

        const redacted: RedactedObject = {};
        for (const { key, descriptor } of selected.entries) {
          const selectedKey = key;
          if (omitSecretKeys && this.redact(selectedKey) !== selectedKey) continue;
          const next = SENSITIVE_KEY.test(selectedKey)
            ? "[REDACTED]"
            : "value" in descriptor
              ? visit(descriptor.value, depth + 1)
              : "[Accessor]";
          Object.defineProperty(redacted, selectedKey, {
            value: next,
            enumerable: true,
            configurable: true,
            writable: true,
          });
        }
        return redacted;
      } finally {
        active.delete(item);
      }
    };
    return visit(value, 0);
  }
}

export const defaultSecretRedactor = new SecretRedactor();
