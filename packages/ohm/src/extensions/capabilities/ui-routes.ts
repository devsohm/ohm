import type { JsonValue } from "../../core/json.js";
import type {
  RuntimeUiComponent,
  RuntimeUiComponentHandle,
  RuntimeUiComponentHost,
} from "../../tui/components.js";

/** Route-aware component host supplied whenever an extension route is mounted. */
export interface ExtensionUIRouteHost extends RuntimeUiComponentHost<void> {
  readonly name: string;
  /** Detached, deeply frozen data supplied by the caller opening this route. */
  readonly data?: JsonValue;
}

/** One named rich-TUI route owned by an extension generation. */
export interface ExtensionUIRouteDefinition {
  /** Plain terminal-safe title rendered by the host. */
  readonly title: string;
  render(host: ExtensionUIRouteHost): RuntimeUiComponent | Promise<RuntimeUiComponent>;
}

export interface ExtensionUIRouteOpenOptions {
  /** Detached and deeply frozen before extension or host code can observe it. */
  readonly data?: JsonValue;
}

/** Detached route metadata. Only `current()` includes open-time data. */
export interface ExtensionUIRouteSnapshot {
  readonly name: string;
  readonly title: string;
  readonly data?: JsonValue;
}

export interface ExtensionUIRouteRegistration {
  readonly disposed: boolean;
  readonly name: string;
  readonly title: string;
  /** Open this exact registration. Superseded registrations fail closed. */
  open(options?: ExtensionUIRouteOpenOptions): RuntimeUiComponentHandle;
  /** Remove this exact registration. Superseded handles are harmless. */
  dispose(): void;
}

export interface ExtensionUIRouteService {
  /** Register or atomically replace one generation-owned route name. */
  register(name: string, definition: ExtensionUIRouteDefinition): ExtensionUIRouteRegistration;
  open(name: string, options?: ExtensionUIRouteOpenOptions): RuntimeUiComponentHandle;
  /** List detached metadata in deterministic registration order. */
  list(): readonly ExtensionUIRouteSnapshot[];
  /** Return the currently mounted route snapshot, if any. */
  current(): ExtensionUIRouteSnapshot | undefined;
  close(): void;
}
