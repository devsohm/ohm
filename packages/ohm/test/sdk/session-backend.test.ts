import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DefaultResourceLoader } from "../../src/core/resource-loader.js";
import { optionalProperties } from "../../src/core/optional-properties.js";
import { SettingsManager } from "../../src/core/settings-manager.js";
import { ModelRuntime } from "../../src/providers/model-compat.js";
import { createModels } from "../../src/providers/models.js";
import { createAgentSession } from "../../src/sdk/index.js";
import { SessionManager } from "../../src/storage/index.js";

for (const ephemeral of [false, true]) {
  test(`SDK ${ephemeral ? "no-save sessions stay in memory" : "default sessions use SQLite"}`, async (context) => {
    const cwd = await mkdtemp(join(tmpdir(), "ohm-sdk-storage-"));
    context.after(() => rm(cwd, { recursive: true, force: true }));
    const settingsManager = SettingsManager.inMemory({ sessionDir: join(cwd, "sessions") });
    const modelRuntime = await ModelRuntime.create({ models: createModels(), modelsPath: null, allowModelNetwork: false });
    context.after(() => modelRuntime.close());
    const agentDir = join(cwd, "agent");
    const resourceLoader = new DefaultResourceLoader({
      cwd, agentDir, settingsManager, noPluginCode: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    });
    await resourceLoader.refresh();
    const options = { cwd, agentDir, settingsManager, modelRuntime, resourceLoader,
      ...optionalProperties(ephemeral ? { sessionManager: SessionManager.inMemory(cwd) } : undefined) };
    const { session } = await createAgentSession(options);
    context.after(() => session.close());
    session.sessionManager.appendMessage({ role: "user", timestamp: Date.now(), content: [{ type: "text", text: "Durable history" }] });
    const path = session.sessionFile;
    if (ephemeral) assert.equal(path, undefined);
    else assert.match(path ?? "", /\.sqlite$/u);
    await session.close();
    if (path !== undefined) {
      assert.equal((await readFile(path)).subarray(0, 16).toString("ascii"), "SQLite format 3\0");
      const reopened = SessionManager.open(path, undefined, undefined, { readOnly: true });
      context.after(() => reopened.closeV4Store());
      assert.ok(reopened.buildSessionContext().messages.some((message) => JSON.stringify(message).includes("Durable history")));
    }
  });
}
