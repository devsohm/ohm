import { Type } from "typebox";
import {
  defineTool,
  PluginConfigConflictError,
  type InlinePlugin,
  type PluginAPI,
  type PluginCommandContext,
  type PluginContext,
  type PluginFactory,
  type PluginRunner,
} from "ohm/plugins";

const tool = defineTool({
  name: "plugin_probe",
  label: "Plugin probe",
  description: "A standalone plugin tool",
  parameters: Type.Object({}),
  async execute() { return { content: [{ type: "text", text: "ready" }], details: {} }; },
});

const factory: PluginFactory = (api: PluginAPI) => {
  api.registerTool(tool);
  api.registerCommand("plugin-probe", {
    description: "Inspect the active plugin session",
    async handler(_args: string, context: PluginCommandContext) {
      const base: PluginContext = context;
      base.ui.notify(base.cwd);
    },
  });
};
const noChildSessionCapability = true satisfies ("childSessions" extends keyof PluginAPI ? false : true);
declare const inline: InlinePlugin;
declare const runner: PluginRunner;
const pluginPaths: string[] = runner.getPluginPaths();
void [factory, inline, PluginConfigConflictError, noChildSessionCapability, pluginPaths];
