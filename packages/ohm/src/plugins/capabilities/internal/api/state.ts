import type { Provider } from "@ohm/models";

import type { SourceInfo } from "../../../../core/source-info.js";
import type {
  PluginFlag,
  PluginShortcut,
  RegisteredCommand,
} from "../../commands.js";
import type { PluginHandler } from "../../events.js";
import type { ProviderConfig } from "../../provider.js";
import type {
  EntryRenderer,
  MarkdownTransformer,
  MessageRenderer,
} from "../../rendering.js";
import type { RegisteredTool } from "../../tools.js";

interface PluginIdentity {
  path: string;
  resolvedPath: string;
  sourceInfo: SourceInfo;
  hidden?: boolean;
}

interface PluginLifecycleState {
  handlers: Map<string, PluginHandler[]>;
  markdownTransformer?: MarkdownTransformer;
}

interface PluginRegistrations {
  tools: Map<string, RegisteredTool>;
  messageRenderers: Map<string, MessageRenderer>;
  entryRenderers?: Map<string, EntryRenderer>;
  commands: Map<string, RegisteredCommand>;
  flags: Map<string, PluginFlag>;
  shortcuts: Map<string, PluginShortcut>;
}

export interface Plugin extends PluginIdentity, PluginLifecycleState, PluginRegistrations {}

interface PluginErrorContext {
  extensionId?: string;
  extensionPath: string;
  event: string;
}

export interface PluginError extends PluginErrorContext {
  error: string;
  stack?: string;
}

export interface PendingProviderRegistration {
  name: string;
  config: ProviderConfig;
  extensionPath: string;
}

export interface PendingNativeProviderRegistration {
  provider: Provider;
  extensionPath: string;
}
