import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { Check } from "typebox/value";

import { loadRuntime } from "../../src/cli/runtime.js";
import { SettingsManager } from "../../src/core/settings-manager.js";
import { RpcClient } from "../../src/interfaces/rpc-client.js";
import { ModelRuntime } from "../../src/providers/model-compat.js";
import { FileProviderModelsStore } from "../../src/providers/models-store.js";
import { createAgentSession } from "../../src/sdk/index.js";
import { SessionManager } from "../../src/storage/session-manager.js";
import { InMemoryCredentialStore } from "../helpers/credential-store.js";

const LISTEN_ADDRESS_VALUE = Type.Object({ port: Type.Number(), address: Type.String(), family: Type.String() });

async function fixture(context: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "ohm-runtime-provider-configuration-"));
  const workspace = join(root, "workspace");
  const agentDirectory = join(root, "agent");
  await mkdir(workspace);
  await mkdir(agentDirectory);
  context.after(() => rm(root, { recursive: true, force: true }));
  return {
    workspace,
    agentDirectory,
    configurationPath: join(agentDirectory, "model-providers.json"),
    credentialStore: new InMemoryCredentialStore(),
    projectTrusted: false,
    ephemeral: true,
    pluginCode: false,
    skills: false,
    promptTemplates: false,
    themes: false,
    offline: true,
  };
}

function customConfiguration(contextWindow = 16_384) {
  return {
    providers: {
      "configured-fixture": {
        name: "Configured fixture",
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "fixture-only-key",
        models: [{ id: "fixture", contextWindow, maxTokens: 2_048 }],
      },
    },
  };
}

test("default SDK and CLI restore the same configured custom model without network or catalog mutation", async (context) => {
  const options = await fixture(context);
  await writeFile(options.configurationPath, JSON.stringify(customConfiguration()));
  const catalogPath = join(options.agentDirectory, "models.json");
  const catalog = JSON.stringify({ version: 1, savedAt: "2026-09-05T00:00:00.000Z", providers: [] });
  await writeFile(catalogPath, catalog);
  await new FileProviderModelsStore(join(options.agentDirectory, "models-store.json")).write("configured-fixture", {
    models: [{
      id: "fixture", name: "Stale cached model", provider: "configured-fixture",
      api: "openai-chat-completions", baseUrl: "http://127.0.0.1:2/v1",
      reasoning: false, input: ["text"], contextWindow: 1_024, maxTokens: 512,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
  });
  const cliManager = SessionManager.inMemory(options.workspace);
  cliManager.appendModelChange("configured-fixture", "fixture");
  const runtime = await loadRuntime({ ...options, sessionManager: cliManager });
  context.after(() => runtime.close());
  const sdkManager = SessionManager.inMemory(options.workspace);
  sdkManager.appendModelChange("configured-fixture", "fixture");
  const { session } = await createAgentSession({
    cwd: options.workspace,
    agentDir: options.agentDirectory,
    sessionManager: sdkManager,
    settingsManager: SettingsManager.inMemory(),
  });
  context.after(() => session.close());

  assert.equal(runtime.providers.has("configured-fixture"), true);
  assert.equal(runtime.auth.binding("configured-fixture").displayName, "Configured fixture");
  assert.deepEqual(runtime.session.model, session.model);
  assert.equal(session.model?.api, "openai-completions");
  assert.equal(session.model?.baseUrl, "http://127.0.0.1:1/v1");
  assert.equal(session.model?.contextWindow, 16_384);
  assert.equal(session.model?.maxTokens, 2_048);
  assert.equal(await runtime.modelRegistry.getApiKeyForProvider("configured-fixture"), "fixture-only-key");
  assert.equal(await readFile(catalogPath, "utf8"), catalog);
  assert.deepEqual(await options.credentialStore.list(), []);
});

test("configured builtin models and invocation keys have the same SDK and CLI precedence", async (context) => {
  const options = await fixture(context);
  await writeFile(options.configurationPath, JSON.stringify({
    providers: {
      openai: {
        name: "Configured OpenAI",
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "configuration-key",
        models: [{ id: "gpt-5.6-sol", contextWindow: 16_384, maxTokens: 2_048 }],
      },
      ...customConfiguration().providers,
    },
  }));
  for (const provider of ["openai", "configured-fixture"]) {
    await options.credentialStore.write(provider, { kind: "api_key", provider, apiKey: "stored-fixture-key" });
  }
  const sdkModels = await ModelRuntime.create({
    credentials: options.credentialStore,
    authPath: join(options.agentDirectory, "auth.json"),
    modelsPath: options.configurationPath,
    allowModelNetwork: false,
  });
  context.after(() => sdkModels.close());
  const runtime = await loadRuntime({ ...options, apiKeyProvider: "configured-fixture", apiKey: "invocation-fixture-key" });
  context.after(() => runtime.close());

  const model = runtime.modelRegistry.find("openai", "gpt-5.6-sol");
  assert.ok(model);
  const sdkModel = sdkModels.find("openai", "gpt-5.6-sol");
  assert.equal(model.baseUrl, sdkModel?.baseUrl);
  assert.equal(model.contextWindow, sdkModel?.contextWindow);
  assert.equal(model.maxTokens, sdkModel?.maxTokens);
  assert.equal(runtime.auth.binding("openai").displayName, "Configured OpenAI");
  assert.equal(await runtime.modelRegistry.getApiKeyForProvider("openai"), "stored-fixture-key");
  assert.equal((await sdkModels.getAuth("openai"))?.auth.apiKey, "stored-fixture-key");
  await sdkModels.setRuntimeApiKey("configured-fixture", "invocation-fixture-key", { allowNetwork: false });
  assert.equal(await runtime.modelRegistry.getApiKeyForProvider("configured-fixture"), "invocation-fixture-key");
  assert.equal((await sdkModels.getAuth("configured-fixture"))?.auth.apiKey, "invocation-fixture-key");
  assert.deepEqual(await options.credentialStore.read("configured-fixture"), {
    kind: "api_key", provider: "configured-fixture", apiKey: "stored-fixture-key",
  });
});

test("builtin provider-only configuration retains its catalog across offline refresh", async (context) => {
  const options = await fixture(context);
  await writeFile(options.configurationPath, JSON.stringify({
    providers: { openai: { baseUrl: "http://127.0.0.1:1/v1", apiKey: "fixture-only-key" } },
  }));
  const runtime = await loadRuntime(options);
  context.after(() => runtime.close());
  const before = runtime.modelRegistry.find("openai", "gpt-5.6-sol");
  assert.ok(before);
  assert.equal(before.baseUrl, "http://127.0.0.1:1/v1");
  const refreshed = await runtime.modelRegistry.refresh({ allowNetwork: false, signal: AbortSignal.timeout(5_000) });
  assert.equal(refreshed.errors.has("openai"), false);
  assert.deepEqual(runtime.modelRegistry.find("openai", "gpt-5.6-sol"), before);
  await writeFile(options.configurationPath, JSON.stringify({
    providers: { openai: { api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", apiKey: "fixture-only-key" } },
  }));
  await runtime.refresh();
  assert.equal(runtime.modelRegistry.find("openai", "gpt-5.6-sol")?.api, "openai-chat-completions");
});

test("configured-host refresh rejects invalid configuration atomically and applies valid changes to the restored model", async (context) => {
  const options = await fixture(context);
  await writeFile(options.configurationPath, JSON.stringify(customConfiguration()));
  const sessionManager = SessionManager.inMemory(options.workspace);
  sessionManager.appendModelChange("configured-fixture", "fixture");
  const runtime = await loadRuntime({ ...options, sessionManager });
  context.after(() => runtime.close());
  const previousSession = runtime.session;
  const previousModel = runtime.session.model;
  const sessionId = runtime.session.sessionId;
  const malformedSecret = "malformed-configuration-secret";
  await writeFile(options.configurationPath, `{ "providers": ${malformedSecret} }`);
  await assert.rejects(loadRuntime(options), /Provider configuration could not be loaded/u);
  await assert.rejects(runtime.refresh(), (error: Error) => {
    assert.match(error.message, /Provider configuration could not be loaded/u);
    assert.equal(error.message.includes(malformedSecret), false);
    return true;
  });
  assert.equal(runtime.session, previousSession);
  assert.deepEqual(runtime.session.model, previousModel);
  assert.equal(runtime.sessionManager, sessionManager);

  await writeFile(options.configurationPath, JSON.stringify({ providers: { invalid: { models: [{ id: "no-api" }] } } }));
  await assert.rejects(runtime.refresh(), /API is required/u);
  assert.equal(runtime.session, previousSession);

  await writeFile(options.configurationPath, JSON.stringify(customConfiguration(32_768)));
  assert.deepEqual(await runtime.refresh(), { warnings: [] });
  assert.notEqual(runtime.session, previousSession);
  assert.equal(runtime.session.sessionId, sessionId);
  assert.equal(runtime.sessionManager, sessionManager);
  assert.equal(runtime.session.model?.contextWindow, 32_768);
  assert.equal(runtime.session.model?.id, "fixture");
});

for (const providerId of ["configured-fixture", "openai"]) {
test(`configured ${providerId} completes real SDK and spawned RPC turns with its endpoint, key, and headers`, async (context) => {
  const options = await fixture(context);
  const requests: Array<{ url: string | undefined; authorization: string | undefined; header: string | string[] | undefined; modelHeader: string | string[] | undefined; body: string }> = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    requests.push({ url: request.url, authorization: request.headers.authorization, header: request.headers["x-fixture"], modelHeader: request.headers["x-model"], body });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ id: "fixture-response", model: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "Configured transport works" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error))));
  const address = server.address();
  assert.ok(Check(LISTEN_ADDRESS_VALUE, address));
  const configuration = customConfiguration();
  configuration.providers["configured-fixture"].baseUrl = `http://127.0.0.1:${address.port}/fixture/v1`;
  const authHeader = providerId !== "openai";
  const headers = authHeader
    ? { "X-Fixture": "header-fixture" }
    : { "X-Fixture": "header-fixture", Authorization: "Fixture custom auth" };
  await writeFile(options.configurationPath, JSON.stringify({ providers: {
    [providerId]: {
      ...configuration.providers["configured-fixture"], authHeader,
      headers,
      models: [{ id: "fixture", contextWindow: 16_384, maxTokens: 2_048, headers: { "X-Model": "model-fixture" } }],
    },
  } }));
  const { session } = await createAgentSession({
    cwd: options.workspace, agentDir: options.agentDirectory,
    sessionManager: SessionManager.inMemory(options.workspace), settingsManager: SettingsManager.inMemory(),
  });
  context.after(() => session.close());
  await session.modelRuntime.setRuntimeApiKey(providerId, "invocation-fixture-key", { allowNetwork: false });
  const model = session.modelRuntime.find(providerId, "fixture");
  assert.ok(model);
  await session.setModel(model);
  await session.prompt("Say hello");
  const sdkText = session.getLastAssistantText();

  const client = new RpcClient({
    cwd: options.workspace,
    cliPath: fileURLToPath(new URL("../../src/bin/ohm.ts", import.meta.url)),
    provider: providerId, model: "fixture",
    env: { OHM_HOME: options.agentDirectory, OHM_OFFLINE: "1", NODE_OPTIONS: `--import=${import.meta.resolve("tsx")}` },
    args: ["--offline", "--approve", "--no-session", "--no-plugin-code", "--no-skills", "--no-context-files", "--api-key", "invocation-fixture-key"],
  });
  await client.start();
  context.after(() => client.stop());
  await client.promptAndWait("Say hello", undefined, 10_000);
  const rpcText = await client.getLastAssistantText();

  assert.deepEqual([sdkText, rpcText], ["Configured transport works", "Configured transport works"]);
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.url, "/fixture/v1/chat/completions");
    assert.equal(request.authorization, authHeader ? "Bearer invocation-fixture-key" : "Fixture custom auth");
    assert.equal(request.header, "header-fixture");
    assert.equal(request.modelHeader, "model-fixture");
    assert.match(request.body, /"model":"fixture"/u);
  }
});
}
