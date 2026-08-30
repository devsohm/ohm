import { optionalProperties } from "../core/optional-properties.js";
import type { ImageContent } from "@ohm/models";

import { defaultSecretRedactor } from "../auth/redaction.js";
import { errorMessage } from "../core/errors.js";
import { SettingsManager } from "../core/settings-manager.js";
import type { ImageBlock } from "../core/types.js";
import type { ExtensionCommandContextActions } from "../extensions/direct.js";
import { extensionSessionManager } from "../extensions/session-contract.js";
import {
  bindInteractiveSessionPresentation,
  interactiveTranscriptHistory,
  interactiveTranscriptUsageBaseline,
  type InteractiveSessionPresentationTerminal,
} from "../interactive/session-presentation.js";
import { AnthropicApiBearerBillingWarning } from "../interactive/anthropic-warning.js";
import { REFRESH_RESOURCE_SUMMARY, renderInteractiveCommandHelp } from "../interactive/commands.js";
import { renderInteractiveResourceReport } from "../interactive/resource-report.js";
import { modelCacheReadPrice } from "../providers/models.js";
import { providerLoginMethods, type ProviderLoginPath } from "../providers/login-path.js";
import type { AgentSession, AgentSessionPromptOptions } from "../service/agent-session.js";
import type { AgentSessionRuntime } from "../service/agent-session-runtime.js";
import { TuiController } from "../tui/controller.js";
import { ohmCompactSignature, ohmTerminalLockup } from "../tui/brand.js";
import { Keybindings as ConfiguredKeybindings, parseKeybindings } from "../tui/keybindings.js";
import { createRichTuiController } from "../tui/rich-frame-projector.js";
import type {
  PickerItem,
  TuiAction,
  TuiControllerOptions,
  TuiInputImageAttachment,
} from "../tui/types.js";
import {
  BoundedDeferredSubmissionQueue,
  classifyActiveSubmission,
  deliverActiveSubmission,
} from "../cli/active-submission.js";
import {
  applyInteractiveSetting,
  interactiveSettingItems,
  tuiOperatorPreferences,
} from "../cli/interactive-settings.js";
import {
  InteractiveCommandCoordinator,
  type InteractiveShellRequest,
} from "./interactive-command-coordinator.js";
import { interactiveSkillCommands } from "./interactive-command-items.js";
import { applyInteractiveThinking } from "./interactive-thinking.js";
import {
  dispatchActiveInteractiveResourceSlash,
  resolveInteractiveResourceSlash,
  type InteractiveResourceCatalog,
} from "./interactive-resource-commands.js";
import {
  dispatchInteractiveSubmissionAfterInterruption,
  interruptInteractiveRunForCommand,
  localInterruptionMarker,
  restoreInterruptedSubmission,
} from "./interactive-interruption-recovery.js";
import { createInteractiveTuiContext } from "./interactive-tui-context.js";
import {
  restoreAllQueuedMessages,
  restoreQueuedMessagesThenAbort,
} from "./interactive-queue.js";
import {
  beginInteractiveShellPresentation,
  runInteractiveShell,
  type InteractiveShellPresentation,
} from "./interactive-shell.js";
import { InteractiveSessionOperations } from "./interactive-session-operations.js";
import { attachClipboardImage } from "./interactive-terminal-actions.js";
import {
  bindInteractiveRuntimeUi,
  createInteractiveRuntimeCommandUi,
  type InteractiveRuntimeUiBinding,
} from "./interactive-runtime-ui.js";
import { presentStartupChangelog, readPackageChangelog } from "./startup-changelog.js";
import { OHM_VERSION } from "../version.js";
import { Check } from "typebox/value";
import { isJsonObject } from "../core/json.js";
import { FUNCTION_VALUE, STRING_VALUE } from "../core/value-schemas.js";

export interface InteractiveModeOptions {
  verbose?: boolean;
  /** Applied only when the mode creates its terminal. */
  terminalOptions?: TuiControllerOptions;
  /** Optional terminal owner for embedding and deterministic tests. */
  terminal?: TuiController;
  initialMessages?: string[];
  initialImages?: ImageContent[];
  initialMessage?: string;
  autoTrustOnRefreshCwd?: string;
  modelFallbackMessage?: string;
  migratedProviders?: string[];
  /** Optional extension commands and prompts exposed by the active embedding host. */
  extensionCatalog?: InteractiveResourceCatalog | (() => InteractiveResourceCatalog | undefined);
  /** Optional host-owned startup copy. */
  startup?: { compactText: string; expandedText: string };
  /** Runs after recovery for every newly bound session generation. */
  prepareSession?: (session: AgentSession, signal?: AbortSignal) => void | Promise<void>;
  /** Expands host-specific prompt references before a prompt is admitted. */
  preparePrompt?: (
    text: string,
    images: readonly ImageBlock[],
    session: AgentSession,
    signal: AbortSignal,
  ) => { text: string; images: readonly ImageBlock[] } | Promise<{ text: string; images: readonly ImageBlock[] }>;
  /** Supplies invocation-wide prompt limits and tool selection. */
  promptOptions?: (
    session: AgentSession,
  ) => Omit<AgentSessionPromptOptions, "images" | "signal" | "source">;
  /** Ensures an interactive model exists immediately before a prompt starts. */
  preparePromptModel?: (
    session: AgentSession,
    terminal: TuiController,
    signal: AbortSignal,
  ) => void | Promise<void>;
  /** Optional host authentication flow, including browser-launch policy. */
  login?: (
    argument: string,
    terminal: TuiController,
    signal: AbortSignal,
  ) => void | Promise<void>;
  /** Optional host credential-removal flow. */
  logout?: (
    argument: string,
    terminal: TuiController,
    signal: AbortSignal,
  ) => void | Promise<void>;
  /** Optional host-owned transactional resource refresh. */
  refreshSession?: (
    session: AgentSession,
    signal: AbortSignal,
    /** Installs the replacement session UI before its session_start event. */
    beforeSessionStart: (session: AgentSession) => Promise<void>,
  ) => { warnings?: readonly string[] } | Promise<{ warnings?: readonly string[] }>;
}

type ModelSelectionAction = Extract<TuiAction, { type: "select" }>;

type ModelSelectionOwner = {
  generation: number;
  controller: AbortController;
};

function canonicalImages(images: readonly ImageContent[] | undefined): ImageBlock[] | undefined {
  if (images === undefined) return undefined;
  return images.map((image) => ({ type: "image", data: image.data, mediaType: image.mimeType }));
}

function inputImages(images: readonly TuiInputImageAttachment[] | undefined): ImageBlock[] | undefined {
  if (images === undefined || images.length === 0) return undefined;
  return images.map((image) => ({ ...image.block }));
}

interface ModelPickerValue {
  provider: string;
  model: string;
  thinkingLevel?: string;
}

function modelItem(model: { provider: string; id: string; name?: string }): PickerItem<ModelPickerValue> {
  return {
    id: `${model.provider}/${model.id}`,
    label: model.name ?? model.id,
    detail: `${model.provider}/${model.id}`,
    keywords: [model.provider, model.id, model.name ?? ""],
    value: { provider: model.provider, model: model.id },
  };
}

const KEY_NAMES: Readonly<Record<string, string>> = Object.freeze({
  escape: "Esc",
  enter: "Enter",
  tab: "Tab",
  space: "Space",
  backspace: "Backspace",
  delete: "Delete",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
});

function displayKey(value: string): string {
  return value.split("+").map((part) => KEY_NAMES[part] ?? (part.length === 1 ? part.toUpperCase() : part)).join("+");
}

function formatHotkeys(keybindings = new ConfiguredKeybindings()): string {
  const hint = (action: Parameters<ConfiguredKeybindings["keys"]>[0], maximum = 3) =>
    keybindings.keys(action).slice(0, maximum).map(displayKey).join("/");
  return [
    `${hint("app.interrupt")} interrupt`,
    `${hint("app.clear")} clear/exit`,
    `${hint("app.exit")} exit`,
    "/ commands",
  ].filter((value) => !value.startsWith(" ")).join(" · ");
}

function waitForInteractiveOperation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolveOperation, rejectOperation) => {
    let settled = false;
    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => settle(() => rejectOperation(signal.reason));
    operation.then(
      (value) => settle(() => resolveOperation(value)),
      (error) => settle(() => rejectOperation(error)),
    );
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Interactive terminal owner for an already-created session runtime. */
export class InteractiveMode {
  readonly #runtime: AgentSessionRuntime;
  readonly #options: InteractiveModeOptions;
  readonly #terminal: TuiController;
  readonly #operatorPreferenceOverrides: NonNullable<TuiControllerOptions["operatorPreferences"]>;
  readonly #doubleEscapeActionOverride: TuiControllerOptions["doubleEscapeAction"];
  readonly #coordinator: InteractiveCommandCoordinator<ImageBlock>;
  readonly #sessionOperations: InteractiveSessionOperations;
  #keybindings = new ConfiguredKeybindings();
  readonly #deferredSubmissions = new BoundedDeferredSubmissionQueue<ImageBlock>((image) =>
    Buffer.byteLength(image.data ?? image.url ?? "", "utf8"));
  #unsubscribe = (): void => undefined;
  #uiBinding: InteractiveRuntimeUiBinding | undefined;
  #sessionBindingAbort: AbortController | undefined;
  #boundSession: AgentSession | undefined;
  #initialized = false;
  #initializationBarrier: Promise<void> | undefined;
  #closed = false;
  #actionTail: Promise<void> = Promise.resolve();
  #activePrompt: Promise<void> | undefined;
  #activePromptAbort: AbortController | undefined;
  #modelRefresh: { controller: AbortController; operation: Promise<void> } | undefined;
  #modelSelectionGeneration = 0;
  #modelSelectionAbort: AbortController | undefined;
  readonly #modelSelectionOwners = new WeakMap<ModelSelectionAction, ModelSelectionOwner>();
  readonly #operationAborts = new Set<AbortController>();
  #treeSummaryCancel: (() => void) | undefined;
  #resolveExit: (() => void) | undefined;
  #exit: Promise<void> | undefined;
  #submissionOrder = 0;
  #drainingDeferred = false;
  #locallyInterruptedOperationId: string | undefined;
  #pendingSessionPreparation: AgentSession | undefined;
  #refreshSessionRebind = false;
  #invalidatedSessionID: string | undefined;
  readonly #pendingUserInputs: Array<{
    resolve(value: string): void;
    reject(error: Error): void;
  }> = [];
  readonly #anthropicApiBearerBillingWarning = new AnthropicApiBearerBillingWarning();

  constructor(runtime: AgentSessionRuntime, options: InteractiveModeOptions = {}) {
    this.#runtime = runtime;
    this.#options = options;
    const {
      doubleEscapeAction,
      operatorPreferences,
      ...terminalOptions
    } = options.terminalOptions ?? {};
    const settings = runtime.session.settingsManager;
    const createsTerminal = options.terminal === undefined;
    this.#operatorPreferenceOverrides = createsTerminal ? operatorPreferences ?? {} : {};
    this.#doubleEscapeActionOverride = createsTerminal ? doubleEscapeAction : undefined;
    this.#terminal = options.terminal ?? createRichTuiController({
      operatorPreferences: {
        ...tuiOperatorPreferences(settings),
        ...operatorPreferences,
      },
      doubleEscapeAction: doubleEscapeAction ?? settings.getDoubleEscapeAction(),
      ...terminalOptions,
      cacheReadPrice: options.terminalOptions?.cacheReadPrice ?? ((provider, model, promptTokens) => {
        try {
          const selected = this.#runtime.session.modelRegistry.find(provider, model);
          return selected === undefined ? undefined : modelCacheReadPrice(selected, promptTokens);
        } catch {
          return undefined;
        }
      }),
    });
    this.#sessionOperations = new InteractiveSessionOperations({
      runtime,
      terminal: this.#terminal,
      refreshTranscript: (refreshOptions) => {
        this.#terminal.replaceTranscript(interactiveTranscriptHistory(this.#runtime.session), "main", refreshOptions);
        const usage = interactiveTranscriptUsageBaseline(this.#runtime.session);
        this.#terminal.setUsageBaseline(
          usage.usage,
          usage.latestCacheHitRate,
          usage.latestCacheUsage,
          usage.reportedUsage,
        );
      },
      updateContext: () => this.#updateContext(),
      registerSummaryCancelHandler: (handler) => {
        this.#treeSummaryCancel = handler;
        return () => {
          if (this.#treeSummaryCancel === handler) this.#treeSummaryCancel = undefined;
        };
      },
    });
    this.#coordinator = this.#createCoordinator();
    this.#terminal.setActionHandler((action) => {
      const operation = this.dispatchAction(action);
      void operation.catch((error) => this.#reportError(error));
      return operation;
    });
  }

  /** Dispatch one terminal action and settle after the coordinator accepts it. */
  async dispatchAction(action: TuiAction): Promise<void> {
    const initialization = this.#initializationBarrier;
    if (initialization !== undefined) {
      await initialization;
      if (!this.#initialized) return;
    }
    if (action.type === "select" && action.picker === "model") this.#beginModelSelection(action);
    if (action.type === "cancel" || action.type === "exit" || action.type === "extension_shortcut" || action.type === "suspend") {
      await this.#coordinator.dispatchAction(action);
      return;
    }
    const operation = this.#actionTail
      .then(async () => await this.#coordinator.dispatchAction(action));
    this.#actionTail = operation.catch(() => undefined);
    await operation;
  }

  #createCoordinator(): InteractiveCommandCoordinator<ImageBlock> {
    return new InteractiveCommandCoordinator<ImageBlock>({
      commands: {
        quit: () => this.stop(),
        cancel: async () => await this.#cancelActiveRun("Cancelled by user"),
        login: async ({ args }) => {
          await this.#runOperation(async (signal) => {
            if (this.#options.login === undefined) await this.#login(args, signal);
            else {
              await this.#options.login(args, this.#terminal, signal);
              this.#applyAvailableModels();
              this.#updateContext();
              await this.#maybeWarnAboutAnthropicApiBearerBilling();
            }
          });
        },
        logout: async ({ args }) => {
          await this.#runOperation(async (signal) => {
            if (this.#options.logout === undefined) await this.#logout(args, signal);
            else {
              await this.#options.logout(args, this.#terminal, signal);
              this.#applyAvailableModels();
              this.#updateContext();
            }
          });
        },
        model: async ({ args }) => {
          await this.#runOperation(async (signal) => await this.#chooseModel(args, signal));
        },
        "scoped-models": ({ args }) => {
          this.#sessionOperations.scopedModels(args);
          this.#applyAvailableModels();
        },
        thinking: ({ args }) => {
          this.#setThinking(args);
        },
        new: async () => {
          await this.#runOperation(async (signal) => await this.#sessionOperations.newSession(signal));
        },
        fork: async ({ args }) => {
          await this.#runOperation(async (signal) => await this.#sessionOperations.fork(args, signal));
        },
        clone: async ({ args }) => {
          await this.#runOperation(async (signal) => await this.#sessionOperations.clone(args, signal));
        },
        resume: async ({ args }) => {
          await this.#runOperation(async (signal) => await this.#sessionOperations.resume(args, signal));
        },
        atlas: async ({ args }) => {
          await this.#runOperation(async (signal) => await this.#sessionOperations.atlas(args, signal));
        },
        recover: async ({ args }) => {
          await this.#runOperation(async (signal) => {
            const session = this.#runtime.session;
            await this.#sessionOperations.recover(args, signal);
            await this.#completePendingSessionPreparation(session, signal);
          });
        },
        refresh: async () => {
          await this.#runOperation(async (signal) => await this.#refresh(signal));
        },
        name: async ({ args }) => await this.#sessionOperations.name(args),
        session: async () => await this.#sessionOperations.showSession(),
        export: async ({ args }) => await this.#sessionOperations.exportSession(args, false),
        share: async ({ args }) => {
          await this.#runOperation(async (signal) => await this.#sessionOperations.shareSession(args, signal));
        },
        context: () => this.#sessionOperations.showContext(),
        resources: () => this.#showResources(),
        copy: async () => await this.#sessionOperations.copyLatestAssistant(),
        hotkeys: () => this.#showHotkeys(),
        compact: async ({ args }) => await this.#sessionOperations.compact(args),
        help: () => this.#terminal.notify(renderInteractiveCommandHelp()),
        settings: async () => await this.#showSettings(),
        changelog: async () => await this.#showChangelog(),
        import: async ({ args }) => {
          await this.#runOperation(async (signal) => await this.#sessionOperations.importSession(args, signal));
        },
        trust: async () => await this.#sessionOperations.saveProjectTrust(),
      },
      unknownCommand: async ({ input, images }) => {
        const route = resolveInteractiveResourceSlash(
          this.#runtime.session,
          input,
          this.#extensionCatalog(),
        );
        if (route === undefined) {
          this.#terminal.notify(`Unknown command: /${input.slice(1).trim().split(/\s/u, 1)[0] ?? ""}`, "error");
          return true;
        }
        if (route.kind === "runtime") {
          const session = this.#runtime.session;
          const result = await this.#runOperation(async (signal) =>
            await session.extensionRunner.getRuntimeHost().runCommand(route.name, {
              args: route.args,
              threadId: session.sessionId,
              signal,
            }));
          if (result?.handled === true && result.prompt !== undefined) {
            this.#startPrompt(result.prompt, [...images]);
          }
          return true;
        }
        this.#startPrompt(route.prompt, [...images]);
        return true;
      },
      submissions: {
        prompt: (text, images) => {
          if (images.length > 0 || !this.#resolveUserInput(text)) this.#startPrompt(text, [...images]);
        },
        shell: async (request) => {
          await this.#runOperation(async (signal) => await this.#runShell(request, signal));
        },
      },
      actions: {
        exit: () => this.stop(),
        error: (action) => this.#reportError(action.error),
        cancel: async () => await this.#cancelActiveRun("Cancelled by user"),
        submit: async (action) => {
          await this.#dispatchInteractiveSubmission(
            action.text,
            this.#actionImages(action),
            {
              text: action.text,
              ...optionalProperties(action.images === undefined ? undefined : { images: action.images }),
              ...optionalProperties(action.recoveredImages === undefined ? undefined : { recoveredImages: action.recoveredImages }),
            },
          );
        },
        activeSubmission: async (action) => await this.#dispatchInteractiveSubmission(
          action.type === "follow_up" ? `/follow ${action.text}` : action.text,
          this.#actionImages(action),
          {
            text: action.text,
            mode: action.type === "follow_up" ? "follow_up" : "steer",
            ...optionalProperties(action.images === undefined ? undefined : { images: action.images }),
            ...optionalProperties(action.recoveredImages === undefined ? undefined : { recoveredImages: action.recoveredImages }),
          },
        ),
        dequeue: () => this.#dequeueMessage(),
        queueRestoreDiscard: () => this.#updateContext(),
        modelCatalog: () => {
          this.#applyAvailableModels();
          this.#startModelRefresh({ force: false, allowNetwork: false });
        },
        sessionCatalog: async (action) => await this.#sessionOperations.handleCatalogAction(action),
        sessionMutation: async (action) => await this.#sessionOperations.handleMutation(action),
        selectSession: async (action) => {
          await this.#runOperation(async (signal) =>
            await this.#sessionOperations.selectCatalogItem(action.item, signal));
        },
        selectModel: async (action) => {
          const selection = this.#takeModelSelection(action);
          await this.#runOperation(async (signal) => await this.#selectModelItem(action.item, signal, selection));
        },
        command: (action) => this.#terminal.setEditorText(String(action.item.value)),
        copy: async () => await this.#sessionOperations.copyLatestAssistant(false),
        copyText: async (action) => await this.#terminal.copyToClipboard(action.text),
        cycleThinking: () => {
          if (this.#runtime.session.cycleThinkingLevel() === undefined) {
            this.#terminal.notify("The selected model does not expose configurable thinking levels", "status");
          }
          this.#updateContext();
        },
        toggleThinkingVisibility: () => { this.#terminal.toggleReasoning(); },
        extensionShortcut: async (action) => {
          await this.#runOperation(async (signal) => {
            const ui = createInteractiveRuntimeCommandUi(this.#terminal, "shortcut", {
              lifecycleSignal: action.generation,
              interactionSignal: signal,
            });
            await this.#runtime.session.extensionRunner.getRuntimeHost().runShortcut(action.shortcut, {
              threadId: this.#runtime.session.sessionId,
              signal: AbortSignal.any([signal, action.generation]),
              ui,
            });
          });
        },
        other: async (action) => {
          if (action.type === "paste_image") {
            await this.#runOperation(async (signal) => {
              await attachClipboardImage(this.#terminal, this.#runtime.session.settingsManager, signal);
            });
          } else if (action.type === "suspend") {
            this.#terminal.suspend();
          }
        },
      },
    });
  }

  /** Initialize the terminal and bind the current extension generation once. */
  async init(): Promise<void> {
    if (this.#closed) throw new Error("Interactive mode is closed");
    if (this.#initialized) {
      await this.#initializationBarrier;
      return;
    }
    this.#initialized = true;
    let finishInitialization!: () => void;
    const initialization = new Promise<void>((resolve) => { finishInitialization = resolve; });
    this.#initializationBarrier = initialization;
    try {
      this.#keybindings = parseKeybindings(this.#runtime.session.settingsManager.getKeybindings());
      this.#terminal.setKeybindings(this.#keybindings);
      this.#terminal.start();
      const startup = this.#options.startup;
      this.#terminal.setStartup(
        startup?.compactText
          ?? `${ohmCompactSignature(OHM_VERSION, this.#terminal.capabilities.unicode)}\n/help commands`,
        startup?.expandedText
          ?? `${ohmTerminalLockup(OHM_VERSION, this.#terminal.capabilities.unicode)}\n/exit quit · /cancel interrupt · /model choose · /refresh resources · !command shell`,
      );
      this.#terminal.setInterruptHandler(() => {
        if (this.#operationAborts.size > 0) {
          void this.#cancelActiveRun("Interrupted").catch((error) => this.#reportError(error));
          return true;
        }
        if (this.#runtime.session.isIdle) return false;
        const marker = localInterruptionMarker(this.#runtime.session);
        if (marker !== undefined) this.#locallyInterruptedOperationId = marker;
        void this.#cancelActiveRun("Interrupted").catch((error) => this.#reportError(error));
        return true;
      });
      this.#runtime.setBeforeSessionInvalidate(() => {
        this.#invalidatedSessionID = this.#boundSession?.sessionId ?? this.#runtime.session.sessionId;
        this.#invalidateModelSelection(new Error("Session replaced"));
        this.#activePromptAbort?.abort(new Error("Session replaced"));
        this.#locallyInterruptedOperationId = undefined;
        this.#pendingSessionPreparation = undefined;
        const modelRefresh = this.#modelRefresh;
        this.#modelRefresh = undefined;
        modelRefresh?.controller.abort(new Error("Session replaced"));
        this.#terminal.setModelPickerLoading(false);
        this.#unbindSession();
      });
      this.#runtime.setRebindSession(async (session) => {
        const refreshing = this.#refreshSessionRebind || this.#invalidatedSessionID === session.sessionId;
        this.#invalidatedSessionID = undefined;
        this.#invalidateModelSelection(new Error("Session replaced"));
        this.#keybindings = parseKeybindings(session.settingsManager.getKeybindings());
        this.#terminal.setKeybindings(this.#keybindings);
        await this.#bindSession(!refreshing, session, refreshing);
        if (!refreshing) await this.#prepareBoundSession(session);
        this.#applyAvailableModels(session);
      });
      await this.#bindSession(true);
      await this.#prepareBoundSession(this.#runtime.session);
      this.#applyAvailableModels();
      this.#startModelRefresh();
      await presentStartupChangelog(this.#runtime.session.settingsManager, (message) => this.#terminal.notify(message));
      await this.#maybeWarnAboutAnthropicApiBearerBilling();

      if ((this.#options.migratedProviders?.length ?? 0) > 0) {
        this.showWarning(`Migrated credentials: ${this.#options.migratedProviders!.join(", ")}`);
      }
      if (this.#options.modelFallbackMessage !== undefined) {
        this.showWarning(this.#options.modelFallbackMessage);
      }
    } catch (error) {
      const refresh = this.#modelRefresh;
      refresh?.controller.abort(new Error("Interactive initialization failed"));
      await refresh?.operation.catch(() => undefined);
      this.#runtime.setBeforeSessionInvalidate(undefined);
      this.#runtime.setRebindSession(undefined);
      this.#unbindSession();
      this.#terminal.setInputBlocked();
      this.#terminal.setInterruptHandler(undefined);
      this.#pendingSessionPreparation = undefined;
      this.#invalidatedSessionID = undefined;
      this.#initialized = false;
      throw error;
    } finally {
      finishInitialization();
      if (this.#initializationBarrier === initialization) this.#initializationBarrier = undefined;
    }
  }

  async run(): Promise<void> {
    await this.init();
    const initial = [this.#options.initialMessage, ...(this.#options.initialMessages ?? [])]
      .filter((message): message is string => message !== undefined && message.trim() !== "");
    for (let index = 0; index < initial.length && !this.#closed; index += 1) {
      try {
        const images = index === 0 ? canonicalImages(this.#options.initialImages) : undefined;
        await this.#submitPrompt(initial[index]!, images);
      } catch (error) {
        this.#reportError(error);
      }
    }
    if (this.#closed) return;
    if (this.#exit === undefined) {
      this.#exit = new Promise<void>((resolve) => { this.#resolveExit = resolve; });
    }
    await this.#exit;
  }

  stop(): void {
    if (this.#closed) return;
    this.#invalidateModelSelection(new Error("Terminal closed"));
    this.#activePromptAbort?.abort(new Error("Terminal closed"));
    this.#locallyInterruptedOperationId = undefined;
    this.#pendingSessionPreparation = undefined;
    this.#invalidatedSessionID = undefined;
    this.#modelRefresh?.controller.abort(new Error("Terminal closed"));
    this.#abortOperations(new Error("Terminal closed"));
    for (const pending of this.#pendingUserInputs.splice(0)) pending.reject(new Error("Terminal closed"));
    this.#closed = true;
    this.#runtime.setBeforeSessionInvalidate(undefined);
    this.#runtime.setRebindSession(undefined);
    this.#unbindSession();
    this.#terminal.setInterruptHandler(undefined);
    this.#terminal.setActionHandler(undefined);
    this.#terminal.close();
    this.#resolveExit?.();
  }

  close(): void { this.stop(); }

  /** Rebuild the visible transcript from the active session branch. */
  renderInitialMessages(): void {
    this.#terminal.replaceTranscript(interactiveTranscriptHistory(this.#runtime.session), "main");
    const usage = interactiveTranscriptUsageBaseline(this.#runtime.session);
    this.#terminal.setUsageBaseline(
      usage.usage,
      usage.latestCacheHitRate,
      usage.latestCacheUsage,
      usage.reportedUsage,
    );
    this.#updateContext();
  }

  /** Wait for the next text-only prompt entered while the session is idle. */
  getUserInput(): Promise<string> {
    if (this.#closed) return Promise.reject(new Error("Interactive mode is closed"));
    return new Promise<string>((resolve, reject) => {
      this.#pendingUserInputs.push({ resolve, reject });
    });
  }

  clearEditor(): void { this.#terminal.setEditorText(""); }

  showError(message: string): void {
    this.#terminal.notify(defaultSecretRedactor.redact(message), "error");
  }

  showWarning(message: string): void { this.#terminal.notify(message, "warning"); }

  showNewVersionNotification(release: { version: string; packageName?: string; note?: string }): void {
    const lines = [
      `ohm ${release.version} is available. Run ohm self-update to update this installation.`,
      ...(release.packageName === undefined ? [] : [`Package: ${release.packageName}`]),
      ...(release.note?.trim() ? [release.note.trim()] : []),
    ];
    this.#terminal.notify(lines.join("\n"), "warning");
  }

  showPackageUpdateNotification(packages: string[]): void {
    if (packages.length === 0) return;
    this.#terminal.notify([
      "Package updates are available. Run ohm update --all to install them.",
      ...packages.map((name) => `- ${name}`),
    ].join("\n"), "warning");
  }

  #commandItems(session: AgentSession): PickerItem<string>[] {
    const commands = session.extensionRunner.getRegisteredCommands().map((command): PickerItem<string> => ({
      id: `extension:${command.invocationName}`,
      label: `/${command.invocationName}`,
      value: `/${command.invocationName}`,
      ...optionalProperties(command.description === undefined ? undefined : { detail: command.description }),
    }));
    const prompts = session.promptTemplates.map((prompt): PickerItem<string> => ({
      id: `prompt:${prompt.name}`,
      label: `/${prompt.name}`,
      value: `/${prompt.name}`,
      ...optionalProperties(prompt.description === undefined ? undefined : { detail: prompt.description }),
    }));
    const skills = session.settingsManager.getEnableSkillCommands()
      ? interactiveSkillCommands(
          session.resourceLoader.getSkills().skills,
          session.promptTemplates.map((prompt) => prompt.name),
        ).map((skill): PickerItem<string> => ({
          id: `skill:${skill.name}`,
          label: `/skill:${skill.name}`,
          value: `/skill:${skill.name}`,
          detail: skill.description,
        }))
      : [];
    return [...commands, ...prompts, ...skills];
  }

  #commandActions(session: AgentSession): ExtensionCommandContextActions {
    return {
      waitForIdle: async () => await session.waitForIdle(),
      newSession: async (options = {}, signal) => await this.#runtime.newSession({
        ...optionalProperties(options.parentSession === undefined ? undefined : { parentSession: options.parentSession }),
        ...optionalProperties(options.setup === undefined ? undefined : {
          setup: async (manager) => await options.setup?.(extensionSessionManager(manager)),
        }),
        ...optionalProperties(options.withSession === undefined ? undefined : {
          withSession: async (context) => await options.withSession?.(context),
        }),
        ...optionalProperties(signal === undefined ? undefined : { signal }),
      }),
      fork: async (entryId, options = {}, signal) => await this.#runtime.fork(entryId, {
        ...optionalProperties(options.position === undefined ? undefined : { position: options.position }),
        ...optionalProperties(options.withSession === undefined ? undefined : {
          withSession: async (context) => await options.withSession?.(context),
        }),
        ...optionalProperties(signal === undefined ? undefined : { signal }),
      }),
      navigateTree: async (targetId, options = {}, signal) => {
        signal?.throwIfAborted();
        const result = await session.navigateTree(targetId, options);
        signal?.throwIfAborted();
        return { cancelled: result.cancelled };
      },
      switchSession: async (sessionPath, options = {}, signal) => await this.#runtime.switchSession(sessionPath, {
        ...optionalProperties(options.withSession === undefined ? undefined : {
          withSession: async (context) => await options.withSession?.(context),
        }),
        ...optionalProperties(signal === undefined ? undefined : { signal }),
      }),
      refresh: async (signal) => await this.#refresh(signal),
    };
  }

  #extensionCatalog(): InteractiveResourceCatalog | undefined {
    const catalog = this.#options.extensionCatalog;
    return Check(FUNCTION_VALUE, catalog) ? catalog() : catalog;
  }

  async #bindSession(
    start: boolean,
    session: AgentSession = this.#runtime.session,
    preserveTranscript = !start,
    sessionStartOnly = false,
  ): Promise<void> {
    this.#unbindSession(!sessionStartOnly);
    this.#terminal.setOperatorPreferences({
      ...tuiOperatorPreferences(session.settingsManager),
      ...this.#operatorPreferenceOverrides,
    });
    this.#terminal.setDoubleEscapeAction(
      this.#doubleEscapeActionOverride ?? session.settingsManager.getDoubleEscapeAction(),
    );
    const themes = session.resourceLoader.getThemes().themes;
    this.#terminal.setCustomThemes(themes.map((theme) => theme.definition));
    const configuredTheme = session.settingsManager.getThemeSetting() ?? "signal";
    try { this.#terminal.setTheme(configuredTheme); }
    catch { this.#terminal.notify(`Configured theme ${configuredTheme} is unavailable`, "warning"); }
    const uiBinding = bindInteractiveRuntimeUi(
      this.#terminal,
      session.extensionRunner,
      this.#runtime.cwd,
      () => this.#commandItems(session),
      {
        settings: session.settingsManager,
        themePath: (name) => {
          try {
            return session.resourceLoader.getThemes().themes.find((theme) => theme.name === name)?.sourcePath;
          } catch {
            return undefined;
          }
        },
      },
      session.toolRendererBinding(),
      { publishCommandInputs: !sessionStartOnly },
    );
    this.#uiBinding = uiBinding;
    this.#boundSession = session;
    const extensionBindings = {
      mode: "tui" as const,
      uiContext: uiBinding.uiContext,
      commandContextActions: this.#commandActions(session),
      abortHandler: () => { void session.abort("Cancelled by extension"); },
      shutdownHandler: () => this.stop(),
      onError: (error: { extensionPath: string; error: string }) => {
        this.showError(`${error.extensionPath}: ${error.error}`);
      },
    };
    if (start) {
      const bindingAbort = new AbortController();
      this.#sessionBindingAbort = bindingAbort;
      try {
        await session.bindExtensions(extensionBindings, bindingAbort.signal);
      } catch (error) {
        if (bindingAbort.signal.aborted && this.#uiBinding !== uiBinding) return;
        throw error;
      }
      if (this.#uiBinding !== uiBinding) {
        if (uiBinding.dispose()) session.clearExtensionBindings();
        return;
      }
      uiBinding.restoreDirectContext();
    } else session.updateExtensionBindings(extensionBindings);
    if (sessionStartOnly) return;
    let presentationActive = true;
    const presentationTerminal: InteractiveSessionPresentationTerminal = {
      render: (event) => { if (presentationActive) this.#terminal.render(event); },
      renderSessionEntry: (entry) => { if (presentationActive) this.#terminal.renderSessionEntry(entry); },
      replaceTranscript: (items, branch, options) => {
        if (presentationActive) this.#terminal.replaceTranscript(items, branch, options);
      },
      setUsageBaseline: (usage, latestCacheHitRate, latestCacheUsage, reportedUsage) => {
        if (presentationActive) {
          this.#terminal.setUsageBaseline(
            usage,
            latestCacheHitRate,
            latestCacheUsage,
            reportedUsage,
          );
        }
      },
    };
    const unsubscribePresentation = bindInteractiveSessionPresentation(session, presentationTerminal, {
      onEnvelope: () => {
        if (presentationActive) this.#updateContext(session, false);
      },
      onSessionEvent: (event) => {
        if (presentationActive) this.#updateContext(session, event.type === "entry_appended");
      },
      preserveTranscript,
    });
    this.#unsubscribe = () => {
      presentationActive = false;
      unsubscribePresentation();
    };
    this.#terminal.setCommandItems(this.#commandItems(session));
    this.#updateContext(session);
    void this.#maybeWarnAboutAnthropicApiBearerBilling(session);
  }

  async #prepareBoundSession(session: AgentSession): Promise<void> {
    const signal = this.#sessionBindingAbort?.signal;
    this.#pendingSessionPreparation = session;
    if (session.suspendedRun !== undefined) {
      this.#terminal.setInputBlocked("Recovering interrupted operation...", "recovery");
      try {
        await this.#sessionOperations.recoverAtStartup(signal);
      } finally {
        this.#terminal.setInputBlocked();
      }
    }
    await this.#completePendingSessionPreparation(session, signal);
  }

  async #completePendingSessionPreparation(session: AgentSession, signal?: AbortSignal): Promise<void> {
    if (this.#pendingSessionPreparation !== session || session.suspendedRun !== undefined) return;
    await this.#options.prepareSession?.(session, signal);
    if (this.#pendingSessionPreparation === session) this.#pendingSessionPreparation = undefined;
  }

  #unbindSession(clearExtensionBindings = true): void {
    this.#unsubscribe();
    this.#unsubscribe = (): void => undefined;
    this.#sessionBindingAbort?.abort(new Error("Interactive session binding disposed"));
    this.#sessionBindingAbort = undefined;
    const owned = this.#uiBinding?.dispose() ?? false;
    this.#uiBinding = undefined;
    const session = this.#boundSession;
    this.#boundSession = undefined;
    if (owned && clearExtensionBindings) session?.clearExtensionBindings();
  }

  #updateContext(session: AgentSession = this.#runtime.session, includeContextUsage = true): void {
    if (this.#closed) return;
    const recoveryPending = !session.isStreaming && session.suspendedRun !== undefined;
    const active = this.#activePromptAbort !== undefined
      || (!session.isIdle && !recoveryPending)
      || this.#operationAborts.size > 0;
    this.#terminal.setQueuedMessages(session.getQueuedMessages());
    this.#terminal.setSteering(!active
      ? undefined
      : (line, images, recovered) => {
          if (classifyActiveSubmission(line).kind === "cancel") {
            void this.#cancelActiveRun("Cancelled by user")
              .catch((error) => this.#reportError(error));
            return;
          }
          const blocks = [
            ...(inputImages(images) ?? []),
            ...(recovered ?? []).map((image) => ({ ...image })),
          ];
          if (this.#operationAborts.size > 0) {
            return this.#dispatchInteractiveSubmission(line, blocks, {
              text: line,
              ...optionalProperties(images === undefined ? undefined : { images }),
              ...optionalProperties(recovered === undefined ? undefined : { recoveredImages: recovered }),
            });
          }
          const operation = this.#actionTail
            .then(async () => await this.#dispatchInteractiveSubmission(line, blocks, {
              text: line,
              ...optionalProperties(images === undefined ? undefined : { images }),
              ...optionalProperties(recovered === undefined ? undefined : { recoveredImages: recovered }),
            }));
          this.#actionTail = operation.catch(() => undefined);
          return operation;
        });
    this.#terminal.setContext(createInteractiveTuiContext(
      session,
      this.#runtime.cwd,
      session.sessionName,
      active,
      {
        includeContextUsage,
        operationOnly: this.#operationAborts.size > 0 && session.isIdle,
      },
    ));
  }

  async #refreshModels(options: { force?: boolean; allowNetwork?: boolean; signal?: AbortSignal } = {}) {
    const session = this.#runtime.session;
    await session.modelRegistry.refresh({
      force: options.force ?? true,
      allowNetwork: options.allowNetwork ?? true,
      ...optionalProperties(options.signal === undefined ? undefined : { signal: options.signal }),
    });
    options.signal?.throwIfAborted();
    return this.#applyAvailableModels();
  }

  #applyAvailableModels(session: AgentSession = this.#runtime.session) {
    const models = session.modelRegistry.getAvailable()
      .filter((model) => session.isModelInScope(model.provider, model.id));
    const items = models.map(modelItem).sort((left, right) => left.label.localeCompare(right.label));
    this.#terminal.setModelPickerItems(items);
    this.#terminal.setModelPickerEmptyMessage(items.length === 0
      ? session.modelRegistry.getError() ?? "No authenticated models are currently available"
      : undefined);
    return { models, items };
  }

  #startModelRefresh(options: { force?: boolean; allowNetwork?: boolean } = {}): (() => void) | undefined {
    if (this.#modelRefresh !== undefined || this.#closed) return undefined;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
    this.#terminal.setModelPickerLoading(true);
    const operation = this.#refreshModels({ ...options, signal }).then(() => undefined, (error) => {
      if (!signal.aborted) this.#reportError(error);
    }).finally(() => {
      if (this.#modelRefresh?.controller !== controller) return;
      this.#modelRefresh = undefined;
      if (!this.#closed) this.#terminal.setModelPickerLoading(false);
    });
    this.#modelRefresh = { controller, operation };
    return () => controller.abort(new Error("Model picker closed"));
  }

  async #refresh(signal?: AbortSignal): Promise<void> {
    this.#terminal.setInputBlocked(`Refreshing ${REFRESH_RESOURCE_SUMMARY}...`, "refresh");
    try {
      const session = this.#runtime.session;
      if (this.#options.refreshSession !== undefined) {
        const operationSignal = signal ?? new AbortController().signal;
        this.#refreshSessionRebind = true;
        let result: { warnings?: readonly string[] };
        try {
          result = await this.#options.refreshSession(
            session,
            operationSignal,
            async (refreshedSession) => { await this.#bindSession(false, refreshedSession, true, true); },
          );
        } finally {
          this.#refreshSessionRebind = false;
        }
        operationSignal.throwIfAborted();
        await this.#refreshModels({ force: false, allowNetwork: false, signal: operationSignal });
        const warnings = result.warnings ?? [];
        this.#terminal.notify(
          warnings.length === 0 ? `Refreshed ${REFRESH_RESOURCE_SUMMARY}` : warnings.join("\n"),
          warnings.length === 0 ? "status" : "warning",
        );
        await this.#maybeWarnAboutAnthropicApiBearerBilling();
        return;
      }
      let refreshedKeybindings: ConfiguredKeybindings | undefined;
      await session.refresh({
        ...optionalProperties(signal === undefined ? undefined : { signal }),
        validateSettings: async (settings) => {
          const candidate = SettingsManager.inMemory(settings);
          candidate.getToolSettings();
          refreshedKeybindings = parseKeybindings(candidate.getKeybindings());
        },
        beforeSessionStart: async () => {
          if (refreshedKeybindings === undefined) throw new Error("Refreshed keybindings were not validated");
          this.#keybindings = refreshedKeybindings;
          this.#terminal.setKeybindings(this.#keybindings);
          await this.#bindSession(false);
        },
      });
      this.#uiBinding?.restoreDirectContext();
      await this.#refreshModels({ force: false, allowNetwork: false });
      this.#terminal.notify(`Refreshed ${REFRESH_RESOURCE_SUMMARY}`);
      await this.#maybeWarnAboutAnthropicApiBearerBilling();
    } finally {
      this.#terminal.setInputBlocked();
    }
  }

  async #login(argument: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const registry = this.#runtime.session.modelRegistry;
    const models = registry.models();
    const requested = argument.trim();
    let provider = requested === "" ? undefined : models.getProvider(requested);
    let path: ProviderLoginPath | undefined;
    if (provider === undefined && requested !== "") throw new Error(`Unknown provider: ${requested}`);
    if (provider === undefined) {
      const available = (["subscription", "api_key"] as const).map((value) => ({
        value,
        candidates: models.getProviders().filter((entry) =>
          providerLoginMethods(entry.auth).some((method) => method.path === value)),
      })).filter((entry) => entry.candidates.length > 0);
      if (available.length === 0) throw new Error("No interactive login is registered");
      path = available.length === 1
        ? available[0]!.value
        : await this.#terminal.choose("Select authentication method", available.map(({ value }) => ({
            label: value === "subscription"
              ? "Use a subscription or provider account"
              : "Use a key, token, or local credentials",
            value,
          })), signal);
      const candidates = available.find((entry) => entry.value === path)?.candidates;
      if (candidates === undefined) throw new Error("The selected login method is no longer available");
      provider = await this.#terminal.choose("Select provider", candidates.map((entry) => ({
        label: entry.name,
        detail: entry.id,
        value: entry,
      })), signal);
    }
    const methods = providerLoginMethods(provider.auth).filter((method) => path === undefined || method.path === path);
    if (methods.length === 0) throw new Error(`${provider.name} does not expose an interactive login method`);
    const method = methods.length === 1 ? methods[0]! : await this.#terminal.choose(`Connect ${provider.name}`, methods.map((entry) => ({
      label: entry.label,
      value: entry,
    })), signal);
    await models.login(provider.id, method.type, {
      signal,
      prompt: async (prompt) => {
        const selectedSignal = prompt.signal ?? signal;
        if (prompt.type === "secret") return await this.#terminal.readSecret(`${prompt.message}: `, selectedSignal);
        if (prompt.type === "manual_code") return await this.#terminal.readSecret(prompt.message, selectedSignal);
        if (prompt.type === "select") {
          return await this.#terminal.choose(prompt.message, prompt.options.map((entry) => ({
            label: entry.label,
            ...optionalProperties(entry.description === undefined ? undefined : { detail: entry.description }),
            value: entry.id,
          })), selectedSignal);
        }
        return await this.#terminal.question(prompt.message, selectedSignal);
      },
      notify: (event) => {
        if (event.type === "auth_url") this.#terminal.notify(`${event.instructions ?? "Open this URL to sign in:"}\n${event.url}`);
        else if (event.type === "device_code") this.#terminal.notify(`Open ${event.verificationUri} and enter code ${event.userCode}`);
        else {
          const links = event.links?.map((link) => `${link.label ?? link.url}: ${link.url}`).join("\n");
          this.#terminal.notify(links === undefined ? event.message : `${event.message}\n${links}`);
        }
      },
    });
    signal.throwIfAborted();
    await this.#refreshModels({ signal });
    signal.throwIfAborted();
    this.#terminal.notify(`Connected ${provider.name}. Use /model to choose a model.`);
    await this.#maybeWarnAboutAnthropicApiBearerBilling();
  }

  async #logout(argument: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const models = this.#runtime.session.modelRegistry.models();
    const requested = argument.trim();
    const provider = requested || await (async () => {
      const available = (await Promise.all(models.getProviders().map(async (entry) => ({
        entry,
        auth: await models.checkAuth(entry.id),
      })))).filter((entry) => entry.auth !== undefined);
      signal.throwIfAborted();
      if (available.length === 0) throw new Error("No stored credentials are available to remove");
      return await this.#terminal.choose("Remove provider authentication", available.map(({ entry, auth }) => ({
        label: entry.name,
        ...optionalProperties(auth?.source === undefined ? undefined : { detail: auth.source }),
        value: entry.id,
      })), signal);
    })();
    signal.throwIfAborted();
    if (models.getProvider(provider) === undefined) throw new Error(`Unknown provider: ${provider}`);
    await models.logout(provider);
    signal.throwIfAborted();
    await this.#refreshModels({ signal });
    signal.throwIfAborted();
    this.#terminal.notify(`Signed out for ${provider}`);
  }

  #beginModelSelection(action?: ModelSelectionAction): ModelSelectionOwner {
    const generation = ++this.#modelSelectionGeneration;
    this.#modelSelectionAbort?.abort(new Error("A newer model selection started"));
    const controller = new AbortController();
    this.#modelSelectionAbort = controller;
    const owner = { generation, controller };
    if (action !== undefined) this.#modelSelectionOwners.set(action, owner);
    return owner;
  }

  #takeModelSelection(action: ModelSelectionAction): ModelSelectionOwner {
    const owner = this.#modelSelectionOwners.get(action) ?? this.#beginModelSelection();
    this.#modelSelectionOwners.delete(action);
    return owner;
  }

  #invalidateModelSelection(reason: Error): void {
    this.#modelSelectionGeneration += 1;
    this.#modelSelectionAbort?.abort(reason);
    this.#modelSelectionAbort = undefined;
  }

  async #chooseModel(
    argument: string,
    operationSignal: AbortSignal,
    thinkingLevel?: string,
    ownedSelection?: ModelSelectionOwner,
  ): Promise<void> {
    operationSignal.throwIfAborted();
    const selected = argument.trim();
    if (selected === "") {
      operationSignal.throwIfAborted();
      this.#applyAvailableModels();
      this.#terminal.openPicker("model", "Models");
      this.#startModelRefresh({ force: false, allowNetwork: false });
      return;
    }
    const owner = ownedSelection ?? this.#beginModelSelection();
    const signal = AbortSignal.any([operationSignal, owner.controller.signal]);
    const session = this.#runtime.session;
    const current = (): boolean =>
      this.#modelSelectionGeneration === owner.generation
      && this.#modelSelectionAbort === owner.controller
      && this.#runtime.session === session
      && !this.#closed
      && !signal.aborted;
    try {
      const requestedThinkingLevel = session.thinkingLevel;
      const model = await session.resolveModel(selected, { signal });
      if (!current()) return;
      await session.setModel(model);
      if (!current()) return;
      if (thinkingLevel !== undefined) session.setThinkingLevel(thinkingLevel, "set");
      if (!current()) return;
      session.settingsManager.setDefaultModelAndProvider(model.provider, model.id);
      await session.settingsManager.flush();
      if (!current()) return;
      this.#updateContext();
      const effectiveThinkingLevel = session.thinkingLevel;
      this.#terminal.notify(effectiveThinkingLevel === requestedThinkingLevel
        ? `Model ${model.provider}/${model.id}`
        : `Model ${model.provider}/${model.id} · thinking ${requestedThinkingLevel} → ${effectiveThinkingLevel}`);
      await this.#maybeWarnAboutAnthropicApiBearerBilling();
    } catch (error) {
      if (!current() || signal.aborted) return;
      throw error;
    } finally {
      if (this.#modelSelectionAbort === owner.controller) this.#modelSelectionAbort = undefined;
    }
  }

  async #selectModelItem(item: PickerItem, signal: AbortSignal, selection: ModelSelectionOwner): Promise<void> {
    const value = item.value;
    if (!isJsonObject(value) || !Check(STRING_VALUE, value.provider) || !Check(STRING_VALUE, value.model)) {
      throw new Error("Invalid model selection");
    }
    if (value.thinkingLevel !== undefined && !Check(STRING_VALUE, value.thinkingLevel)) {
      throw new Error("Invalid model thinking level");
    }
    await this.#chooseModel(`${value.provider}/${value.model}`, signal, value.thinkingLevel, selection);
  }

  #setThinking(argument: string): void {
    const session = this.#runtime.session;
    const level = applyInteractiveThinking(session, argument);
    if (argument.trim() === "") this.#terminal.notify(`Thinking: ${level}`);
    this.#updateContext();
  }

  async #showSettings(): Promise<void> {
    const session = this.#runtime.session;
    await this.#terminal.chooseSettings(
      interactiveSettingItems(session.settingsManager, session, this.#terminal.themeNames()),
      async (item, value) => {
        applyInteractiveSetting(item, value, session.settingsManager, session, this.#terminal);
        await session.settingsManager.flush();
        this.#terminal.setCommandItems(this.#commandItems(session));
        this.#updateContext();
      },
    );
    await this.#maybeWarnAboutAnthropicApiBearerBilling();
  }

  async #maybeWarnAboutAnthropicApiBearerBilling(session: AgentSession = this.#runtime.session): Promise<void> {
    await this.#anthropicApiBearerBillingWarning.maybeNotify({
      enabled: session.settingsManager.getWarnings().anthropicExtraUsage !== false,
      model: session.model,
      models: session.modelRegistry.models(),
      notify: (message) => this.#terminal.notify(message, "warning"),
    });
  }

  async #showChangelog(): Promise<void> {
    const content = await readPackageChangelog();
    this.#terminal.notify(content.trim() || "No changelog entries found");
  }

  #showResources(): void {
    this.#terminal.notify(renderInteractiveResourceReport(this.#runtime.session, this.#runtime.cwd));
  }

  #showHotkeys(): void { this.#terminal.notify(formatHotkeys(this.#keybindings)); }

  async #runShell(request: InteractiveShellRequest, signal: AbortSignal): Promise<void> {
    const session = this.#runtime.session;
    let presentation: InteractiveShellPresentation | undefined;
    const beginPresentation = (command: string): InteractiveShellPresentation => presentation ??= beginInteractiveShellPresentation({
      terminal: this.#terminal,
      threadId: session.sessionId,
      command,
      hidden: request.hidden,
    });
    try {
      const result = await runInteractiveShell({
        command: request.command,
        hidden: request.hidden,
        workspace: this.#runtime.cwd,
        host: session.extensionRunner.getRuntimeHost(),
        session,
        signal,
        onPrepared: beginPresentation,
        onChunk: (chunk) => beginPresentation(request.command).onChunk(chunk),
      });
      beginPresentation(request.command).complete(result);
    } catch (cause) {
      beginPresentation(request.command).fail(cause);
      throw cause;
    }
  }

  #actionImages(action: Extract<TuiAction, { type: "submit" | "steer" | "follow_up" }>): ImageBlock[] {
    return [
      ...(inputImages(action.images) ?? []),
      ...(action.recoveredImages ?? []).map((image) => ({ ...image })),
    ];
  }

  async #dispatchInteractiveSubmission(
    text: string,
    images: readonly ImageBlock[],
    draft: Parameters<typeof restoreInterruptedSubmission>[1],
  ): Promise<void> {
    const session = this.#runtime.session;
    await dispatchInteractiveSubmissionAfterInterruption({
      session,
      locallyInterruptedOperationId: this.#locallyInterruptedOperationId,
      clearLocalInterruptionMarker: () => { this.#locallyInterruptedOperationId = undefined; },
      ...optionalProperties(this.#sessionBindingAbort === undefined ? undefined : { signal: this.#sessionBindingAbort.signal }),
      text,
      draft,
      terminal: this.#terminal,
      canDispatchIdle: () => session.isIdle
        && this.#operationAborts.size === 0
        && this.#activePromptAbort === undefined,
      dispatchIdle: async () => await this.#coordinator.dispatchSubmission(text, images),
      dispatchActive: async () => await this.#dispatchActiveSubmission(text, images),
      updateContext: () => this.#updateContext(),
    });
  }

  async #dispatchActiveSubmission(text: string, images: readonly ImageBlock[]): Promise<void> {
    const session = this.#runtime.session;
    if (
      session.isIdle
      && this.#operationAborts.size === 0
      && this.#activePromptAbort === undefined
    ) {
      await this.#coordinator.dispatchSubmission(text, images);
      return;
    }
    const resourceRoute = text.trim().startsWith("/")
      ? resolveInteractiveResourceSlash(session, text, this.#extensionCatalog())
      : undefined;
    const classified = classifyActiveSubmission(text, { resourceCommand: resourceRoute !== undefined });
    if (classified.kind === "cancel") { await this.#cancelActiveRun("Cancelled by user"); return; }
    if (classified.kind === "reject") {
      this.#terminal.notify(`/${classified.command} is unavailable while work is active`, "warning");
      return;
    }
    if (classified.kind === "unknown") {
      this.#terminal.notify(`Unknown command: /${classified.command}`, "error");
      return;
    }
    if (classified.kind === "command") {
      if (this.#operationAborts.size > 0) {
        this.#terminal.notify("Another command is active; finish or cancel it before starting this command", "warning");
        return;
      }
      if (classified.interrupt) {
        const recovery = await interruptInteractiveRunForCommand({
          session,
          command: classified.text,
          terminal: this.#terminal,
          ...optionalProperties(this.#sessionBindingAbort === undefined ? undefined : { signal: this.#sessionBindingAbort.signal }),
          interrupt: async () => await this.#cancelActiveRun(`${classified.text} requested`),
        });
        if (recovery?.operationId === this.#locallyInterruptedOperationId) {
          this.#locallyInterruptedOperationId = undefined;
        }
      }
      await this.#coordinator.dispatchSlash(classified.text, images);
      this.#updateContext();
      return;
    }
    if (classified.kind === "resource") {
      if (this.#operationAborts.size > 0) {
        this.#terminal.notify("Another command is active; finish or cancel it before starting this command", "warning");
        return;
      }
      if (resourceRoute === undefined) {
        this.#terminal.notify("The command is no longer available", "error");
        return;
      }
      await this.#runOperation(async (signal) =>
        await dispatchActiveInteractiveResourceSlash(session, resourceRoute, images, signal));
      this.#updateContext();
      return;
    }
    if (classified.kind === "defer" || this.#operationAborts.size > 0) {
      const result = this.#deferredSubmissions.enqueue(classified.text, images, this.#submissionOrder++);
      if (!result.accepted) throw new Error(result.reason === "items"
        ? "Too many commands are waiting for the current turn to finish"
        : "Commands waiting for the current turn exceed the input byte limit");
      this.#terminal.notify("Command queued until the current turn finishes");
      return;
    }
    await deliverActiveSubmission(session, classified, images);
    this.#updateContext();
  }

  #abortOperations(reason: Error): boolean {
    if (this.#operationAborts.size === 0) return false;
    for (const controller of this.#operationAborts) controller.abort(reason);
    return true;
  }

  async #runOperation<T>(
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T | undefined> {
    const controller = new AbortController();
    this.#operationAborts.add(controller);
    this.#updateContext();
    try {
      const pending = Promise.resolve().then(async () => await operation(controller.signal));
      return await waitForInteractiveOperation(pending, controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) throw error;
      return undefined;
    } finally {
      this.#operationAborts.delete(controller);
      this.#updateContext();
      if (!this.#closed && this.#operationAborts.size === 0) await this.#drainDeferredSubmissions();
    }
  }

  async #drainDeferredSubmissions(): Promise<void> {
    if (this.#drainingDeferred || this.#operationAborts.size > 0 || !this.#runtime.session.isIdle) return;
    this.#drainingDeferred = true;
    try {
      while (
        this.#runtime.session.isIdle
        && this.#activePrompt === undefined
        && this.#operationAborts.size === 0
      ) {
        const next = this.#deferredSubmissions.shift();
        if (next === undefined) return;
        await this.#coordinator.dispatchSubmission(next.text, next.images);
      }
    } finally {
      this.#drainingDeferred = false;
    }
  }

  async #cancelActiveRun(reason: string): Promise<void> {
    const marker = localInterruptionMarker(this.#runtime.session);
    if (marker !== undefined) this.#locallyInterruptedOperationId = marker;
    if (this.#treeSummaryCancel !== undefined) {
      this.#treeSummaryCancel();
      this.#updateContext();
      return;
    }
    this.#activePromptAbort?.abort(new Error(reason));
    const operationActive = this.#abortOperations(new Error(reason));
    if (!this.#runtime.session.isIdle) {
      await restoreQueuedMessagesThenAbort(this.#runtime.session, this.#terminal, reason);
    } else if (!operationActive) {
      await this.#runtime.session.abort(reason);
    }
    this.#updateContext();
  }

  #dequeueMessage(): void {
    const restored = restoreAllQueuedMessages(this.#runtime.session, this.#terminal);
    if (restored === 0) this.#terminal.notify("The editor queue is empty");
    else this.#terminal.notify(`Returned ${restored} queued message${restored === 1 ? "" : "s"} to the editor`);
    this.#updateContext();
  }

  async #preparePromptPayload(
    text: string,
    images: readonly ImageBlock[],
    session: AgentSession,
    signal: AbortSignal,
  ): Promise<{ text: string; images: readonly ImageBlock[] }> {
    const selected = text.trim();
    if (this.#options.preparePrompt === undefined) return { text: selected, images };
    const prepared = await this.#options.preparePrompt(selected, images, session, signal);
    signal.throwIfAborted();
    return { text: prepared.text, images: [...prepared.images] };
  }

  async #submitPrompt(text: string, images: readonly ImageBlock[] = []): Promise<void> {
    const selected = text.trim();
    if (selected === "") return;
    if (this.#activePromptAbort !== undefined) throw new Error("A prompt is already active");
    const session = this.#runtime.session;
    const controller = new AbortController();
    this.#activePromptAbort = controller;
    const bindingSignal = this.#sessionBindingAbort?.signal;
    const signal = bindingSignal === undefined
      ? controller.signal
      : AbortSignal.any([controller.signal, bindingSignal]);
    const operation = (async (): Promise<void> => {
      try {
        const prepared = await this.#preparePromptPayload(selected, images, session, signal);
        signal.throwIfAborted();
        await this.#options.preparePromptModel?.(session, this.#terminal, signal);
        signal.throwIfAborted();
        const promptOptions = this.#options.promptOptions?.(session) ?? {};
        await session.prompt(prepared.text, {
          ...promptOptions,
          ...optionalProperties(prepared.images.length === 0 ? undefined : { images: prepared.images }),
          source: "interactive",
          signal,
        });
      } catch (error) {
        if (!signal.aborted) throw error;
      }
    })().finally(() => {
      if (this.#activePromptAbort === controller) this.#activePromptAbort = undefined;
      if (this.#activePrompt === operation) this.#activePrompt = undefined;
      this.#updateContext();
      void this.#drainDeferredSubmissions().catch((error) => this.#reportError(error));
    });
    this.#activePrompt = operation;
    this.#updateContext();
    await operation;
  }

  #startPrompt(text: string, images?: ImageBlock[]): void {
    void this.#submitPrompt(text, images).catch((error) => this.#reportError(error));
  }

  #resolveUserInput(text: string): boolean {
    const pending = this.#pendingUserInputs.shift();
    if (pending === undefined) return false;
    pending.resolve(text);
    return true;
  }

  #reportError<Value>(error: Value): void {
    if (this.#closed) return;
    this.showError(errorMessage(error));
  }
}
