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
import type { PluginAPI } from "./capabilities/api.js";
import type { PluginContext, PluginMode } from "./capabilities/host.js";
import type { PluginWireServiceProvider } from "./wire-services.js";

export const PLUGIN_FACET_API_VERSION = 1 as const;
export const MAX_PLUGIN_FACETS = 64;
export const MAX_PLUGIN_FACET_STATES = 32;

/** Stable names for present and planned Ohm host facets. */
export const PLUGIN_FACET_KINDS = [
  "worker",
  "session",
  "rich-tui",
  "presentation",
  "web",
  "desktop",
] as const;

export type PluginFacetKind = (typeof PLUGIN_FACET_KINDS)[number];

export interface PluginPortablePresentationRegistration {
  readonly disposed: boolean;
  readonly document: PortablePresentationDocument;
  update(definition: PortablePresentationDefinition): void;
  invoke(
    request: PortablePresentationActionRequest,
    signal?: AbortSignal,
  ): Promise<PortablePresentationActionResult>;
  dispose(): void;
}

export interface PluginFacetPresentationHost {
  show(definition: PortablePresentationDefinition): PluginPortablePresentationRegistration;
  remove(id: string): void;
}

/** A shared channel view; only the host may close the generation-owned state. */
export type PluginFacetSharedState<T extends JsonValue = JsonValue> = Omit<
  ReplicatedJsonState<T>,
  "close"
>;

export interface PluginFacetStateHost {
  /** Open a generation-owned named channel. The first opener selects its initial value and limits. */
  open<T extends JsonValue>(
    name: string,
    initial: T,
    options?: Omit<ReplicatedJsonStateOptions, "signal">,
  ): PluginFacetSharedState<T>;
  get<T extends JsonValue = JsonValue>(name: string): PluginFacetSharedState<T> | undefined;
}

export interface PluginFacetContext {
  readonly apiVersion: typeof PLUGIN_FACET_API_VERSION;
  readonly kind: PluginFacetKind;
  readonly name: string;
  readonly mode: PluginMode | "worker" | "web" | "desktop";
  readonly signal: AbortSignal;
  readonly extension: PluginAPI;
  readonly session?: PluginContext;
  readonly services: PluginWireServiceProvider;
  readonly presentation: PluginFacetPresentationHost;
  readonly states: PluginFacetStateHost;
  /** Create activation-local state. Use states.open() to share a named channel across facets. */
  createState<T extends JsonValue>(initial: T, options?: ReplicatedJsonStateOptions): ReplicatedJsonState<T>;
}

export interface PluginFacetDefinition {
  readonly apiVersion: typeof PLUGIN_FACET_API_VERSION;
  readonly kind: PluginFacetKind;
  readonly name: string;
  setup(context: PluginFacetContext): void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;
}

export interface PluginFacetRegistration {
  readonly disposed: boolean;
  readonly kind: PluginFacetKind;
  readonly name: string;
  dispose(): Promise<void>;
}

export interface PluginFacetService {
  register(definition: PluginFacetDefinition): Promise<PluginFacetRegistration>;
}

const FACET_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u;
const FACET_STATE_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,47}$/u;

export function pluginFacetStateServiceName(owner: string, stateName: string): string {
  if (
    !Value.Check(STRING_VALUE, owner)
    || owner.length === 0
    || owner.includes("\0")
    || Buffer.byteLength(owner, "utf8") > 512
  ) throw new TypeError("Plugin facet state owner is invalid");
  if (!FACET_STATE_NAME.test(stateName)) throw new TypeError("Plugin facet state name is invalid");
  const ownerKey = createHash("sha256").update(owner).digest("hex").slice(0, 16);
  return `ohm.state.${ownerKey}.${stateName}`;
}

export function validatePluginFacetDefinition(
  value: PluginFacetDefinition,
): PluginFacetDefinition {
  if (!isObjectValue(value) || Array.isArray(value)) {
    throw new TypeError("Plugin facet definition must be an object");
  }
  const unexpected = Object.keys(value).find((key) =>
    !["apiVersion", "kind", "name", "setup"].includes(key));
  if (unexpected !== undefined) throw new TypeError(`Plugin facet definition.${unexpected} is not allowed`);
  if (value.apiVersion !== PLUGIN_FACET_API_VERSION) {
    throw new TypeError("Plugin facet API version is unsupported");
  }
  if (!PLUGIN_FACET_KINDS.includes(value.kind)) throw new TypeError("Plugin facet kind is invalid");
  if (!FACET_NAME.test(value.name)) throw new TypeError("Plugin facet name is invalid");
  if (!Value.Check(FUNCTION_VALUE, value.setup)) throw new TypeError("Plugin facet setup must be a function");
  return Object.freeze({ ...value });
}

export function pluginFacetApplies(
  kind: PluginFacetKind,
  mode: PluginMode,
  capabilities: Readonly<{ components: boolean }>,
): boolean {
  if (kind === "worker") return false;
  if (kind === "session" || kind === "presentation") return true;
  if (kind === "rich-tui") return mode === "tui" && capabilities.components;
  return false;
}
