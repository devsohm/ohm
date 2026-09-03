import type * as Root from "ohm";
import type * as Auth from "ohm/auth";
import type * as Config from "ohm/config";
import type * as Context from "ohm/context";
import type * as Core from "ohm/core";
import type * as Extensions from "ohm/extensions";
import type * as Images from "ohm/images";
import type * as Interfaces from "ohm/interfaces";
import type * as Modes from "ohm/modes";
import type * as Process from "ohm/process";
import type * as Providers from "ohm/providers";
import type * as Service from "ohm/service";
import type * as Tools from "ohm/tools";
import type * as Tui from "ohm/tui";
import {
  KeybindingsManager as SharedKeybindingsManager,
  TUI_KEYBINDINGS,
  type KeybindingsConfig,
} from "@ohm/terminal";

declare const sharedKeybindings: SharedKeybindingsManager;
sharedKeybindings.matches("", "app.clear");
sharedKeybindings.matches("", "tui.editor.redo");
const rawTerminalKeybindings = new SharedKeybindingsManager(TUI_KEYBINDINGS);
declare const applicationKeybindingsConstructor: typeof Root.KeybindingsManager;
const applicationKeybindings = new applicationKeybindingsConstructor();
const effectiveApplicationBindings: KeybindingsConfig = applicationKeybindings.getEffectiveConfig();
const compatibleApplicationKeybindings = new applicationKeybindingsConstructor(TUI_KEYBINDINGS);
compatibleApplicationKeybindings.matches("", "tui.input.submit");

type GenericName =
  | "AgentSessionConfig" | "AgentSessionRuntime" | "AgentSessionRuntimeDiagnostic" | "AgentSessionServices"
  | "AppKeybinding" | "Args" | "AssistantMessageComponent" | "BashExecutionComponent" | "BorderedLoader"
  | "BranchPreparation" | "BranchSummaryMessageComponent" | "BranchSummaryResult" | "CollectEntriesResult"
  | "CompactionSummaryMessageComponent" | "CreateAgentSessionFromServicesOptions" | "CreateAgentSessionRuntimeFactory"
  | "CreateAgentSessionRuntimeResult" | "CreateAgentSessionServicesOptions" | "CreateModelRuntimeOptions"
  | "CustomEditor" | "CustomMessageComponent" | "CutPointResult" | "DEFAULT_COMPACTION_SETTINGS"
  | "DEFAULT_MAX_BYTES" | "DEFAULT_MAX_LINES" | "DynamicBorder" | "EditDiffResult" | "ExtensionEditorComponent"
  | "ExtensionInputComponent" | "ExtensionRunner" | "ExtensionSelectorComponent" | "FileOperations" | "FooterComponent"
  | "GenerateBranchSummaryOptions" | "InteractiveMode" | "InteractiveModeOptions" | "LoginDialogComponent"
  | "MainOptions" | "ModelInfo" | "ModelRuntime" | "ModelRuntimeAuthOverrides"
  | "ModelSelectorComponent" | "OAuthSelectorComponent" | "ParsedSkillBlock" | "ProjectTrustDecision"
  | "ProjectTrustStore" | "ProjectTrustStoreEntry" | "ProjectTrustUpdate" | "PromptOptions" | "RenderDiffOptions"
  | "ResizedImage" | "ResolveCliModelResult" | "RpcExtensionUIRequest"
  | "RpcExtensionUIResponse" | "SessionSelectorComponent" | "SessionStats" | "SettingsCallbacks"
  | "SettingsConfig" | "SettingsSelectorComponent" | "ShowImagesSelectorComponent" | "SkillInvocationMessageComponent"
  | "ThemeColor" | "ThemeSelectorComponent" | "ThinkingSelectorComponent" | "ToolExecutionComponent"
  | "ToolAuthorizationContext" | "ToolAuthorizationDecision" | "ToolAuthorizationHandler"
  | "ToolAuthorizationOwner" | "ToolAuthorizationRequest" | "ToolExecutionOptions" | "TreeSelectorComponent"
  | "TruncationOptions" | "TruncationResult"
  | "UserMessageComponent" | "UserMessageSelectorComponent" | "VERSION" | "VisualTruncateResult"
  | "calculateContextTokens" | "collectEntriesForBranchSummary" | "compact" | "convertToLlm" | "convertToPng"
  | "copyToClipboard" | "createAgentSessionFromServices" | "createAgentSessionRuntime" | "createAgentSessionServices"
  | "createExtensionRuntime" | "discoverAndLoadExtensions" | "estimateTokens" | "findCutPoint" | "findTurnStartIndex"
  | "formatDimensionNote" | "formatSize" | "generateBranchSummary" | "generateSummary" | "generateSummaryWithUsage"
  | "getDocsPath" | "getExamplesPath" | "getLanguageFromPath" | "getLastAssistantUsage" | "getMarkdownTheme"
  | "getPackageDir" | "getReadmePath" | "getSelectListTheme" | "getSettingsListTheme" | "getShellConfig"
  | "hasTrustRequiringProjectResources" | "highlightCode" | "initTheme" | "keyHint" | "keyText" | "main"
  | "parseArgs" | "parseFrontmatter" | "parseSkillBlock" | "prepareBranchEntries" | "rawKeyHint"
  | "readStoredCredential" | "readStoredCredentialAsync" | "renderDiff" | "resizeImage" | "resolveCliModel"
  | "runRpcMode" | "serializeConversation" | "shouldCompact" | "stripFrontmatter" | "truncateHead"
  | "truncateLine" | "truncateTail" | "truncateToVisualLines" | "withFileMutationQueue"
  | "wrapRegisteredTool" | "wrapRegisteredTools";

type RootNames = keyof typeof Root;
type ReferenceRootValueName =
  | "CONFIG_DIR_NAME" | "CURRENT_SESSION_VERSION" | "DefaultPackageManager" | "DefaultResourceLoader"
  | "KeybindingsManager" | "ModelRegistry" | "RpcClient" | "SettingsManager" | "buildContextEntries"
  | "buildSessionContext" | "createAgentSession" | "createBashTool" | "createBashToolDefinition"
  | "createCodingTools" | "createEditTool" | "createEditToolDefinition" | "createEventBus" | "createFindTool"
  | "createFindToolDefinition" | "createGrepTool" | "createGrepToolDefinition" | "createLocalBashOperations"
  | "createLsTool" | "createLsToolDefinition" | "createReadOnlyTools" | "createReadTool"
  | "createReadToolDefinition" | "createSyntheticSourceInfo" | "createWriteTool" | "createWriteToolDefinition"
  | "formatSkillsForPrompt" | "generateDiffString" | "generateUnifiedPatch" | "getAgentDir"
  | "getLatestCompactionEntry" | "loadProjectContextFiles" | "loadSkills" | "loadSkillsFromDir"
  | "sessionEntryToContextMessages";
const referenceRootValuesAreComplete = true satisfies ReferenceRootValueName extends RootNames ? true : false;
const rpcModelInfo = {
  provider: "fixture",
  id: "fixture-model",
  contextWindow: 128_000,
  reasoning: true,
} satisfies Root.ModelInfo;
declare const catalogModelInfo: Core.ModelInfo;
const catalogModelCapabilities: {
  tools: Core.ModelCapability;
  reasoning: Core.ModelCapability;
  images: Core.ModelCapability;
} = catalogModelInfo.capabilities;
const projectTrustReadsAsynchronously = true satisfies (
  ReturnType<InstanceType<typeof Root.ProjectTrustStore>["get"]> extends Promise<Root.ProjectTrustDecision> ? true : false
);
declare const interactiveMode: InstanceType<typeof Root.InteractiveMode>;
interactiveMode.renderInitialMessages();
const pendingInteractiveInput: Promise<string> = interactiveMode.getUserInput();
interactiveMode.clearEditor();
interactiveMode.showError("failed");
interactiveMode.showWarning("warning");
interactiveMode.showNewVersionNotification({ version: "1.2.3", packageName: "ohm", note: "Changes" });
interactiveMode.showPackageUpdateNotification(["example"]);
const publicToolShell: Root.ToolDefinition["renderShell"] = "default";
const mainOptions = {
  toolAuthorizationHandler: () => ({ decision: "allow_once" as const }),
} satisfies Root.MainOptions;
const fullscreenOptions: Tui.FullscreenTUIOptions = { mouse: true, wheelScrollLines: 4 };
const altScreenOptions: Tui.TuiAltScreenOptions = fullscreenOptions;
const runtimePointerEvent = {
  type: "press",
  row: 0,
  column: 0,
  button: "left",
  ctrl: false,
  alt: false,
  shift: false,
} satisfies Tui.RuntimeUiPointerEvent;
const runtimePointerResponse = { handled: true, capture: true } satisfies Tui.RuntimeUiPointerResponse;
type SameType<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
    (<Value>() => Value extends Right ? 1 : 2) ? true : false;
const runtimePointerTypesAreExact = true satisfies SameType<
  Tui.RuntimeUiPointerEvent["type"],
  "press" | "release" | "move" | "wheel" | "leave" | "cancel"
>;
const runtimePointerButtonsAreExact = true satisfies SameType<
  Tui.RuntimeUiPointerEvent["button"],
  "left" | "middle" | "right" | "none"
>;
const runtimePointerResponseKeysAreExact = true satisfies SameType<
  keyof Tui.RuntimeUiPointerResponse,
  "handled" | "capture" | "releaseCapture"
>;
const emptyRuntimePointerResponse = {} satisfies Tui.RuntimeUiPointerResponse;
const runtimePointerComponent = {
  render: () => ({ lines: [] }),
  handlePointer: (
    event: Readonly<Tui.RuntimeUiPointerEvent>,
    context: Readonly<Tui.RuntimeUiRenderContext>,
  ): Tui.RuntimeUiPointerResponse => event.row < context.height ? runtimePointerResponse : {},
} satisfies Tui.RuntimeUiComponent;
const modelAuthFreshness = { minOAuthValidityMs: 30_000 } satisfies Root.ModelRuntimeAuthOverrides;
type CliModelOptions = Parameters<typeof Root.resolveCliModel>[0];
const cliModelInputContract = true satisfies (
  CliModelOptions extends {
    cliProvider?: string;
    cliModel?: string;
    cliThinking?: Root.ModelReasoningEffort;
  } ? true : false
);
const cliModelResultContract = true satisfies (
  Root.ResolveCliModelResult extends {
    model: unknown;
    warning: string | undefined;
    error: string | undefined;
  } ? true : false
);
declare const agentSessionConstructor: typeof Root.AgentSession;
declare const agentSessionConfig: Root.AgentSessionConfig;
const createdAgentSession: Promise<Root.AgentSession> =
  agentSessionConstructor.create(agentSessionConfig);
type RuntimeFactoryInput = Parameters<Root.CreateAgentSessionRuntimeFactory>[0];
type RuntimeFactoryServices = Awaited<ReturnType<Root.CreateAgentSessionRuntimeFactory>>["services"];
const runtimeFactoryScopeContract = true satisfies (
  RuntimeFactoryInput extends { modelScope?: readonly string[] } ? true : false
);
type LegacyMinimalRuntimeFactory = (
  input: RuntimeFactoryInput,
) => Promise<{ session: Root.AgentSession; services: RuntimeFactoryServices }>;
const legacyRuntimeFactoryRemainsCompatible = true satisfies (
  LegacyMinimalRuntimeFactory extends Root.CreateAgentSessionRuntimeFactory ? true : false
);
declare const extensionApi: Extensions.ExtensionAPI;
const durableJobStart: Promise<Extensions.ExtensionJobStatus> = extensionApi.jobs.start(
  { kind: "consumer.fixture", idempotencyKey: "stable" },
  ({ id, attempt, signal, replaceMetadata }) => {
    void [id, attempt, signal, replaceMetadata];
    return { accepted: true };
  },
);
const childSessionStart: Promise<Extensions.ExtensionChildSessionStatus> = extensionApi.childSessions.spawn({
  model: "fixture-model",
  thinkingLevel: "high",
  tools: ["read"],
});
type PublicNames = RootNames | keyof typeof Auth | keyof typeof Config | keyof typeof Context | keyof typeof Core
  | keyof typeof Extensions | keyof typeof Images | keyof typeof Interfaces | keyof typeof Modes | keyof typeof Process
  | keyof typeof Providers | keyof typeof Service | keyof typeof Tools | keyof typeof Tui;
declare const genericName: GenericName;
declare const publicName: PublicNames;
void [
  genericName,
  publicName,
  referenceRootValuesAreComplete,
  rpcModelInfo,
  catalogModelCapabilities,
  projectTrustReadsAsynchronously,
  pendingInteractiveInput,
  publicToolShell,
  mainOptions,
  fullscreenOptions,
  altScreenOptions,
  runtimePointerEvent,
  runtimePointerResponse,
  runtimePointerTypesAreExact,
  runtimePointerButtonsAreExact,
  runtimePointerResponseKeysAreExact,
  emptyRuntimePointerResponse,
  runtimePointerComponent,
  rawTerminalKeybindings,
  applicationKeybindings,
  effectiveApplicationBindings,
  modelAuthFreshness,
  cliModelInputContract,
  cliModelResultContract,
  createdAgentSession,
  legacyRuntimeFactoryRemainsCompatible,
  runtimeFactoryScopeContract,
  durableJobStart,
  childSessionStart,
];

export type {
  AgentSessionConfig,
  AgentSessionRuntimeDiagnostic,
  AgentSessionServices,
  AppKeybinding,
  Args,
  BranchPreparation,
  BranchSummaryResult,
  CollectEntriesResult,
  CreateAgentSessionFromServicesOptions,
  CreateAgentSessionRuntimeFactory,
  CreateAgentSessionRuntimeResult,
  CreateAgentSessionServicesOptions,
  CreateModelRuntimeOptions,
  CutPointResult,
  EditDiffResult,
  FileOperations,
  GenerateBranchSummaryOptions,
  InteractiveModeOptions,
  MainOptions,
  ModelRuntimeAuthOverrides,
  ParsedSkillBlock,
  ProjectTrustDecision,
  ProjectTrustStoreEntry,
  ProjectTrustUpdate,
  PromptOptions,
  RenderDiffOptions,
  ResizedImage,
  ResolveCliModelResult,
  RpcExtensionUIRequest,
  RpcExtensionUIResponse,
  SessionStats,
  SettingsCallbacks,
  SettingsConfig,
  ThemeColor,
  ToolAuthorizationContext,
  ToolAuthorizationDecision,
  ToolAuthorizationHandler,
  ToolAuthorizationOwner,
  ToolAuthorizationRequest,
  ToolExecutionOptions,
  TruncationOptions,
  TruncationResult,
  VisualTruncateResult,
  BashOperations,
  BashSpawnContext,
  BashSpawnHook,
  BashToolDetails,
  BashToolInput,
  BashToolOptions,
  BuildSystemPromptOptions,
  CreateAgentSessionOptions,
  CreateAgentSessionResult,
  DefaultProjectTrust,
  EditOperations,
  EditToolDetails,
  EditToolInput,
  EditToolOptions,
  EventBus,
  EventBusController,
  FindOperations,
  FindToolDetails,
  FindToolInput,
  FindToolOptions,
  GrepOperations,
  GrepToolDetails,
  GrepToolInput,
  GrepToolOptions,
  ImageSettings,
  LoadSkillsFromDirOptions,
  LoadSkillsResult,
  LsOperations,
  LsToolDetails,
  LsToolInput,
  LsToolOptions,
  PackageManager,
  PackageSource,
  PathMetadata,
  ProgressCallback,
  ProgressEvent,
  PromptTemplate,
  ReadOperations,
  ReadToolDetails,
  ReadToolInput,
  ReadToolOptions,
  ReadonlyFooterDataProvider,
  ResolvedPaths,
  ResolvedResource,
  ResourceCollision,
  ResourceDiagnostic,
  ResourceLoader,
  RetrySettings,
  RpcClientOptions,
  RpcEventListener,
  SettingsManagerCreateOptions,
  Skill,
  SkillFrontmatter,
  SlashCommandInfo,
  SlashCommandSource,
  SourceInfo,
  Theme,
  ToolsOptions,
  WriteOperations,
  WriteToolInput,
  WriteToolOptions,
} from "ohm";

declare const bashToolDetails: Root.BashToolDetails;
if (bashToolDetails.truncation !== undefined) {
  const truncated: boolean = bashToolDetails.truncation.truncated;
  void truncated;
}
