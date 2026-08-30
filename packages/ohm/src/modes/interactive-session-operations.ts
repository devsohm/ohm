import { optionalProperties } from "../core/optional-properties.js";
import { normalizeModelScopeSelectors } from "../core/model-scope.js";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";

import { defaultSecretRedactor } from "../auth/redaction.js";
import { TrustStore } from "../config/trust.js";
import { DirectProcessRunner } from "../process/runner.js";
import type { CommandResult, ProcessRunner } from "../process/types.js";
import type { AgentSession } from "../service/agent-session.js";
import { MissingSessionCwdError } from "../service/agent-session-runtime.js";
import { SessionManager } from "../storage/session-manager.js";
import type { SessionInfo } from "../storage/types.js";
import { DEFAULT_TUI_LIMITS, TuiSelectionCancelledError } from "../tui/contracts.js";
import type { PickerItem, QueuedMessage, SessionTreeMetadata, TerminalChoice, TuiAction } from "../tui/types.js";
import type { SessionTreeFilterMode } from "../tui/session-tree-picker.js";
import { sameFilesystemPath } from "../utils/paths.js";
import { projectConfigRootMatchesAgentDir } from "../utils/project-scope.js";
import { listSessionCatalog, type SessionCatalogPage, type SessionCatalogQuery } from "../cli/session-index.js";
import { SessionLoadGate } from "../cli/session-load-gate.js";
import { sessionPickerItems } from "../cli/session-picker.js";
import { resolveSessionFile } from "../cli/session-resolution.js";
import { formatSessionReport, formatSessionUsageReport } from "../cli/session-report.js";
import { sessionTreePickerItems } from "../cli/session-tree.js";
import { parseInteractiveExportRequest } from "../interactive/commands.js";
import { Check } from "typebox/value";
import { STRING_VALUE } from "../core/value-schemas.js";
import { interruptInteractiveRunForCommand } from "./interactive-interruption-recovery.js";
import { restoreQueuedMessagesThenAbort } from "./interactive-queue.js";
import { deleteSessionFile } from "./session-file-deletion.js";

export interface InteractiveSessionRuntime {
  readonly session: InteractiveSessionOperationsSession;
  readonly cwd: string;
  readonly services: { agentDir: string };
  newSession(options?: { signal?: AbortSignal }): Promise<{ cancelled: boolean }>;
  switchSession(path: string, options?: { cwdOverride?: string; signal?: AbortSignal }): Promise<{ cancelled: boolean }>;
  fork(
    entryId: string,
    options?: { position?: "before" | "at"; signal?: AbortSignal },
  ): Promise<{ cancelled: boolean; selectedText?: string }>;
  importFromJsonl(path: string, cwdOverride?: string, signal?: AbortSignal): Promise<{ cancelled: boolean }>;
}

type InteractiveSessionJournal = Pick<
  SessionManager,
  | "getActiveBranchEntryIdsInPage"
  | "getEntryCount"
  | "getLabel"
  | "getLeafId"
  | "getSessionDir"
  | "getTreePage"
  | "usesDefaultSessionDir"
>;

export interface InteractiveSessionOperationsSession extends Pick<
  AgentSession,
  | "abort"
  | "abortBranchSummary"
  | "autoCompactionEnabled"
  | "dequeueMessage"
  | "exportToHtml"
  | "exportToJsonl"
  | "getContextUsage"
  | "getLastAssistantText"
  | "getUserMessagesForForking"
  | "getPromptComposition"
  | "getQueuedMessages"
  | "getSessionStats"
  | "isCompacting"
  | "isIdle"
  | "isStreaming"
  | "navigateTree"
  | "recoverInterruptedRun"
  | "sessionFile"
  | "sessionId"
  | "setLabel"
  | "setSessionName"
  | "suspendedRun"
  | "thinkingLevel"
  | "waitForIdle"
> {
  readonly model: undefined | { readonly provider: string; readonly id: string; readonly api: string };
  readonly messages: readonly object[];
  readonly modelScopeSelectors: readonly string[];
  readonly nativeSessionManager: InteractiveSessionJournal;
  readonly settingsManager: Pick<AgentSession["settingsManager"], "getTreeFilterMode">;
  compact(customInstructions?: string): Promise<object>;
  setModelScope(selectors: readonly string[]): void;
}

type TranscriptRefreshOptions = { preserveExisting?: boolean };

export interface InteractiveSessionOperationsTerminal {
  readonly capabilities?: { readonly unicode: boolean };
  getPickerItemLimit?(): number;
  notify(message: string, kind?: "status" | "warning" | "error"): void;
  choose<T>(prompt: string, choices: TerminalChoice<T>[], signal?: AbortSignal): Promise<T>;
  chooseSessionTree<T>(
    prompt: string,
    items: readonly (PickerItem<T> & { tree: SessionTreeMetadata })[],
    options?: {
      onLabelChange?: (eventId: string, label: string | undefined) =>
        { label?: string; labelTimestamp?: string } | Promise<{ label?: string; labelTimestamp?: string }>;
      filter?: SessionTreeFilterMode;
      initialEventId?: string;
    },
    signal?: AbortSignal,
  ): Promise<T>;
  question(prompt: string, signal?: AbortSignal, options?: { cancelable?: boolean }): Promise<string>;
  copyToClipboard(value: string): Promise<void>;
  getEditorText(): string;
  setEditorText(value: string): void;
  setInputBlocked(message?: string, label?: string): void;
  setPickerItems<T>(
    kind: "session",
    items: readonly PickerItem<T>[],
    sessionResult?: { scope: "current" | "all"; query: string },
  ): void;
  setSessionPickerScope(scope: "current" | "all", status?: string): void;
  setSessionPickerPagination(hasMore: boolean, status?: string): void;
  openPicker(kind: "session", title?: string, initialQuery?: string): void;
  assertQueuedMessagesRestorable(messages: readonly QueuedMessage[]): void;
  restoreQueuedMessages(messages: readonly QueuedMessage[]): number;
}

export interface InteractiveSessionOperationsOptions {
  runtime: InteractiveSessionRuntime;
  terminal: InteractiveSessionOperationsTerminal;
  refreshTranscript(options?: TranscriptRefreshOptions): void;
  updateContext(): void;
  /** Uses host-specific path expansion when supplied. */
  resolveInputPath?(value: string): string;
  /** Test and embedding seam for bounded local helper processes. */
  processRunner?: ProcessRunner;
  /** Deterministic test seam for asynchronous session-catalog loads. */
  sessionCatalogLoader?(query: SessionCatalogQuery): Promise<SessionCatalogPage>;
  /** Lets the interactive owner route Escape to an active branch summary without closing the tree flow. */
  registerSummaryCancelHandler?(handler: () => void): () => void;
}

const SHARE_OUTPUT_LIMIT_BYTES = 64 * 1024;

function runtimeSessionManager(session: InteractiveSessionOperationsSession): InteractiveSessionJournal {
  return session.nativeSessionManager;
}

type AtlasTreeSelection =
  | { kind: "entry"; entryId: string }
  | { kind: "journal_page"; offset: number };

function processFailure(result: CommandResult, fallback: string): string {
  if (result.timedOut) return `${fallback}: command timed out`;
  if (result.cancelled) return `${fallback}: command was cancelled`;
  const detail = defaultSecretRedactor.redact(result.stderr.toString("utf8").trim());
  return detail === "" ? fallback : `${fallback}: ${detail}`;
}

function secretGistUrl(output: string): string {
  for (const candidate of output.trim().split(/\s+/u).reverse()) {
    try {
      const url = new URL(candidate);
      if (
        url.protocol === "https:" &&
        url.hostname === "gist.github.com" &&
        url.username === "" &&
        url.password === "" &&
        url.pathname.split("/").filter(Boolean).length >= 2
      ) return `${url.origin}${url.pathname.replace(/\/+$/u, "")}`;
    } catch {
      // Continue until the bounded CLI output yields a valid Gist URL.
    }
  }
  throw new Error("GitHub CLI did not return a valid Gist URL");
}

export function parseInteractivePathArgument(value: string, command: string): string {
  const selected = value.trim();
  if (selected === "") return "";
  const quote = selected[0];
  if (quote !== "\"" && quote !== "'") return selected;
  if (!selected.endsWith(quote) || selected.length < 2) throw new Error(`${command} path has an unterminated quote`);
  return selected.slice(1, -1);
}

/** Shared session command implementation used by every interactive host. */
export class InteractiveSessionOperations {
  readonly #runtime: InteractiveSessionRuntime;
  readonly #terminal: InteractiveSessionOperationsTerminal;
  readonly #refreshTranscript: (options?: TranscriptRefreshOptions) => void;
  readonly #updateContext: () => void;
  readonly #resolveInputPath: (value: string) => string;
  readonly #processRunner: ProcessRunner;
  readonly #sessionCatalogLoader: (query: SessionCatalogQuery) => Promise<SessionCatalogPage>;
  readonly #registerSummaryCancelHandler: (handler: () => void) => () => void;
  readonly #catalogLoads = new SessionLoadGate<SessionCatalogPage>();
  #page: SessionInfo[] = [];
  #cursor: string | undefined;
  #pageScope: "current" | "all" = "current";
  #pageQuery = "";

  constructor(options: InteractiveSessionOperationsOptions) {
    this.#runtime = options.runtime;
    this.#terminal = options.terminal;
    this.#refreshTranscript = options.refreshTranscript;
    this.#updateContext = options.updateContext;
    this.#resolveInputPath = options.resolveInputPath ?? ((value) => resolve(this.#runtime.cwd, value));
    this.#processRunner = options.processRunner ?? new DirectProcessRunner();
    this.#sessionCatalogLoader = options.sessionCatalogLoader ?? listSessionCatalog;
    this.#registerSummaryCancelHandler = options.registerSummaryCancelHandler ?? (() => () => undefined);
  }

  async newSession(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const result = await this.#runtime.newSession(signal === undefined ? undefined : { signal });
    this.#terminal.notify(result.cancelled ? "New session cancelled" : "Started a new session");
  }

  async fork(argument: string, signal?: AbortSignal): Promise<void> {
    if (argument.trim() !== "") throw new Error("Usage: /fork");
    const session = this.#runtime.session;
    const messages = session.getUserMessagesForForking();
    if (messages.length === 0) {
      this.#terminal.notify("Nothing to fork yet");
      return;
    }
    let entryId: string;
    try {
      entryId = await this.#terminal.choose("Fork from user message", messages.map((message) => ({
        label: message.text,
        value: message.entryId,
      })), signal);
    } catch (error) {
      if (error instanceof TuiSelectionCancelledError) return;
      throw error;
    }
    const result = await this.#runtime.fork(entryId, {
      ...optionalProperties(signal === undefined ? undefined : { signal }),
    });
    if (result.cancelled) {
      this.#terminal.notify("Fork cancelled");
      return;
    }
    this.#terminal.setEditorText(result.selectedText ?? "");
    this.#terminal.notify("Forked from the selected message");
  }

  async clone(argument: string, signal?: AbortSignal): Promise<void> {
    if (argument.trim() !== "") throw new Error("Usage: /clone");
    const session = this.#runtime.session;
    const leafId = runtimeSessionManager(session).getLeafId();
    if (leafId === null) {
      this.#terminal.notify("Nothing to clone yet");
      return;
    }
    const result = await this.#runtime.fork(leafId, {
      position: "at",
      ...optionalProperties(signal === undefined ? undefined : { signal }),
    });
    if (result.cancelled) {
      this.#terminal.notify("Clone cancelled");
      return;
    }
    this.#terminal.setEditorText("");
    this.#terminal.notify("Cloned the current session");
  }

  scopedModels(argument: string): void {
    const selected = argument.trim();
    const session = this.#runtime.session;
    if (selected === "") {
      this.#terminal.notify(session.modelScopeSelectors.length === 0
        ? "Model scope: all available models"
        : `Model scope: ${session.modelScopeSelectors.join(", ")}`);
      return;
    }
    const selectors = selected === "all"
      ? []
      : selected.split(",").map((entry) => entry.trim()).filter((entry) => entry !== "");
    session.setModelScope(normalizeModelScopeSelectors(selectors));
    this.#updateContext();
    this.#terminal.notify(selectors.length === 0
      ? "Model scope: all available models"
      : `Model scope: ${selectors.join(", ")}`);
  }

  async recover(argument: string, signal?: AbortSignal): Promise<void> {
    const values = argument.trim() === "" ? [] : argument.trim().split(/\s+/u);
    if (values.length !== 0 && (values.length !== 2 || values[0] !== "abandon")) {
      throw new Error("Usage: /recover [abandon EFFECT_ID]");
    }
    const recoveryOptions = {
      ...optionalProperties(signal === undefined ? undefined : { signal }),
      ...optionalProperties(values.length === 0 ? undefined : { resolutions: [{ effectId: values[1]!, outcome: "abandoned" as const }] }),
    };
    let result = await this.#runtime.session.recoverInterruptedRun(recoveryOptions);
    let automaticallyAbandoned = 0;
    if (!result.recovered && values.length === 0 && result.blocked.length > 0) {
      const blocked = result.blocked;
      automaticallyAbandoned = blocked.length;
      result = await this.#runtime.session.recoverInterruptedRun({
        ...optionalProperties(signal === undefined ? undefined : { signal }),
        resolutions: blocked.map((entry) => ({
          effectId: entry.effectId,
          outcome: "abandoned" as const,
        })),
      });
    }
    if (result.recovered) {
      this.#terminal.notify(
        (automaticallyAbandoned === 0
          ? `Recovered interrupted operation ${result.operationId}.`
          : `Recovered interrupted operation ${result.operationId}; abandoned ${automaticallyAbandoned} ` +
            `blocked tool call${automaticallyAbandoned === 1 ? "" : "s"} without replay.`) +
          " Send a prompt to continue; the next model turn will see the recovery result.",
        "status",
      );
      return;
    }
    if (result.operationId === undefined) {
      this.#terminal.notify("No interrupted operation needs recovery.", "status");
      return;
    }
    this.#terminal.notify([
      `Interrupted operation ${result.operationId} still needs a decision:`,
      ...result.blocked.map((entry) => `- ${entry.effectId} (${entry.name}): ${entry.reason}`),
      "Automatic recovery could not settle this operation. Retry /recover or use /recover abandon EFFECT_ID.",
    ].join("\n"), "warning");
  }

  async recoverAtStartup(signal?: AbortSignal): Promise<void> {
    const result = await this.#runtime.session.recoverInterruptedRun(
      signal === undefined ? {} : { signal },
    );
    if (result.recovered) {
      this.#terminal.notify(`Recovered interrupted operation ${result.operationId}.`, "status");
      return;
    }
    if (result.operationId === undefined) return;
    this.#terminal.notify([
      `Interrupted operation ${result.operationId} needs a decision:`,
      ...result.blocked.map((entry) => `- ${entry.effectId} (${entry.name}): ${entry.reason}`),
      "Run /recover to settle the remaining effects without replaying unsafe tools.",
    ].join("\n"), "warning");
  }

  async refreshSessions(scope: "current" | "all" = "current", query = "", more = false): Promise<void> {
    const session = this.#runtime.session;
    const manager = runtimeSessionManager(session);
    const sessionDirectory = scope === "all" && manager.usesDefaultSessionDir()
      ? undefined
      : manager.getSessionDir();
    const continuing = more && scope === this.#pageScope && query === this.#pageQuery && this.#cursor !== undefined;
    const afterPath = continuing ? this.#cursor : undefined;
    const requestKey = JSON.stringify([scope, query, afterPath ?? null]);
    const result = await this.#catalogLoads.request(requestKey, async () => await this.#sessionCatalogLoader({
      cwd: this.#runtime.cwd,
      ...optionalProperties(sessionDirectory === undefined ? undefined : { sessionDirectory }),
      allWorkspaces: scope === "all",
      search: query,
      limit: 200,
      ...optionalProperties(afterPath === undefined ? undefined : { afterPath }),
    }));
    if (!result.current) return;
    const page = result.value;
    this.#page = continuing ? [...this.#page, ...page.sessions] : page.sessions;
    this.#cursor = page.nextPath;
    this.#pageScope = scope;
    this.#pageQuery = query;
    const pickerItems = sessionPickerItems(this.#page, session.sessionFile);
    this.#terminal.setPickerItems("session", pickerItems, { scope, query });
    this.#terminal.setSessionPickerScope(scope);
    this.#terminal.setSessionPickerPagination(page.hasMore, page.hasMore ? `${this.#page.length} sessions loaded` : undefined);
  }

  async resume(argument: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (argument === "--all") {
      await this.refreshSessions("all");
      signal?.throwIfAborted();
      this.#terminal.openPicker("session", "Resume session");
      return;
    }
    if (argument !== "") {
      const manager = runtimeSessionManager(this.#runtime.session);
      const sessionDirectory = manager.usesDefaultSessionDir() ? undefined : manager.getSessionDir();
      const info = await resolveSessionFile({
        cwd: this.#runtime.cwd,
        reference: argument,
        ...optionalProperties(sessionDirectory === undefined ? undefined : { sessionDirectory }),
        allWorkspaces: true,
      });
      signal?.throwIfAborted();
      await this.switchSession(info.path, signal);
      return;
    }
    await this.refreshSessions();
    signal?.throwIfAborted();
    this.#terminal.openPicker("session", "Resume session");
  }

  async atlas(argument: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (argument.trim() !== "") throw new Error("Usage: /atlas");
    const session = this.#runtime.session;
    const manager = runtimeSessionManager(session);
    const entryCount = manager.getEntryCount();
    if (entryCount === 0) {
      this.#terminal.notify("Atlas is empty; send a message first", "status");
      return;
    }
    const pickerLimit = this.#terminal.getPickerItemLimit?.() ?? DEFAULT_TUI_LIMITS.maxPickerItems;
    const entryLimit = Math.min(200, Math.max(1, pickerLimit - 2));
    let offset = Math.max(0, entryCount - entryLimit);
    while (true) {
      signal?.throwIfAborted();
      const leafId = manager.getLeafId();
      let selection: AtlasTreeSelection;
      try {
        selection = await this.#terminal.chooseSessionTree(
          "Session Atlas · Current journal",
          this.#atlasPageItems(offset, entryLimit, entryCount),
          {
            filter: session.settingsManager.getTreeFilterMode(),
            ...optionalProperties(leafId === null ? undefined : { initialEventId: leafId }),
            onLabelChange: async (entryId, label) => {
              await this.#prepareAtlasMutation(signal);
              session.setLabel(entryId, label);
              const selected = manager.getLabel(entryId);
              return selected === undefined ? {} : { label: selected };
            },
          },
          signal,
        );
      } catch (error) {
        if (error instanceof TuiSelectionCancelledError) return;
        throw error;
      }
      if (selection.kind === "journal_page") {
        offset = selection.offset;
        continue;
      }
      await this.#selectAtlasEntryAction(selection.entryId, signal);
      return;
    }
  }

  #atlasPageItems(
    offset: number,
    entryLimit: number,
    entryCount: number,
  ): Array<PickerItem<AtlasTreeSelection> & { tree: SessionTreeMetadata }> {
    const manager = runtimeSessionManager(this.#runtime.session);
    const entries = sessionTreePickerItems(
      manager.getTreePage(offset, entryLimit),
      new Set(manager.getActiveBranchEntryIdsInPage(offset, entryLimit)),
    ).map((item): PickerItem<AtlasTreeSelection> & { tree: SessionTreeMetadata } => ({
      ...item,
      value: { kind: "entry", entryId: item.value },
    }));
    const maximumOffset = Math.max(0, entryCount - entryLimit);
    const navigationItem = (
      direction: "earlier" | "later",
      targetOffset: number,
    ): PickerItem<AtlasTreeSelection> & { tree: SessionTreeMetadata } => {
      const id = `atlas:navigation:${direction}:${targetOffset}`;
      return {
        id,
        label: direction === "earlier" ? "Earlier journal points" : "Later journal points",
        detail: `Enter to show entries ${targetOffset + 1}–${Math.min(entryCount, targetOffset + entryLimit)} of ${entryCount}`,
        keywords: [direction, "journal", "history", "page"],
        value: { kind: "journal_page", offset: targetOffset },
        tree: {
          eventId: id,
          kind: "navigation",
          depth: 0,
          prefix: "",
          branches: [],
          paths: [],
          active: false,
        },
      };
    };
    return [
      ...(offset > 0 ? [navigationItem("earlier", Math.max(0, offset - entryLimit))] : []),
      ...entries,
      ...(offset + entryLimit < entryCount
        ? [navigationItem("later", Math.min(maximumOffset, offset + entryLimit))]
        : []),
    ];
  }

  async switchSession(path: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (!this.#runtime.session.isIdle) throw new Error("Wait for the active turn or cancel it before switching sessions");
    if (!existsSync(path)) throw new Error("Selected session no longer exists");
    let result: { cancelled: boolean };
    let recovered = false;
    try {
      result = await this.#runtime.switchSession(path, signal === undefined ? undefined : { signal });
    } catch (error) {
      if (!(error instanceof MissingSessionCwdError)) throw error;
      const selectedCwd = await this.#selectFallbackCwd(error, signal);
      if (selectedCwd === undefined) { this.#terminal.notify("Session switch cancelled"); return; }
      result = await this.#runtime.switchSession(path, {
        cwdOverride: selectedCwd,
        ...optionalProperties(signal === undefined ? undefined : { signal }),
      });
      recovered = true;
    }
    if (result.cancelled) this.#terminal.notify("Session switch cancelled");
    else if (recovered) this.#terminal.notify("Resumed session in current working directory");
  }

  async #selectFallbackCwd(
    error: MissingSessionCwdError,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    try {
      return await this.#terminal.choose("Session working directory not found", [
        {
          label: "Continue in current working directory",
          detail: error.issue.fallbackCwd,
          value: error.issue.fallbackCwd,
        },
        {
          label: "Cancel",
          detail: `Missing: ${error.issue.sessionCwd}`,
          value: undefined,
        },
      ], signal);
    } catch (selectionError) {
      if (!(selectionError instanceof TuiSelectionCancelledError)) throw selectionError;
      return undefined;
    }
  }

  async handleCatalogAction(action:
    | Extract<TuiAction, { type: "session_open" | "session_scope" | "session_search" | "session_more" }>
  ): Promise<void> {
    if (action.type === "session_open" || action.type === "session_scope") {
      await this.refreshSessions(action.type === "session_scope" ? action.scope : "current");
      if (action.type === "session_open") this.#terminal.openPicker("session", "Resume session");
    } else if (action.type === "session_search") await this.refreshSessions(action.scope, action.query);
    else await this.refreshSessions(action.scope, action.query, true);
  }

  async selectCatalogItem(item: PickerItem, signal?: AbortSignal): Promise<void> {
    const value = item.value;
    if (!Check(STRING_VALUE, value)) throw new Error("Session picker returned an invalid selection");
    try {
      await this.switchSession(value, signal);
    } catch (error) {
      if (error instanceof TuiSelectionCancelledError) return;
      throw error;
    }
  }

  async #selectAtlasEntryAction(entryId: string, signal?: AbortSignal): Promise<void> {
    const manager = runtimeSessionManager(this.#runtime.session);
    const atHead = entryId === manager.getLeafId();
    let action: "branch" | "checkout" | "checkout-summary" | "snapshot";
    try {
      action = await this.#terminal.choose("Atlas action", [
        ...(!atHead ? [
          { label: "Checkout here", detail: "Move the active journal head without rewriting history", value: "checkout" as const },
          { label: "Checkout and summarize", detail: "Summarize the path being left before moving", value: "checkout-summary" as const },
        ] : []),
        { label: "Branch from here", detail: "Create a linked session through this point", value: "branch" as const },
        ...(atHead ? [{
          label: "Snapshot current head",
          detail: "Create an independent optionally named copy of the active path",
          value: "snapshot" as const,
        }] : []),
      ], signal);
    } catch (error) {
      if (error instanceof TuiSelectionCancelledError) return;
      throw error;
    }
    if (action === "branch") {
      await this.#prepareAtlasMutation(signal);
      const result = await this.#runtime.fork(entryId, {
        position: "at",
        ...optionalProperties(signal === undefined ? undefined : { signal }),
      });
      if (result.cancelled) this.#terminal.notify("Atlas branch cancelled");
      else {
        this.#terminal.setEditorText("");
        this.#terminal.notify("Created a linked Atlas branch");
      }
      return;
    }
    if (action === "snapshot") {
      let name: string;
      try {
        name = (await this.#terminal.question("Snapshot name (optional): ", signal, { cancelable: true })).trim();
      } catch (error) {
        if (error instanceof TuiSelectionCancelledError) return;
        throw error;
      }
      await this.#prepareAtlasMutation(signal);
      await this.#snapshotSession(name, signal);
      return;
    }
    await this.#checkoutAtlasEntry(entryId, action === "checkout-summary", signal);
  }

  async #prepareAtlasMutation(signal?: AbortSignal): Promise<void> {
    const session = this.#runtime.session;
    if (!session.isStreaming) return;
    await interruptInteractiveRunForCommand({
      session,
      command: "/atlas",
      terminal: this.#terminal,
      ...optionalProperties(signal === undefined ? undefined : { signal }),
      interrupt: async () => {
        await restoreQueuedMessagesThenAbort(session, this.#terminal, "Atlas action requested");
      },
    });
    signal?.throwIfAborted();
  }

  async #checkoutAtlasEntry(entryId: string, summarize: boolean, signal?: AbortSignal): Promise<void> {
    const session = this.#runtime.session;
    if (session.isStreaming) {
      await interruptInteractiveRunForCommand({
        session,
        command: "/atlas",
        terminal: this.#terminal,
        ...optionalProperties(signal === undefined ? undefined : { signal }),
        interrupt: async () => {
          await restoreQueuedMessagesThenAbort(session, this.#terminal, "Atlas checkout requested");
        },
      });
      signal?.throwIfAborted();
    }
    const cancel = (): void => session.abortBranchSummary();
    let release = (): void => undefined;
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      if (summarize) {
        this.#terminal.setInputBlocked("Summarizing branch… Esc to cancel", "summary");
        release = this.#registerSummaryCancelHandler(cancel);
      }
      const result = await session.navigateTree(entryId, { summarize });
      signal?.throwIfAborted();
      if (result.cancelled) {
        this.#terminal.notify(result.aborted === true ? "Atlas summary cancelled" : "Atlas checkout cancelled");
        return;
      }
      if (result.editorText !== undefined && this.#terminal.getEditorText().trim() === "") {
        this.#terminal.setEditorText(result.editorText);
      }
      this.#refreshTranscript();
      this.#updateContext();
      this.#terminal.notify("Checked out the selected Atlas point");
    } finally {
      signal?.removeEventListener("abort", cancel);
      release();
      if (summarize) this.#terminal.setInputBlocked();
    }
  }

  async #snapshotSession(name: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const leafId = runtimeSessionManager(this.#runtime.session).getLeafId();
    if (leafId === null) {
      this.#terminal.notify("Nothing to snapshot yet");
      return;
    }
    const result = await this.#runtime.fork(leafId, {
      position: "at",
      ...optionalProperties(signal === undefined ? undefined : { signal }),
    });
    if (result.cancelled) {
      this.#terminal.notify("Atlas snapshot cancelled");
      return;
    }
    if (name !== "") this.#runtime.session.setSessionName(name);
    this.#terminal.setEditorText("");
    this.#terminal.notify(name === "" ? "Created an Atlas snapshot" : `Created Atlas snapshot "${name}"`);
  }

  async handleMutation(action:
    | Extract<TuiAction, { type: "session_delete" }>
  ): Promise<void> {
    const path = Check(STRING_VALUE, action.item.value) ? action.item.value : "";
    if (path === "") throw new Error("Only saved sessions can be deleted");
    if (
      this.#runtime.session.sessionFile !== undefined &&
      sameFilesystemPath(path, this.#runtime.session.sessionFile)
    ) throw new Error("Cannot delete the active session");
    const method = await deleteSessionFile(path, {
      cwd: this.#runtime.cwd,
      processRunner: this.#processRunner,
    });
    this.#terminal.notify(method === "trash" ? "Session moved to trash" : "Session deleted permanently");
    await this.refreshSessions(action.scope, action.query);
  }

  async name(argument: string): Promise<void> {
    const name = argument || await this.#terminal.question("Session name: ");
    this.#runtime.session.setSessionName(name);
    this.#updateContext();
  }

  async showSession(): Promise<void> {
    const session = this.#runtime.session;
    const stats = session.getSessionStats();
    const model = session.model;
    const context = {
      model: model === undefined ? null : { provider: model.provider, modelId: model.id },
    };
    const info = (await SessionManager.listAll(runtimeSessionManager(session).getSessionDir()))
      .find((entry) => entry.path === session.sessionFile);
    if (info !== undefined) {
      this.#terminal.notify(formatSessionReport({ session: info, context, stats }));
      return;
    }
    this.#terminal.notify(`Session: ${session.sessionId}\nID: ${session.sessionId}\n${formatSessionUsageReport(stats)}`);
  }

  async exportSession(argument: string, forceRedact: boolean): Promise<void> {
    const request = forceRedact ? { redact: true, pathArgument: argument } : parseInteractiveExportRequest(argument);
    const selected = parseInteractivePathArgument(request.pathArgument, request.redact ? "/share" : "/export");
    const path = resolve(this.#runtime.cwd, selected || `${this.#runtime.session.sessionId}.html`);
    if (extname(path).toLowerCase() === ".jsonl") this.#runtime.session.exportToJsonl(path, { redact: request.redact });
    else await this.#runtime.session.exportToHtml(path, { redact: request.redact });
    this.#terminal.notify(`Exported ${path}`);
  }

  async shareSession(argument: string, signal?: AbortSignal): Promise<void> {
    if (argument.trim() !== "") throw new Error("Usage: /share");
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "ohm-share-"));
    const path = join(temporaryDirectory, "ohm-session.html");
    const operationSignal = signal === undefined
      ? AbortSignal.timeout(120_000)
      : AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
    try {
      await this.#runtime.session.exportToHtml(path, { redact: true });
      let authentication: CommandResult;
      try {
        authentication = await this.#processRunner.run({
          argv: ["gh", "auth", "status"],
          cwd: this.#runtime.cwd,
          timeoutMs: 30_000,
          outputLimitBytes: SHARE_OUTPUT_LIMIT_BYTES,
        }, operationSignal);
      } catch (error) {
        throw new Error(
          `GitHub CLI is not available: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      if (authentication.exitCode !== 0) {
        throw new Error(processFailure(authentication, "GitHub CLI is not authenticated; run gh auth login"));
      }
      const shared = await this.#processRunner.run({
        argv: ["gh", "gist", "create", "--public=false", path],
        cwd: this.#runtime.cwd,
        timeoutMs: 120_000,
        outputLimitBytes: SHARE_OUTPUT_LIMIT_BYTES,
      }, operationSignal);
      if (shared.exitCode !== 0) throw new Error(processFailure(shared, "GitHub CLI could not create the Gist"));
      this.#terminal.notify(`Share URL: ${secretGistUrl(shared.stdout.toString("utf8"))}`);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  async importSession(argument: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    let selectedArgument = argument;
    if (selectedArgument.trim() === "") {
      try {
        selectedArgument = await this.#terminal.question("Import session JSONL path: ", signal, { cancelable: true });
      } catch (error) {
        if (!(error instanceof TuiSelectionCancelledError)) throw error;
        this.#terminal.notify("Import cancelled");
        return;
      }
    }
    const selected = parseInteractivePathArgument(selectedArgument, "/import");
    if (selected === "") { this.#terminal.notify("Import cancelled"); return; }
    const path = this.#resolveInputPath(selected);
    let confirmed: boolean;
    try {
      confirmed = await this.#terminal.choose("Import session", [
        { label: "Import and replace current session", detail: path, value: true },
        { label: "Cancel", value: false },
      ], signal);
    } catch (error) {
      if (!(error instanceof TuiSelectionCancelledError)) throw error;
      this.#terminal.notify("Import cancelled");
      return;
    }
    if (!confirmed) { this.#terminal.notify("Import cancelled"); return; }
    let result: { cancelled: boolean };
    try {
      result = await this.#runtime.importFromJsonl(path, undefined, signal);
    } catch (error) {
      if (!(error instanceof MissingSessionCwdError)) throw error;
      const selectedCwd = await this.#selectFallbackCwd(error, signal);
      if (selectedCwd === undefined) { this.#terminal.notify("Import cancelled"); return; }
      result = await this.#runtime.importFromJsonl(path, selectedCwd, signal);
    }
    this.#terminal.notify(result.cancelled ? "Import cancelled" : `Imported session from ${path}`);
  }

  async saveProjectTrust(): Promise<void> {
    const workspace = this.#runtime.cwd;
    const agentDir = this.#runtime.services.agentDir;
    if (projectConfigRootMatchesAgentDir(workspace, agentDir)) {
      this.#terminal.notify(
        "Project trust is unavailable because this workspace's .ohm directory is the active ohm home.",
        "warning",
      );
      return;
    }
    const store = new TrustStore(join(agentDir, "trusted-workspaces.json"));
    const action = await this.#terminal.choose("Project trust", [
      { label: "Trust this workspace", detail: workspace, value: "trust" as const },
      { label: "Trust workspace and descendants", detail: workspace, value: "descendants" as const },
      { label: "Do not trust this workspace", detail: workspace, value: "deny" as const },
      { label: "Remove saved decision", detail: workspace, value: "remove" as const },
    ]);
    if (action === "trust") await store.trust(workspace);
    else if (action === "descendants") await store.trustDescendants(workspace);
    else if (action === "deny") await store.deny(workspace);
    else await store.untrust(workspace);
    this.#terminal.notify("Saved project trust decision. Restart ohm for it to take effect.");
  }

  showContext(): void {
    const session = this.#runtime.session;
    const model = session.model;
    const usage = session.getContextUsage();
    const lines = [
      `Model: ${model === undefined ? "none" : `${model.provider}/${model.id} (${model.api})`} · thinking: ${session.thinkingLevel}`,
      usage === undefined
        ? "Context: unknown (model context window unavailable)"
        : `Context: ${usage.tokens === null ? "unknown" : usage.tokens}/${usage.contextWindow} tokens${usage.percent === null ? "" : ` (${usage.percent.toFixed(1)}%)`}`,
      `Messages: ${session.messages.length} · auto-compaction: ${session.autoCompactionEnabled ? "on" : "off"} · context operation: ${session.isCompacting ? "running" : "idle"}`,
    ];
    const composition = session.getPromptComposition();
    if (composition === undefined) {
      lines.push("System prompt: not composed yet");
    } else {
      const bounded = (values: readonly string[]): string => {
        const shown = values.slice(0, 12);
        return `${shown.join(", ")}${values.length > shown.length ? `, +${values.length - shown.length} more` : ""}`;
      };
      const promptKind = composition.sources.some((source) => source.source === "built-in:system-prompt")
        ? "built-in core"
        : "custom core";
      lines.push(
        `System prompt: ${composition.bytes} bytes · ${promptKind} · sha256 ${composition.sha256}${composition.truncated ? " · provenance truncated" : ""}`,
        `Prompt sources: ${composition.sources.length === 0
          ? "none"
          : bounded(composition.sources.map((source) =>
              `${source.kind.replaceAll("_", " ")}: ${JSON.stringify(source.source)}`))}`,
        `Prompt skills: ${composition.skills.length === 0
          ? "none"
          : bounded(composition.skills.map((skill) =>
              `${skill.name} (${JSON.stringify(skill.manifestPath)})`))}`,
        `Prompt tools: ${composition.tools.length === 0 ? "none" : bounded(composition.tools)}`,
      );
    }
    this.#terminal.notify(lines.join("\n"));
  }

  async copyLatestAssistant(required = true): Promise<void> {
    const value = this.#runtime.session.getLastAssistantText();
    if (value === undefined) {
      if (required) throw new Error("No assistant text is available");
      return;
    }
    await this.#terminal.copyToClipboard(value);
  }

  async compact(argument: string): Promise<void> {
    try {
      await this.#runtime.session.compact(argument || undefined);
      this.#refreshTranscript({ preserveExisting: true });
    } finally {
      this.#updateContext();
    }
  }
}
