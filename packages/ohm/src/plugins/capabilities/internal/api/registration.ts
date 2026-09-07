import type { Provider } from "@ohm/models";
import type { TSchema } from "typebox";

import type {
  CommandOptions,
  FlagOptions,
  ShortcutOptions,
} from "../../commands.js";
import type { ProviderConfig } from "../../provider.js";
import type {
  EntryRenderer,
  MarkdownTransformer,
  MessageRenderer,
} from "../../rendering.js";
import type { ToolDefinition } from "../../tools.js";

/** One exact plugin registration. Calling either form removes it at most once. */
export interface PluginRegistrationHandle {
  (): void | Promise<void>;
  readonly disposed: boolean;
  dispose(): void | Promise<void>;
}

interface PluginToolRegistration {
  registerTool<TParameters extends TSchema, TDetails, TState>(
    tool: ToolDefinition<TParameters, TDetails, TState>,
  ): PluginRegistrationHandle;
}

interface PluginCommandRegistration {
  registerCommand(name: string, options: CommandOptions): PluginRegistrationHandle;
  registerFlag(name: string, options: FlagOptions): PluginRegistrationHandle;
  registerShortcut(shortcut: string, options: ShortcutOptions): PluginRegistrationHandle;
  getFlag(name: string): boolean | string | undefined;
}

interface PluginRendererRegistration {
  registerEntryRenderer<T = unknown>(customType: string, renderer: EntryRenderer<T>): PluginRegistrationHandle;
  registerMarkdownTransformer(transformer: MarkdownTransformer): PluginRegistrationHandle;
  registerMessageRenderer<T = unknown>(customType: string, renderer: MessageRenderer<T>): PluginRegistrationHandle;
}

interface PluginProviderRegistration {
  registerProvider(provider: Provider): PluginRegistrationHandle;
  registerProvider(id: string, config: ProviderConfig): PluginRegistrationHandle;
  unregisterProvider(id: string): void;
}

export interface PluginRegistrationCapabilities
  extends PluginCommandRegistration,
    PluginProviderRegistration,
    PluginRendererRegistration,
    PluginToolRegistration {}
