import type { Api, Model, Provider } from "@ohm/models";

import type { BuildSystemPromptOptions } from "../../core/system-prompt.js";
import type { PluginModelCompletion } from "../model-boundary.js";
import type { CompactOptions, ContextUsage, PluginSessionDelivery } from "./host.js";
import type { ProviderConfig } from "./provider.js";
import type {
  PluginCatalogActions,
  PluginCatalogCapabilities,
} from "./internal/api/catalog.js";
import type { PluginLifecycleCapabilities } from "./internal/api/lifecycle.js";
import type { PluginRegistrationCapabilities } from "./internal/api/registration.js";
import type {
  PluginSessionActions,
  PluginSessionCapabilities,
} from "./internal/api/session.js";
import type {
  Plugin,
  PendingNativeProviderRegistration,
  PendingProviderRegistration,
} from "./internal/api/state.js";

/** Registration and live-session capabilities exposed to one direct plugin. */
export interface PluginAPI extends
  PluginLifecycleCapabilities,
  PluginRegistrationCapabilities,
  PluginSessionCapabilities,
  PluginCatalogCapabilities {}

export type PluginFactory = (ohm: PluginAPI) => void | Promise<void>;
export type InlinePlugin = PluginFactory | { name: string; factory: PluginFactory; hidden?: boolean };

export type { Plugin, PluginError } from "./internal/api/state.js";
export type {
  PluginRegistrationHandle,
} from "./internal/api/registration.js";

/** Host callbacks consumed by the compatibility facade. */
export interface PluginActions extends PluginSessionActions, PluginCatalogActions {
  refreshTools(): void;
}

interface PluginContextStateActions {
  completeModel?: PluginModelCompletion;
  getModel(): Model<Api> | undefined;
  getScopedModels?(): readonly { readonly model: Model<Api>; readonly thinkingLevel?: import("../../core/settings-manager.js").ThinkingLevel }[];
  getSignal(): AbortSignal | undefined;
  getContextUsage(): ContextUsage | undefined;
  getSystemPrompt(): string;
  getSystemPromptOptions?(): BuildSystemPromptOptions;
  getSessionDelivery?(): PluginSessionDelivery;
}

interface PluginContextControlActions {
  abort(): void;
  compact(options?: CompactOptions): void;
  hasPendingMessages(): boolean;
  isIdle(): boolean;
  isProjectTrusted(): boolean;
  shutdown(): void;
}

export interface PluginContextActions extends PluginContextControlActions, PluginContextStateActions {}

export interface PluginRuntime extends PluginActions {
  flagValues: Map<string, boolean | string>;
  pendingProviderRegistrations: PendingProviderRegistration[];
  pendingNativeProviderRegistrations: PendingNativeProviderRegistration[];
  assertActive(): void;
  invalidate(message?: string): void;
  registerProvider(name: string, config: ProviderConfig, extensionPath?: string): void;
  registerNativeProvider(provider: Provider, extensionPath?: string): void;
  unregisterProvider(name: string): void;
}

export interface LoadPluginsResult {
  plugins: Plugin[];
  errors: Array<{ path: string; error: string }>;
  runtime: PluginRuntime;
}

export type { PluginCommandContextActions } from "./session.js";
