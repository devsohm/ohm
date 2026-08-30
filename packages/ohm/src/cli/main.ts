import { optionalProperties } from "../core/optional-properties.js";
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { isProxy } from "node:util/types";

import {
  authorizeAnthropic,
  authorizeGitHubCopilot,
  authorizeOAuthRegistration,
  authorizeOpenAICodex,
  assertCredentialProfileName,
  configuredOAuthClientId,
  configuredGitHubCopilotHost,
  createOpenRouterLoopback,
  type ProviderAuthMethod,
  type ProviderAuthRegistry,
  type ProviderAuthState,
} from "../auth/index.js";
import { defaultSecretRedactor } from "../auth/redaction.js";
import { hasAsciiControl, hasBidiControl, isStringValue } from "../auth/validation.js";
import { TrustStore } from "../config/trust.js";
import { errorMessage } from "../core/errors.js";
import { SettingsManager } from "../core/settings-manager.js";
import type { ImageBlock, ModelInfo, ProviderAdapter, ProviderId } from "../core/types.js";
import {
  modelCacheReadPrice,
  normalizeModelReasoningEffort,
  type ModelReasoningEffort,
  type ProviderRegistry,
} from "../providers/index.js";
import { providerModelFromInfo, providerModelToInfo } from "../providers/internal-runtime-bridge.js";
import { providerLoginMethods, type ProviderLoginPath } from "../providers/login-path.js";
import {
  withGracefulTermination,
  type GracefulTerminationContext,
} from "../process/graceful-termination.js";
import type { ExtensionError, InlineExtension } from "../extensions/direct.js";
import type { RuntimeCommandUi } from "../extensions/runtime.js";
import { SessionManager } from "../storage/session-manager.js";
import { exportSessionFile } from "../storage/session-export.js";
import {
  AgentSessionRuntime,
  type AgentSessionRuntimeServices,
  type SessionStartEvent as RuntimeSessionStartEvent,
} from "../service/agent-session-runtime.js";
import type { AgentSession } from "../service/agent-session.js";
import { createAgentSessionRuntimeCommandActions } from "../service/runtime-command-actions.js";
import {
  byteTruncate,
  ConfiguredKeybindings as Keybindings,
  createInteractiveDirectUiContext,
  parseKeybindings,
  sanitizeTerminalText,
  TuiController,
  type KeybindingAction,
  type PickerItem,
  type TuiAction,
  type TuiInputImageAttachment,
} from "../tui/index.js";
import { createRichTuiController } from "../tui/rich-frame-projector.js";
import {
  isErrorValue,
  isFunctionValue,
  isNumberValue,
  isObjectValue,
  isRecordValue,
} from "../tui/value-guards.js";
import {
  TerminalController,
  type TerminalChoice,
  type TerminalPrompter,
} from "../interfaces/terminal.js";
import { writeMachineOutput } from "../interfaces/output-guard.js";
import { InteractiveCommandCoordinator } from "../modes/interactive-command-coordinator.js";
import { interactiveSkillCommands } from "../modes/interactive-command-items.js";
import {
  bindInteractiveRuntimeUi,
  createInteractiveRuntimeCommandUi,
  type InteractiveRuntimeUiBinding,
} from "../modes/interactive-runtime-ui.js";
import { applyInteractiveThinking } from "../modes/interactive-thinking.js";
import {
  dispatchActiveInteractiveResourceSlash,
  resolveInteractiveResourceSlash,
} from "../modes/interactive-resource-commands.js";
import {
  dispatchInteractiveSubmissionAfterInterruption,
  interruptInteractiveRunForCommand,
  localInterruptionMarker,
  restoreInterruptedSubmission,
} from "../modes/interactive-interruption-recovery.js";
import { createInteractiveTuiContext } from "../modes/interactive-tui-context.js";
import { recoverNonInteractiveSession } from "../modes/noninteractive-recovery.js";
import { formatExtensionError, projectExtensionError, type ProjectedExtensionError } from "../modes/extension-error.js";
import {
  captureOneShotAssistantBoundary,
  latestOneShotAssistant,
  type OneShotAssistantMessage,
} from "../modes/one-shot-assistant.js";
import {
  restoreAllQueuedMessages,
  restoreQueuedMessagesThenAbort,
} from "../modes/interactive-queue.js";
import { beginInteractiveShellPresentation, runInteractiveShell } from "../modes/interactive-shell.js";
import { InteractiveSessionOperations, parseInteractivePathArgument } from "../modes/interactive-session-operations.js";
import { attachClipboardImage } from "../modes/interactive-terminal-actions.js";
import { REFRESH_RESOURCE_SUMMARY, renderInteractiveCommandHelp } from "../interactive/commands.js";
import { renderInteractiveResourceReport } from "../interactive/resource-report.js";
import { AnthropicApiBearerBillingWarning } from "../interactive/anthropic-warning.js";
import { bindInteractiveSessionPresentation } from "../interactive/session-presentation.js";
import { presentStartupChangelog, readPackageChangelog } from "../modes/startup-changelog.js";
import {
  applyInteractiveSetting,
  interactiveSettingItems,
  tuiOperatorPreferences,
} from "./interactive-settings.js";
import {
  BoundedDeferredSubmissionQueue,
  classifyActiveSubmission,
  deliverActiveSubmission,
} from "./active-submission.js";
import { resolveAgentCliMode } from "./invocation-mode.js";
import { installInteractiveEmergencyRecovery } from "./interactive-emergency.js";
import { resolveRequestedModel } from "./model-resolution.js";
import { combinePromptImages, expandPromptReferences } from "./prompt-input.js";
import { parseArgs, type Args } from "./args.js";
import { runCompletionsCommand } from "./completions.js";
import { CLI_HELP_TOPICS } from "./metadata.js";
import {
  findLeadingManagementCommand,
  flagBoolean,
  flagString,
  flagStrings,
  parseManagementArguments,
  type ManagementArguments,
} from "./management-args.js";
import { loadRuntime, preactivateProjectTrustExtensions, type LoadedRuntime } from "./runtime.js";
import { persistDefaultSelection } from "./setup.js";
import { renderCliHelp } from "./help.js";
import { runRpcServer } from "./rpc.js";
import { runDiagnosticsCommand } from "./diagnostics-command.js";
import { runLogsCommand } from "./logs-command.js";
import { runStatsCommand } from "./stats-command.js";
import { runExtensionsCommand, runPackageCommand, runPackageConfigCommand, runProjectPackageCommand } from "./extensions-command.js";
import { runProductInstallAction } from "./product-install.js";
import { runSessionsCommand } from "./sessions-command.js";
import { runServeCommand } from "./serve-command.js";
import { createStartupSession, resolveStartupSessionDirectory, validateSessionFlags } from "./session-startup.js";
import { selectStartupSession } from "./session-picker.js";
import { ThemeHotRefresher } from "./theme-hot-refresh.js";
import { applyRuntimeExtensionFlags } from "./extension-flags.js";
import { agentPaths, expandPath } from "./paths.js";
import { ProjectTrustResolver } from "./project-trust.js";
import { OHM_VERSION } from "../version.js";
import { defaultTools, selectedTools } from "./tool-selection.js";
import { escapeTerminal } from "../tools/output.js";
import { runSettingsConfigCommand } from "./config-settings-command.js";
import { ohmCompactSignature, ohmTerminalLockup } from "../tui/brand.js";
import type { ToolAuthorizationHandler } from "../tools/approval.js";

export { defaultTools, selectedTools };

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
    const reject = <Failure>(error: Failure): void => settle(() => rejectOperation(error));
    operation.then(
      (value) => settle(() => resolveOperation(value)),
      reject,
    );
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

class ScopedTrustPrompter implements TerminalPrompter {
  async question(prompt: string, signal?: AbortSignal): Promise<string> {
    const terminal = new TerminalController();
    try { return await terminal.question(prompt, signal); }
    finally { terminal.close(); }
  }

  async choose<T>(prompt: string, choices: TerminalChoice<T>[], signal?: AbortSignal): Promise<T> {
    const terminal = new TerminalController();
    try { return await terminal.choose(prompt, choices, signal); }
    finally { terminal.close(); }
  }

  async chooseToggle<T>(
    prompt: string,
    choices: TerminalChoice<T>[],
    options?: { initialIndex?: number; signal?: AbortSignal },
  ): Promise<T> {
    const terminal = new TerminalController();
    try { return await terminal.chooseToggle(prompt, choices, options); }
    finally { terminal.close(); }
  }
}

interface InvocationTrustOptions {
  workspace: string;
  override?: boolean;
  terminal?: TerminalPrompter;
  extensions: boolean;
  extensionPaths: readonly string[];
  extensionFactories: readonly InlineExtension[];
}

async function createInvocationTrustResolver(options: InvocationTrustOptions): Promise<ProjectTrustResolver> {
  const paths = agentPaths();
  const settings = SettingsManager.create(resolve(options.workspace), paths.agentDirectory, { projectTrusted: false });
  await settings.refresh();
  return new ProjectTrustResolver(new TrustStore(paths.trustStore), {
    ...optionalProperties(options.override === undefined ? undefined : { override: options.override ? "approve" : "deny" }),
    ...optionalProperties(options.terminal === undefined ? undefined : { terminal: options.terminal }),
    defaultProjectTrust: settings.getDefaultProjectTrust(),
    cwd: process.cwd(),
    agentDirectory: paths.agentDirectory,
    preactivate: async (workspace) => await preactivateProjectTrustExtensions(paths, workspace, {
      extensions: options.extensions,
      extensionPaths: options.extensionPaths,
      extensionFactories: options.extensionFactories,
      extensionRuntime: true,
    }),
  });
}

export interface ModelSelection {
  provider: ProviderId;
  model: string;
  reasoningEffort?: ModelReasoningEffort;
}

export interface InteractiveModelReference {
  provider: ProviderId | undefined;
  model: string | undefined;
}

function pickerModelSelection<Value>(value: Value): ModelSelection {
  if (!isRecordValue(value)) throw new Error("The selected model is invalid");
  const provider = value["provider"];
  const model = value["model"];
  const requestedEffort = value["reasoningEffort"];
  if (!isStringValue(provider) || !isStringValue(model)) {
    throw new Error("The selected model is invalid");
  }
  if (requestedEffort !== undefined && !isStringValue(requestedEffort)) {
    throw new Error("The selected model thinking level is invalid");
  }
  const reasoningEffort = requestedEffort === undefined
    ? undefined
    : normalizeModelReasoningEffort(requestedEffort);
  return {
    provider,
    model,
    ...optionalProperties(reasoningEffort === undefined ? undefined : { reasoningEffort }),
  };
}

export function parseInteractiveModelReference(
  reference: string | undefined,
  provider: ProviderId | undefined,
  providers: readonly string[],
): InteractiveModelReference {
  if (reference === undefined) return { provider, model: undefined };
  const separator = reference.indexOf("/");
  if (separator <= 0 || separator === reference.length - 1) return { provider, model: reference };
  const candidate = reference.slice(0, separator);
  return providers.includes(candidate)
    ? { provider: candidate, model: reference.slice(separator + 1) }
    : { provider, model: reference };
}

export const DEFAULT_MODEL_PER_PROVIDER: Readonly<Record<string, string>> = Object.freeze({
  openai: "gpt-5.6-sol",
  "openai-codex": "gpt-5.6-sol",
  anthropic: "claude-opus-5",
  gemini: "gemini-3.6-flash",
  openrouter: "moonshotai/kimi-k2.6",
  xai: "grok-4.5",
  deepseek: "deepseek-v4-pro",
  opencode: "kimi-k2.6",
  "opencode-go": "gpt-5.6-luna",
});

export function selectDefaultModelAfterLogin(
  provider: ProviderId,
  models: readonly Pick<ModelInfo, "id" | "provider">[],
  configured?: ModelSelection,
  active?: ModelSelection,
): ModelSelection | undefined {
  if (active !== undefined) return undefined;
  const preferred = configured?.provider === provider ? configured.model : DEFAULT_MODEL_PER_PROVIDER[provider];
  return preferred !== undefined && models.some((model) => model.provider === provider && model.id === preferred)
    ? { provider, model: preferred }
    : undefined;
}

export function isAgentOpenAIModel(modelId: string): boolean {
  const id = modelId.trim().toLowerCase();
  if (id === "" || /^(?:babbage|davinci)(?:-|$)/u.test(id) || /^text-(?:babbage|davinci)(?:-|$)/u.test(id)) return false;
  if (/^gpt-3\.5(?:-|$)/u.test(id) || /^gpt-4(?:$|-(?:\d|turbo))/u.test(id)) return false;
  if (id.startsWith("dall-e-") || id.startsWith("gpt-image-") || id.startsWith("chatgpt-image-")) return false;
  return !/(?:^|[-_.])(?:embedding|image|audio|realtime|transcribe|transcription|tts|whisper|moderation|search)(?:[-_.]|$)/u.test(id);
}

export interface ProviderModelCatalogStatus {
  provider: string;
  status: "available" | "unverified" | "empty" | "disconnected" | "authentication" | "network" | "timeout" | "unavailable";
  authStatus?: ProviderAuthState["status"];
  authSource?: ProviderAuthState["source"];
}

export function modelCatalogEmptyMessage(statuses: readonly ProviderModelCatalogStatus[]): string | undefined {
  const unavailable = statuses.filter((entry) =>
    entry.authStatus === "connected" && entry.authSource !== "local" &&
    entry.status !== "available" && entry.status !== "authentication");
  if (unavailable.length === 0) return undefined;
  const shown = unavailable.slice(0, 6).map((entry) => `${byteTruncate(sanitizeTerminalText(entry.provider), 96)} (${entry.status})`);
  return `Connected provider catalogs are unavailable: ${shown.join(", ")}${unavailable.length > shown.length ? `, +${unavailable.length - shown.length} more` : ""}. Retry /model or /refresh; use /login only to change credentials.`;
}

export function classifyModelCatalogFailure<Failure>(error: Failure): "authentication" | "network" | "timeout" | "unavailable" {
  const objectError = isObjectValue(error) && !isProxy(error);
  const prototype = objectError ? Object.getPrototypeOf(error) : undefined;
  const categoryDescriptor = objectError && (
    isErrorValue(error) || prototype === Object.prototype || prototype === null
  ) ? Object.getOwnPropertyDescriptor(error, "category")
    : undefined;
  const category = categoryDescriptor !== undefined && "value" in categoryDescriptor && isStringValue(categoryDescriptor.value)
    ? categoryDescriptor.value
    : undefined;
  if (category === "authentication" || category === "permission") return "authentication";
  if (category === "timeout" || category === "cancelled") return "timeout";
  if (category === "network") return "network";
  const message = errorMessage(error);
  if (/(?:unauthori[sz]ed|forbidden|credential|api[ _-]?key|access token|\b401\b|\b403\b)/iu.test(message)) return "authentication";
  if (/(?:timed? ?out|abort)/iu.test(message)) return "timeout";
  if (/(?:network|fetch failed|econn|enotfound|dns|socket)/iu.test(message)) return "network";
  return "unavailable";
}

function modelItem(model: ModelInfo): PickerItem<ModelSelection> {
  return {
    id: `${model.provider}\0${model.id}`,
    label: `${model.provider} / ${model.id}`,
    value: { provider: model.provider, model: model.id },
    keywords: [model.provider, model.id, model.displayName ?? "", model.description ?? ""],
    ...(() => {
      const detail = [model.displayName, model.description, model.contextTokens === undefined ? undefined : `${model.contextTokens.toLocaleString()} context`]
        .filter(Boolean).join(" · ");
      return detail === "" ? {} : { detail };
    })(),
  };
}

export interface ModelRefreshLease {
  signal: AbortSignal;
  current(): boolean;
  finish(): boolean;
}

export interface ModelRefreshOwner<Result> {
  begin(parentSignal: AbortSignal): ModelRefreshLease;
  currentNetwork(): Promise<Result> | undefined;
  trackNetwork(pending: Promise<Result>): void;
}

export function createModelRefreshOwner<Result = unknown>(): ModelRefreshOwner<Result> {
  let generation = 0;
  let active: AbortController | undefined;
  let network: Promise<Result> | undefined;
  return {
    begin(parentSignal) {
      generation += 1;
      const ownedGeneration = generation;
      active?.abort(new Error("Model refresh superseded"));
      const controller = new AbortController();
      active = controller;
      const signal = AbortSignal.any([parentSignal, controller.signal]);
      return {
        signal,
        current: () => ownedGeneration === generation && !signal.aborted,
        finish: () => {
          if (ownedGeneration !== generation) return false;
          if (active === controller) active = undefined;
          return true;
        },
      };
    },
    currentNetwork: () => network,
    trackNetwork(pending) {
      network = pending;
      const clear = () => { if (network === pending) network = undefined; };
      void pending.then(clear, clear);
    },
  };
}

export async function refreshModelPicker(
  providers: readonly Pick<ProviderAdapter, "id" | "listModels">[],
  terminal: Pick<TuiController, "setPickerItems" | "addPickerItems"> & Partial<Pick<TuiController,
    "setModelPickerItems" | "addModelPickerItems" | "setModelPickerLoading" | "notify">>,
  current: ModelSelection | undefined,
  signal: AbortSignal,
  auth?: Pick<ProviderAuthRegistry, "state">,
  onStatus?: (statuses: readonly ProviderModelCatalogStatus[]) => void,
  catalog?: Pick<ProviderRegistry, "listModels"> & Partial<Pick<ProviderRegistry, "catalogStatus">>,
  options: {
    refresh?: boolean;
    preservedModels?: readonly ModelInfo[];
    manageLoading?: boolean;
    modelFilter?: (model: ModelInfo) => boolean;
  } = {},
): Promise<ModelInfo[]> {
  type CatalogResult = {
    provider: ProviderId;
    models: ModelInfo[];
    authState?: ProviderAuthState;
    status: ProviderModelCatalogStatus["status"];
  };
  const loadCatalog = async (provider: Pick<ProviderAdapter, "id" | "listModels">): Promise<CatalogResult> => {
    let authState: ProviderAuthState | undefined;
    try {
      authState = await auth?.state(provider.id);
      const disconnected = authState !== undefined && (
        authState.status === "unavailable" ||
        (authState.status === "available" && (authState.source === undefined || authState.error !== undefined))
      );
      if (disconnected) return { provider: provider.id, models: [], ...optionalProperties(authState === undefined ? undefined : { authState }), status: "disconnected" };
      const catalogSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
      let models: ModelInfo[];
      if (catalog === undefined) models = options.refresh === false ? [] : await provider.listModels(catalogSignal);
      else {
        models = await catalog.listModels(provider.id, catalogSignal, { refresh: options.refresh !== false, verifiedOnly: true });
        const state = (await catalog.catalogStatus?.(provider.id))?.[0];
        if (options.refresh === false && state?.provenance === "persisted" && state.error === undefined) {
          models = await catalog.listModels(provider.id, catalogSignal, { refresh: false, verifiedOnly: false });
          return {
            provider: provider.id,
            models,
            ...optionalProperties(authState === undefined ? undefined : { authState }),
            status: models.length === 0 ? "empty" : "available",
          };
        }
        if (state?.provenance !== "live" || state.error !== undefined || state.stale) {
          return { provider: provider.id, models: [], ...optionalProperties(authState === undefined ? undefined : { authState }), status: classifyModelCatalogFailure(state?.error?.message) };
        }
      }
      return { provider: provider.id, models, ...optionalProperties(authState === undefined ? undefined : { authState }), status: models.length === 0 ? "empty" : "available" };
    } catch (error) {
      return { provider: provider.id, models: [], ...optionalProperties(authState === undefined ? undefined : { authState }), status: classifyModelCatalogFailure(error) };
    }
  };
  const pickerItems = (entry: CatalogResult): PickerItem<ModelSelection>[] => entry.status !== "available"
    ? []
    : entry.models
      .filter((model) => options.modelFilter?.(model) ?? true)
      .filter((model) => entry.provider !== "openai" || isAgentOpenAIModel(model.id))
      .map(modelItem);
  if (options.manageLoading !== false) terminal.setModelPickerLoading?.(true);
  try {
    const catalogs = await Promise.all(providers.map(async (provider) => {
      const result = await loadCatalog(provider);
      if (!signal.aborted && result.status === "available") {
        const available = pickerItems(result);
        if (terminal.addModelPickerItems !== undefined) terminal.addModelPickerItems(available);
        else terminal.addPickerItems("model", available);
      }
      return result;
    }));
    const discovered = catalogs
      .filter((entry) => entry.status === "available")
      .flatMap((entry) => entry.models)
      .filter((model) => options.modelFilter?.(model) ?? true);
    if (signal.aborted) return discovered;
    const statuses = catalogs.map((entry): ProviderModelCatalogStatus => ({
      provider: entry.provider,
      status: entry.status,
      ...optionalProperties(entry.authState === undefined ? undefined : { authStatus: entry.authState.status }),
      ...optionalProperties(entry.authState?.source === undefined ? undefined : { authSource: entry.authState.source }),
    }));
    onStatus?.(statuses);
    const unavailable = catalogs.filter((entry) => entry.status !== "available" && entry.status !== "disconnected" && (
      entry.provider === current?.provider || (current === undefined && entry.authState?.status === "connected" && entry.authState.source !== "local")
    ));
    if (unavailable.length > 0) terminal.notify?.(`Model catalogs: ${unavailable.map((entry) => `${entry.provider} (${entry.status})`).join(", ")}`, "warning");
    const authoritativeProviders = new Set(catalogs
      .filter((entry) => entry.status === "available" || entry.status === "empty" || entry.status === "disconnected")
      .map((entry) => entry.provider));
    const preserved = (options.preservedModels ?? [])
      .filter((model) => options.modelFilter?.(model) ?? true)
      .filter((model) => !authoritativeProviders.has(model.provider));
    const finalModels = new Map<string, ModelInfo>();
    for (const model of [...preserved, ...discovered]) {
      finalModels.set(`${model.provider}\0${model.id}`, model);
    }
    const availableModels = [...finalModels.values()];
    const allAvailable = availableModels
      .filter((model) => model.provider !== "openai" || isAgentOpenAIModel(model.id))
      .map(modelItem);
    const currentItem = current === undefined ? undefined : allAvailable.find((item) => item.value.provider === current.provider && item.value.model === current.model);
    const ordered = currentItem === undefined ? allAvailable.sort((left, right) => left.label.localeCompare(right.label)) : [currentItem, ...allAvailable.filter((item) => item !== currentItem).sort((left, right) => left.label.localeCompare(right.label))];
    if (terminal.setModelPickerItems !== undefined) terminal.setModelPickerItems(ordered);
    else terminal.setPickerItems("model", ordered);
    return availableModels;
  } finally {
    if (options.manageLoading !== false) terminal.setModelPickerLoading?.(false);
  }
}

const KEY_NAMES: Readonly<Record<string, string>> = Object.freeze({ escape: "Esc", enter: "Enter", tab: "Tab", space: "Space", backspace: "Backspace", delete: "Delete", up: "Up", down: "Down", left: "Left", right: "Right" });

export function displayKeybinding(value: string): string {
  return value.split("+").map((part) => KEY_NAMES[part] ?? (part.length === 1 ? part.toUpperCase() : part)).join("+");
}

function bindingHint(keybindings: Keybindings, action: KeybindingAction, maximum = 3): string {
  return keybindings.keys(action).slice(0, maximum).map(displayKeybinding).join("/");
}

export function formatHotkeys(keybindings: Keybindings): string {
  return [
    `${bindingHint(keybindings, "app.interrupt")} interrupt`,
    `${bindingHint(keybindings, "app.clear")} clear/exit`,
    `${bindingHint(keybindings, "app.exit")} exit`,
    "/ commands",
  ].filter((value) => !value.startsWith(" ")).join(" · ");
}

export interface StartupInventory {
  providers?: readonly string[];
  models?: readonly string[];
  extensions?: readonly string[];
  skills?: readonly string[];
  prompts?: readonly string[];
  themes?: readonly string[];
  instructions?: readonly string[];
  warnings?: readonly string[];
}

export function formatStartupReport(
  inventory: StartupInventory,
  workspace: string,
  keybindings = new Keybindings(),
  unicode = true,
): string {
  const loaded = [
    inventory.extensions?.length ? `${inventory.extensions.length} extensions` : undefined,
    inventory.skills?.length ? `${inventory.skills.length} skills` : undefined,
    inventory.prompts?.length ? `${inventory.prompts.length} prompts` : undefined,
  ].filter(Boolean).join(" · ");
  return [ohmTerminalLockup(OHM_VERSION, unicode), formatHotkeys(keybindings), `Workspace: ${workspace}`, loaded === "" ? undefined : `Loaded: ${loaded}`]
    .filter((value): value is string => value !== undefined).join("\n");
}

export function formatCompactStartupReport(
  inventory: StartupInventory,
  workspace: string,
  keybindings = new Keybindings(),
  unicode = true,
): string {
  const loaded = [
    inventory.extensions?.length ? `${inventory.extensions.length} extensions` : undefined,
    inventory.skills?.length ? `${inventory.skills.length} skills` : undefined,
    inventory.prompts?.length ? `${inventory.prompts.length} prompts` : undefined,
  ].filter(Boolean).join(" · ");
  return [ohmCompactSignature(OHM_VERSION, unicode), formatHotkeys(keybindings), `Workspace: ${workspace}`, loaded === "" ? undefined : `Loaded: ${loaded}`]
    .filter((value): value is string => value !== undefined).join("\n");
}

function shellArgument(value: string): string {
  return value !== "" && !/[^a-zA-Z0-9_\-./~:@]/u.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

export type ResumeSession = Pick<
  SessionManager,
  "getSessionDir" | "getSessionFile" | "getSessionId" | "isPersisted" | "usesDefaultSessionDir"
>;

export function formatResumeCommand(sessionManager: ResumeSession): string | undefined {
  if (process.stdout.isTTY !== true || !sessionManager.isPersisted()) return undefined;
  const sessionFile = sessionManager.getSessionFile();
  if (sessionFile === undefined || !existsSync(sessionFile)) return undefined;
  const argumentsValue = ["ohm"];
  if (!sessionManager.usesDefaultSessionDir()) {
    argumentsValue.push("--session-dir", shellArgument(sessionManager.getSessionDir()));
  }
  argumentsValue.push("--session", sessionManager.getSessionId());
  return argumentsValue.join(" ");
}

export { parseInteractivePathArgument };

export type LoginPath = ProviderLoginPath;

type InteractiveCliTerminal = Pick<
  TuiController,
  "choose" | "notify" | "question" | "readSecret"
>;

export interface InteractiveLoginRuntime {
  auth: Pick<
    LoadedRuntime["auth"],
    | "authorizeManaged"
    | "binding"
    | "has"
    | "loginMethods"
    | "profileState"
    | "registration"
    | "selectFallback"
    | "selectProfile"
    | "storeCredential"
  >;
  modelRegistry: Pick<
    LoadedRuntime["modelRegistry"],
    "getProvider" | "getProviderDisplayName" | "models" | "refresh"
  >;
  network: Pick<LoadedRuntime["network"], "fetch">;
  providers: Pick<LoadedRuntime["providers"], "list">;
}

export interface ModelPickerRuntime {
  providers: {
    refreshModels(
      provider: ProviderId,
      signal: AbortSignal,
    ): Promise<{ ok: true } | { ok: false; status: { error?: { message: string } } }>;
    listModels(
      provider: ProviderId | undefined,
      signal: AbortSignal,
      options?: { verifiedOnly?: boolean },
    ): Promise<Array<Pick<ModelInfo, "id">>>;
  };
}

export function authMethodLoginPath(method: ProviderAuthMethod): LoginPath {
  return ["oauth", "managed_oauth", "openrouter_browser", "openai_codex_browser", "openai_codex_device", "anthropic_browser", "github_copilot_device"].includes(method.kind)
    ? "subscription"
    : "api_key";
}

function managedAuthText<Value>(value: Value, label: string, maximum = 4_096): string {
  if (
    !isStringValue(value) || value === "" || Buffer.byteLength(value, "utf8") > maximum
    || hasAsciiControl(value) || hasBidiControl(value)
  ) throw new TypeError(`${label} is invalid`);
  return value;
}

function managedAuthUrl(value: string | URL): URL {
  const url = new URL(String(value));
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username !== "" || url.password !== "" || Buffer.byteLength(url.toString(), "utf8") > 16 * 1024
  ) throw new TypeError("Managed provider authorization URL is invalid");
  return url;
}

/** @internal Builds a shell-free browser launch so URL metacharacters stay data. */
export interface BrowserLaunch {
  command: string;
  args: string[];
}

export function browserLaunch(url: URL, platform: NodeJS.Platform = process.platform): BrowserLaunch {
  if (platform === "darwin") return { command: "open", args: [url.toString()] };
  if (platform === "win32") {
    return {
      command: "rundll32.exe",
      args: ["url.dll,FileProtocolHandler", url.toString()],
    };
  }
  return { command: "xdg-open", args: [url.toString()] };
}

interface ManualAuthorizationRequest {
  authorizationUrl: URL;
  redirectUri: string;
  state: string;
}

function openBrowser(url: URL, disabled: boolean): void {
  if (disabled) return;
  const { command, args } = browserLaunch(url);
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.once("error", () => undefined);
  child.unref();
}

/** @internal Shared ownership boundary: notification renders the URL; openUrl launches it once. */
export function createInteractiveAuthorizationUi(
  terminal: Pick<TuiController, "notify" | "readSecret">,
  noBrowser: boolean,
  launch: (url: URL, disabled: boolean) => void = openBrowser,
) {
  return {
    showAuthorization: ({ url, userCode }: { url: URL; userCode?: string }) => {
      terminal.notify(userCode === undefined
        ? `Open this URL to sign in:\n${url}`
        : `Open ${url} and enter code ${userCode}`);
    },
    openUrl: (url: URL) => launch(url, noBrowser),
    requestManualAuthorization: async (_value: ManualAuthorizationRequest, selectedSignal: AbortSignal) => {
      const answer = (
        await terminal.readSecret(
          "Paste the callback URL or authorization code, or press Enter to keep waiting: ",
          selectedSignal,
        )
      ).trim();
      return answer === "" ? undefined : answer;
    },
  };
}

async function loginProviderChoices(runtime: InteractiveLoginRuntime, path: LoginPath): Promise<Array<{ label: string; value: ProviderId }>> {
  const providerIds = new Set([
    ...runtime.providers.list().map((provider) => provider.id),
    ...runtime.modelRegistry.models().getProviders().map((provider) => provider.id),
  ]);
  return (await Promise.all([...providerIds].map(async (provider) => {
    const legacy = runtime.auth.has(provider)
      ? (await runtime.auth.loginMethods(provider)).some((method) => authMethodLoginPath(method) === path)
      : false;
    const direct = runtime.modelRegistry.getProvider(provider);
    const native = direct !== undefined && providerLoginMethods(direct.auth).some((method) => method.path === path);
    return legacy || native ? { label: runtime.modelRegistry.getProviderDisplayName(provider), value: provider } : undefined;
  }))).filter((value): value is NonNullable<typeof value> => value !== undefined);
}

async function loginDirectProvider(
  runtime: InteractiveLoginRuntime,
  terminal: InteractiveCliTerminal,
  provider: ProviderId,
  path: LoginPath,
  signal: AbortSignal | undefined,
  noBrowser: boolean,
): Promise<void> {
  const direct = runtime.modelRegistry.getProvider(provider);
  if (direct === undefined) throw new Error(`Unknown provider: ${provider}`);
  const methods = providerLoginMethods(direct.auth).filter((method) => method.path === path);
  if (methods.length === 0) throw new Error(`${provider} does not expose the selected login method`);
  const method = methods.length === 1
    ? methods[0]!
    : await terminal.choose(`Connect ${direct.name}`, methods.map((entry) => ({
        label: entry.label,
        value: entry,
      })), signal);
  await runtime.modelRegistry.models().login(provider, method.type, directAuthInteraction(
    terminal,
    signal,
    noBrowser,
  ));
  await runtime.modelRegistry.refresh({ force: true, ...optionalProperties(signal === undefined ? undefined : { signal }) });
}

function directAuthInteraction(
  terminal: InteractiveCliTerminal,
  signal: AbortSignal | undefined,
  noBrowser: boolean,
) {
  return {
    ...optionalProperties(signal === undefined ? undefined : { signal }),
    async prompt(prompt) {
      const selectedSignal = prompt.signal ?? signal;
      if (prompt.type === "secret") return await terminal.readSecret(`${prompt.message}: `, selectedSignal);
      if (prompt.type === "manual_code") return await terminal.readSecret(prompt.message, selectedSignal);
      if (prompt.type === "select") {
        return await terminal.choose(prompt.message, prompt.options.map((entry) => ({
          label: entry.label,
          ...optionalProperties(entry.description === undefined ? undefined : { detail: entry.description }),
          value: entry.id,
        })), selectedSignal);
      }
      return await terminal.question(prompt.message, selectedSignal);
    },
    notify(event) {
      if (event.type === "auth_url") {
        const url = new URL(event.url);
        terminal.notify(`${event.instructions ?? "Open this URL to sign in:"}\n${url}`);
        openBrowser(url, noBrowser);
      } else if (event.type === "device_code") {
        const url = new URL(event.verificationUri);
        terminal.notify(`Open ${url} and enter code ${event.userCode}`);
        openBrowser(url, noBrowser);
      } else {
        const links = event.links?.map((link) => `${link.label ?? link.url}: ${link.url}`).join("\n");
        terminal.notify(links === undefined ? event.message : `${event.message}\n${links}`);
      }
    },
  } satisfies Parameters<ReturnType<LoadedRuntime["modelRegistry"]["models"]>["login"]>[2];
}

type InteractiveLoginProfile =
  | { action: "authenticate"; profile?: string }
  | { action: "selected"; profile: string };

async function chooseInteractiveLoginProfile(
  runtime: InteractiveLoginRuntime,
  terminal: InteractiveCliTerminal,
  provider: ProviderId,
  signal?: AbortSignal,
): Promise<InteractiveLoginProfile> {
  signal?.throwIfAborted();
  let state: Awaited<ReturnType<LoadedRuntime["auth"]["profileState"]>>;
  try { state = await runtime.auth.profileState(provider); }
  catch { return { action: "authenticate" }; }
  if (state.profiles.length === 0) return { action: "authenticate" };
  const choices: Array<{ label: string; detail: string; value: InteractiveLoginProfile }> = state.profiles.flatMap((profile) => [
    ...(profile.present && profile.usable ? [{
      label: `Use saved profile ${profile.name}`,
      detail: profile.active ? "active · ready" : "ready",
      value: { action: "selected" as const, profile: profile.name },
    }] : []),
    {
      label: `Sign in again to profile ${profile.name}`,
      detail: profile.error ?? "Replace only this profile after authentication succeeds",
      value: { action: "authenticate" as const, profile: profile.name },
    },
  ]);
  const selected = await terminal.choose(`Credential profile for ${provider}`, [...choices, {
    label: "Add a new profile",
    detail: "Keep every existing profile",
    value: { action: "authenticate" as const },
  }], signal);
  if (selected.action === "selected") {
    signal?.throwIfAborted();
    await runtime.auth.selectProfile(provider, selected.profile);
    return selected;
  }
  if (selected.profile !== undefined) return selected;
  const profile = (await terminal.question("New credential profile name: ", signal)).trim();
  assertCredentialProfileName(profile);
  if (state.profiles.some((entry) => entry.name === profile)) throw new Error(`Credential profile already exists: ${profile}`);
  return { action: "authenticate", profile };
}

export async function pickModel(
  runtime: ModelPickerRuntime,
  provider: ProviderId,
  terminal: TerminalPrompter & Partial<Pick<TuiController, "notify">>,
  signal?: AbortSignal,
): Promise<string> {
  try {
    const catalogSignal = signal === undefined
      ? AbortSignal.timeout(30_000)
      : AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    const refresh = await runtime.providers.refreshModels(provider, catalogSignal);
    if (!refresh.ok) throw new Error(refresh.status.error?.message ?? "model discovery failed");
    const models = await runtime.providers.listModels(provider, catalogSignal, { verifiedOnly: true });
    const selectable = provider === "openai" ? models.filter((model) => isAgentOpenAIModel(model.id)) : models;
    if (selectable.length > 0) {
      return await terminal.choose(
        `Select ${provider} model`,
        selectable.map((model) => ({ label: model.id, value: model.id })),
        signal,
      );
    }
  } catch (error) {
    signal?.throwIfAborted();
    terminal.notify?.(`Could not load ${provider} models: ${errorMessage(error)}`, "warning");
  }
  signal?.throwIfAborted();
  const exact = (await terminal.question("Exact model/deployment ID: ", signal)).trim();
  if (exact === "") throw new Error("Model is required");
  return exact;
}

export async function loginInteractively(
  runtime: InteractiveLoginRuntime,
  terminal: InteractiveCliTerminal,
  requested?: string,
  signal?: AbortSignal,
  noBrowser = false,
): Promise<ProviderId> {
  let path: LoginPath | undefined;
  const provider = requested === undefined || requested === ""
    ? await (async () => {
        const available = (await Promise.all((["subscription", "api_key"] as const).map(async (value) => ({
          value,
          choices: await loginProviderChoices(runtime, value),
        })))).filter((entry) => entry.choices.length > 0);
        if (available.length === 0) throw new Error("No interactive login is registered");
        path = available.length === 1
          ? available[0]!.value
          : await terminal.choose("Select authentication method", available.map(({ value }) => ({
              label: value === "subscription"
                ? "Use a subscription or provider account"
                : "Use a key, token, or local credentials",
              value,
            })), signal);
        const choices = available.find((entry) => entry.value === path)?.choices;
        if (choices === undefined) throw new Error("The selected login method is no longer available");
        return await terminal.choose("Select provider", choices, signal);
      })()
    : requested;
  if (!runtime.auth.has(provider)) {
    const direct = runtime.modelRegistry.getProvider(provider);
    if (direct === undefined) throw new Error(`Unknown provider: ${provider}`);
    const methods = providerLoginMethods(direct.auth);
    const paths = [...new Set(methods.map((method) => method.path))];
    path ??= paths.length === 1
      ? paths[0]
      : await terminal.choose(`Connect ${direct.name}`, paths.map((value) => ({
          label: value === "subscription"
            ? "Use a subscription or provider account"
            : "Use a key, token, or local credentials",
          value,
        })), signal);
    if (path === undefined || !paths.includes(path)) throw new Error(`${provider} does not expose an interactive login method`);
    await loginDirectProvider(runtime, terminal, provider, path, signal, noBrowser);
    return provider;
  }
  const profile = await chooseInteractiveLoginProfile(runtime, terminal, provider, signal);
  if (profile.action === "selected") return provider;
  const storeOptions = {
    ...optionalProperties(profile.profile === undefined ? undefined : { profile: profile.profile, select: true }),
    ...optionalProperties(signal === undefined ? undefined : { signal }),
  };
  const available = await runtime.auth.loginMethods(provider);
  const paths = [...new Set(available.map(authMethodLoginPath))];
  if (paths.length === 0) {
    throw new Error(`${provider} does not expose an interactive login method`);
  }
  path ??= paths.length === 1 ? paths[0] : await terminal.choose(`Connect ${provider}`, paths.map((value) => ({
    label: value === "subscription"
      ? "Use a subscription or provider account"
      : "Use a key, token, or local credentials",
    value,
  })), signal);
  const methods = available.filter((method) => authMethodLoginPath(method) === path);
  if (methods.length === 0) throw new Error(`${provider} does not expose an interactive login method`);
  const method = methods.length === 1 ? methods[0]! : await terminal.choose(`Connect ${provider}`, methods.map((value) => ({ label: value.label, detail: value.detail, value })), signal);
  const binding = runtime.auth.binding(provider);
  if (method.kind === "local" || method.kind === "external") { terminal.notify(method.detail); return provider; }
  if (method.kind === "environment" || method.kind === "ambient") { signal?.throwIfAborted(); await runtime.auth.selectFallback(provider); return provider; }
  if (method.kind === "openrouter_browser") {
    const session = await createOpenRouterLoopback({ fetch: runtime.network.fetch, ...optionalProperties(signal === undefined ? undefined : { signal }) });
    terminal.notify(`Open this URL to sign in:\n${session.authorizationUrl.toString()}`); openBrowser(session.authorizationUrl, noBrowser);
    const apiKey = await session.waitForKey();
    signal?.throwIfAborted();
    await runtime.auth.storeCredential(provider, { kind: "api_key", provider: binding.credentialId, apiKey }, storeOptions); return provider;
  }
  const authorizationUi = createInteractiveAuthorizationUi(terminal, noBrowser);
  if (method.kind === "openai_codex_browser" || method.kind === "openai_codex_device") {
    const credential = await authorizeOpenAICodex({ clientId: configuredOAuthClientId("openai-codex", process.env), flow: method.kind === "openai_codex_browser" ? "browser" : "device", ...authorizationUi, ...optionalProperties(signal === undefined ? undefined : { signal }), fetch: runtime.network.fetch });
    signal?.throwIfAborted();
    await runtime.auth.storeCredential(provider, credential, storeOptions); return provider;
  }
  if (method.kind === "anthropic_browser") {
    const credential = await authorizeAnthropic({
      clientId: configuredOAuthClientId("anthropic", process.env),
      ...authorizationUi,
      ...optionalProperties(signal === undefined ? undefined : { signal }),
      fetch: runtime.network.fetch,
    });
    signal?.throwIfAborted();
    await runtime.auth.storeCredential(provider, credential, storeOptions); return provider;
  }
  if (method.kind === "github_copilot_device") {
    const credential = await authorizeGitHubCopilot({
      clientId: configuredOAuthClientId("github-copilot", process.env),
      experimentalTokenBroker: true,
      requestHost: async () => configuredGitHubCopilotHost(process.env),
      showDeviceCode: ({ url, userCode }) => authorizationUi.showAuthorization({ url, userCode }),
      openUrl: authorizationUi.openUrl,
      showProgress: (message) => terminal.notify(message),
      ...optionalProperties(signal === undefined ? undefined : { signal }),
      fetch: runtime.network.fetch,
    });
    signal?.throwIfAborted();
    await runtime.auth.storeCredential(provider, credential, storeOptions); return provider;
  }
  if (method.kind === "oauth") {
    const credential = await authorizeOAuthRegistration(runtime.auth.registration(method.registrationId), binding.credentialId, { ...authorizationUi, ...optionalProperties(signal === undefined ? undefined : { signal }), fetch: runtime.network.fetch });
    signal?.throwIfAborted();
    await runtime.auth.storeCredential(provider, credential, storeOptions); return provider;
  }
  if (method.kind === "managed_oauth") {
    const interaction = signal ?? new AbortController().signal;
    const credential = await runtime.auth.authorizeManaged(provider, method.methodId, {
      signal: interaction,
      showAuthorization: async ({ url }) => { const selected = managedAuthUrl(url); terminal.notify(`Open this URL to sign in:\n${selected}`); openBrowser(selected, noBrowser); },
      showDeviceCode: async ({ verificationUri, userCode }) => {
        const selected = managedAuthUrl(verificationUri);
        const code = managedAuthText(userCode, "Managed provider device code", 1_024);
        terminal.notify(`Open ${selected} and enter code ${code}\nWaiting for authentication...`);
        openBrowser(selected, noBrowser);
      },
      showProgress: (message) => terminal.notify(managedAuthText(message, "Managed provider progress")),
      prompt: async (input) => await terminal.question(managedAuthText(input.message, "Managed provider prompt"), interaction),
      select: async (input) => {
        const message = managedAuthText(input.message, "Managed provider selection prompt");
        if (!Array.isArray(input.options) || input.options.length === 0 || input.options.length > 64) {
          throw new TypeError("Managed provider selection options are invalid");
        }
        return await terminal.choose(message, input.options.map((option) => ({
          label: managedAuthText(option.label, "Managed provider selection label", 256),
          ...optionalProperties(option.detail === undefined ? undefined : { detail: managedAuthText(option.detail, "Managed provider selection detail", 2_048) }),
          value: managedAuthText(option.id, "Managed provider selection ID", 128),
        })), interaction);
      },
    });
    signal?.throwIfAborted();
    await runtime.auth.storeCredential(provider, credential, storeOptions); return provider;
  }
  if (method.kind === "api_key") {
    const directLogin = runtime.modelRegistry.getProvider(provider)?.auth.apiKey?.login;
    if (directLogin !== undefined) {
      const credential = await directLogin(directAuthInteraction(terminal, signal, noBrowser));
      if (credential.key === "" || (credential.key === undefined && Object.keys(credential.env ?? {}).length === 0)) {
        throw new Error("Credential is empty");
      }
      signal?.throwIfAborted();
      if (credential.key !== undefined) defaultSecretRedactor.register(credential.key);
      await runtime.auth.storeCredential(provider, {
        kind: "api_key",
        provider: binding.credentialId,
        ...optionalProperties(credential.key === undefined ? undefined : { apiKey: credential.key }),
        ...optionalProperties(credential.env === undefined ? undefined : { env: credential.env }),
      }, storeOptions);
      await runtime.modelRegistry.refresh({ force: true, ...optionalProperties(signal === undefined ? undefined : { signal }) });
      return provider;
    }
  }
  const secret = await terminal.readSecret(`${provider} ${method.kind === "api_key" ? "API key" : "bearer token"}: `, signal);
  if (secret === "") throw new Error("Credential is empty");
  signal?.throwIfAborted();
  defaultSecretRedactor.register(secret);
  await runtime.auth.storeCredential(provider, method.kind === "api_key"
    ? { kind: "api_key", provider: binding.credentialId, apiKey: secret }
    : { kind: "bearer", provider: binding.credentialId, accessToken: secret }, storeOptions);
  return provider;
}

async function logoutInteractively(
  runtime: LoadedRuntime,
  terminal: InteractiveCliTerminal,
  argument: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const requested = argument.trim();
  const stored = (await runtime.auth.states()).filter((state) => state.stored.present);
  signal?.throwIfAborted();
  const provider = requested || await (async () => {
    if (stored.length === 0) throw new Error("No stored credentials are available to remove");
    return await terminal.choose("Remove provider authentication", stored.map((state) => ({
      label: state.displayName,
      detail: [state.provider, state.activeProfile].filter(Boolean).join(" · "),
      value: state.provider,
    })), signal);
  })();
  signal?.throwIfAborted();
  if (runtime.auth.has(provider)) {
    const result = await runtime.auth.logout(provider);
    signal?.throwIfAborted();
    terminal.notify(result.removedStored
      ? `Signed out for ${provider}${result.profile === undefined ? "" : ` profile ${result.profile}`}`
      : `No stored credential was present for ${provider}`);
  } else {
    if (runtime.modelRegistry.getProvider(provider) === undefined) throw new Error(`Unknown provider: ${provider}`);
    await runtime.modelRegistry.models().logout(provider);
    signal?.throwIfAborted();
    terminal.notify(`Signed out for ${provider}`);
  }
}

export function runtimeUi(
  terminal: TuiController,
  extensionId: string,
  lifecycleSignal?: AbortSignal,
  interactionSignal = lifecycleSignal,
  ownerKey = extensionId,
): RuntimeCommandUi {
  return createInteractiveRuntimeCommandUi(terminal, extensionId, {
    lifecycleSignal,
    interactionSignal,
    ownerKey,
    assertCurrent: () => {
      if (lifecycleSignal?.aborted === true) {
        throw new Error(`Extension UI context is no longer active: ${extensionId}`);
      }
    },
  });
}

type LoadedExtensionBundle = ReturnType<LoadedRuntime["extensions"]["bundle"]>;
type InteractiveSkill = Pick<
  ReturnType<LoadedRuntime["resourceLoader"]["getSkills"]>["skills"][number],
  "description" | "filePath" | "name"
>;
interface InteractiveExtensionBundle {
  commands: Array<Pick<
    LoadedExtensionBundle["commands"][number],
    "argumentHint" | "description" | "extensionId" | "name"
  >>;
  prompts: Array<Pick<
    LoadedExtensionBundle["prompts"][number],
    "argumentHint" | "description" | "extensionId" | "id"
  >>;
  themes: LoadedExtensionBundle["themes"];
}

export interface InteractiveUiRuntime {
  workspace: LoadedRuntime["workspace"];
  settings: LoadedRuntime["settings"];
  resourceLoader: { getSkills(): { skills: InteractiveSkill[] } };
  session: Pick<LoadedRuntime["session"], "extensionRunner" | "toolRendererBinding">;
  runtimeExtensions: LoadedRuntime["runtimeExtensions"];
  extensions: { bundle(): InteractiveExtensionBundle };
}

/** Owns the generation-scoped TUI adapters for the currently loaded extension host. */
export class InteractiveExtensionUiBinder {
  readonly #terminal: TuiController;
  readonly #themeHotRefresher: ThemeHotRefresher;
  #host: LoadedRuntime["runtimeExtensions"] | undefined;
  #binding: InteractiveRuntimeUiBinding | undefined;

  constructor(terminal: TuiController) {
    this.#terminal = terminal;
    this.#themeHotRefresher = new ThemeHotRefresher({
      apply: (definition) => terminal.updateCustomTheme(definition),
    });
  }

  context(runtime: InteractiveUiRuntime): ReturnType<typeof createInteractiveDirectUiContext> {
    if (
      this.#host === runtime.runtimeExtensions
      && this.#binding !== undefined
      && !this.#binding.signal.aborted
    ) return this.#binding.uiContext;
    const themes = runtime.extensions.bundle().themes;
    return createInteractiveDirectUiContext(
      this.#terminal,
      "runtime",
      runtime.workspace,
      runtime.runtimeExtensions.lifecycleSignal(),
      {
        settings: runtime.settings,
        themePath: (name) => themes.find((theme) => theme.name === name)?.sourcePath,
      },
    );
  }

  refreshCommands(runtime: InteractiveUiRuntime): void {
    this.#terminal.setCommandItems(this.#commandItems(runtime));
  }

  #commandItems(runtime: InteractiveUiRuntime): PickerItem<string>[] {
    const bundle = runtime.extensions.bundle();
    const skills = runtime.settings.getEnableSkillCommands()
      ? interactiveSkillCommands(
          runtime.resourceLoader.getSkills().skills,
          bundle.prompts.map((prompt) => prompt.id),
        ).map((skill): PickerItem<string> => ({
          id: `skill:${skill.name}`,
          label: `/skill:${skill.name}`,
          value: `/skill:${skill.name}`,
          detail: skill.description,
          keywords: ["skill", skill.filePath],
        }))
      : [];
    return [
      ...bundle.commands.map((entry): PickerItem<string> => ({
        id: `extension-command:${entry.extensionId}:${entry.name}`,
        label: `/${entry.name}`,
        value: `/${entry.name}`,
        ...optionalProperties(entry.description === undefined ? undefined : { detail: entry.description }),
        keywords: [entry.extensionId, entry.argumentHint ?? ""],
      })),
      ...bundle.prompts.map((entry): PickerItem<string> => ({
        id: `extension-prompt:${entry.extensionId}:${entry.id}`,
        label: `/${entry.id}`,
        value: `/${entry.id}`,
        ...optionalProperties(entry.description === undefined ? undefined : { detail: entry.description }),
        keywords: [entry.extensionId, entry.argumentHint ?? "", "prompt template"],
      })),
      ...runtime.runtimeExtensions.commands().map((entry): PickerItem<string> => ({
        id: `runtime-command:${entry.extensionId}:${entry.name}`,
        label: `/${entry.name}`,
        value: `/${entry.name}`,
        ...optionalProperties(entry.description === undefined ? undefined : { detail: entry.description }),
        keywords: [entry.extensionId, entry.argumentHint ?? "", entry.sourcePath],
      })),
      ...skills,
    ];
  }

  bind(runtime: InteractiveUiRuntime, force = false): boolean {
    const terminal = this.#terminal;
    const host = runtime.runtimeExtensions;
    if (!force && this.#host === host && !host.lifecycleSignal().aborted) return false;
    const hostSignal = host.lifecycleSignal();
    hostSignal.throwIfAborted();
    const replaced = this.#releaseBinding(new Error("Interactive extension UI binding replaced"));
    this.#host = host;
    try {
      terminal.setOperatorPreferences(tuiOperatorPreferences(runtime.settings));
      terminal.setDoubleEscapeAction(runtime.settings.getDoubleEscapeAction());
      const themes = runtime.extensions.bundle().themes;
      terminal.setCustomThemes(themes.map((theme) => theme.definition));
      const theme = runtime.settings.getThemeSetting() ?? "signal";
      try { terminal.setTheme(theme); }
      catch { terminal.notify(`Configured theme ${theme} is unavailable`, "warning"); }
      const watchActiveTheme = (): void => {
        this.#themeHotRefresher.select(themes.find((entry) =>
          entry.extensionId === "theme" && entry.name === terminal.selectedThemeName()));
      };
      watchActiveTheme();
      const binding = bindInteractiveRuntimeUi(
        terminal,
        runtime.session.extensionRunner,
        runtime.workspace,
        () => this.#commandItems(runtime),
        {
          settings: runtime.settings,
          themePath: (name) => themes.find((theme) => theme.name === name)?.sourcePath,
        },
        runtime.session.toolRendererBinding(),
        {
          clearUi: !replaced,
          onThemeChange: watchActiveTheme,
        },
      );
      this.#binding = binding;
      const release = (): void => {
        if (this.#binding !== binding) return;
        this.#binding = undefined;
        this.#host = undefined;
        this.#themeHotRefresher.select(undefined);
      };
      binding.signal.addEventListener("abort", release, { once: true });
      if (binding.signal.aborted) release();
      return true;
    } catch (error) {
      if (this.#host === host) this.#host = undefined;
      this.#themeHotRefresher.select(undefined);
      throw error;
    }
  }

  restoreDirectContext(runtime: InteractiveUiRuntime): void {
    if (this.#host === runtime.runtimeExtensions) this.#binding?.restoreDirectContext();
  }

  unbind(): void {
    this.#releaseBinding(new Error("Interactive extension UI binding released"));
  }

  close(): void {
    this.unbind();
    this.#themeHotRefresher.close();
  }

  #releaseBinding(reason: Error): boolean {
    const binding = this.#binding;
    if (binding === undefined) return false;
    this.#binding = undefined;
    this.#host = undefined;
    this.#themeHotRefresher.select(undefined);
    return binding.dispose(reason);
  }
}

function runtimeOptions(
  argumentsValue: Args,
  extensionFactories: readonly InlineExtension[] = [],
  projectTrustResolver?: ProjectTrustResolver,
  toolAuthorizationHandler?: ToolAuthorizationHandler,
): Parameters<typeof loadRuntime>[0] {
  const apiKey = argumentsValue.apiKey;
  const provider = argumentsValue.provider ?? "openai";
  const localObservabilityMode = resolveAgentCliMode({
    ...optionalProperties(argumentsValue.mode === undefined ? undefined : { mode: argumentsValue.mode }),
    ...optionalProperties(argumentsValue.print === undefined ? undefined : { print: argumentsValue.print }),
    stdinIsTTY: process.stdin.isTTY,
    stdoutIsTTY: process.stdout.isTTY,
  });
  return {
    ...optionalProperties(apiKey === undefined ? undefined : { apiKey, apiKeyProvider: provider }),
    ...optionalProperties(argumentsValue.models === undefined ? undefined : { modelScope: argumentsValue.models }),
    ...optionalProperties(argumentsValue.sessionDir === undefined ? undefined : { sessionDirectory: argumentsValue.sessionDir }),
    ...optionalProperties(argumentsValue.workspace === undefined ? undefined : { workspace: resolve(argumentsValue.workspace) }),
    ...(projectTrustResolver === undefined
      ? argumentsValue.projectTrustOverride === undefined ? {} : { projectTrusted: argumentsValue.projectTrustOverride }
      : { projectTrustResolver }),
    extensions: argumentsValue.noExtensions !== true,
    extensionPaths: argumentsValue.extensions ?? [],
    extensionFactories,
    skills: argumentsValue.noSkills !== true,
    skillPaths: argumentsValue.skills ?? [],
    promptTemplates: argumentsValue.noPromptTemplates !== true,
    promptTemplatePaths: argumentsValue.promptTemplates ?? [],
    themes: argumentsValue.noThemes !== true,
    themePaths: argumentsValue.themes ?? [],
    ...optionalProperties(argumentsValue.systemPrompt === undefined ? undefined : { systemPrompt: argumentsValue.systemPrompt }),
    ...optionalProperties(argumentsValue.appendSystemPrompt === undefined ? undefined : { appendSystemPrompt: argumentsValue.appendSystemPrompt }),
    extensionRuntime: true,
    localObservabilityMode,
    ...optionalProperties(toolAuthorizationHandler === undefined ? undefined : { toolAuthorizationHandler }),
    offline: argumentsValue.offline === true || /^(?:1|true|yes)$/iu.test(process.env.OHM_OFFLINE ?? ""),
  };
}

async function confirmForkFromWorkspace(workspace: string): Promise<boolean> {
  return await new Promise<boolean>((resolveAnswer) => {
    const input = createInterface({ input: process.stdin, output: process.stdout });
    input.question(`Session found in different workspace: ${workspace}\nFork it into the current workspace? [y/N] `, (answer) => {
      input.close();
      resolveAnswer(/^(?:y|yes)$/iu.test(answer.trim()));
    });
  });
}

async function sessionRuntimeOptions(
  argumentsValue: Args,
  extensionFactories: readonly InlineExtension[] = [],
  projectTrustResolver?: ProjectTrustResolver,
  toolAuthorizationHandler?: ToolAuthorizationHandler,
): Promise<Parameters<typeof loadRuntime>[0] | undefined> {
  const options = runtimeOptions(
    argumentsValue,
    extensionFactories,
    projectTrustResolver,
    toolAuthorizationHandler,
  );
  const workspace = resolve(argumentsValue.workspace ?? process.cwd());
  const projectTrusted = projectTrustResolver === undefined
    ? argumentsValue.projectTrustOverride === true
    : await projectTrustResolver.isTrusted(workspace);
  const directory = await resolveStartupSessionDirectory(argumentsValue, workspace, { projectTrusted });
  const selected = await createStartupSession(argumentsValue, workspace, directory, {
    async selectSession(current, all) { return await selectStartupSession(current, all); },
    confirmForkFromWorkspace,
  });
  if (selected.cancelled || selected.sessionManager === undefined) return undefined;
  if (argumentsValue.name !== undefined) {
    const name = argumentsValue.name.trim();
    if (name === "") throw new Error("--name cannot be blank");
    selected.sessionManager.appendSessionInfo(name);
  }
  return {
    ...options,
    ...optionalProperties(directory === undefined ? undefined : { sessionDirectory: directory }),
    workspace: selected.sessionManager.getCwd(),
    sessionManager: selected.sessionManager,
  };
}

async function selectConfiguredModel(
  runtime: LoadedRuntime,
  argumentsValue: Args,
  session: AgentSession = runtime.session,
  signal?: AbortSignal,
): Promise<void> {
  const current = session.model;
  const currentInScope = current !== undefined && session.isModelInScope(current.provider, current.id)
    ? current
    : undefined;
  const defaultModel = runtime.settings.getDefaultModel();
  const defaultProvider = runtime.settings.getDefaultProvider();
  const defaultInScope = defaultModel !== undefined && defaultProvider !== undefined
    && session.isModelInScope(defaultProvider, defaultModel);
  const scopedFallback = session.modelScopeSelectors.length === 0 ? undefined : session.scopedModels[0]?.model;
  if (
    argumentsValue.model === undefined
    && currentInScope === undefined
    && scopedFallback === undefined
    && session.modelScopeSelectors.length > 0
  ) {
    throw new Error(`No available model matches the active scope: ${session.modelScopeSelectors.join(", ")}`);
  }
  const reference = argumentsValue.model
    ?? currentInScope?.id
    ?? (defaultInScope ? defaultModel : undefined)
    ?? (scopedFallback === undefined ? defaultModel : scopedFallback.id);
  const provider = argumentsValue.provider
    ?? currentInScope?.provider
    ?? (defaultInScope ? defaultProvider : undefined)
    ?? (scopedFallback === undefined ? defaultProvider : scopedFallback.provider);
  const reasoningEffort = argumentsValue.thinking;
  if (reference !== undefined) {
    const requestedProvider = argumentsValue.provider === undefined && argumentsValue.model !== undefined
      ? undefined
      : provider;
    const selected = await resolveRequestedModel(runtime.providers, {
      reference,
      ...optionalProperties(requestedProvider === undefined ? undefined : { provider: requestedProvider }),
      ...optionalProperties(provider === undefined ? undefined : { fallbackProvider: provider }),
      ...optionalProperties(reasoningEffort === undefined ? undefined : { reasoningEffort }),
      allowUnknownModel: false,
    }, signal === undefined
      ? AbortSignal.timeout(30_000)
      : AbortSignal.any([signal, AbortSignal.timeout(30_000)]));
    await session.setModel(await session.resolveModel(selected.model, {
      provider: selected.provider,
      ...optionalProperties(selected.reasoningEffort === undefined ? undefined : { reasoningEffort: selected.reasoningEffort }),
    }));
  }
  if (argumentsValue.thinking !== undefined) session.setThinkingLevel(normalizeModelReasoningEffort(argumentsValue.thinking));
}

async function readPipedStdin(): Promise<string | undefined> {
  if (process.stdin.isTTY) return undefined;
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) { const value = Buffer.from(chunk); bytes += value.length; if (bytes > 16 * 1024 * 1024) throw new Error("stdin exceeds 16 MiB"); chunks.push(value); }
  const text = Buffer.concat(chunks).toString("utf8");
  return text === "" ? undefined : text;
}

const structuredOutputFailures = new WeakSet<object>();

class StructuredOutputFailure extends Error {
  readonly exitCode = 1;

  constructor(message: string) {
    super(message);
    structuredOutputFailures.add(this);
  }
}

/** True when a machine-readable event has already reported the CLI failure. */
export function isStructuredOutputFailure<Failure>(error: Failure): boolean {
  return (isObjectValue(error) || isFunctionValue(error))
    && structuredOutputFailures.has(error);
}

export interface ProcessFailure {
  exitCode: number;
  message: string;
}

/** @internal Descriptor-safe top-level process failure projection. */
export function caughtProcessFailure<Failure>(error: Failure): ProcessFailure {
  const descriptor = isErrorValue(error)
    ? Object.getOwnPropertyDescriptor(error, "exitCode")
    : undefined;
  const exitCode = descriptor !== undefined && "value" in descriptor
    && isNumberValue(descriptor.value) && Number.isSafeInteger(descriptor.value)
    ? descriptor.value
    : 1;
  return { exitCode, message: errorMessage(error) };
}

function throwIfAssistantFailed(
  assistant: OneShotAssistantMessage | undefined,
  mode: "json" | "print",
): void {
  if (assistant === undefined) return;
  if (assistant.stopReason !== "error" && assistant.stopReason !== "aborted") return;
  const message = assistant.errorMessage ?? `Request ${assistant.stopReason}`;
  if (mode === "json") throw new StructuredOutputFailure(message);
  throw new Error(message);
}

function applyExtensionArguments(argumentsValue: Args, runtime: LoadedRuntime): void {
  applyRuntimeExtensionFlags(argumentsValue, runtime.runtimeExtensions);
  const errors = argumentsValue.diagnostics.filter((entry) => entry.type === "error");
  if (errors.length > 0) throw new Error(errors.map((entry) => entry.message).join("\n"));
	validateSessionFlags(argumentsValue);
  if (argumentsValue.redact === true && argumentsValue.export === undefined) {
    throw new Error("--redact requires --export");
  }
}

async function runCommand(
  argumentsValue: Args,
  extensionFactories: readonly InlineExtension[] = [],
  projectTrustResolver?: ProjectTrustResolver,
  toolAuthorizationHandler?: ToolAuthorizationHandler,
): Promise<void> {
  await withGracefulTermination(async (termination) => {
    await runCommandOperation(
      argumentsValue,
      termination,
      extensionFactories,
      projectTrustResolver,
      toolAuthorizationHandler,
    );
  });
}

async function runCommandOperation(
  argumentsValue: Args,
  termination: GracefulTerminationContext,
  extensionFactories: readonly InlineExtension[],
  projectTrustResolver?: ProjectTrustResolver,
  toolAuthorizationHandler?: ToolAuthorizationHandler,
): Promise<void> {
  termination.throwIfTerminated();
  const options = await sessionRuntimeOptions(
    argumentsValue,
    extensionFactories,
    projectTrustResolver,
    toolAuthorizationHandler,
  );
  if (options === undefined) return;
  let runtime = await loadRuntime(options);
  let owner: AgentSessionRuntime<InteractiveRuntimeServices> | undefined;
  let unsubscribe = (): void => undefined;
  let bindingAbort: AbortController | undefined;
  let bindingGeneration = 0;
  const uninstallTermination = termination.onTerminate((signal) => {
    void (owner?.session ?? runtime.session).abort(`interrupted by ${signal}`);
  });
  try {
    termination.throwIfTerminated();
    applyExtensionArguments(argumentsValue, runtime);
    owner = await createInteractiveRuntimeOwner(
      argumentsValue,
      runtime,
      extensionFactories,
      projectTrustResolver,
      true,
      toolAuthorizationHandler,
    );
    const mode = argumentsValue.mode === "json" ? "json" : "print";
    let headerPending = mode === "json";
    const pendingExtensionErrors: ProjectedExtensionError[] = [];
    const reportExtensionError = (failure: ExtensionError): void => {
      const event = projectExtensionError(failure);
      if (mode === "json" && headerPending) pendingExtensionErrors.push(event);
      else if (mode === "json") writeMachineOutput(`${JSON.stringify(event)}\n`);
      else console.error(formatExtensionError(failure));
    };
    const bind = async (
      candidate: AgentSession = owner!.session,
      afterBound?: (
        session: AgentSession,
        candidateRuntime: LoadedRuntime,
        signal: AbortSignal,
      ) => Promise<void>,
    ): Promise<void> => {
      if (owner === undefined) return;
      const generation = ++bindingGeneration;
      const controller = new AbortController();
      bindingAbort = controller;
      const signal = AbortSignal.any([termination.signal, controller.signal]);
      const candidateRuntime = owner.services.runtime;
      try {
        await candidate.bindExtensions({
          mode,
          commandContextActions: createAgentSessionRuntimeCommandActions(owner, candidate),
          onError: reportExtensionError,
        }, signal);
      } catch (error) {
        if (controller.signal.aborted && generation !== bindingGeneration) return;
        throw error;
      }
      if (generation !== bindingGeneration || controller.signal.aborted) return;
      runtime = candidateRuntime;
      unsubscribe();
      unsubscribe = candidate.subscribe((event) => {
        if (mode === "json") writeMachineOutput(`${JSON.stringify(event)}\n`);
      });
      if (headerPending) {
        headerPending = false;
        const header = candidate.sessionManager.getHeader();
        if (header !== null) writeMachineOutput(`${JSON.stringify(header)}\n`);
        for (const event of pendingExtensionErrors.splice(0)) {
          writeMachineOutput(`${JSON.stringify(event)}\n`);
        }
      }
      await afterBound?.(candidate, candidateRuntime, signal);
    };
    owner.setBeforeSessionInvalidate(() => {
      bindingAbort?.abort(new Error("Session replaced"));
      bindingGeneration += 1;
      unsubscribe();
      unsubscribe = (): void => undefined;
    });
    const prepare = async (
      session: AgentSession,
      candidateRuntime: LoadedRuntime,
      signal: AbortSignal,
    ): Promise<void> => {
      await recoverNonInteractiveSession(session, signal);
      signal.throwIfAborted();
      await selectConfiguredModel(candidateRuntime, argumentsValue, session, signal);
      signal.throwIfAborted();
      if (session.model === undefined) {
        throw new Error("No model selected. Pass --model or run ohm interactively and use /model.");
      }
    };
    owner.setRebindSession(async (candidate) => {
      await bind(candidate, prepare);
    });
    const messages = [...argumentsValue.messages];
    const first = messages.shift();
    const stdin = await readPipedStdin();
    const input = [stdin, ...argumentsValue.fileArgs.map((path) => `@${path}`), first]
      .filter((value): value is string => value !== undefined && value !== "")
      .join("\n");
    if (input === "" && messages.length === 0) throw new Error("A prompt is required");
    await bind(owner.session, prepare);
    const promptOptions = () => {
      const configuredTools = runtime.settings.getToolSettings();
      const tools = selectedTools(
        argumentsValue,
        runtime.runtimeExtensions.tools().map((tool) => tool.definition.name),
        {
          ...optionalProperties(configuredTools.enabled === undefined ? undefined : { allowedTools: configuredTools.enabled }),
          ...optionalProperties(configuredTools.excluded === undefined ? undefined : { excludedTools: configuredTools.excluded }),
        },
      );
      return {
        ...optionalProperties(tools.allowedTools === undefined ? undefined : { allowedTools: tools.allowedTools }),
        ...optionalProperties(tools.excludedTools === undefined ? undefined : { excludedTools: tools.excludedTools }),
        noContextFiles: argumentsValue.noContextFiles === true,
        ...optionalProperties(argumentsValue.maxSteps === undefined ? undefined : { maxSteps: argumentsValue.maxSteps }),
        ...optionalProperties(argumentsValue.maxOutputTokens === undefined ? undefined : { maxOutputTokens: argumentsValue.maxOutputTokens }),
      };
    };
    let latestAssistant: OneShotAssistantMessage | undefined;
    if (input !== "") {
      const expanded = await expandPromptReferences(input, runtime.workspace, undefined, runtime.settings.getImageAutoResize());
      const boundary = captureOneShotAssistantBoundary(runtime.session);
      await runtime.session.prompt(expanded.text, { ...promptOptions(), images: expanded.images });
      const assistant = latestOneShotAssistant(boundary, runtime.session);
      latestAssistant = assistant;
      throwIfAssistantFailed(assistant, mode);
    }
    for (const message of messages) {
      const boundary = captureOneShotAssistantBoundary(runtime.session);
      await runtime.session.prompt(message, promptOptions());
      const assistant = latestOneShotAssistant(boundary, runtime.session);
      latestAssistant = assistant;
      throwIfAssistantFailed(assistant, mode);
    }
    if (mode !== "json") {
      if (latestAssistant !== undefined) {
        const text = latestAssistant.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("");
        if (text !== "") writeMachineOutput(`${text}\n`);
      }
    }
  } finally {
    uninstallTermination();
    unsubscribe();
    if (owner === undefined) {
      try {
        await runtime.runtimeExtensions.dispatch("session_shutdown", { reason: "quit" }).catch(() => undefined);
      } finally {
        await runtime.close();
      }
    } else await owner.dispose();
  }
}

function inputImageBlocks(images: readonly TuiInputImageAttachment[] | undefined): ImageBlock[] {
  return (images ?? []).map((image) => ({ ...image.block }));
}

function imageSourceBytes(image: ImageBlock): number {
  return Buffer.byteLength(image.data ?? image.url ?? "", "utf8");
}

interface InteractiveRuntimeServices extends AgentSessionRuntimeServices {
  runtime: LoadedRuntime;
  sessionStartEvent?: RuntimeSessionStartEvent;
}

async function createInteractiveRuntimeOwner(
  argumentsValue: Args,
  initial: LoadedRuntime,
  extensionFactories: readonly InlineExtension[] = [],
  projectTrustResolver?: ProjectTrustResolver,
  deferConfiguredModelSelection = false,
  toolAuthorizationHandler?: ToolAuthorizationHandler,
): Promise<AgentSessionRuntime<InteractiveRuntimeServices>> {
  const sessionDirectory = initial.sessionDirectory;
  const create = async ({ cwd, agentDir, sessionManager, modelScope, sessionStartEvent, signal }: {
    cwd: string;
    agentDir: string;
    sessionManager: SessionManager;
    modelScope?: readonly string[];
    sessionStartEvent?: RuntimeSessionStartEvent;
    signal?: AbortSignal;
  }) => {
    const runtime = await loadRuntime({
      ...runtimeOptions(
        argumentsValue,
        extensionFactories,
        projectTrustResolver,
        toolAuthorizationHandler,
      ),
      ...optionalProperties(sessionDirectory === undefined ? undefined : { sessionDirectory }),
      workspace: cwd,
      sessionManager,
      ...optionalProperties(modelScope === undefined ? undefined : { modelScope }),
      ...optionalProperties(sessionStartEvent === undefined ? undefined : { sessionStartEvent }),
      ...optionalProperties(signal === undefined ? undefined : { signal }),
    });
    try {
      applyExtensionArguments(argumentsValue, runtime);
      if (!deferConfiguredModelSelection) await selectConfiguredModel(runtime, argumentsValue);
      return {
        session: runtime.session,
        extensionsResult: runtime.resourceLoader.getExtensions(),
        diagnostics: runtime.runtimeExtensions.diagnostics().map((entry) => ({
          type: "warning" as const,
          message: entry.message,
        })),
        services: {
          cwd,
          agentDir,
          runtime,
          ...optionalProperties(sessionStartEvent === undefined ? undefined : { sessionStartEvent }),
          async close() { await runtime.close(); },
        },
      };
    } catch (error) {
      await runtime.close().catch(() => undefined);
      throw error;
    }
  };

  let owner!: AgentSessionRuntime<InteractiveRuntimeServices>;
  owner = new AgentSessionRuntime({
    session: initial.session,
    extensionsResult: initial.resourceLoader.getExtensions(),
    diagnostics: initial.runtimeExtensions.diagnostics().map((entry) => ({
      type: "warning" as const,
      message: entry.message,
    })),
    services: {
      cwd: initial.workspace,
      agentDir: initial.paths.agentDirectory,
      runtime: initial,
      async close() { await initial.close(); },
    },
  }, create, {
    async beforeSwitch(event, signal) {
      return await owner.services.runtime.runtimeExtensions.reduceSessionBeforeSwitch({
        reason: event.reason,
        ...optionalProperties(event.targetSessionFile === undefined ? undefined : { targetThreadId: event.targetSessionFile }),
      }, signal);
    },
    async beforeFork(event, signal) {
      return await owner.services.runtime.runtimeExtensions.reduceSessionBeforeFork({
        sourceThreadId: owner.session.sessionId,
        sourceEventId: event.entryId,
        position: event.position,
      }, signal);
    },
    async shutdown(event) {
      await owner.services.runtime.runtimeExtensions.dispatch("session_shutdown", {
        reason: event.reason,
        ...optionalProperties(event.targetSessionFile === undefined ? undefined : { targetSessionFile: event.targetSessionFile }),
      });
    },
  });
  return owner;
}

async function chatCommand(
  argumentsValue: Args,
  extensionFactories: readonly InlineExtension[] = [],
  projectTrustResolver?: ProjectTrustResolver,
  toolAuthorizationHandler?: ToolAuthorizationHandler,
): Promise<void> {
  await withGracefulTermination(async (termination) => {
    await chatCommandOperation(
      argumentsValue,
      termination,
      extensionFactories,
      projectTrustResolver,
      toolAuthorizationHandler,
    );
  });
}

async function chatCommandOperation(
  argumentsValue: Args,
  termination: GracefulTerminationContext,
  extensionFactories: readonly InlineExtension[],
  projectTrustResolver?: ProjectTrustResolver,
  toolAuthorizationHandler?: ToolAuthorizationHandler,
): Promise<void> {
  termination.throwIfTerminated();
  const options = await sessionRuntimeOptions(
    argumentsValue,
    extensionFactories,
    projectTrustResolver,
    toolAuthorizationHandler,
  );
  if (options === undefined) return;
  let runtime = await loadRuntime({ ...options, deferModelNetworkRefresh: true });
  projectTrustResolver?.setTerminal(undefined);
  applyExtensionArguments(argumentsValue, runtime);
  const owner = await createInteractiveRuntimeOwner(
    argumentsValue,
    runtime,
    extensionFactories,
    projectTrustResolver,
    true,
    toolAuthorizationHandler,
  );
  let keybindings = parseKeybindings(runtime.settings.getKeybindings());
  let unsubscribe = (): void => undefined;
  let exiting = false;
  let resolveExit!: () => void;
  const exited = new Promise<void>((resolveValue) => { resolveExit = resolveValue; });
  let actionHandler: (action: TuiAction) => void = () => undefined;
  const terminal = createRichTuiController({
    onAction: (action) => actionHandler(action),
    keybindings,
    doubleEscapeAction: runtime.settings.getDoubleEscapeAction(),
    operatorPreferences: tuiOperatorPreferences(runtime.settings),
    cacheReadPrice: (provider, model, promptTokens) => {
      const selected = runtime.modelRegistry.find(provider, model);
      return selected === undefined ? undefined : modelCacheReadPrice(selected, promptTokens);
    },
  });
  projectTrustResolver?.setTerminal(terminal);
  const reportExtensionError = (failure: ExtensionError): void => {
    terminal.notify(formatExtensionError(failure), "error");
  };
  const extensionUi = new InteractiveExtensionUiBinder(terminal);
  const deferredSubmissions = new BoundedDeferredSubmissionQueue<ImageBlock>(imageSourceBytes);
  const anthropicApiBearerBillingWarning = new AnthropicApiBearerBillingWarning();
  let promptActive = false;
  let promptAbort: AbortController | undefined;
  let authAbort: AbortController | undefined;
  let modelSelectionGeneration = 0;
  let modelSelectionAbort: AbortController | undefined;
  const commandAborts = new Set<AbortController>();
  const invalidateModelSelection = (reason: Error): void => {
    modelSelectionGeneration += 1;
    modelSelectionAbort?.abort(reason);
    modelSelectionAbort = undefined;
  };
  const abortCommands = (reason: Error): boolean => {
    if (commandAborts.size === 0) return false;
    for (const controller of commandAborts) controller.abort(reason);
    return true;
  };
  const abortPrompt = (reason: Error): boolean => {
    if (promptAbort === undefined || promptAbort.signal.aborted) return false;
    promptAbort.abort(reason);
    return true;
  };
  const uninstallTermination = termination.onTerminate((signal) => {
    exiting = true;
    abortPrompt(new Error(`interrupted by ${signal}`));
    authAbort?.abort(new Error(`interrupted by ${signal}`));
    abortCommands(new Error(`interrupted by ${signal}`));
    void runtime.session.abort(`interrupted by ${signal}`);
    terminal.close();
    resolveExit();
  });
  let steeringHandler: ((
    line: string,
    images?: readonly TuiInputImageAttachment[],
    recoveredImages?: readonly ImageBlock[],
    recoveredQueueDraft?: boolean,
  ) => void) | undefined;
  let drainDeferredSubmissions: () => Promise<void> = async () => undefined;
  let locallyInterruptedOperationId: string | undefined;
  const maybeWarnAboutAnthropicApiBearerBilling = async (): Promise<void> => {
    await anthropicApiBearerBillingWarning.maybeNotify({
      enabled: runtime.settings.getWarnings().anthropicExtraUsage !== false,
      model: runtime.session.model,
      models: runtime.modelRegistry.models(),
      notify: (message) => terminal.notify(message, "warning"),
    });
  };

  const updateContext = (includeContextUsage = true): void => {
    const sessionName = runtime.sessionManager.getSessionName();
    const recoveryPending = !runtime.session.isStreaming && runtime.session.suspendedRun !== undefined;
    const active = promptActive || commandAborts.size > 0 || (!runtime.session.isIdle && !recoveryPending);
    terminal.setSteering(active ? steeringHandler : undefined);
    terminal.setQueuedMessages(runtime.session.getQueuedMessages());
    terminal.setContext(createInteractiveTuiContext(
      runtime.session,
      runtime.workspace,
      sessionName,
      active,
      {
        includeContextUsage,
        operationOnly: commandAborts.size > 0 && !promptActive && runtime.session.isIdle,
      },
    ));
  };
  const bind = (preserveTranscript = false): void => {
    extensionUi.bind(runtime);
    extensionUi.restoreDirectContext(runtime);
    unsubscribe();
    unsubscribe = bindInteractiveSessionPresentation(runtime.session, terminal, {
      onEnvelope: () => updateContext(false),
      onSessionEvent: (event) => updateContext(event.type === "entry_appended"),
      preserveTranscript,
    });
    updateContext();
    void maybeWarnAboutAnthropicApiBearerBilling();
  };
  const sessionOperations = new InteractiveSessionOperations({
    runtime: owner,
    terminal,
    refreshTranscript: (options) => bind(options?.preserveExisting === true),
    updateContext,
    resolveInputPath: (value) => expandPath(value, runtime.workspace),
  });
  let configuredModelSelectionPending: AgentSession | undefined;
  const applyConfiguredModelSelection = async (
    candidateRuntime: LoadedRuntime,
    session: AgentSession,
    signal?: AbortSignal,
  ): Promise<void> => {
    if (session.suspendedRun !== undefined) {
      configuredModelSelectionPending = session;
      return;
    }
    await selectConfiguredModel(candidateRuntime, argumentsValue, session, signal);
    if (configuredModelSelectionPending === session) configuredModelSelectionPending = undefined;
  };
  const recoverThenApplyConfiguredModel = async (
    candidateRuntime: LoadedRuntime,
    session: AgentSession,
    signal?: AbortSignal,
  ): Promise<void> => {
    if (session.suspendedRun !== undefined) {
      terminal.setInputBlocked("Recovering interrupted operation...", "recovery");
      try {
        await sessionOperations.recoverAtStartup(signal);
      } finally {
        terminal.setInputBlocked();
      }
    }
    await applyConfiguredModelSelection(candidateRuntime, session, signal);
  };
  const interactiveCommandActions = (session: LoadedRuntime["session"]) => {
    let refreshResult: { warnings: string[] } | undefined;
    return createAgentSessionRuntimeCommandActions(owner, session, {
      async refresh(signal) {
        terminal.setInputBlocked(`Refreshing ${REFRESH_RESOURCE_SUMMARY}...`, "refresh");
        try {
          let refreshedKeybindings: Keybindings | undefined;
          refreshResult = await runtime.refresh({
            signal,
            async prepareSettings(settings) {
              refreshedKeybindings = parseKeybindings(settings.getKeybindings());
            },
            onCommit() {
              if (refreshedKeybindings === undefined) throw new Error("Refreshed keybindings were not validated");
              keybindings = refreshedKeybindings;
              terminal.setKeybindings(keybindings);
              extensionUi.bind(runtime, true);
            },
            beforeSessionStart(refreshedSession) {
              refreshedSession.updateExtensionBindings(interactiveExtensionBindings(refreshedSession));
              extensionUi.restoreDirectContext(runtime);
            },
          });
          return runtime.session;
        } catch (error) {
          terminal.setInputBlocked();
          throw error;
        }
      },
      async afterRefresh(refreshedSession) {
        try {
          refreshedSession.updateExtensionBindings(interactiveExtensionBindings(refreshedSession));
          bind(true);
          await refreshInteractiveModels({ force: false, allowNetwork: false });
          const warnings = refreshResult?.warnings ?? [];
          terminal.notify(
            warnings.length === 0 ? `Refreshed ${REFRESH_RESOURCE_SUMMARY}` : warnings.join("\n"),
            warnings.length === 0 ? "status" : "warning",
          );
          await maybeWarnAboutAnthropicApiBearerBilling();
        } finally {
          terminal.setInputBlocked();
        }
      },
    });
  };
  const interactiveExtensionBindings = (session: LoadedRuntime["session"]) => ({
    mode: "tui" as const,
    uiContext: extensionUi.context(runtime),
    commandContextActions: interactiveCommandActions(session),
    onError: reportExtensionError,
  });
  owner.setBeforeSessionInvalidate(() => {
    abortPrompt(new Error("Session replaced"));
    invalidateModelSelection(new Error("Session replaced"));
    configuredModelSelectionPending = undefined;
    locallyInterruptedOperationId = undefined;
    unsubscribe();
    unsubscribe = (): void => undefined;
    extensionUi.unbind();
  });
  owner.setRebindSession(async (session) => {
    invalidateModelSelection(new Error("Session replaced"));
    runtime = owner.services.runtime;
    extensionUi.bind(runtime, true);
    bind(true);
    await session.bindExtensions(
      interactiveExtensionBindings(session),
      runtime.runtimeExtensions.lifecycleSignal(),
    );
    extensionUi.restoreDirectContext(runtime);
    await recoverThenApplyConfiguredModel(
      runtime,
      session,
      runtime.runtimeExtensions.lifecycleSignal(),
    );
    await refreshInteractiveModels({ force: false, allowNetwork: false });
  });
  const reportError = <Failure>(error: Failure): void => terminal.notify(defaultSecretRedactor.redact(errorMessage(error)), "error");
  const chooseModel = async (reference?: string, operationSignal?: AbortSignal): Promise<void> => {
    const generation = ++modelSelectionGeneration;
    modelSelectionAbort?.abort(new Error("A newer model selection started"));
    const controller = new AbortController();
    modelSelectionAbort = controller;
    const signal = operationSignal === undefined
      ? AbortSignal.any([controller.signal, termination.signal])
      : AbortSignal.any([controller.signal, termination.signal, operationSignal]);
    const session = runtime.session;
    const current = (): boolean =>
      modelSelectionGeneration === generation
      && modelSelectionAbort === controller
      && runtime.session === session
      && !signal.aborted;
    try {
      const knownProviders = [...new Set([
        ...runtime.providers.list().map((entry) => entry.id),
        ...runtime.modelRegistry.models().getProviders().map((entry) => entry.id),
      ])];
      const parsed = parseInteractiveModelReference(
        reference,
        argumentsValue.provider ?? session.model?.provider ?? runtime.settings.getDefaultProvider(),
        knownProviders,
      );
      let { provider, model } = parsed;
      if (provider === undefined) {
        provider = await terminal.choose("Select provider", runtime.providers.list().map((entry) => ({ label: entry.id, value: entry.id })), signal);
        if (!current()) return;
      }
      model ??= await pickModel(runtime, provider, terminal, signal);
      if (!current()) return;
      const requestedThinkingLevel = session.thinkingLevel;
      const selected = await session.resolveModel(model, { provider, signal });
      if (!current()) return;
      await session.setModel(selected);
      if (!current()) return;
      await persistDefaultSelection(runtime.settings, { provider: selected.provider, model: selected.id });
      if (!current()) return;
      updateContext();
      const effectiveThinkingLevel = session.thinkingLevel;
      terminal.notify(effectiveThinkingLevel === requestedThinkingLevel
        ? `Model ${selected.provider}/${selected.id}`
        : `Model ${selected.provider}/${selected.id} · thinking ${requestedThinkingLevel} → ${effectiveThinkingLevel}`);
      await maybeWarnAboutAnthropicApiBearerBilling();
    } catch (error) {
      if (!current() || signal.aborted) return;
      throw error;
    } finally {
      if (modelSelectionAbort === controller) modelSelectionAbort = undefined;
    }
  };
  const preparePrompt = async (
    text: string,
    images: readonly ImageBlock[] = [],
    signal?: AbortSignal,
  ): Promise<{ text: string; images: ImageBlock[] }> => {
    const expanded = await expandPromptReferences(text, runtime.workspace, signal, runtime.settings.getImageAutoResize());
    return {
      text: expanded.text,
      images: combinePromptImages(false, images, undefined, expanded.images),
    };
  };
  const submitPrompt = async (text: string, images: readonly ImageBlock[] = []): Promise<void> => {
    if (promptAbort !== undefined) throw new Error("A prompt is already active");
    const controller = new AbortController();
    promptAbort = controller;
    const signal = AbortSignal.any([controller.signal, termination.signal]);
    const selectedRuntime = runtime;
    const session = selectedRuntime.session;
    const current = (): boolean =>
      promptAbort === controller
      && runtime === selectedRuntime
      && selectedRuntime.session === session
      && !signal.aborted;
    promptActive = true;
    updateContext();
    try {
      const prepared = await preparePrompt(text, images, signal);
      if (!current()) return;
      if (session.model === undefined) await chooseModel(undefined, signal);
      if (!current()) return;
      const configuredTools = selectedRuntime.settings.getToolSettings();
      const tools = selectedTools(
        argumentsValue,
        selectedRuntime.runtimeExtensions.tools().map((tool) => tool.definition.name),
        {
          ...optionalProperties(configuredTools.enabled === undefined ? undefined : { allowedTools: configuredTools.enabled }),
          ...optionalProperties(configuredTools.excluded === undefined ? undefined : { excludedTools: configuredTools.excluded }),
        },
      );
      if (!current()) return;
      await session.prompt(prepared.text, {
        images: prepared.images,
        ...optionalProperties(tools.allowedTools === undefined ? undefined : { allowedTools: tools.allowedTools }),
        ...optionalProperties(tools.excludedTools === undefined ? undefined : { excludedTools: tools.excludedTools }),
        noContextFiles: argumentsValue.noContextFiles === true,
        ...optionalProperties(argumentsValue.maxSteps === undefined ? undefined : { maxSteps: argumentsValue.maxSteps }),
        ...optionalProperties(argumentsValue.maxOutputTokens === undefined ? undefined : { maxOutputTokens: argumentsValue.maxOutputTokens }),
      });
    } catch (error) {
      if (!signal.aborted) throw error;
    } finally {
      if (promptAbort === controller) {
        promptAbort = undefined;
        promptActive = false;
        updateContext();
        await drainDeferredSubmissions();
      }
    }
  };
  const startPrompt = (text: string, images: readonly ImageBlock[] = []): void => {
    void submitPrompt(text, images).catch(reportError);
  };
  type InteractiveModelRefresh = {
    available: ReturnType<LoadedRuntime["modelRegistry"]["getAvailable"]>;
    items: PickerItem<ModelSelection>[];
  } | undefined;
  const modelRefreshOwner = createModelRefreshOwner<InteractiveModelRefresh>();
  const interactiveModelNetworkEnabled = argumentsValue.offline !== true
    && !/^(?:1|true|yes)$/iu.test(process.env.OHM_OFFLINE ?? "");
  const refreshInteractiveModels = (options: {
    force?: boolean;
    allowNetwork?: boolean;
    reuseActiveNetwork?: boolean;
    signal?: AbortSignal;
  } = {}): Promise<InteractiveModelRefresh> => {
    const allowNetwork = options.allowNetwork ?? interactiveModelNetworkEnabled;
    const existing = options.reuseActiveNetwork === true && !allowNetwork
      ? modelRefreshOwner.currentNetwork()
      : undefined;
    if (existing !== undefined) return existing;
    const pending = (async (): Promise<InteractiveModelRefresh> => {
      const refreshRuntime = runtime;
      const owner = modelRefreshOwner.begin(options.signal === undefined
        ? refreshRuntime.generationSignal
        : AbortSignal.any([refreshRuntime.generationSignal, options.signal]));
      terminal.setModelPickerLoading(true);
      try {
        const snapshot = refreshRuntime.modelRegistry.getAvailable()
          .filter((model) => refreshRuntime.session.isModelInScope(model.provider, model.id))
          .filter((model) => model.provider !== "openai" || isAgentOpenAIModel(model.id));
        const snapshotItems = snapshot.map((model) => modelItem(providerModelToInfo(model)))
          .sort((left, right) => left.label.localeCompare(right.label));
        const current = refreshRuntime.session.model;
        const active = current === undefined
          ? undefined
          : snapshotItems.find((item) => item.value.provider === current.provider && item.value.model === current.id);
        const ordered = active === undefined ? snapshotItems : [active, ...snapshotItems.filter((item) => item !== active)];
        terminal.setModelPickerItems(ordered);

        if (options.force ?? true) refreshRuntime.providers.invalidateModels();
        const providers = refreshRuntime.providers.list();
        const preservedModels = snapshot.map(providerModelToInfo);
        let statuses: readonly ProviderModelCatalogStatus[] = [];
        const currentSelection = current === undefined
          ? undefined
          : { provider: current.provider, model: current.id };
        const directRefresh = refreshRuntime.modelRegistry.refresh({
          force: options.force ?? true,
          allowNetwork,
          signal: owner.signal,
        });
        const pickerRefresh = refreshModelPicker(
          providers,
          terminal,
          currentSelection,
          owner.signal,
          refreshRuntime.auth,
          (next) => {
            statuses = next;
            terminal.setModelPickerEmptyMessage(modelCatalogEmptyMessage(next));
          },
          refreshRuntime.providers,
          {
            refresh: allowNetwork,
            preservedModels,
            manageLoading: false,
            modelFilter: (model) => refreshRuntime.session.isModelInScope(model.provider, model.id),
          },
        );
        const [, discovered] = await Promise.all([directRefresh, pickerRefresh]);
        if (!owner.current()) return undefined;
        const available = discovered.flatMap((info) => {
          const registered = refreshRuntime.modelRegistry.find(info.provider, info.id);
          if (registered !== undefined) return [registered];
          try { return [providerModelFromInfo(info)]; }
          catch { return []; }
        });
        const items = discovered
          .filter((model) => model.provider !== "openai" || isAgentOpenAIModel(model.id))
          .map(modelItem)
          .sort((left, right) => left.label.localeCompare(right.label));
        if (discovered.length === 0 && statuses.length === 0) {
          const error = refreshRuntime.modelRegistry.getError();
          terminal.setModelPickerEmptyMessage(error === undefined ? undefined : `Model catalogs are unavailable: ${error}`);
        }
        return { available, items };
      } finally {
        if (owner.finish()) terminal.setModelPickerLoading(false);
      }
    })();
    if (allowNetwork) modelRefreshOwner.trackNetwork(pending);
    return pending;
  };
  async function refreshInteractiveResources(signal?: AbortSignal): Promise<void> {
    await interactiveCommandActions(owner.session).refresh(signal);
  }
  const showSettings = async (): Promise<void> => {
    await terminal.chooseSettings(
      interactiveSettingItems(runtime.settings, runtime.session, terminal.themeNames()),
      async (item, value) => {
        applyInteractiveSetting(item, value, runtime.settings, runtime.session, terminal);
        await runtime.settings.flush();
        extensionUi.refreshCommands(runtime);
        updateContext();
      },
    );
    await maybeWarnAboutAnthropicApiBearerBilling();
  };
  const showChangelog = async (): Promise<void> => {
    const content = await readPackageChangelog();
    terminal.notify(byteTruncate(content.trim() || "No changelog entries found", 256 * 1024));
  };
  const logout = async (argument: string): Promise<void> => {
    await logoutInteractively(runtime, terminal, argument);
    await refreshInteractiveModels();
  };
  const runInteractiveOperation = async <T>(
    operation: (signal: AbortSignal) => Promise<T>,
    settleAfterAbort = false,
  ): Promise<T | undefined> => {
    const controller = new AbortController();
    commandAborts.add(controller);
    updateContext();
    try {
      const pending = Promise.resolve().then(async () => await operation(controller.signal));
      return await (settleAfterAbort ? pending : waitForInteractiveOperation(pending, controller.signal));
    } catch (error) {
      if (!controller.signal.aborted) throw error;
      return undefined;
    } finally {
      commandAborts.delete(controller);
      updateContext();
      if (commandAborts.size === 0) await drainDeferredSubmissions();
    }
  };
  const dispatchUnknownCommand = async (input: string, images: readonly ImageBlock[]): Promise<boolean> => {
    const route = resolveInteractiveResourceSlash(runtime.session, input, runtime.extensions);
    if (route === undefined) {
      terminal.notify(`Unknown command: /${input.slice(1).trim().split(/\s/u, 1)[0] ?? ""}`, "error");
      return true;
    }
    if (route.kind === "runtime") {
      const result = await runInteractiveOperation(async (signal) =>
        await runtime.runtimeExtensions.runCommand(route.name, {
          args: route.args,
          threadId: runtime.session.sessionId,
          signal,
        }));
      if (result === undefined) return true;
      if (result.handled && result.prompt !== undefined) startPrompt(result.prompt, images);
      return true;
    }
    startPrompt(route.prompt, images);
    return true;
  };
  const runShellSubmission = async (command: string, hidden: boolean): Promise<void> => {
      await runInteractiveOperation(async (signal) => {
        let presentation: ReturnType<typeof beginInteractiveShellPresentation> | undefined;
        const beginPresentation = (displayCommand: string): ReturnType<typeof beginInteractiveShellPresentation> =>
          presentation ??= beginInteractiveShellPresentation({
            terminal,
            threadId: runtime.session.sessionId,
            command: displayCommand,
            hidden,
          });
        try {
          const result = await runInteractiveShell({
            command,
            hidden,
            workspace: runtime.workspace,
            host: runtime.runtimeExtensions,
            session: runtime.session,
            signal,
            onPrepared: beginPresentation,
            onChunk: (chunk) => beginPresentation(command).onChunk(chunk),
          });
          beginPresentation(command).complete(result);
        } catch (cause) {
          beginPresentation(command).fail(cause);
          throw cause;
        }
      });
  };
  let activeSubmissionOrder = 0;
  let submissionWork = Promise.resolve();
  let processActiveSubmission: (
    text: string,
    images: readonly ImageBlock[],
    order: number,
  ) => Promise<void> = async () => undefined;
  type InteractiveSubmissionDraft = Parameters<typeof restoreInterruptedSubmission>[1];
  let dispatchInteractiveSubmission: (
    draft: InteractiveSubmissionDraft,
    text: string,
    images: readonly ImageBlock[],
    order: number,
  ) => Promise<void> = async () => undefined;
  const scheduleInteractiveSubmission = async (operation: () => Promise<void>): Promise<void> => {
    const scheduled = submissionWork.then(operation);
    submissionWork = scheduled.catch(() => undefined);
    await scheduled;
  };
  const coordinator = new InteractiveCommandCoordinator<ImageBlock>({
    commands: {
      quit() {
        exiting = true;
        abortPrompt(new Error("Terminal closed"));
        authAbort?.abort(new Error("Terminal closed"));
        abortCommands(new Error("Terminal closed"));
        resolveExit();
      },
      async cancel() {
        const promptWasActive = abortPrompt(new Error("Cancelled by user"));
        const authenticationActive = authAbort !== undefined;
        if (authenticationActive) authAbort?.abort(new Error("authorization cancelled from terminal"));
        const commandActive = abortCommands(new Error("command cancelled from terminal"));
        if (promptWasActive || !runtime.session.isIdle) {
          await restoreQueuedMessagesThenAbort(runtime.session, terminal, "Cancelled by user");
        } else if (!authenticationActive && !commandActive) {
          await runtime.session.abort("Cancelled by user");
        }
      },
      async login({ args }) {
        await runInteractiveOperation(async (operationSignal) => {
          const controller = new AbortController();
          authAbort = controller;
          const signal = AbortSignal.any([controller.signal, operationSignal]);
          try {
            const provider = await loginInteractively(runtime, terminal, args || undefined, signal, argumentsValue.noBrowser === true);
            const refreshed = await refreshInteractiveModels(runtime.auth.has(provider)
              ? { signal }
              : { force: false, allowNetwork: false, signal });
            if (refreshed === undefined || signal.aborted) return;
            const { available } = refreshed;
            const selected = selectDefaultModelAfterLogin(provider, available, undefined, runtime.session.model === undefined ? undefined : {
              provider: runtime.session.model.provider,
              model: runtime.session.model.id,
            });
            if (selected !== undefined) await chooseModel(`${selected.provider}/${selected.model}`, signal);
            signal.throwIfAborted();
            const source = runtime.auth.has(provider) ? (await runtime.auth.state(provider)).source : "stored";
            signal.throwIfAborted();
            terminal.notify(`Connected ${provider}${source === undefined ? "" : ` via ${source}`}. Use /model or Ctrl+L to choose a model.`);
            await maybeWarnAboutAnthropicApiBearerBilling();
          } catch (error) {
            if (!signal.aborted) throw error;
          } finally {
            if (authAbort === controller) authAbort = undefined;
          }
        });
      },
      async model({ args }) {
        if (args !== "") {
          await runInteractiveOperation(async (signal) => await chooseModel(args, signal));
          return;
        }
        const refresh = refreshInteractiveModels({ force: false, allowNetwork: false, reuseActiveNetwork: true });
        terminal.openPicker("model", "Models");
        void refresh.catch(reportError);
      },
      async "scoped-models"({ args }) {
        sessionOperations.scopedModels(args);
        await refreshInteractiveModels({ force: false, allowNetwork: false, reuseActiveNetwork: true });
      },
      thinking({ args }) {
        const level = applyInteractiveThinking(runtime.session, args);
        if (args.trim() === "") terminal.notify(`Thinking: ${level}`);
        updateContext();
      },
      async new() {
        await runInteractiveOperation(async (signal) => await sessionOperations.newSession(signal));
      },
      async fork({ args }) {
        await runInteractiveOperation(async (signal) => await sessionOperations.fork(args, signal));
      },
      async clone({ args }) {
        await runInteractiveOperation(async (signal) => await sessionOperations.clone(args, signal));
      },
      async resume({ args }) {
        await runInteractiveOperation(async (signal) => await sessionOperations.resume(args, signal));
      },
      async atlas({ args }) {
        await runInteractiveOperation(async (signal) => await sessionOperations.atlas(args, signal));
      },
      async recover({ args }) {
        await runInteractiveOperation(async (signal) => {
          await sessionOperations.recover(args, signal);
          const session = runtime.session;
          if (configuredModelSelectionPending === session) {
            await applyConfiguredModelSelection(runtime, session, signal);
            if (configuredModelSelectionPending !== session) {
              void refreshInteractiveModels().catch(reportError);
            }
          }
        });
      },
      async refresh() {
        await runInteractiveOperation(async (signal) => await refreshInteractiveResources(signal), true);
      },
      async name({ args }) { await sessionOperations.name(args); },
      async session() { await sessionOperations.showSession(); },
      async export({ args }) { await sessionOperations.exportSession(args, false); },
      async share({ args }) {
        await runInteractiveOperation(async (signal) => await sessionOperations.shareSession(args, signal));
      },
      context() { sessionOperations.showContext(); },
      resources() {
        terminal.notify(renderInteractiveResourceReport(runtime.session, runtime.workspace));
      },
      copy() { return sessionOperations.copyLatestAssistant(); },
      hotkeys() { terminal.notify(formatHotkeys(keybindings)); },
      async compact({ args }) { await sessionOperations.compact(args); },
      help() { terminal.notify(renderInteractiveCommandHelp()); },
      async settings() { await showSettings(); },
      async changelog() { await showChangelog(); },
      async import({ args }) {
        await runInteractiveOperation(async (signal) => await sessionOperations.importSession(args, signal));
      },
      async trust() { await sessionOperations.saveProjectTrust(); },
      async logout({ args }) { await logout(args); },
    },
    unknownCommand: async ({ input, images }) => await dispatchUnknownCommand(input, images),
    submissions: {
      prompt: (text, images) => startPrompt(text, images),
      shell: async ({ command, hidden }) => await runShellSubmission(command, hidden),
    },
    actions: {
      async exit() {
        exiting = true;
        abortPrompt(new Error("Terminal closed"));
        authAbort?.abort(new Error("Terminal closed"));
        abortCommands(new Error("Terminal closed"));
        await runtime.session.abort("Terminal closed");
        resolveExit();
      },
      error(action) { reportError(action.error); },
      async cancel() {
        const promptWasActive = abortPrompt(new Error("Cancelled by user"));
        const authenticationActive = authAbort !== undefined;
        if (authenticationActive) authAbort?.abort(new Error("authorization cancelled from terminal"));
        const commandActive = abortCommands(new Error("command cancelled from terminal"));
        if (promptWasActive || !runtime.session.isIdle) {
          await restoreQueuedMessagesThenAbort(runtime.session, terminal, "Cancelled by user");
        } else if (!authenticationActive && !commandActive) {
          await runtime.session.abort("Cancelled by user");
        }
      },
      async submit(action) {
        const blocks = [
          ...inputImageBlocks(action.images),
          ...(action.recoveredImages ?? []).map((image) => ({ ...image })),
        ];
        const operation = async (): Promise<void> => await dispatchInteractiveSubmission({
          text: action.text,
          ...optionalProperties(action.images === undefined ? undefined : { images: action.images }),
          ...optionalProperties(action.recoveredImages === undefined ? undefined : { recoveredImages: action.recoveredImages }),
        }, action.text, blocks, activeSubmissionOrder++);
        if (promptActive || commandAborts.size > 0 || !runtime.session.isIdle) await operation();
        else await scheduleInteractiveSubmission(operation);
      },
      async activeSubmission(action) {
        const text = action.type === "follow_up" ? `/follow ${action.text}` : action.text;
        const blocks = [
          ...inputImageBlocks(action.images),
          ...(action.recoveredImages ?? []).map((image) => ({ ...image })),
        ];
        const operation = async (): Promise<void> => await dispatchInteractiveSubmission({
          text: action.text,
          mode: action.type === "follow_up" ? "follow_up" : "steer",
          ...optionalProperties(action.images === undefined ? undefined : { images: action.images }),
          ...optionalProperties(action.recoveredImages === undefined ? undefined : { recoveredImages: action.recoveredImages }),
        }, text, blocks, activeSubmissionOrder++);
        if (promptActive || commandAborts.size > 0 || !runtime.session.isIdle) await operation();
        else await scheduleInteractiveSubmission(operation);
      },
      dequeue() {
        const restored = restoreAllQueuedMessages(runtime.session, terminal);
        if (restored === 0) terminal.notify("The editor queue is empty");
        else terminal.notify(`Returned ${restored} queued message${restored === 1 ? "" : "s"} to the editor`);
        updateContext();
      },
      queueRestoreDiscard() { updateContext(); },
      async modelCatalog() {
        await refreshInteractiveModels({ force: false, allowNetwork: false, reuseActiveNetwork: true });
      },
      async sessionCatalog(action) { await sessionOperations.handleCatalogAction(action); },
      async sessionMutation(action) { await sessionOperations.handleMutation(action); },
      async selectSession(action) {
        await runInteractiveOperation(async (signal) =>
          await sessionOperations.selectCatalogItem(action.item, signal));
      },
      async selectModel(action) {
        const value = pickerModelSelection(action.item.value);
        await runInteractiveOperation(async (signal) => await chooseModel(
          `${value.provider}/${value.model}${value.reasoningEffort === undefined ? "" : `:${value.reasoningEffort}`}`,
          signal,
        ));
      },
      command(action) { terminal.setEditorText(String(action.item.value)); },
      copy() { return sessionOperations.copyLatestAssistant(false); },
      copyText(action) { return terminal.copyToClipboard(action.text); },
      cycleThinking() {
        if (runtime.session.cycleThinkingLevel() === undefined) {
          terminal.notify("The selected model does not expose configurable thinking levels", "status");
        }
        updateContext();
      },
      toggleThinkingVisibility() { terminal.toggleReasoning(); },
      async extensionShortcut(action) {
        action.generation.throwIfAborted();
        await runInteractiveOperation(async (signal) =>
          await runtime.runtimeExtensions.runShortcut(action.shortcut, {
            threadId: runtime.session.sessionId,
            signal,
            ui: runtimeUi(terminal, "shortcut", action.generation),
          }));
      },
      async other(action) {
        if (action.type === "paste_image") {
          await runInteractiveOperation(async (signal) => {
            await attachClipboardImage(terminal, runtime.settings, signal);
          });
        } else if (action.type === "suspend") {
          terminal.suspend();
        }
      },
    },
  });
  const dispatchIdleSubmission = async (text: string, images: readonly ImageBlock[] = []): Promise<void> => {
    await coordinator.dispatchSubmission(text, images);
  };
  dispatchInteractiveSubmission = async (draft, text, images, order): Promise<void> => {
    await dispatchInteractiveSubmissionAfterInterruption({
      session: runtime.session,
      locallyInterruptedOperationId,
      clearLocalInterruptionMarker: () => { locallyInterruptedOperationId = undefined; },
      signal: termination.signal,
      text,
      draft,
      terminal,
      canDispatchIdle: () => !promptActive && commandAborts.size === 0 && runtime.session.isIdle,
      dispatchIdle: async () => await dispatchIdleSubmission(text, images),
      dispatchActive: async () => await processActiveSubmission(text, images, order),
      updateContext,
    });
  };
  let drainingDeferred = false;
  drainDeferredSubmissions = async (): Promise<void> => {
    if (drainingDeferred || promptActive || commandAborts.size > 0 || !runtime.session.isIdle) return;
    drainingDeferred = true;
    try {
      while (!promptActive && commandAborts.size === 0 && runtime.session.isIdle) {
        const next = deferredSubmissions.shift();
        if (next === undefined) return;
        try {
          await dispatchIdleSubmission(next.text, next.images);
        } catch (error) {
          reportError(error);
        }
        if (exiting) return;
      }
    } finally {
      drainingDeferred = false;
    }
  };
  processActiveSubmission = async (
    text: string,
    images: readonly ImageBlock[],
    order: number,
  ): Promise<void> => {
    if (!promptActive && commandAborts.size === 0 && runtime.session.isIdle) {
      await dispatchIdleSubmission(text, images);
      return;
    }
    const resourceRoute = text.trim().startsWith("/")
      ? resolveInteractiveResourceSlash(runtime.session, text, runtime.extensions)
      : undefined;
    const classified = classifyActiveSubmission(text, { resourceCommand: resourceRoute !== undefined });
    if (classified.kind === "cancel") {
      const marker = localInterruptionMarker(runtime.session);
      if (marker !== undefined) locallyInterruptedOperationId = marker;
      const promptWasActive = abortPrompt(new Error("Cancelled by user"));
      const authenticationActive = authAbort !== undefined;
      if (authenticationActive) authAbort?.abort(new Error("authorization cancelled from terminal"));
      const commandActive = abortCommands(new Error("command cancelled from terminal"));
      if (promptWasActive || !runtime.session.isIdle) {
        await restoreQueuedMessagesThenAbort(runtime.session, terminal, "Cancelled by user");
      } else if (!authenticationActive && !commandActive) {
        await runtime.session.abort("Cancelled by user");
      }
      updateContext();
      return;
    }
    if (classified.kind === "reject") {
      terminal.notify(`/${classified.command} is unavailable while work is active`, "warning");
      return;
    }
    if (classified.kind === "unknown") {
      terminal.notify(`Unknown command: /${classified.command}`, "error");
      return;
    }
    if (classified.kind === "command") {
      if (commandAborts.size > 0) {
        terminal.notify("Another command is active; finish or cancel it before starting this command", "warning");
        return;
      }
      if (classified.interrupt && (promptActive || !runtime.session.isIdle)) {
        await interruptInteractiveRunForCommand({
          session: runtime.session,
          command: classified.text,
          terminal,
          signal: termination.signal,
          interrupt: async () => {
            abortPrompt(new Error(`${classified.text} requested`));
            await restoreQueuedMessagesThenAbort(runtime.session, terminal, `${classified.text} requested`);
          },
        });
      }
      await coordinator.dispatchSlash(classified.text, images);
      updateContext();
      return;
    }
    if (classified.kind === "resource") {
      if (commandAborts.size > 0) {
        terminal.notify("Another command is active; finish or cancel it before starting this command", "warning");
        return;
      }
      if (resourceRoute === undefined) {
        terminal.notify("The command is no longer available", "error");
        return;
      }
      await runInteractiveOperation(async (signal) =>
        await dispatchActiveInteractiveResourceSlash(runtime.session, resourceRoute, images, signal));
      updateContext();
      return;
    }
    if (classified.kind === "defer" || commandAborts.size > 0) {
      const result = deferredSubmissions.enqueue(classified.text, images, order);
      if (!result.accepted) throw new Error(result.reason === "items"
        ? "Too many commands are waiting for the current turn to finish"
        : "Commands waiting for the current turn exceed the input byte limit");
      terminal.notify("Command queued until the current turn finishes");
      return;
    }
    const activePromptSignal = promptAbort?.signal;
    const prepared = await preparePrompt(classified.text, images, activePromptSignal);
    if (activePromptSignal?.aborted === true) return;
    if (!promptActive && commandAborts.size === 0 && runtime.session.isIdle) {
      await dispatchIdleSubmission(classified.text, images);
      return;
    }
    await deliverActiveSubmission(runtime.session, { ...classified, text: prepared.text }, prepared.images);
    updateContext();
  };
  steeringHandler = (line, images, recoveredImages) => {
    const blocks = [...inputImageBlocks(images), ...(recoveredImages ?? []).map((image) => ({ ...image }))];
    const order = activeSubmissionOrder++;
    const operation = async (): Promise<void> => await dispatchInteractiveSubmission({
      text: line,
      ...optionalProperties(images === undefined ? undefined : { images }),
      ...optionalProperties(recoveredImages === undefined ? undefined : { recoveredImages }),
    }, line, blocks, order);
    const classified = classifyActiveSubmission(line);
    if (classified.kind === "cancel" || commandAborts.size > 0) {
      void operation().catch(reportError);
      return;
    }
    return scheduleInteractiveSubmission(operation);
  };
  actionHandler = (action) => { void coordinator.dispatchAction(action).catch(reportError); };
  const uninstallEmergencyRecovery = installInteractiveEmergencyRecovery({
    restoreTerminal: () => terminal.close(),
  });
  let resumeCommand: string | undefined;
  try {
    terminal.start();
    extensionUi.bind(runtime);
    const startupSession = runtime.session;
    await startupSession.bindExtensions(
      interactiveExtensionBindings(startupSession),
      AbortSignal.any([runtime.runtimeExtensions.lifecycleSignal(), termination.signal]),
    );
    extensionUi.restoreDirectContext(runtime);
    await recoverThenApplyConfiguredModel(runtime, startupSession);
    terminal.setInterruptHandler(() => {
      let interrupted = false;
      if (abortPrompt(new Error("Interrupted"))) interrupted = true;
      if (authAbort !== undefined) {
        authAbort.abort(new Error("authorization cancelled from terminal"));
        interrupted = true;
      }
      if (abortCommands(new Error("command cancelled from terminal"))) interrupted = true;
      if (interrupted && runtime.session.isIdle) return true;
      if (runtime.session.isIdle) return false;
      const marker = localInterruptionMarker(runtime.session);
      if (marker !== undefined) locallyInterruptedOperationId = marker;
      void restoreQueuedMessagesThenAbort(runtime.session, terminal, "Interrupted").catch(reportError);
      return true;
    });
    terminal.setStartup(
      formatCompactStartupReport(
        { extensions: runtime.extensions.list().map((entry) => entry.id) },
        runtime.workspace,
        keybindings,
        terminal.capabilities.unicode,
      ),
      formatStartupReport({}, runtime.workspace, keybindings, terminal.capabilities.unicode),
    );
    if (owner.session === startupSession) bind();
    await presentStartupChangelog(runtime.settings, (message) => terminal.notify(message));
    await maybeWarnAboutAnthropicApiBearerBilling();
    if (configuredModelSelectionPending !== startupSession) {
      void refreshInteractiveModels().catch(reportError);
    }
    const initial = [...argumentsValue.fileArgs.map((path) => `@${path}`), ...argumentsValue.messages].join(" ").trim();
    if (initial !== "") startPrompt(initial);
    await exited;
    resumeCommand = formatResumeCommand(runtime.sessionManager);
  } finally {
    abortPrompt(new Error("Terminal closed"));
    invalidateModelSelection(new Error("Terminal closed"));
    locallyInterruptedOperationId = undefined;
    uninstallEmergencyRecovery();
    uninstallTermination();
    unsubscribe();
    extensionUi.close();
    terminal.close();
    abortCommands(new Error("Terminal closed"));
    if (!exiting) void runtime.session.abort("Terminal closed");
    await owner.dispose();
  }
  if (resumeCommand !== undefined) process.stdout.write(`To resume this session: ${resumeCommand}\n`);
}

async function listModels(
  argumentsValue: Args,
  extensionFactories: readonly InlineExtension[] = [],
  projectTrustResolver?: ProjectTrustResolver,
  toolAuthorizationHandler?: ToolAuthorizationHandler,
): Promise<void> {
  const runtime = await loadRuntime({
    ...runtimeOptions(argumentsValue, extensionFactories, projectTrustResolver, toolAuthorizationHandler),
    ephemeral: true,
  });
  try {
    applyExtensionArguments(argumentsValue, runtime);
    const provider = argumentsValue.provider;
    const direct = argumentsValue.offline === true || /^(?:1|true|yes)$/iu.test(process.env.OHM_OFFLINE ?? "")
      ? runtime.modelRegistry.getAll()
      : runtime.modelRegistry.getAvailable();
    const models = direct
      .filter((model) => provider === undefined || model.provider === provider)
      .map(providerModelToInfo);
    const query = isStringValue(argumentsValue.listModels) ? argumentsValue.listModels : undefined;
    const selected = query === undefined ? models : models.filter((model) => `${model.provider}/${model.id}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
    writeMachineOutput(argumentsValue.mode === "json" ? `${JSON.stringify(selected)}\n` : `${selected.map((model) => `${model.provider}/${model.id}\t${model.compatibility?.protocolFamily?.value ?? "unknown-api"}`).join("\n")}\n`);
  } finally { await runtime.close(); }
}

async function configCommand(
  argumentsValue: ManagementArguments,
  projectTrustResolver?: ProjectTrustResolver,
  signal?: AbortSignal,
): Promise<void> {
  if (await runSettingsConfigCommand(argumentsValue, {
    ...optionalProperties(projectTrustResolver === undefined ? undefined : { projectTrustResolver }),
    ...optionalProperties(signal === undefined ? undefined : { signal }),
  })) return;
  const action = argumentsValue.positionals[0];
  if (action !== undefined) throw new Error("config accepts path, edit, or validate; run config without an action to select package resources");
  await runPackageConfigCommand(
    argumentsValue,
    projectTrustResolver === undefined ? {} : { projectTrustResolver },
  );
}

export interface MainOptions {
  /** Trusted in-process extensions activated for every runtime generation. */
  extensionFactories?: InlineExtension[];
  /** Optional host-owned gate for model-requested tool effects in every runtime mode. */
  toolAuthorizationHandler?: ToolAuthorizationHandler;
}

export async function main(argv = process.argv.slice(2), options: MainOptions = {}): Promise<void> {
  const extensionFactories = options.extensionFactories ?? [];
  const helpTopics: ReadonlySet<string> = new Set(CLI_HELP_TOPICS);
  if (argv[0] === "help") {
    writeMachineOutput(renderCliHelp(argv[1]));
    return;
  }
  if (argv[0] !== undefined && helpTopics.has(argv[0]) && argv.slice(1).some((argument) => argument === "--help" || argument === "-h")) {
    writeMachineOutput(renderCliHelp(argv[0]));
    return;
  }
  const explicitAgentCommand = argv[0] === "chat" || argv[0] === "run";
  const management = !explicitAgentCommand && findLeadingManagementCommand(argv) !== undefined
    ? parseManagementArguments(argv)
    : undefined;
  if (management !== undefined) {
    if (management.command === "completions") { runCompletionsCommand(management); return; }
    if (management.command === "diagnostics") { await runDiagnosticsCommand(management); return; }
    if (management.command === "logs") { await runLogsCommand(management); return; }
    if (management.command === "stats") { await runStatsCommand(management); return; }
    if (management.command === "sessions") { await runSessionsCommand(management); return; }
    const approve = flagBoolean(management, "approve");
    const deny = flagBoolean(management, "no-approve");
    if (approve && deny) throw new Error("--approve and --no-approve are mutually exclusive");
    if (management.command === "config") {
      const action = management.positionals[0];
      const local = flagBoolean(management, "local");
      const scope = flagString(management, "scope");
      const direct = action === "path"
        || (action === "edit" || action === "validate") && (
          (!local && scope !== "project")
          || (local && scope !== undefined)
          || approve
          || deny
        );
      if (direct) {
        await withGracefulTermination(async (termination) => {
          termination.throwIfTerminated();
          await configCommand(management, undefined, termination.signal);
          termination.throwIfTerminated();
        });
        return;
      }
    }
    if (["extensions", "install", "remove", "update", "list", "packages", "config", "serve"].includes(management.command)) {
      const projectTrustResolver = await createInvocationTrustResolver({
        workspace: flagString(management, "workspace") ?? process.cwd(),
        ...optionalProperties(approve || deny ? { override: approve } : undefined),
        ...optionalProperties(management.command !== "serve" && process.stdin.isTTY && process.stdout.isTTY ? { terminal: new ScopedTrustPrompter() } : undefined),
        extensions: !flagBoolean(management, "no-extensions"),
        extensionPaths: flagStrings(management, "extension"),
        extensionFactories,
      });
      try {
        if (management.command === "serve") {
          await runServeCommand(management, {
            extensionFactories,
            projectTrustResolver,
            ...optionalProperties(options.toolAuthorizationHandler === undefined ? undefined : { toolAuthorizationHandler: options.toolAuthorizationHandler }),
          });
        } else if (management.command === "extensions") {
          await runExtensionsCommand(management, { extensionFactories, projectTrustResolver });
        } else if (["install", "remove", "update", "list"].includes(management.command)) {
          await withGracefulTermination(async (termination) => {
            termination.throwIfTerminated();
            await runPackageCommand(management, { projectTrustResolver, signal: termination.signal });
            termination.throwIfTerminated();
          });
        } else if (management.command === "packages") {
          await withGracefulTermination(async (termination) => {
            termination.throwIfTerminated();
            await runProjectPackageCommand(management, { projectTrustResolver, signal: termination.signal });
            termination.throwIfTerminated();
          });
        } else {
          await withGracefulTermination(async (termination) => {
            termination.throwIfTerminated();
            await configCommand(management, projectTrustResolver, termination.signal);
            termination.throwIfTerminated();
          });
        }
      } finally {
        await projectTrustResolver.close();
      }
      return;
    }
    const action = management.command === "self-install" ? "install" : management.command === "self-update" ? "update" : "uninstall";
    await runProductInstallAction(action, { yes: flagBoolean(management, "yes") });
    return;
  }

  const argumentsValue = parseArgs(explicitAgentCommand ? argv.slice(1) : argv);
  for (const diagnostic of argumentsValue.diagnostics.filter((entry) => entry.type === "warning")) {
    process.stderr.write(`Warning: ${escapeTerminal(defaultSecretRedactor.redact(diagnostic.message))}\n`);
  }
  const errors = argumentsValue.diagnostics.filter((entry) => entry.type === "error");
  if (errors.length > 0) throw new Error(errors.map((entry) => entry.message).join("\n"));
  if (argumentsValue.help) { writeMachineOutput(renderCliHelp()); return; }
  if (argumentsValue.version) { writeFileSync(1, `${OHM_VERSION}\n`); return; }
  if (argumentsValue.redact === true && argumentsValue.export === undefined) throw new Error("--redact requires --export");
  if (argumentsValue.export !== undefined) {
    const output = exportSessionFile(argumentsValue.export, argumentsValue.messages[0], { redact: argumentsValue.redact === true });
    writeMachineOutput(`Exported to: ${output}\n`);
    return;
  }
  const interactive = argumentsValue.listModels === undefined
    && argumentsValue.mode === undefined
    && !argumentsValue.print
    && process.stdin.isTTY
    && process.stdout.isTTY;
  const startupTrustPrompter = interactive ? new ScopedTrustPrompter() : undefined;
  const projectTrustResolver = await createInvocationTrustResolver({
    workspace: argumentsValue.workspace ?? process.cwd(),
    ...optionalProperties(argumentsValue.projectTrustOverride === undefined ? undefined : { override: argumentsValue.projectTrustOverride }),
    ...optionalProperties(startupTrustPrompter === undefined ? undefined : { terminal: startupTrustPrompter }),
    extensions: argumentsValue.noExtensions !== true,
    extensionPaths: argumentsValue.extensions ?? [],
    extensionFactories,
  });
  try {
    if (argumentsValue.listModels !== undefined) {
      await listModels(
        argumentsValue,
        extensionFactories,
        projectTrustResolver,
        options.toolAuthorizationHandler,
      );
      return;
    }
    if (argumentsValue.mode === "rpc") {
      if (argumentsValue.fileArgs.length > 0) throw new Error("RPC mode cannot accept @file inputs");
      await runRpcServer(argumentsValue, {
        extensionFactories,
        projectTrustResolver,
        ...optionalProperties(options.toolAuthorizationHandler === undefined ? undefined : { toolAuthorizationHandler: options.toolAuthorizationHandler }),
      });
      return;
    }
    if (interactive) {
      await chatCommand(
        argumentsValue,
        extensionFactories,
        projectTrustResolver,
        options.toolAuthorizationHandler,
      );
    } else {
      await runCommand(
        argumentsValue,
        extensionFactories,
        projectTrustResolver,
        options.toolAuthorizationHandler,
      );
    }
  } finally {
    await projectTrustResolver.close();
  }
}
