import { optionalProperties } from "../core/optional-properties.js";
import { isDeepStrictEqual, types as utilTypes } from "node:util";
import { Value } from "typebox/value";

import type { Api, ImageContent, Model, Provider, TextContent } from "@ohm/models";
import type { KeyId, KeybindingsConfig } from "@ohm/terminal";

import { defaultSecretRedactor } from "../auth/redaction.js";
import type { ResourceDiagnostic } from "../core/diagnostics.js";
import { errorMessage } from "../core/errors.js";
import { isJsonObject, isJsonValue, type JsonValue } from "../core/json.js";
import type { ThinkingLevel } from "../core/settings-manager.js";
import type { BuildSystemPromptOptions } from "../core/system-prompt.js";
import { STRING_VALUE } from "../core/value-schemas.js";
import { ModelRegistry } from "../providers/model-registry.js";
import { SessionManager } from "../storage/session-manager.js";
import { normalizeShellTerminalState } from "../tools/shell-result.js";
import { createTheme } from "../tui/theme.js";
import { sanitizeTerminalText } from "../tui/unicode.js";
import {
  extensionModelRegistry,
  type ExtensionModelRegistry,
} from "./model-boundary.js";
import {
  canonicalAgentMessages,
  canonicalMessage,
  canonicalUsage,
  extensionCanonicalMessages,
  extensionMessage,
  extensionSessionManager,
  extensionUsage,
} from "./session-contract.js";
import {
  HEADLESS_EXTENSION_UI_CAPABILITIES,
  RuntimeExtensionHost,
  runtimeSessionGuardResult,
  type RuntimeDirectCompactOptions,
  type RuntimeDirectReplacementContext,
  type RuntimeExtensionEvent,
  type RuntimeRunScope,
} from "./runtime.js";
import { UNAVAILABLE_EXTENSION_UI_SLOTS } from "./runtime-internal/ui-slot-registrations.js";
import { UNAVAILABLE_EXTENSION_UI_ROUTES } from "./runtime-internal/ui-route-registrations.js";
import {
  attachExtensionProjection,
  attachExtensionRuntimeHost,
  compatibilityPublicContent as publicContent,
  createCompatibilityDirectActions,
  createExtensionRuntime,
  ensureExtensionRuntimeHost,
  extensionProjectionHost,
  getExtensionRuntimeHost,
} from "./runtime-internal/action-binding.js";
import type {
  BeforeAgentStartEventResult,
  BeforeProviderHeadersEvent,
  BeforeProviderRequestEvent,
  CompactOptions,
  ContextUsage,
  ExtensionError,
  ExtensionMode,
  ExtensionUIContext,
  Extension,
  ExtensionCommandContext,
  ExtensionCommandContextActions,
  ExtensionContext,
  ExtensionContextActions,
  ExtensionEvent,
  ExtensionEventMap,
  ExtensionHandler,
  ExtensionActions,
  ExtensionFlag,
  ExtensionRuntime,
  ExtensionShortcut,
  InputEventResult,
  InputSource,
  MessageEndEvent,
  MessageRenderer,
  MarkdownTransformer,
  EntryRenderer,
  ProviderConfig,
  ReplacedSessionContext,
  RegisteredTool,
  ResolvedCommand,
  SessionBeforeCompactResult,
  SessionBeforeForkResult,
  SessionBeforeSwitchResult,
  SessionBeforeTreeResult,
  ToolCallEvent,
  ToolCallEventResult,
  ToolResultEvent,
  ToolResultEventResult,
  UserBashEvent,
  UserBashEventResult,
} from "./direct.js";

function extensionFailure<T>(cause: T): Pick<ExtensionError, "error" | "stack"> {
  if (!utilTypes.isNativeError(cause)) return { error: errorMessage(cause) };
  let stack: string | undefined;
  try {
    const value = cause.stack;
    stack = Value.Check(STRING_VALUE, value) ? value : undefined;
  }
  catch { /* A hostile Error accessor must not replace the original failure. */ }
  return {
    error: errorMessage(cause),
    ...optionalProperties(stack === undefined ? undefined : { stack }),
  };
}

export {
  attachExtensionProjection,
  attachExtensionRuntimeHost,
  createExtensionRuntime,
  ensureExtensionRuntimeHost,
  getExtensionRuntimeHost,
};

type RunnerEmitEvent = Exclude<
  ExtensionEvent,
  | ToolCallEvent
  | { type: "project_trust" }
  | ToolResultEvent
  | UserBashEvent
  | { type: "context" }
  | BeforeProviderRequestEvent
  | BeforeProviderHeadersEvent
  | { type: "before_agent_start" }
  | MessageEndEvent
  | { type: "resources_discover" }
  | { type: "input" }
>;

interface RunnerGuardResults {
  session_before_switch: SessionBeforeSwitchResult;
  session_before_fork: SessionBeforeForkResult;
  session_before_compact: SessionBeforeCompactResult;
  session_before_tree: SessionBeforeTreeResult;
}

const MESSAGE_ROLE_CHANGE_ERROR = "message_end cannot replace a message with a different role";

type RunnerEmitResult<TEvent extends RunnerEmitEvent> =
  TEvent extends { type: infer TType }
    ? TType extends keyof RunnerGuardResults
      ? RunnerGuardResults[TType] | undefined
      : undefined
    : never;

type RunnerEmitOutput = RunnerGuardResults[keyof RunnerGuardResults] | undefined;
type RunnerEvent<TType extends RunnerEmitEvent["type"]> = Extract<RunnerEmitEvent, { type: TType }>;

export type ExtensionErrorListener = (error: ExtensionError) => void;

const reservedShortcutActions = new Set<string>([
  "app.exit",
  "app.suspend",
  "app.interrupt",
  "app.clear",
  "app.editor.external",
  "app.message.copy",
  "app.message.followUp",
  "app.thinking.cycle",
  "app.thinking.toggle",
  "app.model.select",
  "app.tools.expand",
  "tui.input.copy",
  "tui.input.submit",
  "tui.select.confirm",
  "tui.select.cancel",
  "tui.editor.deleteToLineEnd",
]);

const fallbackTheme = createTheme("mono", { color: false, unicode: false });
const noUi: ExtensionUIContext = {
  capabilities: HEADLESS_EXTENSION_UI_CAPABILITIES,
  slots: UNAVAILABLE_EXTENSION_UI_SLOTS,
  routes: UNAVAILABLE_EXTENSION_UI_ROUTES,
  select: async () => undefined,
  confirm: async () => false,
  input: async () => undefined,
  notify() {},
  onTerminalInput: () => () => {},
  setStatus() {},
  setWorkingMessage() {},
  setWorkingVisible() {},
  setWorkingIndicator() {},
  setHiddenThinkingLabel() {},
  setBackground() {},
  setWidget() {},
  setFooter() {},
  setHeader() {},
  setTitle() {},
  // SAFETY: the legacy headless UI contract resolves no selection, represented at runtime by undefined.
  custom: async () => undefined as never,
  pasteToEditor() {},
  setEditorText() {},
  getEditorText: () => "",
  editor: async () => undefined,
  addAutocompleteProvider() {},
  setEditorComponent() {},
  getEditorComponent: () => undefined,
  get theme() { return fallbackTheme; },
  getAllThemes: () => [],
  getTheme: () => undefined,
  setTheme: () => ({ success: false, error: "Interactive UI is unavailable" }),
  getToolsExpanded: () => false,
  setToolsExpanded() {},
};

function publicImages(images: readonly import("../core/types.js").ImageBlock[] | undefined): ImageContent[] | undefined {
  if (images === undefined) return undefined;
  return images.map((image) => ({
    type: "image",
    data: image.data ?? "",
    mimeType: image.mediaType,
  }));
}

function nativeImages(images: undefined): undefined;
function nativeImages(images: readonly ImageContent[]): import("../core/types.js").ImageBlock[];
function nativeImages(
  images: readonly ImageContent[] | undefined,
): import("../core/types.js").ImageBlock[] | undefined;
function nativeImages(images: readonly ImageContent[] | undefined): import("../core/types.js").ImageBlock[] | undefined {
  if (images === undefined) return undefined;
  return images.map((image) => ({ type: "image", data: image.data, mediaType: image.mimeType }));
}

function checkedJsonValue<T>(value: T, label: string): JsonValue {
  if (!isJsonValue(value)) throw new TypeError(`${label} must be a JSON value`);
  return value;
}

function nativeContent(
  blocks: readonly (TextContent | ImageContent)[],
): Array<import("../core/types.js").TextBlock | import("../core/types.js").ImageBlock> {
  return blocks.map((block) => block.type === "text"
    ? { type: "text", text: block.text }
    : { type: "image", data: block.data, mediaType: block.mimeType });
}

interface PublicProviderBindingActions {
  registerProvider?: (name: string, config: ProviderConfig) => void;
  unregisterProvider?: (name: string) => void;
}

interface NativeProviderBindingActions {
  registerNativeProvider?: (provider: Provider) => void;
}

interface ProviderBindingActions extends PublicProviderBindingActions, NativeProviderBindingActions {}

interface RunnerDiscoveredResourcePath {
  path: string;
  extensionPath: string;
}

interface RunnerDiscoveredResources {
  skillPaths: RunnerDiscoveredResourcePath[];
  promptPaths: RunnerDiscoveredResourcePath[];
  themePaths: RunnerDiscoveredResourcePath[];
}

function contextProxy(context: ExtensionContext, getSystemPrompt = (): string => context.getSystemPrompt()): ExtensionContext {
  return {
    get ui() { return context.ui; },
    get mode() { return context.mode; },
    get hasUI() { return context.hasUI; },
    get cwd() { return context.cwd; },
    get paths() { return context.paths; },
    get sessionManager() { return context.sessionManager; },
    get modelRegistry() { return context.modelRegistry; },
    get model() { return context.model; },
    get scopedModels() { return context.scopedModels; },
    get thinkingLevel() { return context.thinkingLevel; },
    get signal() { return context.signal; },
    abort: () => { context.abort(); },
    compact: (options) => { context.compact(options); },
    getContextUsage: () => context.getContextUsage(),
    getSystemPrompt,
    hasPendingMessages: () => context.hasPendingMessages(),
    isIdle: () => context.isIdle(),
    isProjectTrusted: () => context.isProjectTrusted(),
    shutdown: () => { context.shutdown(); },
  };
}

/** Public runner facade over exactly one RuntimeExtensionHost generation. */
export class ExtensionRunner {
  readonly #extensions: Extension[];
  readonly #runtime: ExtensionRuntime;
  readonly #host: RuntimeExtensionHost;
  readonly #cwd: string;
  readonly #sessionManager: SessionManager;
  readonly #modelRegistry: ModelRegistry;
  readonly #publicSessionManager: ReturnType<typeof extensionSessionManager>;
  readonly #publicModelRegistry: ExtensionModelRegistry;
  readonly #errorListeners = new Set<ExtensionErrorListener>();
  #ui: ExtensionUIContext = noUi;
  #mode: ExtensionMode = "print";
  #shortcutDiagnostics: ResourceDiagnostic[] = [];
  #commandDiagnostics: ResourceDiagnostic[] = [];
  #getModel: () => Model<Api> | undefined = () => undefined;
  #getScopedModels: () => readonly { readonly model: Model<Api>; readonly thinkingLevel?: ThinkingLevel }[] = () => [];
  #getThinkingLevel: ExtensionActions["getThinkingLevel"] = () => "off";
  #isIdle: () => boolean = () => true;
  #isProjectTrusted: () => boolean = () => true;
  #getSignal: () => AbortSignal | undefined = () => undefined;
  #abort: () => void = () => {};
  #hasPendingMessages: () => boolean = () => false;
  #shutdown: () => void = () => {};
  #getContextUsage: () => ContextUsage | undefined = () => undefined;
  #compact: (options?: CompactOptions) => void = () => {};
  #getSystemPrompt: () => string = () => "";
  #getSystemPromptOptions: () => BuildSystemPromptOptions;
  #waitForIdle: ExtensionCommandContextActions["waitForIdle"] = async () => {};
  #newSession: ExtensionCommandContextActions["newSession"] = async () => ({ cancelled: false });
  #fork: ExtensionCommandContextActions["fork"] = async () => ({ cancelled: false });
  #navigateTree: ExtensionCommandContextActions["navigateTree"] = async () => ({ cancelled: false });
  #switchSession: ExtensionCommandContextActions["switchSession"] = async () => ({ cancelled: false });
  #refresh: ExtensionCommandContextActions["refresh"] = async () => {};
  #staleMessage: string | undefined;
  #unsubscribeHostError: (() => void) | undefined;

  constructor(
    extensions: Extension[],
    runtime: ExtensionRuntime,
    cwd: string,
    sessionManager: SessionManager,
    modelRegistry: ModelRegistry,
  ) {
    this.#extensions = [...extensions];
    this.#runtime = runtime;
    this.#cwd = cwd;
    this.#sessionManager = sessionManager;
    this.#modelRegistry = modelRegistry;
    this.#publicSessionManager = extensionSessionManager(sessionManager);
    this.#publicModelRegistry = extensionModelRegistry(modelRegistry);
    this.#getSystemPromptOptions = () => ({ cwd: this.#cwd });
    this.#host = ensureExtensionRuntimeHost(runtime, cwd);
    for (const extension of extensions) {
      const owner = extensionProjectionHost(extension);
      if (owner !== undefined && owner !== this.#host) {
        throw new Error(`Extension projection belongs to another host generation: ${extension.path}`);
      }
    }
    this.#unsubscribeHostError = this.#host.onError((entry) => this.emitError({
      ...optionalProperties(entry.extensionId === undefined ? undefined : { extensionId: entry.extensionId }),
      extensionPath: entry.sourcePath ?? "<runtime>",
      event: /^Runtime ([a-z_]+) handler failed:/u.exec(entry.message)?.[1] ?? "runtime",
      error: entry.message,
    }));
    this.#installStandaloneHostBridge();
  }

  bindCore(
    actions: ExtensionActions,
    contextActions: ExtensionContextActions,
    providerActions?: ProviderBindingActions,
  ): void {
    this.#assertActive();
    this.#runtime.sendMessage = (message, options) => {
      this.#assertActive();
      actions.sendMessage(message, options);
    };
    this.#runtime.sendUserMessage = (content, options) => {
      this.#assertActive();
      actions.sendUserMessage(content, options);
    };
    this.#runtime.appendEntry = (customType, data) => {
      this.#assertActive();
      actions.appendEntry(customType, data);
    };
    this.#runtime.setSessionName = (name) => {
      this.#assertActive();
      actions.setSessionName(name);
    };
    this.#runtime.getSessionName = () => {
      this.#assertActive();
      return actions.getSessionName();
    };
    this.#runtime.setLabel = (entryId, label) => {
      this.#assertActive();
      actions.setLabel(entryId, label);
    };
    this.#runtime.getActiveTools = () => {
      this.#assertActive();
      return [...actions.getActiveTools()];
    };
    this.#runtime.getAllTools = () => {
      this.#assertActive();
      return actions.getAllTools();
    };
    this.#runtime.setActiveTools = (toolNames) => {
      this.#assertActive();
      actions.setActiveTools(toolNames);
    };
    this.#runtime.refreshTools = () => {
      this.#assertActive();
      actions.refreshTools();
    };
    this.#runtime.getCommands = () => {
      this.#assertActive();
      return actions.getCommands();
    };
    this.#runtime.setModel = (model) => {
      this.#assertActive();
      return actions.setModel(model);
    };
    this.#runtime.getThinkingLevel = () => {
      this.#assertActive();
      return actions.getThinkingLevel();
    };
    this.#runtime.setThinkingLevel = (level) => {
      this.#assertActive();
      actions.setThinkingLevel(level);
    };
    this.#getModel = contextActions.getModel;
    this.#getScopedModels = contextActions.getScopedModels ?? (() => []);
    this.#getThinkingLevel = actions.getThinkingLevel;
    this.#isIdle = contextActions.isIdle;
    this.#isProjectTrusted = contextActions.isProjectTrusted;
    this.#getSignal = contextActions.getSignal;
    this.#abort = contextActions.abort;
    this.#hasPendingMessages = contextActions.hasPendingMessages;
    this.#shutdown = contextActions.shutdown;
    this.#getContextUsage = contextActions.getContextUsage;
    this.#compact = contextActions.compact;
    this.#getSystemPrompt = contextActions.getSystemPrompt;
    this.#getSystemPromptOptions = contextActions.getSystemPromptOptions ?? (() => ({ cwd: this.#cwd }));

    for (const pending of this.#runtime.pendingProviderRegistrations) {
      try {
        (providerActions?.registerProvider ?? ((name, config) => this.#publicModelRegistry.registerProvider(name, config)))(
          pending.name,
          pending.config,
        );
      } catch (cause) {
        this.#providerError(pending.extensionPath, cause);
      }
    }
    this.#runtime.pendingProviderRegistrations = [];
    for (const pending of this.#runtime.pendingNativeProviderRegistrations) {
      try {
        (providerActions?.registerNativeProvider ?? ((provider) => this.#publicModelRegistry.registerProvider(provider)))(
          pending.provider,
        );
      } catch (cause) {
        this.#providerError(pending.extensionPath, cause);
      }
    }
    this.#runtime.pendingNativeProviderRegistrations = [];
    this.#runtime.registerProvider = (name, config) => {
      this.#assertActive();
      (providerActions?.registerProvider ?? ((providerName, selected) => this.#publicModelRegistry.registerProvider(providerName, selected)))(
        name,
        config,
      );
    };
    this.#runtime.registerNativeProvider = (provider) => {
      this.#assertActive();
      (providerActions?.registerNativeProvider ?? ((selected) => this.#publicModelRegistry.registerProvider(selected)))(provider);
    };
    this.#runtime.unregisterProvider = (name) => {
      this.#assertActive();
      (providerActions?.unregisterProvider ?? ((providerName) => this.#publicModelRegistry.unregisterProvider(providerName)))(name);
    };
    this.#host.setHostContext({ projectTrusted: this.#isProjectTrusted() });
  }

  bindCommandContext(actions?: ExtensionCommandContextActions): void {
    this.#assertActive();
    this.#waitForIdle = actions?.waitForIdle ?? (async () => {});
    this.#newSession = actions?.newSession ?? (async () => ({ cancelled: false }));
    this.#fork = actions?.fork ?? (async () => ({ cancelled: false }));
    this.#navigateTree = actions?.navigateTree ?? (async () => ({ cancelled: false }));
    this.#switchSession = actions?.switchSession ?? (async () => ({ cancelled: false }));
    this.#refresh = actions?.refresh ?? (async () => {});
  }

  setUIContext(uiContext?: ExtensionUIContext, mode: ExtensionMode = "print"): void {
    this.#assertActive();
    this.#ui = uiContext ?? noUi;
    this.#mode = mode;
    this.#host.setHostContext({ mode });
    this.#host.setSessionUiHandler(() => this.#ui);
  }

  getUIContext(): ExtensionUIContext { return this.#ui; }
  hasUI(): boolean { return this.#ui !== noUi; }
  getExtensionPaths(): string[] { return this.#extensions.map((extension) => extension.path); }

  /** @internal Native generation used by first-party mode adapters. */
  getRuntimeHost(): RuntimeExtensionHost {
    this.#assertActive();
    return this.#host;
  }

  getAllRegisteredTools(): RegisteredTool[] {
    const tools = new Map<string, { extension: Extension; tool: RegisteredTool }>();
    for (const extension of this.#extensions) {
      for (const tool of extension.tools.values()) {
        if (!tools.has(tool.definition.name)) tools.set(tool.definition.name, { extension, tool });
      }
    }
    return [...tools.values()].map(({ extension, tool }) => ({
      ...tool,
      definition: {
        ...tool.definition,
        execute: (toolCallId, params, signal, onUpdate) => tool.definition.execute(
          toolCallId,
          params,
          signal,
          onUpdate,
          this.createContext(extension),
        ),
      },
    }));
  }

  getToolDefinition(name: string): RegisteredTool["definition"] | undefined {
    return this.getAllRegisteredTools().find((tool) => tool.definition.name === name)?.definition;
  }

  getFlags(): Map<string, ExtensionFlag> {
    const flags = new Map<string, ExtensionFlag>();
    for (const extension of this.#extensions) {
      for (const [name, flag] of extension.flags) if (!flags.has(name)) flags.set(name, { ...flag });
    }
    return flags;
  }

  setFlagValue(name: string, value: boolean | string): void {
    this.#assertActive();
    this.#runtime.flagValues.set(name, value);
    if (this.#host.flags().some((flag) => flag.name === name)) this.#host.setFlagValue(name, value);
  }

  getFlagValues(): Map<string, boolean | string> { return new Map(this.#runtime.flagValues); }

  getShortcuts(keybindings: KeybindingsConfig): Map<KeyId, ExtensionShortcut> {
    this.#shortcutDiagnostics = [];
    const builtins = new Map<string, { action: string; reserved: boolean }>();
    for (const [action, configured] of Object.entries(keybindings)) {
      for (const shortcut of configured === undefined ? [] : Array.isArray(configured) ? configured : [configured]) {
        const normalized = shortcut.toLowerCase();
        const reserved = reservedShortcutActions.has(action);
        if (builtins.get(normalized)?.reserved === true && !reserved) continue;
        builtins.set(normalized, { action, reserved });
      }
    }
    const addDiagnostic = (message: string, path: string): void => {
      const safeMessage = sanitizeTerminalText(defaultSecretRedactor.redact(message));
      this.#shortcutDiagnostics.push({ type: "warning", message: safeMessage, path });
      if (!this.hasUI()) console.warn(safeMessage);
    };
    const selected = new Map<KeyId, ExtensionShortcut>();
    for (const extension of this.#extensions) {
      for (const [shortcut, registration] of extension.shortcuts) {
        const normalized: KeyId = shortcut.toLowerCase();
        const builtin = builtins.get(normalized);
        if (builtin?.reserved === true) {
          addDiagnostic(
            `Reserved key '${shortcut}' cannot be assigned by ${registration.extensionPath}; that registration was ignored.`,
            registration.extensionPath,
          );
          continue;
        }
        const previous = selected.get(normalized);
        if (builtin !== undefined) {
          addDiagnostic(
            `Key '${shortcut}' normally runs ${builtin.action}; ${registration.extensionPath} now owns it.`,
            registration.extensionPath,
          );
        }
        if (previous !== undefined) {
          addDiagnostic(
            `Key '${shortcut}' was claimed by ${previous.extensionPath} and ${registration.extensionPath}; the later registration takes precedence.`,
            registration.extensionPath,
          );
        }
        selected.set(normalized, {
          ...registration,
          handler: () => registration.handler(this.createContext(extension)),
        });
      }
    }
    return selected;
  }

  getShortcutDiagnostics(): ResourceDiagnostic[] {
    return this.#shortcutDiagnostics.map((diagnostic) => ({ ...diagnostic }));
  }

  invalidate(message = "Extension runtime context is stale after session replacement or refresh"): void {
    if (this.#staleMessage !== undefined) return;
    this.#staleMessage = message;
    const unsubscribeHostError = this.#unsubscribeHostError;
    this.#unsubscribeHostError = undefined;
    unsubscribeHostError?.();
    this.#runtime.invalidate(message);
  }

  onError(listener: ExtensionErrorListener): () => void {
    this.#errorListeners.add(listener);
    return () => this.#errorListeners.delete(listener);
  }

  emitError(error: ExtensionError): void {
    const extensionId = error.extensionId ?? this.#extensionIdForPath(error.extensionPath);
    const selected = extensionId === undefined ? error : { ...error, extensionId };
    for (const listener of this.#errorListeners) {
      try { listener(selected); }
      catch { /* Diagnostic observers must not destabilize the compatibility runner. */ }
    }
  }

  hasHandlers(eventType: string): boolean {
    return this.#extensions.some((extension) => (extension.handlers.get(eventType)?.length ?? 0) > 0)
      || this.#host.hasListeners(eventType);
  }

  getMessageRenderer(customType: string): MessageRenderer | undefined {
    for (const extension of this.#extensions) {
      const renderer = extension.messageRenderers.get(customType);
      if (renderer !== undefined) return renderer;
    }
    return undefined;
  }

  getMarkdownTransformers(): MarkdownTransformer[] {
    return this.#extensions.flatMap((extension) =>
      extension.markdownTransformer === undefined ? [] : [extension.markdownTransformer]);
  }

  getEntryRenderer(customType: string): EntryRenderer | undefined {
    for (const extension of this.#extensions) {
      const renderer = extension.entryRenderers?.get(customType);
      if (renderer !== undefined) return renderer;
    }
    return undefined;
  }

  getModelRegistry(): ModelRegistry { return this.#modelRegistry; }

  getRegisteredCommands(): ResolvedCommand[] {
    this.#commandDiagnostics = [];
    const registrations = this.#extensions.flatMap((extension) =>
      [...extension.commands.values()].map((command) => ({ command, extension })));

    const groups = new Map<string, number[]>();
    registrations.forEach(({ command }, index) => {
      const members = groups.get(command.name) ?? [];
      members.push(index);
      groups.set(command.name, members);
    });

    const naming = new Map<number, { preferred: string; nextSuffix: number }>();
    for (const [name, members] of groups) {
      members.forEach((registrationIndex, memberIndex) => {
        naming.set(registrationIndex, {
          preferred: members.length === 1 ? name : `${name}:${memberIndex + 1}`,
          nextSuffix: memberIndex + 2,
        });
      });
    }

    const assigned = new Set<string>();
    return registrations.map(({ command, extension }, index) => {
      const plan = naming.get(index);
      if (plan === undefined) throw new Error(`Missing command naming plan for ${command.name}`);
      let invocationName = plan.preferred;
      let suffix = plan.nextSuffix;
      while (assigned.has(invocationName)) {
        invocationName = [command.name, suffix].join(":");
        suffix += 1;
      }
      assigned.add(invocationName);
      return {
        ...command,
        invocationName,
        handler: (args: string) => command.handler(args, this.createCommandContext(extension)),
      };
    });
  }

  getCommandDiagnostics(): ResourceDiagnostic[] {
    return this.#commandDiagnostics.map((diagnostic) => ({ ...diagnostic }));
  }
  getCommand(name: string): ResolvedCommand | undefined {
    return this.getRegisteredCommands().find((command) => command.invocationName === name);
  }

  shutdown(): void { this.#shutdown(); }
  getActiveTools(): string[] { this.#assertActive(); return [...this.#runtime.getActiveTools()]; }

  createContext(extension?: Extension): ExtensionContext {
    const owner = (): ExtensionRunner => this;
    return {
      get ui() { const runner = owner(); runner.#assertActive(); return runner.#ui; },
      get mode() { const runner = owner(); runner.#assertActive(); return runner.#mode; },
      get hasUI() { const runner = owner(); runner.#assertActive(); return runner.hasUI(); },
      get cwd() { const runner = owner(); runner.#assertActive(); return runner.#cwd; },
      get paths() {
        const runner = owner();
        runner.#assertActive();
        const selected = extension ?? (runner.#extensions.length === 1 ? runner.#extensions[0] : undefined);
        const paths = selected === undefined
          ? undefined
          : runner.#host.extensionDataPaths(selected.resolvedPath);
        if (paths === undefined) {
          throw new Error("Extension data paths are available only inside a loaded extension callback");
        }
        return Object.freeze({ userData: paths.user, workspaceData: paths.workspace });
      },
      get sessionManager() { const runner = owner(); runner.#assertActive(); return runner.#publicSessionManager; },
      get modelRegistry() { const runner = owner(); runner.#assertActive(); return runner.#publicModelRegistry; },
      get model() { const runner = owner(); runner.#assertActive(); return runner.#getModel(); },
      get scopedModels() { const runner = owner(); runner.#assertActive(); return [...runner.#getScopedModels()]; },
      get thinkingLevel() { const runner = owner(); runner.#assertActive(); return runner.#getThinkingLevel(); },
      isIdle: () => { this.#assertActive(); return this.#isIdle(); },
      isProjectTrusted: () => { this.#assertActive(); return this.#isProjectTrusted(); },
      get signal() { const runner = owner(); runner.#assertActive(); return runner.#getSignal(); },
      abort: () => { this.#assertActive(); this.#abort(); },
      hasPendingMessages: () => { this.#assertActive(); return this.#hasPendingMessages(); },
      shutdown: () => { this.#assertActive(); this.#shutdown(); },
      getContextUsage: () => { this.#assertActive(); return this.#getContextUsage(); },
      compact: (options) => { this.#assertActive(); this.#compact(options); },
      getSystemPrompt: () => { this.#assertActive(); return this.#getSystemPrompt(); },
    };
  }

  createCommandContext(extension?: Extension): ExtensionCommandContext {
    return Object.assign(contextProxy(this.createContext(extension)), {
      getSystemPromptOptions: () => { this.#assertActive(); return this.#getSystemPromptOptions(); },
      waitForIdle: async () => { this.#assertActive(); await this.#waitForIdle(); },
      newSession: (...args: Parameters<ExtensionCommandContextActions["newSession"]>) => {
        this.#assertActive();
        return this.#newSession(...args);
      },
      fork: (...args: Parameters<ExtensionCommandContextActions["fork"]>) => {
        this.#assertActive();
        return this.#fork(...args);
      },
      navigateTree: (...args: Parameters<ExtensionCommandContextActions["navigateTree"]>) => {
        this.#assertActive();
        return this.#navigateTree(...args);
      },
      switchSession: (...args: Parameters<ExtensionCommandContextActions["switchSession"]>) => {
        this.#assertActive();
        return this.#switchSession(...args);
      },
      refresh: () => { this.#assertActive(); return this.#refresh(); },
    });
  }

  async emit<TEvent extends RunnerEmitEvent>(event: TEvent): Promise<RunnerEmitResult<TEvent>>;
  async emit(event: RunnerEmitEvent): Promise<RunnerEmitOutput> {
    this.#assertActive();
    if (event.type === "session_before_switch") return await this.#emitSessionBeforeSwitch(event);
    if (event.type === "session_before_fork") return await this.#emitSessionBeforeFork(event);
    if (event.type === "session_before_compact") return await this.#emitSessionBeforeCompact(event);
    if (event.type === "session_before_tree") return await this.#emitSessionBeforeTree(event);
    if (!this.#usesNativeHost()) {
      await this.#emitLocal(event);
      return undefined;
    }
    const scope = this.#scope();
    try {
      // SAFETY: RunnerEmitEvent names are a subset of RuntimeExtensionEvent and dispatchPayload adapts the matching value.
      await this.#host.dispatch(event.type as RuntimeExtensionEvent, this.#dispatchPayload(event, scope) as never);
    } catch {
      // The native host already reports each handler failure through its diagnostic stream.
      // The public runner contract isolates those failures from the caller.
    }
    return undefined;
  }

  async #emitSessionBeforeSwitch(
    event: RunnerEvent<"session_before_switch">,
  ): Promise<SessionBeforeSwitchResult | undefined> {
    if (this.#usesNativeHost()) {
      return await this.#host.reduceSessionBeforeSwitch({
        reason: event.reason,
        ...optionalProperties(event.targetSessionFile === undefined ? undefined : {
          targetThreadId: event.targetSessionFile,
        }),
      });
    }
    let result: SessionBeforeSwitchResult | undefined;
    for (const { extension, handler } of this.#handlersFor("session_before_switch")) {
      let selected: SessionBeforeSwitchResult | void;
      try {
        selected = await handler(event, this.createContext(extension));
      } catch (cause) {
        this.#handlerError(extension.path, event.type, cause);
        continue;
      }
      if (selected === undefined) continue;
      try {
        result = runtimeSessionGuardResult(selected);
        if (result.cancel === true) return result;
      } catch (cause) {
        this.#handlerError(extension.path, event.type, cause);
        return { cancel: true };
      }
    }
    return result;
  }

  async #emitSessionBeforeFork(
    event: RunnerEvent<"session_before_fork">,
  ): Promise<SessionBeforeForkResult | undefined> {
    if (this.#usesNativeHost()) {
      const scope = this.#scope();
      return await this.#host.reduceSessionBeforeFork({
        sourceThreadId: scope.threadId,
        sourceEventId: event.entryId,
        position: event.position,
      });
    }
    let result: SessionBeforeForkResult | undefined;
    for (const { extension, handler } of this.#handlersFor("session_before_fork")) {
      let selected: SessionBeforeForkResult | void;
      try {
        selected = await handler(event, this.createContext(extension));
      } catch (cause) {
        this.#handlerError(extension.path, event.type, cause);
        continue;
      }
      if (selected === undefined) continue;
      try {
        result = runtimeSessionGuardResult(selected);
        if (result.cancel === true) return result;
      } catch (cause) {
        this.#handlerError(extension.path, event.type, cause);
        return { cancel: true };
      }
    }
    return result;
  }

  async #emitSessionBeforeCompact(
    event: RunnerEvent<"session_before_compact">,
  ): Promise<SessionBeforeCompactResult | undefined> {
    let result: SessionBeforeCompactResult | undefined;
    for (const { extension, handler } of this.#handlersFor("session_before_compact")) {
      try {
        const selected = await handler(event, this.createContext(extension));
        if (selected !== undefined) {
          result = selected;
          if (selected.cancel === true) return selected;
        }
      } catch (cause) {
        this.#handlerError(extension.path, event.type, cause);
      }
    }
    return result;
  }

  async #emitSessionBeforeTree(
    event: RunnerEvent<"session_before_tree">,
  ): Promise<SessionBeforeTreeResult | undefined> {
    let result: SessionBeforeTreeResult | undefined;
    for (const { extension, handler } of this.#handlersFor("session_before_tree")) {
      try {
        const selected = await handler(event, this.createContext(extension));
        if (selected !== undefined) {
          result = selected;
          if (selected.cancel === true) return selected;
        }
      } catch (cause) {
        this.#handlerError(extension.path, event.type, cause);
      }
    }
    return result;
  }

  async #emitLocal(event: RunnerEmitEvent): Promise<void> {
    for (const { extension, handler } of this.#handlersFor(event.type)) {
      try {
        await handler(event, this.createContext(extension));
      } catch (cause) {
        this.#handlerError(extension.path, event.type, cause);
      }
    }
  }

  async emitMessageEnd(event: MessageEndEvent): Promise<import("@ohm/kernel").AgentMessage | undefined> {
    if (!this.#usesNativeHost()) {
      let currentMessage = event.message;
      let modified = false;
      for (const { extension, handler } of this.#handlersFor("message_end")) {
        try {
          const selected = await handler({ ...event, message: currentMessage }, this.createContext(extension));
          if (selected?.message === undefined) continue;
          if (selected.message.role !== currentMessage.role) {
            this.emitError({
              extensionPath: extension.path,
              event: "message_end",
              error: MESSAGE_ROLE_CHANGE_ERROR,
            });
            continue;
          }
          currentMessage = selected.message;
          modified = true;
        } catch (cause) {
          this.#handlerError(extension.path, "message_end", cause);
        }
      }
      if (!modified) return undefined;
      return currentMessage;
    }
    const initial = canonicalAgentMessages([event.message])[0];
    if (initial === undefined) throw new Error("message_end requires one canonical message");
    const reduced = await this.#host.reduceMessageEnd({ ...this.#scope(), message: initial });
    return isDeepStrictEqual(initial, reduced) ? undefined : extensionMessage(reduced);
  }

  async emitToolResult(event: ToolResultEvent): Promise<ToolResultEventResult | undefined> {
    if (!this.#usesNativeHost()) {
      const currentEvent: ToolResultEvent = { ...event };
      let modified = false;
      for (const { extension, handler } of this.#handlersFor("tool_result")) {
        try {
          const selected = await handler(currentEvent, this.createContext(extension));
          if (selected === undefined) continue;
          if (selected.content !== undefined) { currentEvent.content = selected.content; modified = true; }
          if (selected.details !== undefined) { currentEvent.details = selected.details; modified = true; }
          if (selected.isError !== undefined) { currentEvent.isError = selected.isError; modified = true; }
          if (selected.usage !== undefined) { currentEvent.usage = selected.usage; modified = true; }
        } catch (cause) {
          this.#handlerError(extension.path, "tool_result", cause);
        }
      }
      return modified
        ? {
            content: currentEvent.content,
            details: currentEvent.details,
            isError: currentEvent.isError,
            ...optionalProperties(currentEvent.usage === undefined ? undefined : { usage: currentEvent.usage }),
          }
        : undefined;
    }
    const blocks = nativeContent(event.content);
    const imageBlocks = event.content.filter((block): block is ImageContent => block.type === "image");
    const result = {
      content: blocks.filter((block): block is import("../core/types.js").TextBlock => block.type === "text")
        .map((block) => block.text).join(""),
      contentBlocks: blocks,
      isError: event.isError,
      ...optionalProperties(event.usage === undefined ? undefined : { usage: canonicalUsage(event.usage) }),
      ...optionalProperties(event.details === undefined ? undefined : {
        metadata: checkedJsonValue(event.details, "Tool result details"),
      }),
      ...optionalProperties(imageBlocks.length === 0 ? undefined : { images: nativeImages(imageBlocks) }),
    };
    const reduced = await this.#host.reduceToolResult({
      ...this.#scope(),
      invocation: { callId: event.toolCallId, name: event.toolName, input: event.input, index: 0 },
      result,
    });
    if (isDeepStrictEqual(result, reduced)) return undefined;
    const content = publicContent(reduced.contentBlocks ?? [
      ...(reduced.content === "" ? [] : [{ type: "text" as const, text: reduced.content }]),
      ...(reduced.images ?? []),
    ]);
    return {
      content,
      details: reduced.metadata,
      isError: reduced.isError,
      ...optionalProperties(reduced.usage === undefined ? undefined : { usage: extensionUsage(reduced.usage) }),
    };
  }

  async emitToolCall(event: ToolCallEvent): Promise<ToolCallEventResult | undefined> {
    if (!this.#usesNativeHost()) {
      let result: ToolCallEventResult | undefined;
      for (const { extension, handler } of this.#handlersFor("tool_call")) {
        const selected = await handler(event, this.createContext(extension));
        if (selected !== undefined) {
          result = selected;
          if (selected.block === true) return selected;
        }
      }
      return result;
    }
    const reduced = await this.#host.reduceToolCall({
      ...this.#scope(),
      callId: event.toolCallId,
      name: event.toolName,
      input: event.input,
      index: 0,
    });
    if (reduced.invocation.input !== event.input && isJsonObject(reduced.invocation.input)) {
      for (const name of Object.keys(event.input)) delete event.input[name];
      Object.assign(event.input, reduced.invocation.input);
    }
    return reduced.blocked
      ? {
          block: true,
          ...optionalProperties(reduced.reason === undefined ? undefined : { reason: reduced.reason }),
          ...optionalProperties(reduced.terminate === true ? { terminate: true } : undefined),
        }
      : undefined;
  }

  async emitUserBash(event: UserBashEvent): Promise<UserBashEventResult | undefined> {
    if (!this.#usesNativeHost()) {
      for (const { extension, handler } of this.#handlersFor("user_bash")) {
        try {
          const selected = await handler(event, this.createContext(extension));
          if (selected !== undefined) return selected;
        } catch (cause) {
          this.#handlerError(extension.path, "user_bash", cause);
        }
      }
      return undefined;
    }
    const reduced = await this.#host.reduceBeforeUserShell({
      command: event.command,
      cwd: event.cwd,
      hidden: event.excludeFromContext,
    });
    if (reduced.action === "handled") {
      const terminal = normalizeShellTerminalState(reduced.result, {
        legacySignalImpliesCancellation: true,
      });
      return {
        command: reduced.command,
        cwd: reduced.cwd,
        result: {
          output: reduced.result.text,
          ...optionalProperties(terminal.exitCode === undefined ? undefined : { exitCode: terminal.exitCode }),
          ...optionalProperties(terminal.isError === undefined ? undefined : { isError: terminal.isError }),
          cancelled: terminal.cancelled,
          ...optionalProperties(terminal.timedOut === undefined ? undefined : { timedOut: terminal.timedOut }),
          ...optionalProperties(terminal.signal === undefined ? undefined : { signal: terminal.signal }),
          truncated: reduced.result.truncated === true,
          ...optionalProperties(reduced.result.fullOutputPath === undefined ? undefined : { fullOutputPath: reduced.result.fullOutputPath }),
        },
      };
    }
    if (
      reduced.operations === undefined
      && reduced.command === event.command
      && reduced.cwd === event.cwd
    ) return undefined;
    return {
      command: reduced.command,
      cwd: reduced.cwd,
      ...optionalProperties(reduced.operations === undefined ? undefined : { operations: reduced.operations }),
    };
  }

  async emitContext(messages: import("@ohm/kernel").AgentMessage[]): Promise<import("@ohm/kernel").AgentMessage[]> {
    if (!this.#usesNativeHost()) {
      const originalCopy = structuredClone(messages);
      let currentMessages = originalCopy;
      for (const { extension, handler } of this.#handlersFor("context")) {
        try {
          const selected = await handler(
            { type: "context", messages: currentMessages },
            this.createContext(extension),
          );
          if (selected?.messages !== undefined) currentMessages = selected.messages;
        } catch (cause) {
          this.#handlerError(extension.path, "context", cause);
        }
      }
      return currentMessages;
    }
    const canonical = canonicalAgentMessages(messages);
    return extensionCanonicalMessages(await this.#host.reduceContext({ ...this.#scope(), messages: canonical }));
  }

  async emitBeforeProviderRequest<T>(payload: T): Promise<JsonValue> {
    const initial = checkedJsonValue(payload, "Provider request payload");
    if (!this.#usesNativeHost()) {
      let currentPayload = initial;
      for (const { extension, handler } of this.#handlersFor("before_provider_request")) {
        try {
          const selected = await handler(
            { type: "before_provider_request", payload: currentPayload },
            this.createContext(extension),
          );
          if (selected !== undefined) currentPayload = selected;
        } catch (cause) {
          this.#handlerError(extension.path, "before_provider_request", cause);
        }
      }
      return currentPayload;
    }
    return await this.#host.applyBeforeProviderRequestPayload(initial);
  }

  async emitBeforeProviderHeaders(headers: Record<string, string | null>): Promise<Record<string, string | null>> {
    if (!this.#usesNativeHost()) {
      for (const { extension, handler } of this.#handlersFor("before_provider_headers")) {
        try {
          await handler({ type: "before_provider_headers", headers }, this.createContext(extension));
        } catch (cause) {
          this.#handlerError(extension.path, "before_provider_headers", cause);
        }
      }
      return headers;
    }
    return await this.#host.applyBeforeProviderHeaders(headers);
  }

  async emitBeforeAgentStart(
    prompt: string,
    images: ImageContent[] | undefined,
    systemPrompt: string,
    systemPromptOptions: BuildSystemPromptOptions,
  ): Promise<{ messages?: NonNullable<BeforeAgentStartEventResult["message"]>[]; systemPrompt?: string } | undefined> {
    if (!this.#usesNativeHost()) {
      let currentSystemPrompt = systemPrompt;
      const messages: NonNullable<BeforeAgentStartEventResult["message"]>[] = [];
      let systemPromptModified = false;
      for (const { extension, handler } of this.#handlersFor("before_agent_start")) {
        try {
          const context = contextProxy(
            this.createContext(extension),
            () => { this.#assertActive(); return currentSystemPrompt; },
          );
          const selected = await handler({
            type: "before_agent_start",
            prompt,
            ...optionalProperties(images === undefined ? undefined : { images }),
            systemPrompt: currentSystemPrompt,
            systemPromptOptions,
          }, context);
          if (selected?.message !== undefined) messages.push(selected.message);
          if (selected?.systemPrompt !== undefined) {
            currentSystemPrompt = selected.systemPrompt;
            systemPromptModified = true;
          }
        } catch (cause) {
          this.#handlerError(extension.path, "before_agent_start", cause);
        }
      }
      if (messages.length === 0 && !systemPromptModified) return undefined;
      return {
        ...optionalProperties(messages.length === 0 ? undefined : { messages }),
        ...optionalProperties(systemPromptModified ? { systemPrompt: currentSystemPrompt } : undefined),
      };
    }
    const selectedImages = nativeImages(images);
    const reduced = await this.#host.reduceBeforeAgentStart({
      ...this.#scope(),
      prompt,
      ...optionalProperties(selectedImages === undefined ? undefined : { images: selectedImages }),
      systemPrompt,
      systemPromptOptions,
    });
    const messages = reduced.messages.map((message) => ({
      customType: message.customType,
      content: Value.Check(STRING_VALUE, message.content) ? message.content : publicContent(message.content),
      display: message.display,
      ...optionalProperties(message.details === undefined ? undefined : { details: message.details }),
    }));
    if (messages.length === 0 && reduced.systemPrompt === systemPrompt) return undefined;
    return {
      ...optionalProperties(messages.length === 0 ? undefined : { messages }),
      ...optionalProperties(reduced.systemPrompt === systemPrompt ? undefined : { systemPrompt: reduced.systemPrompt }),
    };
  }

  async emitResourcesDiscover(
    cwd: string,
    reason: "startup" | "refresh",
  ): Promise<RunnerDiscoveredResources> {
    if (!this.#usesNativeHost()) {
      const result: RunnerDiscoveredResources = {
        skillPaths: [],
        promptPaths: [],
        themePaths: [],
      };
      for (const { extension, handler } of this.#handlersFor("resources_discover")) {
        try {
          const selected = await handler(
            { type: "resources_discover", cwd, reason },
            this.createContext(extension),
          );
          for (const path of selected?.skillPaths ?? []) result.skillPaths.push({ path, extensionPath: extension.path });
          for (const path of selected?.promptPaths ?? []) result.promptPaths.push({ path, extensionPath: extension.path });
          for (const path of selected?.themePaths ?? []) result.themePaths.push({ path, extensionPath: extension.path });
        } catch (cause) {
          this.#handlerError(extension.path, "resources_discover", cause);
        }
      }
      return result;
    }
    const resources = await this.#host.discoverResources(reason);
    const convert = (entries: typeof resources.skillPaths) => entries.map((entry) => ({
      path: entry.path,
      extensionPath: entry.sourcePath,
    }));
    return {
      skillPaths: convert(resources.skillPaths),
      promptPaths: convert(resources.promptPaths),
      themePaths: convert(resources.themePaths),
    };
  }

  async emitInput(
    inputText: string,
    inputImages: ImageContent[] | undefined,
    inputSource: InputSource,
    delivery?: "steer" | "followUp",
  ): Promise<InputEventResult> {
    if (!this.#usesNativeHost()) {
      let currentText = inputText;
      let currentImages = inputImages;
      for (const { extension, handler } of this.#handlersFor("input")) {
        try {
          const selected = await handler({
            type: "input",
            text: currentText,
            ...optionalProperties(currentImages === undefined ? undefined : { images: currentImages }),
            source: inputSource,
            ...optionalProperties(delivery === undefined ? undefined : { streamingBehavior: delivery }),
          }, this.createContext(extension));
          if (selected?.action === "handled") return selected;
          if (selected?.action === "transform") {
            currentText = selected.text;
            currentImages = selected.images ?? currentImages;
          }
        } catch (cause) {
          this.#handlerError(extension.path, "input", cause);
        }
      }
      const textChanged = currentText !== inputText;
      const imagesChanged = currentImages !== inputImages;
      if (!textChanged && !imagesChanged) return { action: "continue" };
      return {
        action: "transform",
        text: currentText,
        ...optionalProperties(currentImages === undefined ? undefined : { images: currentImages }),
      };
    }
    const selectedImages = nativeImages(inputImages);
    const reduced = await this.#host.reduceInput({
      threadId: this.#sessionManager.getSessionId(),
      branch: "main",
      text: inputText,
      ...optionalProperties(selectedImages === undefined ? undefined : { images: selectedImages }),
      source: inputSource,
      ...optionalProperties(delivery === undefined ? undefined : { streamingBehavior: delivery }),
    });
    if (reduced.action !== "transform") return reduced;
    const outputImages = publicImages(reduced.images);
    return {
      action: "transform",
      text: reduced.text,
      ...optionalProperties(outputImages === undefined ? undefined : { images: outputImages }),
    };
  }

  #usesNativeHost(): boolean {
    if (this.#extensions.length === 0) return this.#host.extensions().length > 0;
    return this.#extensions.every((extension) => extensionProjectionHost(extension) === this.#host);
  }

  #installStandaloneHostBridge(): void {
    const directActions = createCompatibilityDirectActions(
      this.#runtime,
      this.#cwd,
      () => this.#assertActive(),
      {
        getSystemPromptOptions: () => this.#getSystemPromptOptions(),
        waitForIdle: async (signal) => await this.#waitForIdle(signal),
        newSession: async (options, signal) => {
        if (options === undefined) return this.#newSession(undefined, signal);
        const withSession = options.withSession;
        return this.#newSession({
          ...optionalProperties(options.parentSession === undefined ? undefined : { parentSession: options.parentSession }),
          ...optionalProperties(options.setup === undefined ? undefined : { setup: options.setup }),
          ...optionalProperties(withSession === undefined ? undefined : {
            withSession: async (context) => await withSession(this.#directReplacementContext(context)),
          }),
        }, signal);
        },
        fork: async (entryId, options, signal) => {
          if (options === undefined) return await this.#fork(entryId, undefined, signal);
          const withSession = options.withSession;
          return await this.#fork(entryId, {
            ...optionalProperties(options.position === undefined ? undefined : { position: options.position }),
            ...optionalProperties(withSession === undefined ? undefined : {
              withSession: async (context) => await withSession(this.#directReplacementContext(context)),
            }),
          }, signal);
        },
        navigateTree: async (targetId, options, signal) => await this.#navigateTree(targetId, options, signal),
        switchSession: async (sessionPath, options, signal) => {
          if (options === undefined) return await this.#switchSession(sessionPath, undefined, signal);
          const withSession = options.withSession;
          return await this.#switchSession(sessionPath, {
            ...optionalProperties(withSession === undefined ? undefined : {
              withSession: async (context) => await withSession(this.#directReplacementContext(context)),
            }),
          }, signal);
        },
        refresh: async (signal) => await this.#refresh(signal),
      },
    );
    this.#host.setDirectActionsHandler(directActions);
    this.#host.setDirectContextHandler((_target, signal) => {
      this.#assertActive();
      signal.throwIfAborted();
      const selected = this.#getModel();
      const model = selected === undefined
        ? undefined
        : this.#modelRegistry.find(selected.provider, selected.id);
      return {
        sessionManager: this.#publicSessionManager,
        modelRegistry: this.#modelRegistry,
        ...optionalProperties(model === undefined ? undefined : { model }),
        scopedModels: this.#getScopedModels().flatMap((entry) => {
          const scoped = this.#modelRegistry.find(entry.model.provider, entry.model.id);
          return scoped === undefined ? [] : [{
            model: scoped,
            ...optionalProperties(entry.thinkingLevel === undefined ? undefined : { thinkingLevel: entry.thinkingLevel }),
          }];
        }),
        thinkingLevel: this.#getThinkingLevel(),
        isIdle: () => this.#isIdle(),
        hasPendingMessages: () => this.#hasPendingMessages(),
        abort: () => { this.#abort(); },
        shutdown: () => { this.#shutdown(); },
        getContextUsage: () => this.#getContextUsage(),
        compact: (options) => this.#compact(this.#publicCompactOptions(
          options,
          () => this.#sessionManager.getSessionId(),
        )),
        getSystemPrompt: () => this.#getSystemPrompt(),
      };
    });
    this.#host.setHostContext({ mode: this.#mode, projectTrusted: this.#isProjectTrusted() });
    this.#host.setSessionUiHandler(() => this.#ui);
  }

  #publicCompactOptions(
    options: RuntimeDirectCompactOptions | undefined,
    getThreadId: () => string,
  ): CompactOptions | undefined {
    if (options === undefined) return undefined;
    return {
      ...optionalProperties(options.customInstructions === undefined ? undefined : { customInstructions: options.customInstructions }),
      ...optionalProperties(options.onComplete === undefined ? undefined : {
        onComplete: (result) => options.onComplete?.({
          ...result,
          threadId: getThreadId(),
          branch: "main",
        }),
      }),
      ...optionalProperties(options.onError === undefined ? undefined : { onError: options.onError }),
    };
  }

  #directReplacementContext(context: ReplacedSessionContext): RuntimeDirectReplacementContext {
    const wrapSession = (
      callback: ((selected: RuntimeDirectReplacementContext) => Promise<void>) | undefined,
    ): ((selected: ReplacedSessionContext) => Promise<void>) | undefined => callback === undefined
      ? undefined
      : async (selected) => await callback(this.#directReplacementContext(selected));
    return {
      cwd: context.cwd,
      paths: context.paths,
      signal: context.signal,
      mode: context.mode,
      hasUI: context.hasUI,
      isProjectTrusted: () => context.isProjectTrusted(),
      ui: context.ui,
      sessionManager: context.sessionManager,
      modelRegistry: context.modelRegistry,
      model: context.model,
      scopedModels: context.scopedModels,
      thinkingLevel: context.thinkingLevel,
      isIdle: () => context.isIdle(),
      hasPendingMessages: () => context.hasPendingMessages(),
      abort: () => context.abort(),
      shutdown: () => context.shutdown(),
      getContextUsage: () => context.getContextUsage(),
      compact: (options) => {
        context.compact(this.#publicCompactOptions(
          options,
          () => context.sessionManager.getSessionId(),
        ));
      },
      getSystemPrompt: () => context.getSystemPrompt(),
      getSystemPromptOptions: () => context.getSystemPromptOptions(),
      waitForIdle: async () => await context.waitForIdle(),
      newSession: async (options) => {
        if (options === undefined) return await context.newSession();
        const withSession = wrapSession(options.withSession);
        return await context.newSession({
          ...optionalProperties(options.parentSession === undefined ? undefined : { parentSession: options.parentSession }),
          ...optionalProperties(options.setup === undefined ? undefined : { setup: options.setup }),
          ...optionalProperties(withSession === undefined ? undefined : { withSession }),
        });
      },
      fork: async (entryId, options) => {
        if (options === undefined) return await context.fork(entryId);
        const withSession = wrapSession(options.withSession);
        return await context.fork(entryId, {
          ...optionalProperties(options.position === undefined ? undefined : { position: options.position }),
          ...optionalProperties(withSession === undefined ? undefined : { withSession }),
        });
      },
      navigateTree: async (targetId, options) => await context.navigateTree(targetId, options),
      switchSession: async (sessionPath, options) => {
        if (options === undefined) return await context.switchSession(sessionPath);
        const withSession = wrapSession(options.withSession);
        return await context.switchSession(sessionPath, withSession === undefined ? {} : { withSession });
      },
      refresh: async () => await context.refresh(),
      sendMessage: async (message, options) => {
        await context.sendMessage({
          customType: message.customType,
          content: Value.Check(STRING_VALUE, message.content) ? message.content : publicContent(message.content),
          display: message.display,
          ...optionalProperties(message.details === undefined ? undefined : { details: message.details }),
        }, options);
      },
      sendUserMessage: async (content, options) => {
        await context.sendUserMessage(
          Value.Check(STRING_VALUE, content) ? content : publicContent(content),
          options,
        );
      },
    };
  }

  #handlersFor<K extends keyof ExtensionEventMap>(eventType: K): Array<{
    extension: Extension;
    handler: ExtensionHandler<K>;
  }> {
    const handlers: Array<{
      extension: Extension;
      handler: ExtensionHandler<K>;
    }> = [];
    for (const extension of this.#extensions) {
      for (const handler of extension.handlers.get(eventType) ?? []) {
        // SAFETY: registration stores each handler under the same event key used to retrieve it here.
        handlers.push({ extension, handler: handler as ExtensionHandler<K> });
      }
    }
    return handlers;
  }

  #handlerError<T>(extensionPath: string, event: string, cause: T): void {
    this.emitError({
      extensionPath,
      event,
      ...extensionFailure(cause),
    });
  }

  #extensionIdForPath(extensionPath: string): string | undefined {
    const projected = this.#extensions.find((extension) =>
      extension.path === extensionPath || extension.resolvedPath === extensionPath);
    const resolvedPath = projected?.resolvedPath ?? extensionPath;
    return this.#host.extensions().find((entry) => entry.sourcePath === resolvedPath)?.extensionId;
  }

  #assertActive(): void {
    if (this.#staleMessage !== undefined) throw new Error(this.#staleMessage);
    this.#runtime.assertActive();
  }

  #providerError<T>(extensionPath: string, cause: T): void {
    this.emitError({
      extensionPath,
      event: "register_provider",
      ...extensionFailure(cause),
    });
  }

  #scope(): RuntimeRunScope {
    return {
      threadId: this.#sessionManager.getSessionId(),
      branch: "main",
      runId: "compatibility-runner",
      step: 1,
    };
  }

  #dispatchPayload(event: RunnerEmitEvent, scope: RuntimeRunScope) {
    const { type: _type, ...payload } = event;
    if (event.type === "session_start" || event.type === "session_shutdown") return payload;
    if (event.type === "session_info_changed") return { ...payload, threadId: scope.threadId, branch: scope.branch };
    if (event.type === "agent_start") {
      const model = this.#getModel();
      return { ...scope, provider: model?.provider ?? "compatibility", model: model?.id ?? "compatibility" };
    }
    if (event.type === "agent_end") {
      return {
        ...scope,
        outcome: { status: "completed", finishReason: "stop" },
        messages: canonicalAgentMessages(event.messages),
        messagesTruncated: false,
      };
    }
    if (event.type === "agent_settled") {
      return {
        ...scope,
        outcome: { status: "completed", finishReason: "stop" },
        messages: [],
        messagesTruncated: false,
      };
    }
    if (event.type === "message_start") return { ...scope, message: canonicalMessage(event.message) };
    if (event.type === "message_update") {
      return { ...scope, step: 1, message: canonicalMessage(event.message), assistantMessageEvent: event.assistantMessageEvent };
    }
    if (event.type === "model_select") {
      return {
        threadId: scope.threadId,
        branch: scope.branch,
        provider: event.model.provider,
        model: event.model.id,
        ...optionalProperties(event.previousModel === undefined ? undefined : {
          previousModel: { provider: event.previousModel.provider, model: event.previousModel.id },
        }),
        source: event.source,
      };
    }
    if (event.type === "thinking_level_select") {
      return { threadId: scope.threadId, branch: scope.branch, level: event.level, previousLevel: event.previousLevel, source: "set" };
    }
    return { ...scope, ...payload };
  }
}
