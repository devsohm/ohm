import type { Api, Model } from "@ohm/models";

import type { SlashCommandInfo } from "../../../../core/slash-commands.js";
import type { ThinkingLevel } from "../../../../core/settings-manager.js";
import type { DiscoveryView } from "../../host.js";
import type { ToolInfo } from "../../tools.js";

interface PluginToolCatalogActions {
  getActiveTools(): string[];
  getAllTools(): ToolInfo[];
  getCommands(): SlashCommandInfo[];
  setActiveTools(toolNames: string[]): void;
}

interface PluginModelSelectionActions {
  getThinkingLevel(): ThinkingLevel;
  setModel(model: Model<Api>): Promise<boolean>;
  setThinkingLevel(level: ThinkingLevel): void;
}

export interface PluginCatalogActions extends PluginModelSelectionActions, PluginToolCatalogActions {}

export interface PluginCatalogCapabilities extends PluginCatalogActions {
  getDiscoveryView(signal?: AbortSignal): Promise<DiscoveryView>;
}
