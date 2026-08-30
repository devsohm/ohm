import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import * as api from "ohm";
import * as embedding from "ohm/embedding";
import * as interfaces from "ohm/interfaces";
import * as sdk from "ohm/sdk";
import * as testing from "ohm/testing";
import * as tui from "ohm/tui";

const execute = promisify(execFile);

function standaloneEnvironment() {
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  delete environment.NODE_TEST_WORKER_ID;
  return environment;
}

const LAYER_ENTRY_POINTS = {
  "ohm/auth": "SecretRedactor",
  "ohm/config": "SettingsManager",
  "ohm/context": "deriveContextBudget",
  "ohm/core": "HarnessError",
  "ohm/embedding": "createInMemoryHarness",
  "ohm/extensions": "defineTool",
  "ohm/images": "sniffImageMediaType",
  "ohm/interfaces": "RpcClient",
  "ohm/modes": "runPrintMode",
  "ohm/net": "createNetworkTransport",
  "ohm/process": "DirectProcessRunner",
  "ohm/prompts": "buildSystemPrompt",
  "ohm/providers": "ModelRegistry",
  "ohm/sdk": "createAgentSession",
  "ohm/service": "AgentSession",
  "ohm/serve": "startServeServer",
  "ohm/storage": "SessionManager",
  "ohm/testing": "createScriptedProvider",
  "ohm/tools": "ToolRegistry",
  "ohm/tui": "fuzzyScore",
};

test("built package root exposes the direct session architecture without retired service/store owners", () => {
  assert.equal(api.AgentSession instanceof Function, true);
  assert.equal(api.SessionManager instanceof Function, true);
  assert.equal(api.defineTool instanceof Function, true);
  assert.equal("RuntimeExtensionHost" in api, false);
  assert.equal("HarnessService" in api, false);
  assert.equal("SessionStore" in api, false);
  assert.equal("createohmSdk" in sdk, false);

  const manager = api.SessionManager.inMemory(process.cwd(), { id: "dist-session" });
  manager.appendSessionInfo("Compiled session");
  assert.equal(manager.getSessionName(), "Compiled session");
});

test("built package root exposes the documented aliases and adapters", () => {
  for (const name of [
    "AgentSessionRuntime",
    "CONFIG_DIR_NAME",
    "CURRENT_SESSION_VERSION",
    "DefaultPackageManager",
    "DefaultResourceLoader",
    "KeybindingsManager",
    "ModelRegistry",
    "ModelRuntime",
    "ProjectTrustStore",
    "RpcClient",
    "SettingsManager",
    "buildContextEntries",
    "buildSessionContext",
    "createAgentSession",
    "createAgentSessionServices",
    "createBashTool",
    "createBashToolDefinition",
    "createCodingTools",
    "createEditTool",
    "createEditToolDefinition",
    "createEventBus",
    "createExtensionRuntime",
    "createFindTool",
    "createFindToolDefinition",
    "createGrepTool",
    "createGrepToolDefinition",
    "createLocalBashOperations",
    "createLsTool",
    "createLsToolDefinition",
    "createReadOnlyTools",
    "createReadTool",
    "createReadToolDefinition",
    "createSyntheticSourceInfo",
    "createWriteTool",
    "createWriteToolDefinition",
    "formatSkillsForPrompt",
    "generateDiffString",
    "generateUnifiedPatch",
    "getAgentDir",
    "getLatestCompactionEntry",
    "loadProjectContextFiles",
    "loadSkills",
    "loadSkillsFromDir",
    "parseArgs",
    "parseFrontmatter",
    "renderDiff",
    "resizeImage",
    "sessionEntryToContextMessages",
    "truncateHead",
  ]) assert.ok(name in api, `ohm is missing ${name}`);
});

test("built root uses application keybindings while the TUI subpath retains the raw manager", () => {
  const application = new api.KeybindingsManager({ "app.model.select": "alt+k" });
  assert.deepEqual(application.getKeys("app.model.select"), ["alt+k"]);
  assert.equal(application.getEffectiveConfig()["app.model.select"], "alt+k");

  const raw = new tui.KeybindingsManager(tui.TUI_KEYBINDINGS);
  assert.deepEqual(raw.getKeys("tui.input.submit"), ["enter"]);
  assert.equal(raw.refresh, undefined);
});

test("built runtime pointer declarations own their adapter-neutral literals", async () => {
  const declaration = await readFile(new URL("../dist/tui/components.d.ts", import.meta.url), "utf8");
  assert.doesNotMatch(declaration, /\bViewportPointer(?:Event|Response)\b/u);
  assert.match(declaration, /readonly type: "press" \| "release" \| "move" \| "wheel" \| "leave" \| "cancel";/u);
  assert.match(declaration, /readonly button: "left" \| "middle" \| "right" \| "none";/u);
  assert.match(declaration, /interface RuntimeUiPointerResponse \{\s+handled\?: boolean;\s+capture\?: boolean;\s+releaseCapture\?: boolean;\s+\}/u);
});

test("built package import defers the native image backend", async () => {
  const entry = new URL("../dist/index.js", import.meta.url).href;
  const script = `
    import { registerHooks } from "node:module";
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === "sharp") throw new Error("ohm eagerly loaded Sharp");
        return nextResolve(specifier, context);
      },
    });
    await import(${JSON.stringify(entry)});
    (await import("node:fs")).writeFileSync(1, "native image backend deferred\\n");
  `;
  const result = await execute(process.execPath, ["--input-type=module", "--eval", script], {
    env: standaloneEnvironment(),
  });
  assert.equal(result.stdout, "native image backend deferred\n");
  assert.equal(result.stderr, "");
});

test("built RPC executable export boots through the public CLI contract", async () => {
  const entry = fileURLToPath(new URL("../dist/rpc-entry.js", import.meta.url));
  const result = await execute(process.execPath, [entry, "--version"], {
    env: standaloneEnvironment(),
  });
  assert.match(result.stdout, /^\d+\.\d+\.\d+\n$/u);
  assert.equal(result.stderr, "");
});

test("built version output survives a non-writing Node stdout stream", async () => {
  const script = `
    process.stdout.write = (_chunk, encoding, callback) => {
      const complete = typeof encoding === "function" ? encoding : callback;
      complete?.();
      return true;
    };
    const { main } = await import("ohm");
    await main(["--version"]);
  `;
  const result = await execute(process.execPath, ["--input-type=module", "--eval", script], {
    env: standaloneEnvironment(),
  });
  assert.match(result.stdout, /^\d+\.\d+\.\d+\n$/u);
  assert.equal(result.stderr, "");
});

test("built testing and embedding subpaths complete an offline direct session", async () => {
  const provider = testing.createScriptedProvider({
    id: "dist-embedding",
    models: [{ id: "dist-model" }],
    scripts: [{ kind: "turn", content: [{ type: "text", text: "embedded dist works" }] }],
  });
  await using harness = await embedding.createInMemoryHarness({
    provider,
    model: "dist-model",
    api: "openai-chat-completions",
  });
  const run = await harness.session.run({ prompt: "offline" });
  assert.equal(run.results.at(-1)?.finalText, "embedded dist works");
});

test("built print mode owns the runtime and supports an embedded output sink", async () => {
  const output = [];
  const session = {
    sessionManager: {
      getHeader() { return null; },
      getEntries() {
        return thisSession.state.messages.map((message, index) => ({
          id: `entry-${index}`,
          type: "message",
          message,
        }));
      },
    },
    state: { messages: [] },
    async bindExtensions() {},
    subscribe() { return () => {}; },
    async prompt() {
      this.state.messages.push({
        role: "assistant",
        content: [{ type: "text", text: "print dist works" }],
        stopReason: "stop",
      });
    },
  };
  const thisSession = session;
  const runtime = {
    session,
    setBeforeSessionInvalidate() {},
    setRebindSession() {},
    async dispose() {},
  };
  const result = await (await import("ohm/modes")).runPrintMode(runtime, {
    mode: "text",
    initialMessage: "probe",
    write: (text) => output.push(text),
  });
  assert.equal(result, 0);
  assert.deepEqual(output, ["print dist works\n"]);
});

test("built interfaces serialize and parse the direct JSONL protocol", async () => {
  assert.deepEqual(interfaces.parseRpcInput('{"id":"dist","type":"get_state"}'), {
    id: "dist",
    type: "get_state",
  });
  const output = new PassThrough();
  const chunks = [];
  output.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  await new interfaces.RpcWriter(output).send({
    id: "dist",
    type: "response",
    command: "get_state",
    success: true,
  });
  assert.equal(
    Buffer.concat(chunks).toString("utf8"),
    '{"id":"dist","type":"response","command":"get_state","success":true}\n',
  );
});

test("built TUI subpath exposes semantic component builders", () => {
  const view = tui.uiPanel(tui.uiStack([
    tui.uiText("ready", { role: "success" }),
    tui.uiMarkdown("**public** component", { role: "muted" }),
  ], { gap: 1 }), { title: "Status" });
  const block = view.render({
    width: 24,
    height: 8,
    focused: false,
    expanded: false,
    theme: { name: "mono", color: true, unicode: true },
  });
  assert.equal(block.lines.some((line) => line.spans.some((span) => span.role === "success")), true);
});

test("built package exposes each documented Node.js layer as an ESM subpath", async () => {
  for (const [specifier, representativeExport] of Object.entries(LAYER_ENTRY_POINTS)) {
    const layer = await import(specifier);
    assert.ok(representativeExport in layer, `${specifier} is missing ${representativeExport}`);
  }
});

test("every built named export has declaration and runtime conformance evidence", async () => {
  const probe = fileURLToPath(new URL("public-api/named-export-conformance.mjs", import.meta.url));
  const result = await execute(process.execPath, [probe], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: standaloneEnvironment(),
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const marker = "OHM_NAMED_EXPORT_CONFORMANCE ";
  const line = result.stdout.split("\n").find((value) => value.startsWith(marker));
  assert.ok(line, `missing named-export summary in: ${result.stdout}`);
  const summary = JSON.parse(line.slice(marker.length));
  const inventory = JSON.parse(await readFile(
    new URL("../release/public-named-export-inventory.json", import.meta.url),
    "utf8",
  ));
  const entries = Object.values(inventory.entries);
  const runtimeBindings = entries.reduce((count, entry) => count + entry.runtime.length, 0);
  const typeOnlyBindings = entries.reduce((count, entry) => count + entry.typeOnly.length, 0);
  assert.deepEqual({
    entrypoints: summary.entrypoints,
    runtimeBindings: summary.runtimeBindings,
    typeOnlyBindings: summary.typeOnlyBindings,
    totalBindings: summary.totalBindings,
    semanticFunctions: summary.semanticFunctions,
  }, {
    entrypoints: entries.length,
    runtimeBindings,
    typeOnlyBindings,
    totalBindings: runtimeBindings + typeOnlyBindings,
    semanticFunctions: 22,
  });
  assert.equal(result.stderr, "");
});
