import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  InteractiveSessionOperations,
  type InteractiveSessionOperationsTerminal,
  type InteractiveSessionOperationsSession,
  type InteractiveSessionRuntime,
} from "../../src/modes/interactive-session-operations.js";
import type { AgentSessionRecoveryOptions } from "../../src/service/agent-session.js";
import { TuiSelectionCancelledError } from "../../src/tui/contracts.js";
import { TuiController } from "../../src/tui/controller.js";
import { INTERNAL_TUI_FRAME_PROJECTOR } from "../../src/tui/frame-projector.js";
import type { PickerItem } from "../../src/tui/types.js";
import type { CommandResult, CommandSpec, ProcessRunner } from "../../src/process/types.js";
import type { SessionInfo } from "../../src/storage/types.js";
import { createFixtureFrameProjector, envelope, FakeInput, FakeOutput, tick } from "../tui/helpers.js";
import { FocusedVirtualTerminal } from "../tui/virtual-terminal.js";

function result(stdout = "", stderr = "", exitCode = 0): CommandResult {
  return {
    exitCode,
    signal: null,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
    stdoutBytes: Buffer.byteLength(stdout),
    stderrBytes: Buffer.byteLength(stderr),
    timedOut: false,
    cancelled: false,
    durationMs: 1,
  };
}

function terminalFixture(
  overrides: Partial<InteractiveSessionOperationsTerminal> = {},
): InteractiveSessionOperationsTerminal {
  return {
    notify() { throw new Error("Unexpected terminal notification"); },
    async choose<T>(): Promise<T> { throw new Error("Unexpected terminal choice"); },
    async chooseSessionTree<T>(): Promise<T> { throw new Error("Unexpected tree choice"); },
    async question(): Promise<string> { throw new Error("Unexpected terminal question"); },
    async copyToClipboard(): Promise<void> { throw new Error("Unexpected clipboard write"); },
    getEditorText() { throw new Error("Unexpected editor read"); },
    setEditorText() { throw new Error("Unexpected editor write"); },
    setInputBlocked() { throw new Error("Unexpected input block"); },
    setPickerItems<_T>() { throw new Error("Unexpected picker update"); },
    setSessionPickerScope() { throw new Error("Unexpected picker scope update"); },
    setSessionPickerPagination() { throw new Error("Unexpected picker pagination update"); },
    openPicker() { throw new Error("Unexpected picker open"); },
    assertQueuedMessagesRestorable() { throw new Error("Unexpected queue validation"); },
    restoreQueuedMessages() { throw new Error("Unexpected queue restoration"); },
    ...overrides,
  };
}

type OperationsSessionFixture = Omit<
  Partial<InteractiveSessionOperationsSession>,
  "nativeSessionManager" | "settingsManager"
> & {
  nativeSessionManager?: Partial<InteractiveSessionOperationsSession["nativeSessionManager"]>;
  settingsManager?: Partial<InteractiveSessionOperationsSession["settingsManager"]>;
};

function operationsSessionFixture(
  fixture: OperationsSessionFixture,
): InteractiveSessionOperationsSession {
  // SAFETY: every supplied member is checked against the production session capability;
  // omitted members deliberately fail if a test reaches outside its declared fixture surface.
  return fixture as InteractiveSessionOperationsSession;
}

function treeSession(overrides: OperationsSessionFixture = {}): InteractiveSessionOperationsSession {
  const timestamp = "2026-07-20T00:00:00.000Z";
  const entry = (id: string, parentId: string | null, text: string) => ({
    type: "message" as const,
    id,
    parentId,
    timestamp,
    message: {
      id: `message-${id}`,
      role: "user" as const,
      content: [{ type: "text" as const, text }],
      createdAt: timestamp,
    },
  });
  const root = entry("root", null, "Root");
  const leaf = entry("leaf", "root", "Current leaf");
  const target = entry("target", "root", "Alternate branch");
  const fixture = {
    nativeSessionManager: {
      getEntryCount: () => 3,
      getTree: () => [{
        entry: root,
        children: [
          { entry: leaf, children: [] },
          { entry: target, children: [] },
        ],
      }],
      getBranch: () => [root, leaf],
      getLeafId: () => "leaf",
    },
    settingsManager: {
      getTreeFilterMode: (): "default" => "default",
      getBranchSummarySkipPrompt: () => false,
    },
    isStreaming: false,
    setLabel() {},
    async navigateTree() { return { cancelled: false }; },
    ...overrides,
  };
  return operationsSessionFixture(fixture);
}

function treeRuntime(
  session: InteractiveSessionOperationsSession,
  overrides: Partial<Omit<InteractiveSessionRuntime, "session">> = {},
): InteractiveSessionRuntime {
  return {
    session,
    cwd: process.cwd(),
    services: { agentDir: process.cwd() },
    async newSession() { return { cancelled: false }; },
    async switchSession() { return { cancelled: false }; },
    async fork() { return { cancelled: false }; },
    async importFromJsonl() { return { cancelled: false }; },
    ...overrides,
  };
}

function catalogSession(id: string): SessionInfo {
  return {
    path: `/sessions/${id}.jsonl`,
    id,
    cwd: process.cwd(),
    created: new Date("2026-01-01T00:00:00.000Z"),
    modified: new Date("2026-01-01T00:00:00.000Z"),
    messageCount: 1,
    firstMessage: id,
    allMessagesText: id,
  };
}

test("cancelling a session-picker selection is silent without hiding switch failures", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-session-picker-cancel-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const path = join(root, "selected.jsonl");
  await writeFile(path, "{}\n");
  const otherContextCancellation = new TuiSelectionCancelledError();
  const failures = [
    new TuiSelectionCancelledError(),
    new Error("session load failed"),
    otherContextCancellation,
  ];
  const operations = new InteractiveSessionOperations({
    runtime: treeRuntime(operationsSessionFixture({ isIdle: true }), {
      async switchSession() { throw failures.shift(); },
    }),
    terminal: terminalFixture(),
    refreshTranscript() {},
    updateContext() {},
  });
  const item: PickerItem<string> = { id: path, label: "Selected", value: path };

  await operations.selectCatalogItem(item);
  await assert.rejects(operations.selectCatalogItem(item), /session load failed/u);
  await assert.rejects(operations.switchSession(path), (error) => error === otherContextCancellation);
  await assert.rejects(
    operations.selectCatalogItem({ id: "invalid", label: "Invalid", value: 42 }),
    /invalid selection/u,
  );
});

test("bare /recover safely retries first, then abandons every remaining blocked effect without replay", async () => {
  const calls: AgentSessionRecoveryOptions[] = [];
  const notifications: Array<[string, string | undefined]> = [];
  const controller = new AbortController();
  // SAFETY: recovery tests invoke only recoverInterruptedRun on this session fixture.
  const session = operationsSessionFixture({
    async recoverInterruptedRun(options: AgentSessionRecoveryOptions = {}) {
      calls.push(options);
      if (calls.length === 1) {
        return {
          recovered: false as const,
          operationId: "run-restart",
          blocked: [
            { effectId: "effect-bash", name: "bash", reason: "This tool cannot be repeated safely." },
            { effectId: "effect-write", name: "write", reason: "The tool outcome is still uncertain." },
          ],
        };
      }
      return { recovered: true as const, operationId: "run-restart", blocked: [] as const };
    },
  });
  const operations = new InteractiveSessionOperations({
    runtime: treeRuntime(session),
    terminal: terminalFixture({
      notify(message, kind) { notifications.push([message, kind]); },
    }),
    refreshTranscript() {},
    updateContext() {},
  });

  await operations.recover("", controller.signal);

  assert.deepEqual(calls, [
    { signal: controller.signal },
    {
      signal: controller.signal,
      resolutions: [
        { effectId: "effect-bash", outcome: "abandoned" },
        { effectId: "effect-write", outcome: "abandoned" },
      ],
    },
  ]);
  assert.deepEqual(notifications, [[
    "Recovered interrupted operation run-restart; abandoned 2 blocked tool calls without replay. " +
      "Send a prompt to continue; the next model turn will see the recovery result.",
    "status",
  ]]);
});

test("explicit /recover abandon keeps one-effect manual resolution semantics", async () => {
  const calls: AgentSessionRecoveryOptions[] = [];
  // SAFETY: recovery tests invoke only recoverInterruptedRun on this session fixture.
  const session = operationsSessionFixture({
    async recoverInterruptedRun(options: AgentSessionRecoveryOptions) {
      calls.push(options);
      return { recovered: true as const, operationId: "run-explicit", blocked: [] as const };
    },
  });
  const operations = new InteractiveSessionOperations({
    runtime: treeRuntime(session),
    terminal: terminalFixture({ notify() {} }),
    refreshTranscript() {},
    updateContext() {},
  });

  await operations.recover("abandon effect-one");

  assert.deepEqual(calls, [{ resolutions: [{ effectId: "effect-one", outcome: "abandoned" }] }]);
});

test("/fork branches before the selected user message and restores its text", async () => {
  const signal = new AbortController().signal;
  const calls: Array<{ entryId: string; position?: "before" | "at"; signal?: AbortSignal }> = [];
  const editor: string[] = [];
  const notifications: string[] = [];
  const session = operationsSessionFixture({
    getUserMessagesForForking: () => [
      { entryId: "user-one", text: "First prompt" },
      { entryId: "user-two", text: "Second prompt" },
    ],
  });
  const operations = new InteractiveSessionOperations({
    runtime: treeRuntime(session, {
      async fork(entryId, options) {
        calls.push({ entryId, ...options });
        return { cancelled: false, selectedText: "Second prompt" };
      },
    }),
    terminal: terminalFixture({
      async choose(_prompt, choices) { return choices[1]!.value; },
      setEditorText(value) { editor.push(value); },
      notify(message) { notifications.push(message); },
    }),
    refreshTranscript() {},
    updateContext() {},
  });

  await operations.fork("", signal);

  assert.deepEqual(calls, [{ entryId: "user-two", signal }]);
  assert.deepEqual(editor, ["Second prompt"]);
  assert.deepEqual(notifications, ["Forked from the selected message"]);
});

test("/clone copies the current leaf and rejects command arguments", async () => {
  const calls: Array<{ entryId: string; position?: "before" | "at" }> = [];
  const editor: string[] = [];
  const session = treeSession();
  const operations = new InteractiveSessionOperations({
    runtime: treeRuntime(session, {
      async fork(entryId, options) {
        calls.push(options?.position === undefined
          ? { entryId }
          : { entryId, position: options.position });
        return { cancelled: false };
      },
    }),
    terminal: terminalFixture({
      setEditorText(value) { editor.push(value); },
      notify() {},
    }),
    refreshTranscript() {},
    updateContext() {},
  });

  await operations.clone("");

  assert.deepEqual(calls, [{ entryId: "leaf", position: "at" }]);
  assert.deepEqual(editor, [""]);
  await assert.rejects(operations.clone("unexpected"), /Usage: \/clone/u);
});

test("/scoped-models reports, replaces, and clears the session-owned exact scope", () => {
  let selectors = ["alpha/one"];
  let updates = 0;
  const notifications: string[] = [];
  const session = operationsSessionFixture({
    get modelScopeSelectors() { return selectors; },
    setModelScope(value) { selectors = [...value]; },
  });
  const operations = new InteractiveSessionOperations({
    runtime: treeRuntime(session),
    terminal: terminalFixture({ notify(message) { notifications.push(message); } }),
    refreshTranscript() {},
    updateContext() { updates += 1; },
  });

  operations.scopedModels("");
  operations.scopedModels("beta/two, beta/family/three");
  operations.scopedModels("all");

  assert.deepEqual(selectors, []);
  assert.equal(updates, 2);
  assert.deepEqual(notifications, [
    "Model scope: alpha/one",
    "Model scope: beta/two, beta/family/three",
    "Model scope: all available models",
  ]);
  assert.throws(() => operations.scopedModels("beta/*"), /exact provider\/model/u);
});

test("/trust rejects the active ohm home without saving an inert decision", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-project-trust-collision-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const workspace = join(root, "home");
  const agentDir = join(workspace, ".ohm");
  await mkdir(agentDir, { recursive: true });
  let choicePrompts = 0;
  const notifications: Array<[string, string | undefined]> = [];
  const operations = new InteractiveSessionOperations({
    runtime: {
      // SAFETY: saveProjectTrust never reads the session object.
      session: operationsSessionFixture({ isIdle: true }),
      cwd: workspace,
      services: { agentDir },
      async newSession() { return { cancelled: false }; },
      async switchSession() { return { cancelled: false }; },
      async fork() { return { cancelled: false }; },
      async importFromJsonl() { return { cancelled: false }; },
    },
    terminal: terminalFixture({
      async choose(_prompt, choices) {
        choicePrompts += 1;
        const selected = choices.find((choice) => choice.value === "trust");
        if (selected === undefined) throw new Error("Trust choice is unavailable");
        return selected.value;
      },
      notify(message, level) { notifications.push([message, level]); },
    }),
    refreshTranscript() {},
    updateContext() {},
  });

  await operations.saveProjectTrust();

  assert.equal(choicePrompts, 0);
  assert.deepEqual(notifications, [[
    "Project trust is unavailable because this workspace's .ohm directory is the active ohm home.",
    "warning",
  ]]);
  await assert.rejects(access(join(agentDir, "trusted-workspaces.json")), /ENOENT/u);
});

test("interactive session catalog ignores stale scope results and failures", async () => {
  for (const staleOutcome of ["success", "failure"] as const) {
    let resolveAll!: (value: { sessions: SessionInfo[]; hasMore: boolean }) => void;
    let rejectAll!: (cause: unknown) => void;
    const allPage = new Promise<{ sessions: SessionInfo[]; hasMore: boolean }>((resolvePromise, rejectPromise) => {
      resolveAll = resolvePromise;
      rejectAll = rejectPromise;
    });
    const scopes: Array<"current" | "all"> = [];
    const itemIds: string[][] = [];
    const session = treeSession({
      sessionFile: undefined,
    nativeSessionManager: {
        usesDefaultSessionDir: () => true,
        getSessionDir: () => "/sessions",
      },
    });
    const operations = new InteractiveSessionOperations({
      runtime: treeRuntime(session),
      terminal: terminalFixture({
        setPickerItems(_picker, items) { itemIds.push(items.map((item) => item.id)); },
        setSessionPickerScope(scope) { scopes.push(scope); },
        setSessionPickerPagination() {},
      }),
      refreshTranscript() {},
      updateContext() {},
      async sessionCatalogLoader(query) {
        if (query.allWorkspaces === true) return await allPage;
        return { sessions: [catalogSession("current")], hasMore: false };
      },
    });

    const stale = operations.refreshSessions("all");
    await operations.refreshSessions("current");
    if (staleOutcome === "success") resolveAll({ sessions: [catalogSession("stale-all")], hasMore: false });
    else rejectAll(new Error("stale catalog failure"));
    await assert.doesNotReject(stale);

    assert.deepEqual(scopes, ["current"]);
    assert.deepEqual(itemIds, [[catalogSession("current").path]]);
  }
});

test("interactive session catalog reuses an identical in-flight All load", async () => {
  let resolveAll!: (value: { sessions: SessionInfo[]; hasMore: boolean }) => void;
  const allPage = new Promise<{ sessions: SessionInfo[]; hasMore: boolean }>((resolvePromise) => {
    resolveAll = resolvePromise;
  });
  let allLoads = 0;
  const scopes: Array<"current" | "all"> = [];
  const session = treeSession({
    sessionFile: undefined,
    nativeSessionManager: {
      usesDefaultSessionDir: () => true,
      getSessionDir: () => "/sessions",
    },
  });
  const operations = new InteractiveSessionOperations({
    runtime: treeRuntime(session),
    terminal: terminalFixture({
      setPickerItems() {},
      setSessionPickerScope(scope) { scopes.push(scope); },
      setSessionPickerPagination() {},
    }),
    refreshTranscript() {},
    updateContext() {},
    async sessionCatalogLoader(query) {
      if (query.allWorkspaces === true) {
        allLoads += 1;
        return await allPage;
      }
      return { sessions: [catalogSession("current")], hasMore: false };
    },
  });

  const firstAll = operations.refreshSessions("all");
  const current = operations.refreshSessions("current");
  const secondAll = operations.refreshSessions("all");
  await new Promise<void>((resolveWait) => setImmediate(resolveWait));
  assert.equal(allLoads, 1);

  resolveAll({ sessions: [catalogSession("all")], hasMore: false });
  await Promise.all([firstAll, current, secondAll]);
  assert.deepEqual(scopes, ["all"]);
});

test("session deletion rejects an active file reached through another symlink alias", {
  skip: process.platform === "win32" ? "directory symlinks require optional Windows privileges" : false,
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-active-session-alias-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const real = join(root, "real");
  const aliasA = join(root, "alias-a");
  const aliasB = join(root, "alias-b");
  await mkdir(real);
  await symlink(real, aliasA, "dir");
  await symlink(real, aliasB, "dir");
  await writeFile(join(real, "active.jsonl"), "session\n");

  const operations = new InteractiveSessionOperations({
    runtime: treeRuntime(treeSession({ sessionFile: join(aliasA, "active.jsonl") })),
    terminal: terminalFixture(),
    refreshTranscript() {},
    updateContext() {},
  });
  await assert.rejects(
    operations.handleMutation({
      type: "session_delete",
      item: { id: "active", label: "Active", value: join(aliasB, "active.jsonl") },
      scope: "current",
      query: "",
    }),
    /Cannot delete the active session/u,
  );
});

test("/atlas opens only the active journal tree and never loads the saved-session catalog", async () => {
  const timestamp = "2026-08-21T00:00:00.000Z";
  const rootEntry = {
    type: "message" as const,
    id: "root-entry",
    parentId: null,
    timestamp,
    message: {
      id: "root-message",
      role: "user" as const,
      content: [{ type: "text" as const, text: "Start" }],
      createdAt: timestamp,
    },
  };
  // SAFETY: this Atlas test reads only the declared journal and filter members.
  const session = operationsSessionFixture({
    settingsManager: { getTreeFilterMode: () => "default" },
    nativeSessionManager: {
      getEntryCount: () => 1,
      getTreePage: () => [{ entry: rootEntry, children: [], depth: 0 }],
      getActiveBranchEntryIdsInPage: () => [rootEntry.id],
      getLeafId: () => rootEntry.id,
    },
  });
  let catalogLoads = 0;
  let title = "";
  let pickerItems: Array<{ tree?: { kind?: string }; value: unknown }> = [];
  let initialEventId: string | undefined;
  let filter: string | undefined;
  const operations = new InteractiveSessionOperations({
    runtime: treeRuntime(session),
    terminal: terminalFixture({
      getPickerItemLimit: () => 100,
      async chooseSessionTree(
        prompt,
        items,
        options,
      ) {
        title = prompt;
        pickerItems = [...items];
        initialEventId = options?.initialEventId;
        filter = options?.filter;
        throw new TuiSelectionCancelledError();
      },
    }),
    refreshTranscript() {},
    updateContext() {},
    async sessionCatalogLoader() {
      catalogLoads += 1;
      return { sessions: [catalogSession("unrelated")], hasMore: false };
    },
  });

  await operations.atlas("");

  assert.equal(catalogLoads, 0);
  assert.equal(title, "Session Atlas · Current journal");
  assert.equal(initialEventId, rootEntry.id);
  assert.equal(filter, "default");
  assert.equal(pickerItems.length, 1);
  assert.equal(pickerItems.every((item) => item.tree !== undefined), true);
  assert.deepEqual(pickerItems[0]?.value, { kind: "entry", entryId: rootEntry.id });
  await assert.rejects(operations.atlas("--all"), /Usage: \/atlas/u);
});

test("/atlas explains an empty journal without opening a picker or loading sessions", async () => {
  const notifications: Array<[string, string | undefined]> = [];
  let opened = false;
  let catalogLoads = 0;
  const emptySessionFixture = {
      nativeSessionManager: { getEntryCount: () => 0 },
  };
  // SAFETY: empty Atlas detection reads only the journal entry count from this fixture.
  const emptySession = operationsSessionFixture(emptySessionFixture);
  const operations = new InteractiveSessionOperations({
    runtime: treeRuntime(emptySession),
    terminal: terminalFixture({
      notify(message, kind) { notifications.push([message, kind]); },
      async chooseSessionTree() {
        opened = true;
        throw new Error("unexpected picker");
      },
    }),
    refreshTranscript() {},
    updateContext() {},
    async sessionCatalogLoader() {
      catalogLoads += 1;
      return { sessions: [], hasMore: false };
    },
  });

  await operations.atlas("");

  assert.equal(opened, false);
  assert.equal(catalogLoads, 0);
  assert.deepEqual(notifications, [["Atlas is empty; send a message first", "status"]]);
});

test("Atlas pages a large journal without building its complete tree", async () => {
  const timestamp = "2026-08-21T00:00:00.000Z";
  const offsets: number[] = [];
  let catalogLoads = 0;
  // SAFETY: pagination reads only the declared journal page and filter members.
  const session = operationsSessionFixture({
    settingsManager: { getTreeFilterMode: () => "all" },
    nativeSessionManager: {
      getEntryCount: () => 400,
      getTreePage(offset: number) {
        offsets.push(offset);
        return [{
          depth: offset,
          children: [],
          entry: {
            type: "message" as const,
            id: `entry-${offset}`,
            parentId: null,
            timestamp,
            message: {
              id: `message-${offset}`,
              role: "user" as const,
              content: [{ type: "text" as const, text: `Entry ${offset}` }],
              createdAt: timestamp,
            },
          },
        }];
      },
      getActiveBranchEntryIdsInPage: (offset: number) => [`entry-${offset}`],
      getLeafId: () => "entry-399",
    },
  });
  const pages: Array<Array<{ tree?: { kind?: string }; value: unknown }>> = [];
  const terminal = terminalFixture({
    getPickerItemLimit: () => 205,
    async chooseSessionTree(
      _prompt,
      items,
    ) {
      pages.push([...items]);
      if (pages.length > 1) throw new TuiSelectionCancelledError();
      const earlier = items.find((item) => item.tree?.kind === "navigation");
      assert.ok(earlier);
      return earlier.value;
    },
  });
  const operations = new InteractiveSessionOperations({
    runtime: treeRuntime(session),
    terminal,
    refreshTranscript() {},
    updateContext() {},
    async sessionCatalogLoader() {
      catalogLoads += 1;
      return { sessions: [], hasMore: false };
    },
  });

  await operations.atlas("");

  assert.deepEqual(offsets, [200, 0]);
  assert.equal(catalogLoads, 0);
  assert.equal(pages.every((items) => items.every((item) => item.tree !== undefined)), true);
  assert.equal(pages[0]?.some((item) => item.tree?.kind === "navigation"), true);
  assert.equal(pages[1]?.some((item) => item.tree?.kind === "navigation"), true);
});

test("Atlas checkout can summarize, restore the editor, and refresh the active projection", async () => {
  const timestamp = "2026-08-21T00:00:00.000Z";
  const earlier = {
    type: "message" as const,
    id: "earlier",
    parentId: null,
    timestamp,
    message: {
      id: "earlier-message",
      role: "user" as const,
      content: [{ type: "text" as const, text: "Earlier point" }],
      createdAt: timestamp,
    },
  };
  const blockedStates: Array<string | undefined> = [];
  const notifications: string[] = [];
  const navigations: Array<{ target: string; summarize: boolean | undefined }> = [];
  let refreshed = 0;
  let contexts = 0;
  let editor = "";
  // SAFETY: checkout exercises only the declared journal, navigation, and summary members.
  const session = operationsSessionFixture({
    isStreaming: false,
    settingsManager: { getTreeFilterMode: () => "default" },
    nativeSessionManager: {
      getEntryCount: () => 1,
      getTreePage: () => [{ entry: earlier, children: [], depth: 0 }],
      getActiveBranchEntryIdsInPage: () => [],
      getLeafId: () => "leaf",
    },
    abortBranchSummary() {},
    async navigateTree(target: string, options: { summarize?: boolean }) {
      navigations.push({ target, summarize: options.summarize });
      return { cancelled: false, editorText: "restored draft" };
    },
  });
  const operations = new InteractiveSessionOperations({
    runtime: treeRuntime(session),
    terminal: terminalFixture({
      async chooseSessionTree(_prompt, items) { return items[0]!.value; },
      async choose(_prompt, choices) {
        const selected = choices.find((choice) => choice.value === "checkout-summary");
        if (selected === undefined) throw new Error("Summary checkout choice is unavailable");
        return selected.value;
      },
      setInputBlocked(message?: string) { blockedStates.push(message); },
      getEditorText() { return editor; },
      setEditorText(value: string) { editor = value; },
      notify(message: string) { notifications.push(message); },
    }),
    refreshTranscript() { refreshed += 1; },
    updateContext() { contexts += 1; },
  });

  await operations.atlas("");

  assert.deepEqual(navigations, [{ target: "earlier", summarize: true }]);
  assert.equal(editor, "restored draft");
  assert.equal(refreshed, 1);
  assert.equal(contexts, 1);
  assert.deepEqual(blockedStates, ["Summarizing branch… Esc to cancel", undefined]);
  assert.deepEqual(notifications, ["Checked out the selected Atlas point"]);
});

test("/share uploads one temporary redacted HTML export as a secret Gist and removes it", async (context) => {
  const cwd = await mkdtemp(join(tmpdir(), "ohm-share-test-"));
  context.after(async () => await rm(cwd, { recursive: true, force: true }));
  const calls: CommandSpec[] = [];
  let exportedPath = "";
  let exportedOptions: { redact?: boolean } | undefined;
  const notifications: string[] = [];
  // SAFETY: sharing reads sessionId and invokes only exportToHtml on this fixture.
  const session = operationsSessionFixture({
    sessionId: "session-test",
    async exportToHtml(path: string, options: { redact?: boolean } = {}) {
      exportedPath = path;
      exportedOptions = options;
      await writeFile(path, "<html>redacted</html>");
      return path;
    },
  });
  const runtime = {
    session,
    cwd,
    services: { agentDir: join(cwd, ".ohm") },
    async newSession() { return { cancelled: false }; },
    async switchSession() { return { cancelled: false }; },
    async fork() { return { cancelled: false }; },
    async importFromJsonl() { return { cancelled: false }; },
  } satisfies InteractiveSessionRuntime;
  const runner: ProcessRunner = {
    async run(spec) {
      calls.push(spec);
      if (calls.length === 1) return result();
      assert.equal(await readFile(spec.argv.at(-1)!, "utf8"), "<html>redacted</html>");
      return result("https://gist.github.com/ohm-user/0123456789abcdef\n");
    },
  };
  const terminal = terminalFixture({
    notify(message: string) { notifications.push(message); },
  });
  const operations = new InteractiveSessionOperations({
    runtime,
    terminal,
    processRunner: runner,
    refreshTranscript() {},
    updateContext() {},
  });

  await operations.shareSession("");

  assert.deepEqual(exportedOptions, { redact: true });
  assert.deepEqual(calls.map((call) => call.argv.slice(0, 4)), [
    ["gh", "auth", "status"],
    ["gh", "gist", "create", "--public=false"],
  ]);
  assert.deepEqual(notifications, ["Share URL: https://gist.github.com/ohm-user/0123456789abcdef"]);
  await assert.rejects(access(exportedPath));
});

test("/share rejects path arguments before exporting or starting GitHub CLI", async () => {
  let exported = false;
  let started = false;
  // SAFETY: invalid /share arguments are rejected before this export fixture can be invoked.
  const session = operationsSessionFixture({
    async exportToHtml() { exported = true; return "unused"; },
  });
  const operations = new InteractiveSessionOperations({
    runtime: {
      session,
      cwd: process.cwd(),
      services: { agentDir: process.cwd() },
      async newSession() { return { cancelled: false }; },
      async switchSession() { return { cancelled: false }; },
      async fork() { return { cancelled: false }; },
      async importFromJsonl() { return { cancelled: false }; },
    },
    terminal: terminalFixture({ notify() {} }),
    processRunner: {
      async run() {
        started = true;
        return result();
      },
    },
    refreshTranscript() {},
    updateContext() {},
  });

  await assert.rejects(operations.shareSession("copy.html"), /Usage: \/share/u);
  assert.equal(exported, false);
  assert.equal(started, false);
});

test("/share forwards host cancellation to GitHub CLI work and removes its temporary export", async (context) => {
  const cwd = await mkdtemp(join(tmpdir(), "ohm-share-cancel-test-"));
  context.after(async () => await rm(cwd, { recursive: true, force: true }));
  let exportedPath = "";
  let started!: () => void;
  const commandStarted = new Promise<void>((resolve) => { started = resolve; });
  // SAFETY: sharing invokes only exportToHtml on this session fixture.
  const session = operationsSessionFixture({
    async exportToHtml(path: string) {
      exportedPath = path;
      await writeFile(path, "<html>redacted</html>");
      return path;
    },
  });
  const operations = new InteractiveSessionOperations({
    runtime: {
      session,
      cwd,
      services: { agentDir: join(cwd, ".ohm") },
      async newSession() { return { cancelled: false }; },
      async switchSession() { return { cancelled: false }; },
      async fork() { return { cancelled: false }; },
      async importFromJsonl() { return { cancelled: false }; },
    },
    terminal: terminalFixture({ notify() {} }),
    processRunner: {
      async run(_spec, signal): Promise<CommandResult> {
        started();
        return await new Promise<never>((_resolve, reject) => {
          const abort = (): void => reject(signal.reason);
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        });
      },
    },
    refreshTranscript() {},
    updateContext() {},
  });
  const controller = new AbortController();
  const pending = operations.shareSession("", controller.signal);
  await commandStarted;
  const reason = new Error("cancel share");
  controller.abort(reason);
  await assert.rejects(pending, (error) => error instanceof Error && error.cause === reason);
  await assert.rejects(access(exportedPath));
});

test("Atlas snapshots the current head and applies its optional name after replacement", async () => {
  const timestamp = "2026-08-21T00:00:00.000Z";
  const leaf = {
    type: "message" as const,
    id: "leaf",
    parentId: null,
    timestamp,
    message: {
      id: "leaf-message",
      role: "user" as const,
      content: [{ type: "text" as const, text: "Current head" }],
      createdAt: timestamp,
    },
  };
  const names: string[] = [];
  const notifications: string[] = [];
  let forkOptions: { position?: "before" | "at"; signal?: AbortSignal } | undefined;
  // SAFETY: snapshot exercises only the declared journal, naming, and streaming members.
  const session = operationsSessionFixture({
    isStreaming: false,
    settingsManager: { getTreeFilterMode: () => "default" },
    nativeSessionManager: {
      getEntryCount: () => 1,
      getTreePage: () => [{ entry: leaf, children: [], depth: 0 }],
      getActiveBranchEntryIdsInPage: () => [leaf.id],
      getLeafId: () => leaf.id,
    },
    setSessionName(name: string) { names.push(name); },
  });
  const runtime = {
    session,
    cwd: process.cwd(),
    services: { agentDir: process.cwd() },
    async newSession() { return { cancelled: false }; },
    async switchSession() { return { cancelled: false }; },
    async fork(entryId: string, options?: { position?: "before" | "at"; signal?: AbortSignal }) {
      assert.equal(entryId, "leaf");
      forkOptions = options;
      return { cancelled: false };
    },
    async importFromJsonl() { return { cancelled: false }; },
  } satisfies InteractiveSessionRuntime;
  const terminal = terminalFixture({
    async chooseSessionTree(_prompt, items) { return items[0]!.value; },
    async choose(_prompt, choices) {
      assert.equal(choices.some((choice) => choice.value === "snapshot"), true);
      const selected = choices.find((choice) => choice.value === "snapshot");
      if (selected === undefined) throw new Error("Snapshot choice is unavailable");
      return selected.value;
    },
    async question(_prompt, signal) {
      assert.equal(signal, controller.signal);
      return "  reviewed branch  ";
    },
    setEditorText(value: string) { assert.equal(value, ""); },
    notify(message: string) { notifications.push(message); },
  });
  const operations = new InteractiveSessionOperations({
    runtime,
    terminal,
    refreshTranscript() {},
    updateContext() {},
  });
  const controller = new AbortController();

  await operations.atlas("", controller.signal);

  assert.deepEqual(names, ["reviewed branch"]);
  assert.deepEqual(forkOptions, { position: "at", signal: controller.signal });
  assert.deepEqual(notifications, ['Created Atlas snapshot "reviewed branch"']);
});

test("new and Atlas branch operations forward their caller signal to runtime and TUI boundaries", async () => {
  const controller = new AbortController();
  let newSignal: AbortSignal | undefined;
  let forkSignal: AbortSignal | undefined;
  let treeSignal: AbortSignal | undefined;
  let chooseSignal: AbortSignal | undefined;
  const timestamp = "2026-08-21T00:00:00.000Z";
  const leaf = {
    type: "message" as const,
    id: "leaf",
    parentId: null,
    timestamp,
    message: {
      id: "leaf-message",
      role: "user" as const,
      content: [{ type: "text" as const, text: "Current head" }],
      createdAt: timestamp,
    },
  };
  // SAFETY: signal forwarding reads only the declared Atlas journal and streaming members.
  const session = operationsSessionFixture({
    isStreaming: false,
    settingsManager: { getTreeFilterMode: () => "default" },
    nativeSessionManager: {
      getEntryCount: () => 1,
      getTreePage: () => [{ entry: leaf, children: [], depth: 0 }],
      getActiveBranchEntryIdsInPage: () => [leaf.id],
      getLeafId: () => leaf.id,
    },
  });
  const runtime = {
    session,
    cwd: process.cwd(),
    services: { agentDir: process.cwd() },
    async newSession(options?: { signal?: AbortSignal }) {
      newSignal = options?.signal;
      return { cancelled: false };
    },
    async switchSession() { return { cancelled: false }; },
    async fork(_entryId: string, options?: { position?: "before" | "at"; signal?: AbortSignal }) {
      forkSignal = options?.signal;
      return { cancelled: false };
    },
    async importFromJsonl() { return { cancelled: false }; },
  } satisfies InteractiveSessionRuntime;
  const terminal = terminalFixture({
    async chooseSessionTree(_prompt, items, _options, signal) {
      treeSignal = signal;
      return items[0]!.value;
    },
    async choose(_prompt, choices, signal) {
      chooseSignal = signal;
      const selected = choices.find((choice) => choice.value === "branch");
      if (selected === undefined) throw new Error("Branch choice is unavailable");
      return selected.value;
    },
    setEditorText() {},
    notify() {},
  });
  const operations = new InteractiveSessionOperations({
    runtime,
    terminal,
    refreshTranscript() {},
    updateContext() {},
  });

  await operations.newSession(controller.signal);
  await operations.atlas("", controller.signal);

  assert.equal(newSignal, controller.signal);
  assert.equal(treeSignal, controller.signal);
  assert.equal(chooseSignal, controller.signal);
  assert.equal(forkSignal, controller.signal);
});

test("/context reports the composed prompt sources and current context state", () => {
  const notifications: string[] = [];
  // SAFETY: /context reads only the model, thinking, usage, message, and prompt-composition members below.
  const session = operationsSessionFixture({
    model: { provider: "openai-codex", id: "gpt-test", api: "openai-responses" },
    thinkingLevel: "xhigh",
    messages: [{}, {}],
    autoCompactionEnabled: true,
    isCompacting: false,
    getContextUsage() { return { tokens: 512, contextWindow: 4096, percent: 12.5 }; },
    getPromptComposition() {
      return {
        bytes: 6,
        sha256: "a".repeat(64),
        sources: [
          {
            kind: "additional_instructions",
            source: "built-in:system-prompt",
            bytes: 2,
            sha256: "b".repeat(64),
          },
          {
            kind: "instruction",
            source: "/workspace/AGENTS.md",
            bytes: 4,
            sha256: "c".repeat(64),
          },
        ],
        tools: ["read", "bash"],
        skills: [{ name: "build", manifestPath: "/skills/build/SKILL.md" }],
        truncated: false,
      };
    },
  });
  const runtime = {
    session,
    cwd: "/workspace",
    services: { agentDir: "/agent" },
    async newSession() { return { cancelled: false }; },
    async switchSession() { return { cancelled: false }; },
    async fork() { return { cancelled: false }; },
    async importFromJsonl() { return { cancelled: false }; },
  } satisfies InteractiveSessionRuntime;
  const operations = new InteractiveSessionOperations({
    runtime,
    terminal: terminalFixture({ notify(message) { notifications.push(message); } }),
    refreshTranscript() {},
    updateContext() {},
  });

  operations.showContext();

  assert.deepEqual(notifications, [[
    "Model: openai-codex/gpt-test (openai-responses) · thinking: xhigh",
    "Context: 512/4096 tokens (12.5%)",
    "Messages: 2 · auto-compaction: on · context operation: idle",
    `System prompt: 6 bytes · built-in core · sha256 ${"a".repeat(64)}`,
    'Prompt sources: additional instructions: "built-in:system-prompt", instruction: "/workspace/AGENTS.md"',
    'Prompt skills: build ("/skills/build/SKILL.md")',
    "Prompt tools: read, bash",
  ].join("\n")]);
});

test("/context does not claim prompt provenance before the first composition", () => {
  const notifications: string[] = [];
  // SAFETY: /context reads only the model, thinking, usage, message, and prompt-composition members below.
  const session = operationsSessionFixture({
    model: undefined,
    thinkingLevel: "off",
    messages: [],
    autoCompactionEnabled: false,
    isCompacting: true,
    getContextUsage() { return { tokens: null, contextWindow: 1000, percent: null }; },
    getPromptComposition() { return undefined; },
  });
  const runtime = {
    session,
    cwd: "/workspace",
    services: { agentDir: "/agent" },
    async newSession() { return { cancelled: false }; },
    async switchSession() { return { cancelled: false }; },
    async fork() { return { cancelled: false }; },
    async importFromJsonl() { return { cancelled: false }; },
  } satisfies InteractiveSessionRuntime;
  const operations = new InteractiveSessionOperations({
    runtime,
    terminal: terminalFixture({ notify(message) { notifications.push(message); } }),
    refreshTranscript() {},
    updateContext() {},
  });

  operations.showContext();

  assert.deepEqual(notifications, [[
    "Model: none · thinking: off",
    "Context: unknown/1000 tokens",
    "Messages: 0 · auto-compaction: off · context operation: running",
    "System prompt: not composed yet",
  ].join("\n")]);
});

test("/compact preserves the live transcript and relies on its durable completion card", async () => {
  const refreshes: Array<{ preserveExisting?: boolean } | undefined> = [];
  const notifications: string[] = [];
  const compactArguments: Array<string | undefined> = [];
  let contextUpdates = 0;
  // SAFETY: /compact invokes only compact on this session fixture.
  const session = operationsSessionFixture({
    async compact(argument?: string) {
      compactArguments.push(argument);
      return {
        summary: "durable summary",
        firstKeptEntryId: "kept",
        tokensBefore: 12_345,
      };
    },
  });
  const runtime = {
    session,
    cwd: "/workspace",
    services: { agentDir: "/agent" },
    async newSession() { return { cancelled: false }; },
    async switchSession() { return { cancelled: false }; },
    async fork() { return { cancelled: false }; },
    async importFromJsonl() { return { cancelled: false }; },
  } satisfies InteractiveSessionRuntime;
  const operations = new InteractiveSessionOperations({
    runtime,
    terminal: terminalFixture({
      notify(message: string) { notifications.push(message); },
    }),
    refreshTranscript(options) { refreshes.push(options); },
    updateContext() { contextUpdates += 1; },
  });

  await operations.compact("keep decisions");

  assert.deepEqual(compactArguments, ["keep decisions"]);
  assert.deepEqual(refreshes, [{ preserveExisting: true }]);
  assert.deepEqual(notifications, []);
  assert.equal(contextUpdates, 1);
});

test("/compact clears only earlier local errors at the operations-to-TUI boundary", async (context) => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const terminal = new TuiController({
    input,
    output,
    [INTERNAL_TUI_FRAME_PROJECTOR]: createFixtureFrameProjector(),
    mode: "full",
    environment: { TERM: "xterm-256color", LANG: "en_US.UTF-8", TERM_COLOR: "0" },
    handleSignals: false,
  });
  context.after(() => terminal.close());
  terminal.start();
  const viewport = new FocusedVirtualTerminal(output.columns, output.rows);
  let renderedChunks = 0;
  const flush = (): void => {
    for (const chunk of output.chunks.slice(renderedChunks)) viewport.write(chunk.toString("utf8"));
    renderedChunks = output.chunks.length;
  };
  flush();

  terminal.notify("No subscription login is registered", "error");
  terminal.notify("Review provider settings", "warning");
  await tick();
  flush();
  assert.match(viewport.viewport().join("\n"), /No subscription login is registered/u);

  // SAFETY: /compact invokes only compact on this session fixture.
  const session = operationsSessionFixture({
    async compact() {
      terminal.render(envelope({ type: "compaction_started", reason: "manual" }));
      await Promise.resolve();
      terminal.notify("Provider refresh failed during compaction", "error");
      return {
        summary: "Retained compacted context",
        firstKeptEntryId: "kept",
        tokensBefore: 14_721,
      };
    },
  });
  const operations = new InteractiveSessionOperations({
    runtime: treeRuntime(session),
    terminal,
    refreshTranscript(options) {
      terminal.replaceTranscript([{
        type: "session_summary",
        id: "fresh-compaction-summary",
        summaryType: "compaction",
        text: "Retained compacted context",
        tokensBefore: 14_721,
      }], "main", options);
    },
    updateContext() {},
  });

  await operations.compact("");
  await tick();
  terminal.renderNow();
  flush();

  const rendered = viewport.viewport().join("\n");
  assert.match(rendered, /Context compacted/u);
  assert.match(rendered, /Review provider settings/u);
  assert.match(rendered, /Provider refresh failed during compaction/u);
  assert.doesNotMatch(rendered, /No subscription login is registered/u);
});

test("/compact refreshes interactive state after a failed compaction", async () => {
  let contextUpdates = 0;
  // SAFETY: failed /compact invokes only compact on this session fixture.
  const session = operationsSessionFixture({
    async compact() { throw new Error("nothing to compact"); },
  });
  const runtime = {
    session,
    cwd: "/workspace",
    services: { agentDir: "/agent" },
    async newSession() { return { cancelled: false }; },
    async switchSession() { return { cancelled: false }; },
    async fork() { return { cancelled: false }; },
    async importFromJsonl() { return { cancelled: false }; },
  } satisfies InteractiveSessionRuntime;
  const operations = new InteractiveSessionOperations({
    runtime,
    terminal: terminalFixture({ notify() {} }),
    refreshTranscript() {},
    updateContext() { contextUpdates += 1; },
  });

  await assert.rejects(operations.compact(""), /nothing to compact/u);
  assert.equal(contextUpdates, 1);
});
