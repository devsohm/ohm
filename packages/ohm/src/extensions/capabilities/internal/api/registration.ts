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

/** One exact extension registration. Calling either form removes it at most once. */
export interface ExtensionRegistrationHandle {
  (): void | Promise<void>;
  readonly disposed: boolean;
  dispose(): void | Promise<void>;
}

interface ExtensionToolRegistration {
  registerTool<TParameters extends TSchema, TDetails, TState>(
    tool: ToolDefinition<TParameters, TDetails, TState>,
  ): ExtensionRegistrationHandle;
}

interface ExtensionCommandRegistration {
  registerCommand(name: string, options: CommandOptions): ExtensionRegistrationHandle;
  registerFlag(name: string, options: FlagOptions): ExtensionRegistrationHandle;
  registerShortcut(shortcut: string, options: ShortcutOptions): ExtensionRegistrationHandle;
  getFlag(name: string): boolean | string | undefined;
}

interface ExtensionRendererRegistration {
  registerEntryRenderer<T = unknown>(customType: string, renderer: EntryRenderer<T>): ExtensionRegistrationHandle;
  registerMarkdownTransformer(transformer: MarkdownTransformer): ExtensionRegistrationHandle;
  registerMessageRenderer<T = unknown>(customType: string, renderer: MessageRenderer<T>): ExtensionRegistrationHandle;
}

interface ExtensionProviderRegistration {
  registerProvider(provider: Provider): ExtensionRegistrationHandle;
  registerProvider(id: string, config: ProviderConfig): ExtensionRegistrationHandle;
  unregisterProvider(id: string): void;
}

export interface ExtensionRegistrationCapabilities
  extends ExtensionCommandRegistration,
    ExtensionProviderRegistration,
    ExtensionRendererRegistration,
    ExtensionToolRegistration {}
