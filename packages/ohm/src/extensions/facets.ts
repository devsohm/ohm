import { createHash } from "node:crypto";
import { Value } from "typebox/value";

import type { JsonValue } from "../core/json.js";
import { FUNCTION_VALUE, STRING_VALUE, isObjectValue } from "../core/value-schemas.js";
import type {
  PortablePresentationActionRequest,
  PortablePresentationActionResult,
  PortablePresentationDefinition,
  PortablePresentationDocument,
} from "../interfaces/portable-presentation.js";
import type {
  ReplicatedJsonState,
  ReplicatedJsonStateOptions,
} from "./replicated-state.js";
import type { ExtensionAPI } from "./capabilities/api.js";
import type { ExtensionContext, ExtensionMode } from "./capabilities/host.js";
import type { ExtensionWireServiceProvider } from "./wire-services.js";

export const EXTENSION_FACET_API_VERSION = 1 as const;
export const MAX_EXTENSION_FACETS = 64;
export const MAX_EXTENSION_FACET_STATES = 32;

/** Stable names for present and planned Ohm host facets. */
export const EXTENSION_FACET_KINDS = [
  "worker",
  "session",
  "rich-tui",
  "presentation",
  "web",
  "desktop",
] as const;

export type ExtensionFacetKind = (typeof EXTENSION_FACET_KINDS)[number];

export interface ExtensionPortablePresentationRegistration {
  readonly disposed: boolean;
  readonly document: PortablePresentationDocument;
  update(definition: PortablePresentationDefinition): void;
  invoke(
    request: PortablePresentationActionRequest,
    signal?: AbortSignal,
  ): Promise<PortablePresentationActionResult>;
  dispose(): void;
}

export interface ExtensionFacetPresentationHost {
  show(definition: PortablePresentationDefinition): ExtensionPortablePresentationRegistration;
  remove(id: string): void;
}

/** A shared channel view; only the host may close the generation-owned state. */
export type ExtensionFacetSharedState<T extends JsonValue = JsonValue> = Omit<
  ReplicatedJsonState<T>,
  "close"
>;

export interface ExtensionFacetStateHost {
  /** Open a generation-owned named channel. The first opener selects its initial value and limits. */
  open<T extends JsonValue>(
    name: string,
    initial: T,
    options?: Omit<ReplicatedJsonStateOptions, "signal">,
  ): ExtensionFacetSharedState<T>;
  get<T extends JsonValue = JsonValue>(name: string): ExtensionFacetSharedState<T> | undefined;
}

export interface ExtensionFacetContext {
  readonly apiVersion: typeof EXTENSION_FACET_API_VERSION;
  readonly kind: ExtensionFacetKind;
  readonly name: string;
  readonly mode: ExtensionMode | "worker" | "web" | "desktop";
  readonly signal: AbortSignal;
  readonly extension: ExtensionAPI;
  readonly session?: ExtensionContext;
  readonly services: ExtensionWireServiceProvider;
  readonly presentation: ExtensionFacetPresentationHost;
  readonly states: ExtensionFacetStateHost;
  /** Create activation-local state. Use states.open() to share a named channel across facets. */
  createState<T extends JsonValue>(initial: T, options?: ReplicatedJsonStateOptions): ReplicatedJsonState<T>;
}

export interface ExtensionFacetDefinition {
  readonly apiVersion: typeof EXTENSION_FACET_API_VERSION;
  readonly kind: ExtensionFacetKind;
  readonly name: string;
  setup(context: ExtensionFacetContext): void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;
}

export interface ExtensionFacetRegistration {
  readonly disposed: boolean;
  readonly kind: ExtensionFacetKind;
  readonly name: string;
  dispose(): Promise<void>;
}

export interface ExtensionFacetService {
  register(definition: ExtensionFacetDefinition): Promise<ExtensionFacetRegistration>;
}

const FACET_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u;
const FACET_STATE_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,47}$/u;

export function extensionFacetStateServiceName(owner: string, stateName: string): string {
  if (
    !Value.Check(STRING_VALUE, owner)
    || owner.length === 0
    || owner.includes("\0")
    || Buffer.byteLength(owner, "utf8") > 512
  ) throw new TypeError("Extension facet state owner is invalid");
  if (!FACET_STATE_NAME.test(stateName)) throw new TypeError("Extension facet state name is invalid");
  const ownerKey = createHash("sha256").update(owner).digest("hex").slice(0, 16);
  return `ohm.state.${ownerKey}.${stateName}`;
}

export function validateExtensionFacetDefinition(
  value: ExtensionFacetDefinition,
): ExtensionFacetDefinition {
  if (!isObjectValue(value) || Array.isArray(value)) {
    throw new TypeError("Extension facet definition must be an object");
  }
  const unexpected = Object.keys(value).find((key) =>
    !["apiVersion", "kind", "name", "setup"].includes(key));
  if (unexpected !== undefined) throw new TypeError(`Extension facet definition.${unexpected} is not allowed`);
  if (value.apiVersion !== EXTENSION_FACET_API_VERSION) {
    throw new TypeError("Extension facet API version is unsupported");
  }
  if (!EXTENSION_FACET_KINDS.includes(value.kind)) throw new TypeError("Extension facet kind is invalid");
  if (!FACET_NAME.test(value.name)) throw new TypeError("Extension facet name is invalid");
  if (!Value.Check(FUNCTION_VALUE, value.setup)) throw new TypeError("Extension facet setup must be a function");
  return Object.freeze({ ...value });
}

export function extensionFacetApplies(
  kind: ExtensionFacetKind,
  mode: ExtensionMode,
  capabilities: Readonly<{ components: boolean }>,
): boolean {
  if (kind === "worker") return false;
  if (kind === "session" || kind === "presentation") return true;
  if (kind === "rich-tui") return mode === "tui" && capabilities.components;
  return false;
}
