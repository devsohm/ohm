import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { defaultSecretRedactor } from "../../src/auth/redaction.js";
import { ProviderRegistry } from "../../src/providers/registry.js";
import {
  AgentSession,
  createAgentSession,
  inspectAgentSession,
  SessionManager,
  SettingsManager,
} from "../../src/sdk/index.js";
import { createScriptedProvider } from "../../src/testing/scripted-provider.js";

async function workspace(context: TestContext): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "ohm-inspection-edge-"));
  context.after(async () => await rm(cwd, { recursive: true, force: true }));
  return cwd;
}

test("inspection reports a live blocked provider as running, not suspended", { timeout: 10_000 }, async (context) => {
  const cwd = await workspace(context);
  let markStarted!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const provider = createScriptedProvider({
    scripts: [async () => {
      markStarted();
      await gate;
      return { kind: "turn", content: [{ type: "text", text: "finished" }] };
    }],
  });
  const session = await AgentSession.create({
    workspace: cwd,
    sessionManager: SessionManager.inMemory(cwd),
    providers: new ProviderRegistry([provider]),
    settingsManager: SettingsManager.inMemory(),
    model: { provider: provider.id, id: provider.models[0]!.id, api: "openai-chat-completions", info: provider.models[0]! },
    baseToolsOverride: {},
  });
  const running = session.prompt("inspect while active", { noContextFiles: true });
  try {
    await started;
    assert.equal(session.isStreaming, true);
    assert.ok(session.suspendedRun, "the live operation remains present in durable recovery metadata");
    const active = inspectAgentSession(session);
    assert.equal(active.state, "running");
    assert.equal(active.activity.operations.length, 1);
    assert.equal(active.activity.operations[0]?.finishedAt, null);
    release();
    await running;
    const completed = inspectAgentSession(session);
    assert.equal(completed.state, "idle");
    assert.ok(completed.activity.operations[0]?.finishedAt);
  } finally {
    release();
    await running;
    await session.close();
  }
});

test("inspection supports a model-free session without an extension host", async (context) => {
  const cwd = await workspace(context);
  const session = await AgentSession.create({
    workspace: cwd,
    sessionManager: SessionManager.inMemory(cwd),
    providers: new ProviderRegistry([]),
    settingsManager: SettingsManager.inMemory(),
    baseToolsOverride: {},
  });
  try {
    assert.deepEqual(session.getLoadedPlugins(), []);
    const snapshot = inspectAgentSession(session);
    assert.equal(snapshot.sessionId, session.sessionId);
    assert.equal(snapshot.workspace, cwd);
    assert.equal(snapshot.state, "idle");
    assert.equal(snapshot.model, null);
    assert.equal(snapshot.prompt, null);
    assert.equal(snapshot.contextUsage, null);
    assert.deepEqual(snapshot.extensions, []);
    assert.deepEqual(snapshot.tools, []);
    assert.deepEqual(snapshot.activity, { operations: [], toolEffects: [] });
    assert.deepEqual(snapshot.counts, { tools: 0, activeTools: 0, extensions: 0 });
    assert.deepEqual(snapshot.omitted, { tools: 0, extensions: 0 });
  } finally {
    await session.close();
  }
});

test("SDK-discovered extension inspection is detached and redacts registered metadata secrets", async (context) => {
  const cwd = await workspace(context);
  const agentDir = join(cwd, "agent");
  const extensionDirectory = join(agentDir, "extensions");
  const secret = "inspection-metadata-secret";
  await mkdir(extensionDirectory, { recursive: true });
  await writeFile(join(extensionDirectory, `${secret}.mjs`), `
export default function(api) {
  api.registerCommand("inspection-probe", { async handler() {} });
}
`);
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: SettingsManager.inMemory(),
  });
  try {
    const original = session.getLoadedPlugins();
    assert.equal(original.length, 1);
    assert.match(original[0]!.id, /inspection-metadata-secret/u);
    assert.equal(original[0]!.path, join(extensionDirectory, `${secret}.mjs`));
    assert.match(original[0]!.sha256, /^[a-f0-9]{64}$/u);
    assert.deepEqual(Object.keys(original[0]!).sort(), ["id", "path", "scope", "sha256"]);
    defaultSecretRedactor.register(secret);

    const snapshot = inspectAgentSession(session);
    assert.equal(snapshot.counts.extensions, 1);
    assert.equal(snapshot.extensions.length, 1);
    assert.match(snapshot.extensions[0]!.id, /\[REDACTED\]/u);
    assert.match(snapshot.extensions[0]!.path, /\[REDACTED\]/u);
    assert.equal(JSON.stringify(snapshot).includes(secret), false);
    snapshot.extensions[0]!.id = "modified-snapshot";
    snapshot.extensions[0]!.path = "modified-snapshot";
    const metadata = session.getLoadedPlugins();
    metadata[0]!.id = "modified-metadata";
    metadata[0]!.path = "modified-metadata";
    assert.deepEqual(session.getLoadedPlugins(), original);
    assert.notEqual(inspectAgentSession(session).extensions[0]!.id, "modified-snapshot");
  } finally {
    await session.close();
  }
});

test("inspection counts every tool even when active tools fall beyond the display cap", async (context) => {
  const cwd = await workspace(context);
  const tools = Array.from({ length: 130 }, (_, index) => ({
    definition: { name: `inspection_tool_${index}`, description: "Inspection count fixture", inputSchema: { type: "object" } },
    validate() {},
    resources: () => [],
    async execute() { return { content: "unused", isError: false }; },
  }));
  const session = await AgentSession.create({
    workspace: cwd,
    sessionManager: SessionManager.inMemory(cwd),
    providers: new ProviderRegistry([]),
    settingsManager: SettingsManager.inMemory(),
    baseToolsOverride: {},
    tools,
  });
  try {
    session.setActiveTools(tools.slice(128).map((tool) => tool.definition.name));
    const snapshot = inspectAgentSession(session);
    assert.deepEqual(snapshot.counts, { tools: 130, activeTools: 2, extensions: 0 });
    assert.equal(snapshot.tools.length, 128);
    assert.deepEqual(snapshot.omitted, { tools: 2, extensions: 0 });
    assert.equal(snapshot.tools.filter((tool) => tool.active).length, 0);
    assert.deepEqual(session.getActiveTools(), ["inspection_tool_128", "inspection_tool_129"]);
  } finally {
    await session.close();
  }
});
