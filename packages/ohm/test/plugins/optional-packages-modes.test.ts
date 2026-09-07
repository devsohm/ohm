import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { SettingsManager } from "../../src/core/settings-manager.js";
import { RpcClient } from "../../src/interfaces/rpc-client.js";
import { ModelRuntime } from "../../src/providers/model-compat.js";
import { createAgentSession } from "../../src/sdk/index.js";
import { SessionManager } from "../../src/storage/session-manager.js";

const extensions = ["workspace-memory", "code-review"].map((name) => resolve("examples", name));

async function fixture(context: TestContext): Promise<{ cwd: string; agentDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "ohm-optional-modes-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  await mkdir(cwd);
  await mkdir(agentDir);
  await writeFile(join(agentDir, "model-providers.json"), JSON.stringify({ providers: {
    "optional-fixture": { api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", apiKey: "fixture-only", models: [{ id: "fixture", contextWindow: 16_384, maxTokens: 2_048 }] },
  } }));
  execFileSync("git", ["init", "--quiet", cwd]);
  execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", "fixture"], { cwd });
  context.after(async () => await rm(root, { recursive: true, force: true }));
  return { cwd, agentDir };
}

test("optional packages execute through the public SDK and memory survives refresh and reopen", async (context) => {
  const { cwd, agentDir } = await fixture(context);
  const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "model-providers.json"), allowModelNetwork: false });
  const model = runtime.find("optional-fixture", "fixture");
  assert.ok(model);
  const settingsManager = SettingsManager.inMemory({ extensions }, { projectTrusted: true });
  const create = async () => await createAgentSession({ cwd, agentDir, modelRuntime: runtime, model, settingsManager, sessionManager: SessionManager.inMemory(cwd) });
  let created = await create();
  try {
    await created.session.prompt("/memory");
    const shown = created.session.listPortablePresentations()[0];
    assert.ok(shown?.operation === "show");
    await created.session.invokePortablePresentationAction({
      protocolVersion: 1, owner: shown.owner, presentationId: shown.presentation.id,
      revision: shown.presentation.revision, actionId: "remember", input: { text: "SDK saved this note" },
    });
    await created.session.refresh();
    await created.session.prompt("/memory");
    assert.match(JSON.stringify(created.session.listPortablePresentations()), /SDK saved this note/u);
    await created.session.prompt("/review");
    assert.equal(created.session.getSessionStats().assistantMessages, 0);
    await created.session.close();
    created = await create();
    await created.session.prompt("/memory");
    assert.match(JSON.stringify(created.session.listPortablePresentations()), /SDK saved this note/u);
  } finally {
    await created.session.close();
    await runtime.close();
  }
});

test("optional packages execute through an actual RPC client without model requests for empty diffs", async (context) => {
  const { cwd, agentDir } = await fixture(context);
  const client = new RpcClient({
    cwd,
    cliPath: fileURLToPath(new URL("../../src/bin/ohm.ts", import.meta.url)),
    provider: "optional-fixture", model: "fixture",
    env: { OHM_HOME: agentDir, OHM_OFFLINE: "1", NODE_OPTIONS: `--import=${import.meta.resolve("tsx")}` },
    args: ["--offline", "--approve", "--no-session", "--no-skills", "--no-context-files", ...extensions.flatMap((path) => ["--plugin", path])],
  });
  const events: string[] = [];
  const unsubscribe = client.onEvent((event) => events.push(JSON.stringify(event)));
  await client.start();
  try {
    const commands = await client.getCommands();
    assert.ok(commands.some((command) => command.name === "review"));
    await client.prompt("/memory");
    const shown = (await client.listPortablePresentations())[0];
    assert.ok(shown?.operation === "show");
    await client.invokePortablePresentationAction({
      protocolVersion: 1, owner: shown.owner, presentationId: shown.presentation.id,
      revision: shown.presentation.revision, actionId: "remember", input: { text: "RPC saved this note" },
    });
    assert.match(JSON.stringify(await client.listPortablePresentations()), /RPC saved this note/u);
    await client.prompt("/review");
    assert.match(events.join("\n"), /No tracked changes to review/u);
    assert.equal(await client.getLastAssistantText(), null);
    const inspection = await client.getInspection();
    assert.equal(inspection.state, "idle");
    assert.equal(inspection.model?.provider, "optional-fixture");
    assert.equal(inspection.counts.extensions, 2);
    assert.equal(inspection.extensions.length, 2);
    assert.doesNotMatch(JSON.stringify(inspection), /RPC saved this note|fixture-only/u);
  } finally {
    unsubscribe();
    await client.stop();
  }
});
