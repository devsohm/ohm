import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { SessionV4Changes, SessionV4Json } from "@ohm/kernel/session-v4";
import { SessionManager, type SessionHistoryPageOptions } from "../../src/storage/session-manager.js";
import { SqliteSessionHistoryIndex, type SessionHistoryIndexCommit } from "../../src/storage/session-history-index.js";
import { pluginSessionManager } from "../../src/plugins/session-contract.js";
import { RpcRuntimeDispatcher, type RpcSessionRuntime } from "../../src/interfaces/rpc-runtime.js";

const TIME = "2026-09-05T12:00:00.000Z";

function message(id: string, parentId: string | null) {
  return { type: "conversation_node" as const, node: {
    id, parentId, createdAt: TIME, nodeType: "message" as const, role: "assistant" as const,
    content: { id, role: "assistant", createdAt: TIME, content: [
      { type: "text", text: `visible ${id} 🙂` },
      { type: "provider_opaque", provider: "fixture", mediaType: "application/json",
        value: { nested: [id, { preserved: true }] }, serialized: '{ "spacing": true }' },
    ] },
  } };
}

function head(nodeId: string | null) {
  return { type: "head" as const, branchId: "main" as const, nodeId };
}

test("cold RPC pages load only requested node payloads and do not build history indexes", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ohm-cold-rpc-page-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const prepare = DatabaseSync.prototype.prepare;
  const reads = { nodes: 0, commits: 0 };
  t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
    const statement = prepare.call(this, sql);
    if (sql === "SELECT record FROM temp.ohm_session_state_records WHERE kind = ? AND id = ?") {
      const get = statement.get.bind(statement);
      t.mock.method(statement, "get", function (kind: string, id: string) {
        if (kind === "nodes") reads.nodes += 1;
        if (kind === "commits") reads.commits += 1;
        return get(kind, id);
      });
    }
    return statement;
  });
  const update = t.mock.method(SqliteSessionHistoryIndex.prototype, "update");
  for (const firstOffset of [0, 63]) {
    const manager = SessionManager.create(directory, directory, { id: `cold-page-${firstOffset}` });
    for (let index = 0; index < 64; index += 1) {
      manager.commitChanges([message(`n${index}`, index === 0 ? null : `n${index - 1}`), head(`n${index}`)], `commit-${index}`, TIME);
    }
    const lookup = t.mock.method(manager, "getEntry");
    const full = t.mock.method(manager, "getEntries");
    const ordinalPage = t.mock.method(manager, "getEntriesPage");
    // SAFETY: get_entries uses only the supplied native manager and plugin facade.
    const session = { nativeSessionManager: manager, sessionManager: pluginSessionManager(manager) } as RpcSessionRuntime["session"];
    const dispatcher = new RpcRuntimeDispatcher({
      runtime: { session, setRebindSession() {}, setBeforeSessionInvalidate() {},
        async newSession() { throw new Error("Session replacement is outside this fixture"); },
        async switchSession() { throw new Error("Session replacement is outside this fixture"); },
        async fork() { throw new Error("Session replacement is outside this fixture"); } },
      output() {},
    });
    try {
      for (const offset of [firstOffset, 1, 63]) {
        reads.nodes = 0;
        reads.commits = 0;
        const previousLookups = lookup.mock.callCount();
        const response = await dispatcher.dispatch({ id: `page-${offset}`, type: "get_entries", afterSequence: offset, limit: 1 });
        assert.ok(response?.success === true && response.command === "get_entries");
        assert.deepEqual(response.data.entries.map((entry) => entry.id), [`n${offset}`]);
        assert.equal(response.data.totalEntries, 64);
        assert.equal(lookup.mock.callCount() - previousLookups, 1);
        assert.ok(reads.nodes <= 1, `one page hydrated ${reads.nodes} node payloads`);
        if (firstOffset === 0 && previousLookups === 0) assert.equal(reads.nodes, 1);
        assert.equal(reads.commits, 0);
        assert.equal(update.mock.callCount(), 0);
        assert.equal(full.mock.callCount(), 0);
        assert.equal(ordinalPage.mock.callCount(), 0);
      }
      manager.commitChanges([message("appended", "n63"), head("appended")], "append", TIME);
      reads.nodes = 0;
      reads.commits = 0;
      const previousLookups = lookup.mock.callCount();
      const appended = await dispatcher.dispatch({ id: "appended", type: "get_entries", afterSequence: 64, limit: 1 });
      assert.ok(appended?.success === true && appended.command === "get_entries");
      assert.deepEqual(appended.data.entries.map((entry) => entry.id), ["appended"]);
      assert.equal(appended.data.totalEntries, 65);
      assert.equal(lookup.mock.callCount() - previousLookups, 1);
      assert.ok(reads.nodes <= 1);
      assert.equal(reads.commits, 0);
      assert.equal(update.mock.callCount(), 0);
      assert.equal(full.mock.callCount(), 0);
      assert.equal(ordinalPage.mock.callCount(), 0);
    } finally { await dispatcher.close(); manager.closeV4Store(); }
  }
});

test("cold plugin pages match full projection for canonical messages and accepted fallback payloads", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ohm-projection-count-parity-"));
  const saved = SessionManager.create(directory, directory);
  const memory = SessionManager.inMemory(directory);
  t.after(() => { saved.closeV4Store(); rmSync(directory, { recursive: true, force: true }); });
  const results = [
    { type: "tool_result", callId: "one", name: "one", content: "first", isError: false },
    { type: "tool_result", callId: "two", name: "two", content: "second", isError: false },
  ];
  const canonical = { id: "canonical", role: "tool", createdAt: TIME, content: results };
  const incomplete = { role: "tool", content: results };
  const invalidBlocks = [...results, { type: "tool_result" }];
  const custom = { ...canonical, custom: { customType: "fixture", display: false, timestamp: Date.parse(TIME) } };
  const messageNode = (id: string, content: SessionV4Json, role: "tool" | "assistant" = "tool") => ({
    id, parentId: null, createdAt: TIME, nodeType: "message" as const, role, content,
  });
  const contextNode = (id: string, context: SessionV4Json, extensionId = "ohm.session.message-custom") => ({
    id, parentId: null, createdAt: TIME, nodeType: "extension_context" as const, extensionId, context,
  });
  const cases = [
    { node: messageNode("nested-tool", canonical, "assistant"), count: 2 },
    { node: messageNode("nested-assistant", { ...canonical, role: "assistant" }), count: 1 },
    { node: messageNode("incomplete-message", incomplete), count: 1 },
    { node: messageNode("invalid-message-content", { ...canonical, content: invalidBlocks }), count: 1 },
    { node: messageNode("invalid-array", invalidBlocks), count: 1 },
    { node: messageNode("valid-array", results), count: 2 },
    { node: messageNode("empty-array", []), count: 1 },
    { node: messageNode("empty-canonical", { ...canonical, content: [] }), count: 1 },
    { node: messageNode("canonical-custom", custom), count: 1 },
    { node: contextNode("context-tool", canonical), count: 2 },
    { node: contextNode("incomplete-context", incomplete), count: 1 },
    { node: contextNode("array-context", results), count: 1 },
    { node: contextNode("custom-context", custom), count: 1 },
    { node: contextNode("other-context", canonical, "other"), count: 1 },
    { node: messageNode("bash-message", { role: "bashExecution", command: "true", output: "", cancelled: false,
      truncated: false, timestamp: Date.parse(TIME) }), count: 1 },
    { node: messageNode("custom-message", { role: "custom", customType: "fixture", content: "", display: false,
      timestamp: Date.parse(TIME) }), count: 1 },
  ];
  for (const manager of [saved, memory]) {
    for (const [index, entry] of cases.entries()) {
      manager.commitChanges([{ type: "conversation_node", node: entry.node }], `commit-${index}`, TIME);
    }
    const facade = pluginSessionManager(manager);
    const total = cases.reduce((sum, entry) => sum + entry.count, 0);
    const paged = Array.from({ length: total }, (_, offset) => {
      const page = facade.getEntriesPage(offset, 1);
      assert.equal(page.totalEntries, total);
      assert.equal(page.entries.length, 1);
      return page.entries[0];
    });
    const full = facade.getEntries();
    assert.deepEqual(paged, full);
    for (let offset = 0; offset < total; offset += 1) {
      assert.deepEqual(facade.getEntriesPage(offset, 3).entries, full.slice(offset, offset + 3));
    }
    assert.deepEqual(manager.getEntryProjectionMetadataPage(0, cases.length).map((entry) => entry.projectedEntryCount),
      cases.map((entry) => entry.count));
  }
});

test("accepted malformed canonical custom metadata falls back consistently across session reads", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ohm-malformed-custom-projection-"));
  const managers: SessionManager[] = [];
  t.after(() => {
    for (const manager of managers) manager.closeV4Store();
    rmSync(directory, { recursive: true, force: true });
  });
  managers.push(SessionManager.create(directory, directory), SessionManager.inMemory(directory));
  const valid = { customType: "fixture", display: false, timestamp: Date.parse(TIME) };
  const malformed: SessionV4Json[] = [
    null, "invalid", [], {},
    { ...valid, customType: 1 },
    { ...valid, display: "false" },
    { ...valid, timestamp: "yesterday" },
  ];
  for (const manager of managers) {
    let parentId: string | null = null;
    const payloads = malformed.map((custom) => ({
      id: "nested", role: "user", createdAt: TIME,
      content: [{ type: "text", text: "nested content" }], custom,
    }));
    for (const [index, content] of payloads.entries()) {
      for (const nodeType of ["message", "extension_context"] as const) {
        const id = `${nodeType}-${index}`;
        const base = { id, parentId, createdAt: TIME };
        const node = nodeType === "message"
          ? { ...base, nodeType, role: "user" as const, content }
          : { ...base, nodeType, extensionId: "ohm.session.message-custom", context: content };
        manager.commitChanges([{ type: "conversation_node", node }, head(id)]);
        parentId = id;
      }
    }
    const facade = pluginSessionManager(manager);
    const pages = payloads.flatMap((content, index) => {
      const message = facade.getEntriesPage(index * 2, 1);
      assert.equal(message.totalEntries, payloads.length * 2);
      assert.equal(message.entries.length, 1);
      assert.deepEqual(message.entries[0], {
        type: "message", id: `message-${index}`,
        parentId: index === 0 ? null : `extension_context-${index - 1}`, timestamp: TIME,
        message: { role: "user", content: [{ type: "text", text: JSON.stringify(content) }], timestamp: Date.parse(TIME) },
      });
      const context = facade.getEntriesPage(index * 2 + 1, 1);
      assert.equal(context.totalEntries, payloads.length * 2);
      assert.deepEqual(context.entries, [{
        type: "custom", id: `extension_context-${index}`, parentId: `message-${index}`, timestamp: TIME,
        customType: "ohm.session.message-custom", data: content,
      }]);
      return [...message.entries, ...context.entries];
    });
    assert.deepEqual(facade.getEntries(), pages);
    assert.deepEqual(facade.buildContextEntries(), pages);
    for (const entry of pages) assert.deepEqual(facade.getEntry(entry.id), entry);
    assert.deepEqual(manager.getEntryProjectionMetadataPage(0, pages.length).map((entry) => entry.projectedEntryCount),
      pages.map(() => 1));
  }
});

test("owned SQL history and tree queries preserve native page, branch, label and selection contracts", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ohm-history-index-contract-"));
  const saved = SessionManager.create(directory, directory);
  const memory = SessionManager.inMemory(directory);
  t.after(() => { saved.closeV4Store(); rmSync(directory, { recursive: true, force: true }); });
  let sequence = 0;
  const apply = (changes: SessionV4Changes, timestamp = TIME): void => {
    sequence += 1;
    for (const manager of [saved, memory]) manager.commitChanges(changes, `commit-${sequence}`, timestamp);
  };
  const compare = (): void => {
    assert.deepEqual(saved.getPersistedSelection(), memory.getPersistedSelection());
    assert.equal(saved.getTreeRevision(), memory.getTreeRevision());
    const entries = memory.getEntries();
    const tips = [undefined, ...entries.map((entry) => entry.id)];
    for (const from of tips) {
      const options = from === undefined ? {} : { from };
      const lineage = memory.getHistoryPage({ ...options, limit: 500 }).entries;
      const cases: SessionHistoryPageOptions[] = [options, { ...options, edge: "oldest" }];
      for (const cursor of lineage) cases.push({ ...options, before: cursor.id }, { ...options, after: cursor.id });
      for (const query of cases) for (const limit of [1, 3]) for (const maxBytes of [1, 2 * 1024 * 1024]) {
        const bounded = { ...query, limit, maxBytes };
        assert.deepEqual(saved.getHistoryPage(bounded), memory.getHistoryPage(bounded), JSON.stringify(bounded));
      }
    }
    for (const [offset, limit] of [[0, 3], [2, 2], [99, 4], [1.5, 1.5], [NaN, 3], [1, NaN], [Infinity, 2], [0, Infinity]]) {
      assert.deepEqual(saved.getEntriesPage(offset!, limit!), memory.getEntriesPage(offset!, limit!));
      assert.deepEqual(saved.getEntryProjectionMetadataPage(offset!, limit!), memory.getEntryProjectionMetadataPage(offset!, limit!));
      assert.deepEqual(saved.getTreeEntryPage(offset!, limit!), memory.getTreeEntryPage(offset!, limit!));
      assert.deepEqual(saved.getTreePage(offset!, limit!), memory.getTreePage(offset!, limit!));
      assert.deepEqual(saved.getActiveBranchEntryIdsInPage(offset!, limit!), memory.getActiveBranchEntryIdsInPage(offset!, limit!));
    }
    for (const entry of entries) assert.equal(saved.getEntrySequence(entry.id), memory.getEntrySequence(entry.id));
    assert.equal(saved.getEntrySequence("missing"), undefined);
  };
  compare();
  apply([message("root", null), message("left", "root"), message("left-tail", "left"), head("left-tail")]);
  compare();
  apply([
    { type: "conversation_node", node: { id: "model", parentId: "root", createdAt: TIME,
      nodeType: "model_change", provider: "fixture", model: "model-a" } },
    { type: "conversation_node", node: { id: "thinking", parentId: "model", createdAt: TIME,
      nodeType: "thinking_change", level: "off" } },
    message("right", "thinking"), head("right"),
    { type: "node_label", nodeId: "root", label: "first" },
    { type: "node_label", nodeId: "root", label: "renamed" },
  ]);
  compare();
  assert.throws(() => saved.getHistoryPage({ from: "left-tail", before: "right" }), /not on the selected lineage/u);
  assert.throws(() => saved.getHistoryPage({ from: "absent" }), /not found/u);
  assert.throws(() => saved.getHistoryPage({ before: "absent" }), /not on the selected lineage/u);
  assert.deepEqual(saved.getHistoryPage({ from: "left-tail", limit: 3 }).entries.map((entry) => entry.id), ["root", "left", "left-tail"]);
  apply([{ type: "node_label", nodeId: "root", label: null }, head("left-tail")]);
  compare();
  apply([{ type: "node_label", nodeId: "root", label: "earlier timestamp" }], "2026-09-04T12:00:00.000Z");
  assert.equal(saved.getTreeEntryPage(0, 1)[0]?.labelTimestamp, "2026-09-04T12:00:00.000Z");
  apply([head(null)]);
  compare();
  assert.deepEqual(saved.getPersistedSelection(), { model: null, thinkingLevel: "off", hasPersistedThinking: true });
  apply([
    message("odd\ud800", "right"), message("odd\ud801", "odd\ud800"), head("odd\ud801"),
    { type: "node_label", nodeId: "odd\ud800", label: "label\udc00" },
  ]);
  compare();
  const page = saved.getHistoryPage({ from: "right", limit: 1 });
  const original = saved.getEntry("right");
  page.entries[0]!.parentId = "mutated";
  const entry = page.entries[0];
  if (entry?.type === "message" && entry.message.role === "assistant") entry.message.content = [];
  assert.deepEqual(saved.getEntry("right"), original);
  assert.equal(Object.getOwnPropertyDescriptor(saved, "entryOrderCache")?.value, undefined);
  assert.equal(Object.getOwnPropertyDescriptor(saved, "historyOrderCache")?.value, undefined);
});

test("indexed history reads use validated payloads and never trust or persist a journal cache", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ohm-history-index-trust-"));
  const manager = SessionManager.create(directory, directory);
  t.after(() => { manager.closeV4Store(); rmSync(directory, { recursive: true, force: true }); });
  manager.commitChanges([message("root", null), head("root")], "first", TIME);
  const path = manager.getSessionFile()!;
  const expected = manager.getHistoryPage();
  const snapshot = SessionManager.openSnapshot(path);
  const db = new DatabaseSync(path);
  try {
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => row.name),
      ["session_commits", "session_header"]);
    const original = db.prepare("SELECT record FROM session_commits WHERE sequence = 1").get()!.record;
    db.prepare("UPDATE session_commits SET record = 'null' WHERE sequence = 1").run();
    assert.deepEqual(manager.getHistoryPage(), expected);
    assert.deepEqual(manager.getTreeEntryPage(0, 1)[0]?.entry, expected.entries[0]);
    assert.deepEqual(snapshot.getHistoryPage(), expected);
    assert.throws(() => SessionManager.openSnapshot(path), /must be an object/u);
    db.prepare("UPDATE session_commits SET record = ? WHERE sequence = 1").run(original!);
  } finally { db.close(); }
  manager.commitChanges([message("later", "root"), head("later")], "second", TIME);
  assert.deepEqual(snapshot.getHistoryPage(), expected);
  assert.deepEqual(manager.getHistoryPage().entries.map((entry) => entry.id), ["root", "later"]);
});

test("query metadata follows accepted appends, idempotency and replacement ownership", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ohm-history-index-lifecycle-"));
  const manager = SessionManager.create(directory, directory);
  t.after(() => { manager.closeV4Store(); rmSync(directory, { recursive: true, force: true }); });
  const firstFile = manager.getSessionFile()!;
  manager.getTreeEntryPage(0, 1);
  const changes = [message("root", null), head("root")] satisfies SessionV4Changes;
  const observed: string[][] = [];
  const remove = manager.onAppend(() => { observed.push(manager.getHistoryPage().entries.map((entry) => entry.id)); });
  manager.commitChanges(changes, "first", TIME);
  assert.deepEqual(observed, [["root"]]);
  const revision = manager.getTreeRevision();
  manager.commitChanges(changes, "first", TIME);
  assert.equal(manager.getTreeRevision(), revision);
  assert.deepEqual(manager.getHistoryPage().entries.map((entry) => entry.id), ["root"]);
  assert.throws(() => manager.commitChanges([head(null)], "first", TIME), /already used/u);
  assert.throws(() => manager.commitChanges([head("absent")], "invalid", TIME), /unknown|not exist/u);
  assert.equal(manager.getTreeRevision(), revision);
  remove();
  manager.newSession();
  assert.deepEqual(manager.getHistoryPage(), { entries: [], hasMoreBefore: false, hasMoreAfter: false });
  manager.commitChanges([message("other", null), head("other")], "other-commit", TIME);
  manager.setSessionFile(firstFile);
  assert.deepEqual(manager.getHistoryPage().entries.map((entry) => entry.id), ["root"]);
  assert.deepEqual(manager.getTreeEntryPage(0, 1).map((node) => node.depth), [0]);
  manager.closeV4Store();
  manager.closeV4Store();
  assert.throws(() => manager.getHistoryPage(), /not initialized/u);
});

test("cold selection and newest pages defer index construction until deeper navigation", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ohm-history-index-lazy-"));
  const manager = SessionManager.create(directory, directory);
  t.after(() => { manager.closeV4Store(); rmSync(directory, { recursive: true, force: true }); });
  manager.commitChanges([message("root", null), head("root")], "root-commit", TIME);
  const update = SqliteSessionHistoryIndex.prototype.update;
  const feed = t.mock.method(SqliteSessionHistoryIndex.prototype, "update", function (
    this: SqliteSessionHistoryIndex, commits: Iterable<SessionHistoryIndexCommit>,
  ) { return update.call(this, commits); });
  const selected = manager.getPersistedSelection();
  const newest = manager.getHistoryPage({ maxBytes: 1 });
  manager.commitChanges([message("branch", "root"), head("branch")], "branch-commit", TIME);
  assert.deepEqual(manager.getHistoryPage({ from: "root", maxBytes: 1 }), newest);
  assert.equal(feed.mock.callCount(), 0);
  manager.getTreeEntryPage(0, 1);
  assert.equal(feed.mock.callCount(), 1);
  assert.deepEqual(manager.getPersistedSelection(), selected);
  assert.deepEqual(manager.getHistoryPage({ from: "root", maxBytes: 1 }), newest);
  manager.commitChanges([head(null)], "reset", TIME);
  assert.deepEqual(manager.getHistoryPage(), { entries: [], hasMoreBefore: false, hasMoreAfter: false });
  assert.equal(feed.mock.callCount(), 2);
});

test("query-backed search keeps bounded metadata batches and fixed ownership during yields", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ohm-history-index-search-"));
  const saved = SessionManager.create(directory, directory);
  const memory = SessionManager.inMemory(directory);
  t.after(() => { saved.closeV4Store(); rmSync(directory, { recursive: true, force: true }); });
  const nodes = Array.from({ length: 300 }, (_, index) => message(`n${index}`, index === 0 ? null : `n${index - 1}`));
  for (const manager of [saved, memory]) {
    manager.commitChanges([nodes[0]!, ...nodes.slice(1), message("branch", "n10"), head("branch")], "tree", TIME);
    manager.appendCustomEntry("private", { secret: "hidden needle" });
    manager.appendCustomMessageEntry("private", "hidden needle", false);
  }
  for (const from of [undefined, "n299", "branch"]) {
    const selected = from === undefined ? {} : { from };
    for (const cursor of [undefined, "n0", "n10", from]) {
      const cases = cursor === undefined ? [selected] : [{ ...selected, before: cursor }, { ...selected, after: cursor }];
      for (const options of cases) for (const query of ["visible", "n2", "hidden needle", "no match"]) {
        assert.deepEqual(await saved.searchHistory(query, { ...options, limit: 3 }),
          await memory.searchHistory(query, { ...options, limit: 3 }));
      }
    }
  }
  await assert.rejects(saved.searchHistory("visible", { from: "branch", before: "n299" }), /not in the selected history/u);
  await assert.rejects(saved.searchHistory("visible", { from: "branch", before: "n11" }), /not in the selected history/u);
  const interleaved = saved.searchHistory("n299", { from: "n299", after: "n0" });
  saved.getHistoryPage({ from: "branch", edge: "oldest", limit: 1 });
  assert.deepEqual((await interleaved).matches.map((match) => match.id), ["n299"]);
  assert.equal(Object.getOwnPropertyDescriptor(saved, "entryOrderCache")?.value, undefined);
  assert.equal(Object.getOwnPropertyDescriptor(saved, "historyOrderCache")?.value, undefined);

  const controller = new AbortController();
  const cancelled = saved.searchHistory("no match", { signal: controller.signal });
  controller.abort(new Error("stop scan"));
  await assert.rejects(cancelled, /stop scan/u);

  const fixed = saved.searchHistory("not yet present");
  saved.commitChanges([message("not yet present", "branch"), head("not yet present")], "later", TIME);
  assert.deepEqual((await fixed).matches, []);
  assert.equal((await saved.searchHistory("not yet present")).matches.length, 1);

  const switched = saved.searchHistory("no match");
  const path = saved.getSessionFile()!;
  saved.closeV4Store();
  saved.setSessionFile(path);
  await assert.rejects(switched, /Session changed while searching history/u);
});
