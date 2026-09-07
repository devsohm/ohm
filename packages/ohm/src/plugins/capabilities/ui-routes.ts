import type { JsonValue } from "../../core/json.js";
import type {
  RuntimeUiComponent,
  RuntimeUiComponentHandle,
  RuntimeUiComponentHost,
} from "../../tui/components.js";

/** Route-aware component host supplied whenever an extension route is mounted. */
export interface PluginUIRouteHost extends RuntimeUiComponentHost<void> {
  readonly name: string;
  /** Detached, deeply frozen data supplied by the caller opening this route. */
  readonly data?: JsonValue;
}

/** One named rich-TUI route owned by an extension generation. */
export interface PluginUIRouteDefinition {
  /** Plain terminal-safe title rendered by the host. */
  readonly title: string;
  render(host: PluginUIRouteHost): RuntimeUiComponent | Promise<RuntimeUiComponent>;
}

export interface PluginUIRouteOpenOptions {
  /** Detached and deeply frozen before extension or host code can observe it. */
  readonly data?: JsonValue;
}

/** Detached route metadata. Only `current()` includes open-time data. */
export interface PluginUIRouteSnapshot {
  readonly name: string;
  readonly title: string;
  readonly data?: JsonValue;
}

export interface PluginUIRouteRegistration {
  readonly disposed: boolean;
  readonly name: string;
  readonly title: string;
  /** Open this exact registration. Superseded registrations fail closed. */
  open(options?: PluginUIRouteOpenOptions): RuntimeUiComponentHandle;
  /** Remove this exact registration. Superseded handles are harmless. */
  dispose(): void;
}

export interface PluginUIRouteService {
  /** Register or atomically replace one generation-owned route name. */
  register(name: string, definition: PluginUIRouteDefinition): PluginUIRouteRegistration;
  open(name: string, options?: PluginUIRouteOpenOptions): RuntimeUiComponentHandle;
  /** List detached metadata in deterministic registration order. */
  list(): readonly PluginUIRouteSnapshot[];
  /** Return the currently mounted route snapshot, if any. */
  current(): PluginUIRouteSnapshot | undefined;
  close(): void;
}
