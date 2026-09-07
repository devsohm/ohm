import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SettingsManager } from "../../src/core/settings-manager.js";
import { ProviderRegistry } from "../../src/providers/registry.js";
import { AgentSession } from "../../src/service/agent-session.js";
import { SessionManager } from "../../src/storage/session-manager.js";

test("explicit session ownership disposes services once and leaves a host-owned writer open", async (context) => {
  const cwd = await mkdtemp(join(tmpdir(), "ohm-session-ownership-"));
  context.after(async () => await rm(cwd, { recursive: true, force: true }));
  const manager = SessionManager.create(cwd, join(cwd, "sessions"));
  context.after(() => manager.closeV4Store());
  let disposals = 0;
  const session = await AgentSession.create({
    sessionManager: manager,
    providers: new ProviderRegistry([]),
    settingsManager: SettingsManager.inMemory(),
  }, {
    sessionStore: "host",
    dispose: () => { disposals += 1; },
  });
  await session.close({ reason: "replacement" });
  await session.close();
  assert.equal(disposals, 1);
  manager.appendCustomEntry("after-replacement", { retained: true });
  assert.throws(() => SessionManager.open(manager.getSessionFile()!), /active writer/u);
  manager.closeV4Store();
  const reopened = SessionManager.open(manager.getSessionFile()!);
  assert.equal(reopened.getEntries().at(-1)?.type, "custom");
  reopened.closeV4Store();
});

test("construction failure closes only the session-owned store and always releases owned services", async (context) => {
  const cwd = await mkdtemp(join(tmpdir(), "ohm-session-failed-ownership-"));
  context.after(async () => await rm(cwd, { recursive: true, force: true }));
  for (const sessionStore of ["session", "host"] as const) {
    const manager = SessionManager.create(cwd, join(cwd, sessionStore));
    let disposals = 0;
    await assert.rejects(AgentSession.create({
      sessionManager: manager,
      providers: new ProviderRegistry([]),
      settingsManager: SettingsManager.inMemory(),
      model: { provider: "missing", id: "missing", api: "openai-chat-completions" },
    }, {
      sessionStore,
      dispose: () => { disposals += 1; },
    }), /Provider adapter is not registered/u);
    assert.equal(disposals, 1);
    if (sessionStore === "host") {
      manager.appendCustomEntry("preserved-after-failure", {});
      assert.throws(() => SessionManager.open(manager.getSessionFile()!), /active writer/u);
      manager.closeV4Store();
    }
    const reopened = SessionManager.open(manager.getSessionFile()!);
    reopened.closeV4Store();
  }
});
