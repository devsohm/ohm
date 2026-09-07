import type { CustomMessage, Usage } from "@ohm/kernel";
import type { Api, Model } from "@ohm/models";

import type { ThinkingLevel } from "../../core/settings-manager.js";
import type { ReadonlyPluginSessionManager } from "../session-contract.js";
import type { PluginModelRegistry } from "../model-boundary.js";
import type {
  RuntimeDirectAutocompleteProviderFactory,
  RuntimeDirectBackgroundFactory,
  RuntimeDirectEditorFactory,
  RuntimeDirectFooterFactory,
  RuntimeDirectTerminalInputHandler,
  RuntimeDirectUiContext,
  RuntimeDirectWidgetOptions,
  RuntimeDirectWorkingIndicatorOptions,
  RuntimeDiscoveryView,
} from "../runtime.js";

export type { PluginUICapabilities } from "../runtime.js";

export type PluginMode = "tui" | "rpc" | "json" | "print" | "serve" | "sdk";
export type InputSource = "interactive" | "rpc" | "serve" | "extension";
export type ModelSelectSource = "set" | "cycle" | "restore" | "run";

export type PluginUIContext = RuntimeDirectUiContext;
export type PluginUIDialogOptions = Parameters<PluginUIContext["select"]>[2];
export type WorkingIndicatorOptions = RuntimeDirectWorkingIndicatorOptions;
export type WidgetPlacement = NonNullable<RuntimeDirectWidgetOptions["placement"]>;
export type PluginWidgetOptions = RuntimeDirectWidgetOptions;
export type TerminalInputHandler = RuntimeDirectTerminalInputHandler;
export type AutocompleteProviderFactory = RuntimeDirectAutocompleteProviderFactory;
export type EditorFactory = RuntimeDirectEditorFactory;
export type BackgroundFactory = RuntimeDirectBackgroundFactory;
export type FooterFactory = RuntimeDirectFooterFactory;
export type DiscoveryView = RuntimeDiscoveryView;
export type DiscoverableResource = RuntimeDiscoveryView["resources"][number];

export interface ContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export interface CompactionResult {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  estimatedTokensAfter: number;
  details?: unknown;
  usage?: Usage;
}

export interface CompactOptions {
  customInstructions?: string;
  onComplete?(result: CompactionResult): void;
  onError?(error: Error): void;
}

export interface PluginDataPaths {
  readonly userData: string;
  readonly workspaceData: string;
}

interface PluginContextOperations {
  abort(): void;
  compact(options?: CompactOptions): void;
  getContextUsage(): ContextUsage | undefined;
  getSystemPrompt(): string;
  hasPendingMessages(): boolean;
  isIdle(): boolean;
  isProjectTrusted(): boolean;
  shutdown(): void;
}

/** Services that are valid for every direct extension callback. */
export interface PluginContext extends PluginContextOperations {
  readonly ui: PluginUIContext;
  readonly mode: PluginMode;
  readonly hasUI: boolean;
  readonly cwd: string;
  readonly paths: PluginDataPaths;
  readonly signal: AbortSignal | undefined;
  readonly sessionManager: ReadonlyPluginSessionManager;
  /** Promise-returning delivery bound to this callback's exact live session. */
  readonly sessionDelivery: PluginSessionDelivery;
  readonly modelRegistry: PluginModelRegistry;
  readonly model: Model<Api> | undefined;
  /** Models currently available inside the session's exact provider/model scope. */
  readonly scopedModels: readonly {
    readonly model: Model<Api>;
    readonly thinkingLevel?: ThinkingLevel;
  }[];
  readonly thinkingLevel: ThinkingLevel;
}

export interface ExecOptions {
  cwd?: string;
  signal?: AbortSignal;
  timeout?: number;
}

export interface ExecResult {
  code: number;
  killed: boolean;
  stderr: string;
  stdout: string;
}

export interface CustomMessageDeliveryOptions {
  triggerTurn?: boolean;
  deliverAs?: "steer" | "followUp" | "nextTurn";
}

export interface UserMessageDeliveryOptions {
  deliverAs?: "steer" | "followUp";
  expandPromptTemplates?: boolean;
}

/**
 * Acknowledged message delivery captured from one live session binding.
 *
 * The handle remains tied to `sessionId`; it never follows a later host binding.
 * Calls reject after that session or extension generation becomes stale.
 */
export interface PluginSessionDelivery {
  readonly sessionId: string;
  sendMessage<T = unknown>(
    message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
    options?: CustomMessageDeliveryOptions,
  ): Promise<void>;
  sendUserMessage(
    content: CustomMessage["content"],
    options?: UserMessageDeliveryOptions,
  ): Promise<void>;
}

export type PluginMessage = Pick<CustomMessage, "customType" | "content" | "display" | "details">;

export type {
  AppKeybinding,
} from "../../tui/public-components.js";
export type { AppKeybindings, KeybindingsManager } from "../../tui/keybindings.js";
export type {
  PluginConfigDataRoots,
  PluginConfigReadOptions,
  PluginConfigScope,
  PluginConfigSnapshot,
  PluginConfigStore,
  PluginConfigStoreOptions,
  PluginConfigWriteOptions,
} from "../config-store.js";
export type {
  PluginProcessId,
  PluginProcessOutputMode,
  PluginProcessReadResult,
  PluginProcessResult,
  PluginProcessService,
  PluginProcessSpec,
  PluginProcessState,
  PluginProcessStatus,
  PluginProcessWaitOptions,
} from "../../process/managed-process.js";
