import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Agent, EnvHttpProxyAgent } from "undici";

import { loadRuntime } from "../../src/cli/runtime.js";
import { DefaultPackageManager } from "../../src/core/package-manager.js";
import type { ProviderAdapter } from "../../src/core/types.js";
import { ProviderRegistry } from "../../src/providers/registry.js";
import { InMemoryCredentialStore } from "../helpers/credential-store.js";

test("runtime construction closes acquired services when package discovery fails", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-runtime-construction-cleanup-"));
  const failure = new Error("package discovery fixture failed");
  const providers: ProviderAdapter[] = [];
  const disposed = new Set<ProviderAdapter>();
  let networkCloses = 0;
  const register = ProviderRegistry.prototype.register;
  const observeRegistration: ProviderRegistry["register"] = function (this: ProviderRegistry, provider) {
    providers.push(provider);
    if (provider.dispose !== undefined) {
      const dispose = provider.dispose.bind(provider);
      const observeDisposal: NonNullable<ProviderAdapter["dispose"]> = () => {
        disposed.add(provider);
        return dispose();
      };
      context.mock.method(provider, "dispose", observeDisposal, {});
    }
    return register.call(this, provider);
  };
  context.mock.method(ProviderRegistry.prototype, "register", observeRegistration);
  const closeAgent = Agent.prototype.close;
  context.mock.method(Agent.prototype, "close", function (this: Agent, callback?: () => void) {
    const close = closeAgent.bind(this);
    if (callback !== undefined) return close(callback);
    networkCloses += 1;
    return close();
  });
  const closeProxyAgent = EnvHttpProxyAgent.prototype.close;
  context.mock.method(EnvHttpProxyAgent.prototype, "close", function (this: EnvHttpProxyAgent, callback?: () => void) {
    const close = closeProxyAgent.bind(this);
    if (callback !== undefined) return close(callback);
    networkCloses += 1;
    return close();
  });
  context.mock.method(DefaultPackageManager.prototype, "resolve", async () => { throw failure; });
  context.after(async () => {
    try {
      for (const provider of providers) {
        if (!disposed.has(provider)) await provider.dispose?.();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await assert.rejects(loadRuntime({
    workspace: root,
    agentDirectory: join(root, "agent"),
    credentialStore: new InMemoryCredentialStore(),
    projectTrusted: false,
    ephemeral: true,
    pluginCode: true,
    pluginRuntime: true,
    skills: false,
    promptTemplates: false,
    themes: false,
    offline: true,
  }), (error) => error === failure);
  assert.ok(providers.length > 0, "Failure must follow actual provider/network construction");
  assert.ok(networkCloses > 0, "The already-created network dispatcher must be closed");
  assert.deepEqual(
    providers.filter((provider) => provider.dispose !== undefined && !disposed.has(provider)),
    [],
    "Every acquired disposable provider must be released",
  );
});
