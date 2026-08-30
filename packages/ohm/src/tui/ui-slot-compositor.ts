import { hasObjectType, isFunctionValue, isStringValue } from "./value-guards.js";
import {
  EXTENSION_UI_SLOT_PATHS,
  type ExtensionUISlotContribution,
  type ExtensionUISlotPath,
  type ExtensionUISlotPlacement,
} from "../extensions/capabilities/ui-slots.js";
import { sanitizeTerminalText } from "./unicode.js";

export const MAX_EXTENSION_UI_SLOT_CONTRIBUTIONS = 64;
export const MAX_EXTENSION_UI_SLOT_CONTRIBUTIONS_PER_PATH = 16;
export const MAX_EXTENSION_UI_SLOT_LINES = 4;
export const MAX_EXTENSION_UI_SLOT_CONTRIBUTION_BYTES = 16 * 1024;
export const MAX_EXTENSION_UI_SLOT_BYTES = 64 * 1024;
export const MAX_EXTENSION_UI_SLOT_ORDER = 1_000_000;

const pathSet = new Set<string>(EXTENSION_UI_SLOT_PATHS);
const REPLACEABLE_PATHS = new Set<ExtensionUISlotPath>([
  "session.header",
  "session.footer",
]);
const KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,127}$/u;

interface NormalizedContribution {
  readonly lines: readonly string[];
  readonly placement: ExtensionUISlotPlacement;
  readonly order: number;
  readonly bytes: number;
}

export interface ExtensionUISlotToken {
  toString(): string;
}

interface SlotRecord extends NormalizedContribution {
  readonly ownerKey: string;
  readonly path: ExtensionUISlotPath;
  readonly key: string;
  readonly token: ExtensionUISlotToken;
  readonly ownerOrder: number;
  readonly registrationOrder: number;
}

export interface ExtensionUISlotProjection {
  readonly path: ExtensionUISlotPath;
  readonly lines: readonly string[];
  readonly replacement: boolean;
}

export function extensionUiSlotPath(value: ExtensionUISlotPath): ExtensionUISlotPath {
  if (!isStringValue(value) || !pathSet.has(value)) {
    throw new TypeError("Extension UI slot path is invalid");
  }
  return value;
}

export function extensionUiSlotKey(value: string): string {
  if (!isStringValue(value) || !KEY_PATTERN.test(value)) {
    throw new TypeError("Extension UI slot keys must be 1-128 identifier characters");
  }
  return value;
}

function ownerKey(value: string): string {
  if (!isStringValue(value) || value.length === 0 || Buffer.byteLength(value, "utf8") > 1_024) {
    throw new TypeError("Extension UI slot owner keys must contain 1-1024 bytes");
  }
  return value;
}

function contribution(
  path: ExtensionUISlotPath,
  value: ExtensionUISlotContribution,
): NormalizedContribution {
  if (value === null || !hasObjectType(value) || Array.isArray(value)) {
    throw new TypeError("Extension UI slot contribution must be an object");
  }
  if (!Array.isArray(value.lines) || value.lines.length < 1 || value.lines.length > MAX_EXTENSION_UI_SLOT_LINES) {
    throw new RangeError(`Extension UI slot contributions require 1-${MAX_EXTENSION_UI_SLOT_LINES} lines`);
  }
  const lines = value.lines.map((line, index) => {
    if (!isStringValue(line) || line.includes("\n") || line.includes("\r") || sanitizeTerminalText(line) !== line) {
      throw new TypeError(`Extension UI slot line ${index} must be plain terminal-safe text`);
    }
    return line;
  });
  const bytes = lines.reduce((total, line) => total + Buffer.byteLength(line, "utf8"), 0);
  if (bytes > MAX_EXTENSION_UI_SLOT_CONTRIBUTION_BYTES) {
    throw new RangeError(`Extension UI slot contributions are limited to ${MAX_EXTENSION_UI_SLOT_CONTRIBUTION_BYTES} bytes`);
  }
  const placement = value.placement ?? "append";
  if (placement !== "prepend" && placement !== "append" && placement !== "replace") {
    throw new TypeError("Extension UI slot placement must be prepend, append, or replace");
  }
  if (placement === "replace" && !REPLACEABLE_PATHS.has(path)) {
    throw new Error("Only session.header and session.footer support replacement");
  }
  const order = value.order ?? 0;
  if (!Number.isSafeInteger(order) || Math.abs(order) > MAX_EXTENSION_UI_SLOT_ORDER) {
    throw new RangeError(`Extension UI slot order must be an integer from -${MAX_EXTENSION_UI_SLOT_ORDER} through ${MAX_EXTENSION_UI_SLOT_ORDER}`);
  }
  return Object.freeze({
    lines: Object.freeze(lines),
    placement,
    order,
    bytes,
  });
}

export function validateExtensionUISlotContribution(
  pathValue: ExtensionUISlotPath,
  value: ExtensionUISlotContribution,
): ExtensionUISlotContribution {
  const path = extensionUiSlotPath(pathValue);
  const normalized = contribution(path, value);
  return Object.freeze({
    lines: normalized.lines,
    placement: normalized.placement,
    order: normalized.order,
  });
}

function recordId(owner: string, path: ExtensionUISlotPath, key: string): string {
  return JSON.stringify([owner, path, key]);
}

function compare(left: SlotRecord, right: SlotRecord): number {
  return left.order - right.order
    || left.ownerOrder - right.ownerOrder
    || left.registrationOrder - right.registrationOrder;
}

/** Bounded deterministic state store used by the rich TUI's existing slots. */
export class ExtensionUISlotCompositor {
  readonly #records = new Map<string, SlotRecord>();
  readonly #ownerOrders = new Map<string, number>();
  readonly #projections = new Map<ExtensionUISlotPath, ExtensionUISlotProjection>();
  #nextOwnerOrder = 0;
  #nextRegistrationOrder = 0;
  #bytes = 0;
  #version = 0;

  set(
    owner: string,
    pathValue: ExtensionUISlotPath,
    keyValue: string,
    value: ExtensionUISlotContribution,
    token: ExtensionUISlotToken,
  ): () => void {
    const selectedOwner = ownerKey(owner);
    const path = extensionUiSlotPath(pathValue);
    const key = extensionUiSlotKey(keyValue);
    if ((!hasObjectType(token) && !isFunctionValue(token)) || token === null) {
      throw new TypeError("Extension UI slot registration token must be an object");
    }
    const normalized = contribution(path, value);
    const id = recordId(selectedOwner, path, key);
    const previous = this.#records.get(id);
    const sameRegistration = previous?.token === token;
    if (previous === undefined && this.#records.size >= MAX_EXTENSION_UI_SLOT_CONTRIBUTIONS) {
      throw new RangeError(`Extension UI slots are limited to ${MAX_EXTENSION_UI_SLOT_CONTRIBUTIONS} contributions`);
    }
    if (
      previous === undefined
      && [...this.#records.values()].filter((record) => record.path === path).length
        >= MAX_EXTENSION_UI_SLOT_CONTRIBUTIONS_PER_PATH
    ) {
      throw new RangeError(`Extension UI slot ${path} is limited to ${MAX_EXTENSION_UI_SLOT_CONTRIBUTIONS_PER_PATH} contributions`);
    }
    const nextBytes = this.#bytes - (previous?.bytes ?? 0) + normalized.bytes;
    if (nextBytes > MAX_EXTENSION_UI_SLOT_BYTES) {
      throw new RangeError(`Extension UI slots are limited to ${MAX_EXTENSION_UI_SLOT_BYTES} bytes`);
    }
    const previousOwnerOrder = this.#ownerOrders.get(selectedOwner);
    const previousNextOwnerOrder = this.#nextOwnerOrder;
    const previousNextRegistrationOrder = this.#nextRegistrationOrder;
    let selectedOwnerOrder = previousOwnerOrder;
    if (selectedOwnerOrder === undefined) {
      selectedOwnerOrder = this.#nextOwnerOrder;
      this.#nextOwnerOrder += 1;
      this.#ownerOrders.set(selectedOwner, selectedOwnerOrder);
    }
    const selected: SlotRecord = Object.freeze({
      ...normalized,
      ownerKey: selectedOwner,
      path,
      key,
      token,
      ownerOrder: selectedOwnerOrder,
      registrationOrder: sameRegistration
        ? previous.registrationOrder
        : this.#nextRegistrationOrder++,
    });
    this.#records.set(id, selected);
    this.#bytes = nextBytes;
    this.#projections.delete(path);
    const selectedVersion = ++this.#version;
    let rolledBack = false;
    return () => {
      if (rolledBack || this.#version !== selectedVersion || this.#records.get(id) !== selected) return;
      rolledBack = true;
      if (previous === undefined) this.#records.delete(id);
      else this.#records.set(id, previous);
      this.#bytes = this.#bytes - selected.bytes + (previous?.bytes ?? 0);
      if (previousOwnerOrder === undefined) this.#forgetOwnerIfEmpty(selectedOwner);
      else this.#ownerOrders.set(selectedOwner, previousOwnerOrder);
      this.#nextOwnerOrder = previousNextOwnerOrder;
      this.#nextRegistrationOrder = previousNextRegistrationOrder;
      this.#version -= 1;
      this.#projections.delete(path);
    };
  }

  remove(owner: string, pathValue: ExtensionUISlotPath, keyValue: string, token?: ExtensionUISlotToken): boolean {
    const selectedOwner = ownerKey(owner);
    const path = extensionUiSlotPath(pathValue);
    const key = extensionUiSlotKey(keyValue);
    const id = recordId(selectedOwner, path, key);
    const previous = this.#records.get(id);
    if (previous === undefined || (token !== undefined && previous.token !== token)) return false;
    this.#records.delete(id);
    this.#bytes -= previous.bytes;
    this.#version += 1;
    this.#projections.delete(path);
    this.#forgetOwnerIfEmpty(selectedOwner);
    this.#resetOrdinalsIfEmpty();
    return true;
  }

  clear(): void {
    this.#records.clear();
    this.#ownerOrders.clear();
    this.#projections.clear();
    this.#bytes = 0;
    this.#nextOwnerOrder = 0;
    this.#nextRegistrationOrder = 0;
    this.#version += 1;
  }

  owns(owner: string, pathValue: ExtensionUISlotPath, keyValue: string, token: ExtensionUISlotToken): boolean {
    const selectedOwner = ownerKey(owner);
    const path = extensionUiSlotPath(pathValue);
    const key = extensionUiSlotKey(keyValue);
    return this.#records.get(recordId(selectedOwner, path, key))?.token === token;
  }

  project(pathValue: ExtensionUISlotPath): ExtensionUISlotProjection {
    const path = extensionUiSlotPath(pathValue);
    const cached = this.#projections.get(path);
    if (cached !== undefined) return cached;
    const records = [...this.#records.values()].filter((record) => record.path === path);
    const replacements = records.filter((record) => record.placement === "replace").sort(compare);
    const replacement = replacements.at(-1);
    if (replacement !== undefined) {
      const selected = Object.freeze({
        path,
        lines: replacement.lines,
        replacement: true,
      });
      this.#projections.set(path, selected);
      return selected;
    }
    const prepend = records.filter((record) => record.placement === "prepend").sort(compare);
    const append = records.filter((record) => record.placement === "append").sort(compare);
    const selected = Object.freeze({
      path,
      lines: Object.freeze([...prepend, ...append].flatMap((record) => record.lines)),
      replacement: false,
    });
    this.#projections.set(path, selected);
    return selected;
  }

  #forgetOwnerIfEmpty(owner: string): void {
    if (![...this.#records.values()].some((record) => record.ownerKey === owner)) {
      this.#ownerOrders.delete(owner);
    }
  }

  #resetOrdinalsIfEmpty(): void {
    if (this.#records.size !== 0) return;
    this.#nextOwnerOrder = 0;
    this.#nextRegistrationOrder = 0;
  }
}
