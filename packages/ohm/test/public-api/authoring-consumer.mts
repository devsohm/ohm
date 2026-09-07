import {
  defineTool,
  type AppKeybinding,
  type BuildSystemPromptOptions,
  type CommandCompletion,
  type CommandOptions,
  type CustomMessageDeliveryOptions,
  type PluginAPI,
  type PluginEventMap,
  type PluginEventResultMap,
  type PluginFactory,
  type PluginMessage,
  type PluginModelRegistry,
  type PluginOAuthConfig,
  type PluginProviderConfig,
  type PluginProviderModelConfig,
  type PluginRegistrationHandle,
  type PluginSessionProvenance,
  type PluginThinkingLevel,
  type PluginUICapabilities,
  type FlagOptions,
  type FooterFactory,
  type ForkOptions,
  type KeybindingsManager,
  type NavigateTreeOptions,
  type ReplacementOptions,
  type ResourceClaim,
  type SessionBeforeForkResult,
  type SessionBeforeSwitchResult,
  type ShortcutOptions,
  type SlashCommandInfo,
  type SlashCommandSource,
  type SourceInfo,
  type SwitchSessionOptions,
  type ToolContext,
  type ToolRecoveryContract,
  type UserMessageDeliveryOptions,
  type WidgetPlacement,
} from "ohm/plugins";
import { Type } from "typebox";
import {
  defineProviderAdapter,
  type ProviderAdapterDefinition,
} from "ohm/providers";

export const extension: PluginFactory = (ohm: PluginAPI) => {
  const switchGuard = { cancel: true, reason: "consumer switch policy" } satisfies SessionBeforeSwitchResult;
  const forkGuard = { cancel: true, reason: "consumer fork policy" } satisfies SessionBeforeForkResult;
  ohm.on("session_before_switch", () => switchGuard);
  ohm.on("session_before_fork", () => forkGuard);
  ohm.on("tool_call", () => ({ block: false, terminate: true }));
  // @ts-expect-error Tool authorization is host-owned; extension reducers can only block or transform.
  ohm.on("tool_call", () => ({ decision: "allow_once" }));
  ohm.on("tool_execution_update", (event) => {
    const type: "tool_execution_update" = event.type;
    void [type, event.partialResult];
  });
  ohm.on("tool_execution_end", (event) => {
    const type: "tool_execution_end" = event.type;
    void [type, event.result, event.isError];
  });
  ohm.registerCommand("consumer", {
    description: "Consumer command",
    async handler(_args, context) {
      context.ui.notify("ready");
      await context.ui.custom<void>((_tui, _theme, keybindings, done) => {
        keybindings.getKeys("app.model.select");
        keybindings.getKeys("tui.editor.cursorWordLeft");
        done();
        return { render: () => [], invalidate() {} };
      });
    },
  });
  ohm.registerTool(defineTool({
    name: "consumer_typed_tool",
    label: "Consumer typed tool",
    description: "Public typed tool helper",
    parameters: Type.Object({ text: Type.String() }, { additionalProperties: false }),
    recovery: { mode: "repeatable" },
    resources(input, context): ResourceClaim[] {
      return [{
        kind: "workspace",
        key: `${context.workspace.root}:${input.text}`,
        mode: "read",
      }];
    },
    async execute(_toolCallId, input, signal) {
      signal?.throwIfAborted();
      return { content: [{ type: "text", text: input.text }], details: {} };
    },
  }));
};

const definition = {
  id: "consumer-provider",
  models: [{ id: "consumer-model", capabilities: { tools: true } }],
  async *stream(request, signal) {
    signal.throwIfAborted();
    yield { type: "response_start" as const, model: request.model };
  },
} satisfies ProviderAdapterDefinition;
export const provider = defineProviderAdapter(definition);

export interface ExtensionAuthoringConvenienceTypes {
  appKeybinding: AppKeybinding;
  commandCompletion: CommandCompletion;
  commandOptions: CommandOptions;
  customMessageDelivery: CustomMessageDeliveryOptions;
  event: PluginEventMap[keyof PluginEventMap];
  eventResult: PluginEventResultMap[keyof PluginEventResultMap];
  extensionMessage: PluginMessage;
  uiCapabilities: PluginUICapabilities;
  flagOptions: FlagOptions;
  footerFactory: FooterFactory;
  forkOptions: ForkOptions;
  keybindingsManager: KeybindingsManager;
  modelRegistry: PluginModelRegistry;
  navigateTreeOptions: NavigateTreeOptions;
  oauth: PluginOAuthConfig;
  provider: PluginProviderConfig;
  providerModel: PluginProviderModelConfig;
  registration: PluginRegistrationHandle;
  sessionProvenance: PluginSessionProvenance;
  replacementOptions: ReplacementOptions;
  shortcutOptions: ShortcutOptions;
  slashCommand: SlashCommandInfo;
  slashCommandSource: SlashCommandSource;
  sourceInfo: SourceInfo;
  switchSessionOptions: SwitchSessionOptions;
  systemPromptOptions: BuildSystemPromptOptions;
  thinkingLevel: PluginThinkingLevel;
  toolContext: ToolContext;
  recovery: ToolRecoveryContract;
  userMessageDelivery: UserMessageDeliveryOptions;
  widgetPlacement: WidgetPlacement;
}
