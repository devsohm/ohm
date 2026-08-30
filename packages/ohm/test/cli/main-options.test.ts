import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

const STRING_VALUE = Type.String();
const STRING_ARRAY_VALUE = Type.Array(STRING_VALUE);
const HEALTH_REPORT_VALUE = Type.Object({ healthy: Type.Optional(Type.Boolean()) });
const RUNTIME_COMMAND_REPORT_VALUE = Type.Object({
  runtime: Type.Array(Type.Object({ name: Type.String() })),
});
const RPC_RECORD_VALUE = Type.Object({
  id: Type.Optional(Type.String()),
  type: Type.Optional(Type.String()),
  command: Type.Optional(Type.String()),
  success: Type.Optional(Type.Boolean()),
  extensionId: Type.Optional(Type.String()),
  event: Type.Optional(Type.String()),
  error: Type.Optional(Type.Unknown()),
  data: Type.Optional(Type.Object({
    commands: Type.Optional(Type.Array(Type.Object({ name: Type.String() }))),
    recovered: Type.Optional(Type.Boolean()),
    operationId: Type.Optional(Type.String()),
    blocked: Type.Optional(Type.Array(Type.Unknown())),
  })),
});
const SESSION_EVENT_VALUE = Type.Object({
  type: Type.Optional(Type.String()),
  entry: Type.Optional(Type.Object({ customType: Type.Optional(Type.String()) })),
});
const MODEL_LIST_VALUE = Type.Array(Type.Object({
  provider: Type.Optional(Type.String()),
  id: Type.Optional(Type.String()),
}));
const MESSAGE_EVENT_VALUE = Type.Object({
  type: Type.Optional(Type.String()),
  message: Type.Optional(Type.Object({
    stopReason: Type.Optional(Type.String()),
    errorMessage: Type.Optional(Type.String()),
  })),
});
const RECOVERY_RECORD_VALUE = Type.Object({
  scenario: Type.Union([Type.Literal("startup"), Type.Literal("resume"), Type.Literal("rpc")]),
  type: Type.String(),
  model: Type.Optional(Type.String()),
  suspended: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  resolutions: Type.Optional(Type.Array(Type.Object({
    effectId: Type.String(),
    outcome: Type.String(),
  }))),
  message: Type.Optional(Type.String()),
});

function parseJson<Schema extends TSchema>(schema: Schema, source: string): Static<Schema> {
  const value: unknown = JSON.parse(source);
  if (!Value.Check(schema, value)) throw new Error("CLI JSON does not match its test contract");
  return value;
}

const execute = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const mainModule = pathToFileURL(fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url))).href;
const agentSessionModule = pathToFileURL(fileURLToPath(new URL("../../src/service/agent-session.ts", import.meta.url))).href;
const cliModule = fileURLToPath(new URL("../../src/bin/ohm.ts", import.meta.url));
const sessionManagerModule = pathToFileURL(
  fileURLToPath(new URL("../../src/storage/session-manager.ts", import.meta.url)),
).href;
const sessionV4Module = pathToFileURL(
  fileURLToPath(new URL("../../../kernel/src/session-v4/index.ts", import.meta.url)),
).href;

async function executeWithClosedStdin(
  file: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeout: number; stdin?: string },
): Promise<{ stdout: string; stderr: string }> {
  const { stdin, ...spawnOptions } = options;
  const child = spawn(file, args, { ...spawnOptions, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  child.stdin.end(stdin);
  await new Promise<void>((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Command timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, options.timeout);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolveExit();
      else reject(new Error(`Command exited with ${code ?? signal}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    });
  });
  return { stdout, stderr };
}

async function waitForJsonlEntry(path: string, expected: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  const needle = `${JSON.stringify(expected)}\n`;
  while (true) {
    const contents = await readFile(path, "utf8").catch(() => "");
    if (contents.includes(needle)) return;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${expected}:\n${contents}`);
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
  }
}

test("human CLI warnings redact credentials and escape terminal controls", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-main-warning-output-"));
  const entrypoint = join(root, "entrypoint.mjs");
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const secret = "sk-proj-1234567890abcdefghijkl";
  const invalidThinking = `${secret}\x1b[31m`;
  await writeFile(entrypoint, `
import { main } from ${JSON.stringify(mainModule)};
await main(${JSON.stringify(["--thinking", invalidThinking, "--version"])});
`, "utf8");

  const result = await executeWithClosedStdin(process.execPath, ["--import", "tsx", entrypoint], {
    cwd: repositoryRoot,
    env: process.env,
    timeout: 30_000,
  });
  assert.doesNotMatch(result.stderr, new RegExp(secret, "u"));
  assert.equal(result.stderr.includes("\x1b"), false);
  assert.match(result.stderr, /Invalid thinking level "\[REDACTED\]\\x1b\[31m"/u);
});

test("compatible leading flags preserve management-command dispatch", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-main-leading-management-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const entrypoint = join(root, "entrypoint.mjs");
  await mkdir(workspace);
  context.after(async () => await rm(root, { recursive: true, force: true }));

  await writeFile(entrypoint, `
import { main } from ${JSON.stringify(mainModule)};
for (const invocation of ${JSON.stringify([
    ["--offline", "config", "path"],
    ["--approve", "config", "path"],
    ["--no-approve", "config", "path"],
    ["--offline", "config", "--", "path"],
    ["--json", "sessions", "doctor"],
  ])}) await main(invocation);
`, "utf8");

  const result = await executeWithClosedStdin(process.execPath, ["--import", "tsx", entrypoint], {
    cwd: repositoryRoot,
    env: { ...process.env, OHM_HOME: agentDir, OHM_OFFLINE: "1" },
    timeout: 30_000,
  });
  const lines = result.stdout.trim().split("\n");
  assert.deepEqual(lines.slice(0, 4), Array(4).fill(join(agentDir, "config.json")));
  assert.equal(parseJson(HEALTH_REPORT_VALUE, lines.slice(4).join("\n")).healthy, true);
});

test("invalid leading management flags fail before agent state is created", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-main-invalid-leading-management-"));
  const agentDir = join(root, "agent");
  const entrypoint = join(root, "entrypoint.mjs");
  context.after(async () => await rm(root, { recursive: true, force: true }));

  await writeFile(entrypoint, `
import { main } from ${JSON.stringify(mainModule)};
const errors = [];
for (const invocation of ${JSON.stringify([
    ["--local", "sessions", "doctor"],
    ["--yes", "config", "path"],
    ["--offline", "--offline", "config", "path"],
  ])}) {
  try {
    await main(invocation);
    errors.push("accepted");
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
}
process.stdout.write(JSON.stringify(errors));
`, "utf8");

  const result = await executeWithClosedStdin(process.execPath, ["--import", "tsx", entrypoint], {
    cwd: repositoryRoot,
    env: { ...process.env, OHM_HOME: agentDir, OHM_OFFLINE: "1" },
    timeout: 30_000,
  });
  assert.equal(result.stderr, "");
  const errors = parseJson(STRING_ARRAY_VALUE, result.stdout);
  assert.match(errors[0]!, /--local is not valid for sessions/u);
  assert.match(errors[1]!, /--yes is not valid for config/u);
  assert.match(errors[2]!, /Flag --offline was provided more than once/u);
  await assert.rejects(access(agentDir), { code: "ENOENT" });
});

test("text mode merges piped input, file arguments, and only the first prompt before file expansion", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-main-prompt-composition-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const entrypoint = join(root, "entrypoint.mjs");
  const observed = join(root, "observed.jsonl");
  await mkdir(workspace);
  await writeFile(join(workspace, "context.txt"), "file body", "utf8");
  context.after(async () => await rm(root, { recursive: true, force: true }));

  await writeFile(entrypoint, `
import { appendFileSync } from "node:fs";
import { main } from ${JSON.stringify(mainModule)};

await main([
  "--mode", "text",
  "--workspace", ${JSON.stringify(workspace)},
  "--offline",
  "--no-extensions",
  "--no-session",
  "--approve",
  "--provider", "inline-compose",
  "--model", "inline-model",
  "@context.txt",
  "first prompt",
  "second prompt",
], {
  extensionFactories: [{
    name: "inline-prompt-composition",
    factory(ohm) {
      ohm.registerProvider("inline-compose", {
        api: "openai-responses",
        apiKey: "fixture-key",
        baseUrl: "https://example.invalid/v1",
        models: [{
          id: "inline-model",
          name: "Inline Model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8000,
          maxTokens: 1000,
        }],
      });
      ohm.on("input", (event) => {
        appendFileSync(${JSON.stringify(observed)}, JSON.stringify(event.text) + "\\n");
        return { action: "handled" };
      });
    },
  }],
});
`, "utf8");

  const result = await executeWithClosedStdin(process.execPath, ["--import", "tsx", entrypoint], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      OHM_HOME: agentDir,
      OHM_OFFLINE: "1",
    },
    timeout: 30_000,
    stdin: "stdin text",
  });
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, "");
  const inputs = (await readFile(observed, "utf8")).trim().split("\n").map((line) => parseJson(STRING_VALUE, line));
  assert.deepEqual(inputs, [
    "stdin text\n@context.txt\nfirst prompt\n\n<file path=\"context.txt\">\nfile body\n</file>",
    "second prompt",
  ]);
});

test("installed one-shot mode does not report a historical failed assistant after handled input", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-main-historical-assistant-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const entrypoint = join(root, "entrypoint.mjs");
  await mkdir(workspace);
  context.after(async () => await rm(root, { recursive: true, force: true }));

  await writeFile(entrypoint, `
import { main } from ${JSON.stringify(mainModule)};
import { AgentSession } from ${JSON.stringify(agentSessionModule)};

const descriptor = Object.getOwnPropertyDescriptor(AgentSession.prototype, "messages");
if (descriptor?.get === undefined) throw new Error("AgentSession messages getter is unavailable");
let historicalStopReason = "error";
Object.defineProperty(AgentSession.prototype, "messages", {
  configurable: true,
  get() {
    return [...descriptor.get.call(this), {
      role: "assistant",
      content: [{ type: "text", text: "historical answer" }],
      api: "openai",
      provider: "historical",
      model: "historical",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: historicalStopReason,
      errorMessage: "historical " + historicalStopReason,
      timestamp: 0,
    }];
  },
});

for (const stopReason of ["error", "aborted"]) {
  historicalStopReason = stopReason;
  await main([
    "--mode", "text",
    "--workspace", ${JSON.stringify(workspace)},
    "--offline",
    "--no-extensions",
    "--no-session",
    "--approve",
    "--provider", "inline-history",
    "--model", "inline-model",
    "/handled-without-output",
  ], {
    extensionFactories: [{
      name: "inline-history",
      factory(ohm) {
        ohm.registerProvider("inline-history", {
          api: "openai-responses",
          apiKey: "fixture-key",
          baseUrl: "https://example.invalid/v1",
          models: [{
            id: "inline-model",
            name: "Inline Model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 8000,
            maxTokens: 1000,
          }],
        });
        ohm.on("input", () => ({ action: "handled" }));
      },
    }],
  });
}
`, "utf8");

  const result = await executeWithClosedStdin(process.execPath, ["--import", "tsx", entrypoint], {
    cwd: repositoryRoot,
    env: { ...process.env, OHM_HOME: agentDir, OHM_OFFLINE: "1" },
    timeout: 30_000,
  });
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("installed one-shot mode does not repeat an earlier assistant when the final prompt has no output", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-main-final-no-output-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const entrypoint = join(root, "entrypoint.mjs");
  await mkdir(workspace);
  context.after(async () => await rm(root, { recursive: true, force: true }));

  await writeFile(entrypoint, `
import { main } from ${JSON.stringify(mainModule)};
import { AgentSession } from ${JSON.stringify(agentSessionModule)};

let promptCount = 0;
AgentSession.prototype.prompt = async function () {
  promptCount += 1;
  if (promptCount === 1) {
    this.sessionManager.appendMessage({
      id: "first-assistant",
      role: "assistant",
      content: [{ type: "text", text: "first answer" }],
      api: "openai-responses",
      provider: "inline-final-no-output",
      model: "inline-model",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      timestamp: Date.parse("2026-01-01T00:00:00.000Z"),
      stopReason: "stop",
    });
  }
  return { sessionId: "session", results: [] };
};

await main([
  "--mode", "text",
  "--workspace", ${JSON.stringify(workspace)},
  "--offline",
  "--no-extensions",
  "--no-session",
  "--approve",
  "--provider", "inline-final-no-output",
  "--model", "inline-model",
  "first prompt",
  "second prompt",
], {
  extensionFactories: [{
    name: "inline-final-no-output",
    factory(ohm) {
      ohm.registerProvider("inline-final-no-output", {
        api: "openai-responses",
        apiKey: "fixture-key",
        baseUrl: "https://example.invalid/v1",
        models: [{
          id: "inline-model",
          name: "Inline Model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8000,
          maxTokens: 1000,
        }],
      });
    },
  }],
});
`, "utf8");

  const result = await executeWithClosedStdin(process.execPath, ["--import", "tsx", entrypoint], {
    cwd: repositoryRoot,
    env: { ...process.env, OHM_HOME: agentDir, OHM_OFFLINE: "1" },
    timeout: 30_000,
  });
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("an explicit text mode remains one-shot when both streams are TTYs", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-main-explicit-text-mode-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const entrypoint = join(root, "entrypoint.mjs");
  const observed = join(root, "mode.txt");
  await mkdir(workspace);
  context.after(async () => await rm(root, { recursive: true, force: true }));

  await writeFile(entrypoint, `
import { writeFileSync } from "node:fs";
import { main } from ${JSON.stringify(mainModule)};

Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
await main([
  "--mode", "text",
  "--workspace", ${JSON.stringify(workspace)},
  "--offline",
  "--no-extensions",
  "--no-session",
  "--approve",
  "--provider", "inline-text-mode",
  "--model", "inline-model",
  "hello",
], {
  extensionFactories: [{
    name: "inline-text-mode",
    factory(ohm) {
      ohm.registerProvider("inline-text-mode", {
        api: "openai-responses",
        apiKey: "fixture-key",
        baseUrl: "https://example.invalid/v1",
        models: [{
          id: "inline-model",
          name: "Inline Model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8000,
          maxTokens: 1000,
        }],
      });
      ohm.on("session_start", (_event, extensionContext) => {
        writeFileSync(${JSON.stringify(observed)}, extensionContext.mode);
      });
      ohm.on("session_start", () => {
        throw new Error("text startup failure sentinel");
      });
      ohm.on("input", () => ({ action: "handled" }));
    },
  }],
});
`, "utf8");

  const result = await executeWithClosedStdin(process.execPath, ["--import", "tsx", entrypoint], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      OHM_HOME: agentDir,
      OHM_OFFLINE: "1",
    },
    timeout: 30_000,
  });
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Extension error \(inline-inline-text-mode, .*session_start\): Runtime session_start handler failed: text startup failure sentinel/u);
  assert.equal(await readFile(observed, "utf8"), "print");
});

test("interactive CLI executes slash commands before an active prompt settles", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-main-active-slash-command-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const entrypoint = join(root, "entrypoint.mjs");
  const observed = join(root, "observed.jsonl");
  await Promise.all([mkdir(workspace), mkdir(agentDir)]);
  context.after(async () => await rm(root, { recursive: true, force: true }));

  const controllerModule = pathToFileURL(
    fileURLToPath(new URL("../../src/tui/controller.ts", import.meta.url)),
  ).href;
  await writeFile(entrypoint, `
import { appendFileSync } from "node:fs";
import { main } from ${JSON.stringify(mainModule)};
import { AgentSession } from ${JSON.stringify(agentSessionModule)};
import { TuiController } from ${JSON.stringify(controllerModule)};

Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
Object.defineProperty(process.stdout, "columns", { value: 100, configurable: true });
Object.defineProperty(process.stdout, "rows", { value: 30, configurable: true });
process.stdin.setRawMode = () => process.stdin;

const record = (value) => appendFileSync(${JSON.stringify(observed)}, JSON.stringify(value) + "\\n");
let releasePrompt;
let released = false;
let active = false;
let suspended;
const promptGate = new Promise((resolve) => { releasePrompt = resolve; });
let fallback;
const release = (source) => {
  if (released) return;
  released = true;
  clearTimeout(fallback);
  record("release:" + source);
  releasePrompt();
};

AgentSession.prototype.prompt = async function(text, options) {
  if (text === "/active-resource now") {
    record("resource:" + options.streamingBehavior);
    return;
  }
  active = true;
  suspended = {
    operationId: "active-slash-operation",
    acceptedAt: "2026-08-11T00:00:00.000Z",
    cancelled: false,
    attempts: 1,
    claimedQueueIds: [],
    effects: [{
      effectId: "active-slash-effect",
      callId: "active-slash-call",
      name: "bash",
      policy: "never_repeat",
      status: "dispatched",
      step: 0,
      index: 0,
      inputHash: "active-slash-input",
    }],
  };
  record("prompt:" + text);
  fallback = setTimeout(() => release("timeout"), 5_000);
  await promptGate;
  record("prompt:settled");
};
Object.defineProperty(AgentSession.prototype, "isStreaming", {
  configurable: true,
  get() { return active; },
});
Object.defineProperty(AgentSession.prototype, "isIdle", {
  configurable: true,
  get() { return !active && suspended === undefined; },
});
Object.defineProperty(AgentSession.prototype, "suspendedRun", {
  configurable: true,
  get() { return suspended; },
});
AgentSession.prototype.followUp = async function(text) {
  record("follow:" + text);
};
AgentSession.prototype.abort = async function(reason) {
  if (String(reason).includes("/new requested")) {
    record("abort:" + reason);
    active = false;
    suspended = { ...suspended, cancelled: true };
    release("new");
  }
};
AgentSession.prototype.recoverInterruptedRun = async function(options = {}) {
  record("recover:" + JSON.stringify(options.resolutions ?? []));
  if ((options.resolutions?.length ?? 0) === 0) {
    return {
      recovered: false,
      operationId: suspended?.operationId,
      blocked: [{
        effectId: "active-slash-effect",
        name: "bash",
        reason: "This tool cannot be repeated safely.",
      }],
    };
  }
  const operationId = suspended.operationId;
  suspended = undefined;
  return { recovered: true, operationId, blocked: [] };
};

let started = false;
for (const Terminal of [TuiController]) {
  const originalNotify = Terminal.prototype.notify;
  Terminal.prototype.notify = function(message, kind) {
    if (String(message).startsWith("Interactive commands:")) {
      record("help");
    }
    if (String(message) === "Started a new session") {
      record("new");
    }
    return originalNotify.call(this, message, kind);
  };
}
const originalSetStartup = TuiController.prototype.setStartup;
TuiController.prototype.setStartup = function(...args) {
  originalSetStartup.apply(this, args);
  if (started) return;
  started = true;
  record("ready");
};
await main([
  "chat",
  "--workspace", ${JSON.stringify(workspace)},
  "--provider", "active-command-provider",
  "--model", "active-model",
  "--offline",
  "--no-session",
  "--approve",
], {
  extensionFactories: [{
    name: "active-command-provider-fixture",
    factory(ohm) {
      ohm.registerProvider("active-command-provider", {
        api: "openai-responses",
        apiKey: "fixture-key",
        baseUrl: "https://example.invalid/v1",
        models: [{
          id: "active-model",
          name: "Active Model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8000,
          maxTokens: 1000,
        }],
      });
      ohm.registerCommand("active-resource", {
        handler() { return { prompt: "resource prompt" }; },
      });
    },
  }],
});
`, "utf8");

  const child = spawn(process.execPath, ["--import", "tsx", entrypoint], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      OHM_HOME: agentDir,
      OHM_OFFLINE: "1",
      TERM: "xterm-256color",
      NO_COLOR: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  context.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  await waitForJsonlEntry(observed, "ready");
  child.stdin.write("hold\r");
  await waitForJsonlEntry(observed, "prompt:hold");
  child.stdin.write("/active-resource now\r");
  await waitForJsonlEntry(observed, "resource:followUp");
  child.stdin.write("/follow next step\r");
  await waitForJsonlEntry(observed, "follow:next step");
  child.stdin.write("/help\r");
  await waitForJsonlEntry(observed, "help");
  child.stdin.write("/new\r");
  await waitForJsonlEntry(observed, "new");
  child.stdin.write("/quit\r");
  await new Promise<void>((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Active slash fixture timed out\nstdout:\n${stdout.slice(-8_000)}\nstderr:\n${stderr.slice(-8_000)}`));
    }, 30_000);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolveExit();
      else reject(new Error(`Active slash fixture exited with ${code ?? signal}\nstdout:\n${stdout.slice(-8_000)}\nstderr:\n${stderr.slice(-8_000)}`));
    });
  });
  const records = (await readFile(observed, "utf8")).trim().split("\n").map((line) => parseJson(STRING_VALUE, line));
  for (const expected of [
    "prompt:hold",
    "resource:followUp",
    "follow:next step",
    "help",
    "abort:/new requested",
    "release:new",
    'recover:[{"effectId":"active-slash-effect","outcome":"abandoned"}]',
    "new",
  ]) assert.notEqual(records.indexOf(expected), -1, expected);
  assert.ok(records.indexOf("resource:followUp") < records.indexOf("prompt:settled"));
  assert.ok(records.indexOf("help") < records.indexOf("prompt:settled"));
  assert.ok(records.indexOf("abort:/new requested") < records.indexOf('recover:[{"effectId":"active-slash-effect","outcome":"abandoned"}]'));
  assert.ok(records.indexOf('recover:[{"effectId":"active-slash-effect","outcome":"abandoned"}]') < records.indexOf("new"));
  assert.equal(stderr.replaceAll("\u001b[?25h", ""), "");
});

test("installed interactive CLI executes an active extension handler and follows its prompt once", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-main-active-extension-handler-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const entrypoint = join(root, "entrypoint.mjs");
  const observed = join(root, "observed.jsonl");
  await Promise.all([mkdir(workspace), mkdir(agentDir)]);
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const controllerModule = pathToFileURL(
    fileURLToPath(new URL("../../src/tui/controller.ts", import.meta.url)),
  ).href;

  await writeFile(entrypoint, `
import { appendFileSync } from "node:fs";
import { main } from ${JSON.stringify(mainModule)};
import { TuiController } from ${JSON.stringify(controllerModule)};

Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
Object.defineProperty(process.stdout, "columns", { value: 100, configurable: true });
Object.defineProperty(process.stdout, "rows", { value: 30, configurable: true });
process.stdin.setRawMode = () => process.stdin;

const record = (value) => appendFileSync(${JSON.stringify(observed)}, JSON.stringify(value) + "\\n");
const messageText = (message) => typeof message.content === "string"
  ? message.content
  : message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
let releaseFirst;
const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
let requests = 0;
let started = false;
const originalSetStartup = TuiController.prototype.setStartup;
TuiController.prototype.setStartup = function(...args) {
  originalSetStartup.apply(this, args);
  if (started) return;
  started = true;
  record("ready");
};
await main([
  "chat",
  "--workspace", ${JSON.stringify(workspace)},
  "--provider", "active-handler-provider",
  "--model", "active-handler-model",
  "--offline",
  "--no-session",
  "--approve",
], {
  extensionFactories: [{
    name: "active-handler-fixture",
    factory(ohm) {
      ohm.registerProvider("active-handler-provider", {
        api: "openai-responses",
        apiKey: "fixture-key",
        baseUrl: "https://example.invalid/v1",
        models: [{
          id: "active-handler-model",
          name: "Active handler model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8000,
          maxTokens: 1000,
        }],
        streamSimple: async function* (model, context) {
          requests += 1;
          const latest = context.messages.filter((message) => message.role === "user").map(messageText).at(-1);
          record("provider:start:" + latest);
          yield { type: "response_start", model: model.id };
          if (requests === 1) await firstGate;
          yield { type: "text_delta", part: 0, text: "answer-" + requests };
          yield {
            type: "response_end",
            reason: "stop",
            state: { kind: "openai_responses", outputItems: [] },
          };
          record("provider:end:" + latest);
        },
      });
      ohm.registerCommand("active-resource", {
        handler(args) {
          record("handler:" + args);
          setImmediate(releaseFirst);
          return { prompt: "returned prompt " + args };
        },
      });
      ohm.on("input", (event) => {
        record("input:" + event.text);
        return { action: "continue" };
      });
    },
  }],
});
`, "utf8");

  const child = spawn(process.execPath, ["--import", "tsx", entrypoint], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      OHM_HOME: agentDir,
      OHM_OFFLINE: "1",
      TERM: "xterm-256color",
      NO_COLOR: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  context.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  await waitForJsonlEntry(observed, "ready");
  child.stdin.write("hold\r");
  await waitForJsonlEntry(observed, "provider:start:hold");
  child.stdin.write("/active-resource now\r");
  await waitForJsonlEntry(observed, "provider:end:returned prompt now");
  child.stdin.write("/quit\r");
  await new Promise<void>((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Active extension fixture timed out\nstdout:\n${stdout.slice(-8_000)}\nstderr:\n${stderr.slice(-8_000)}`));
    }, 30_000);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolveExit();
      else reject(new Error(`Active extension fixture exited with ${code ?? signal}\nstdout:\n${stdout.slice(-8_000)}\nstderr:\n${stderr.slice(-8_000)}`));
    });
  });
  const records = (await readFile(observed, "utf8")).trim().split("\n").map((line) => parseJson(STRING_VALUE, line));
  assert.equal(records.filter((entry) => entry === "handler:now").length, 1);
  assert.equal(records.filter((entry) => entry === "input:returned prompt now").length, 1);
  assert.equal(records.filter((entry) => entry === "provider:start:returned prompt now").length, 1);
  assert.ok(records.indexOf("handler:now") < records.indexOf("provider:end:hold"));
  assert.ok(records.indexOf("provider:end:hold") < records.indexOf("provider:start:returned prompt now"));
  assert.equal(stderr.replaceAll("\u001b[?25h", ""), "");
});

test("interactive CLI cancellation prevents a prompt from starting after reference preparation", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-main-cancel-prompt-preparation-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const entrypoint = join(root, "entrypoint.mjs");
  const observed = join(root, "observed.jsonl");
  await Promise.all([mkdir(workspace), mkdir(agentDir)]);
  await writeFile(join(workspace, "slow.txt"), "prepared input", "utf8");
  context.after(async () => await rm(root, { recursive: true, force: true }));

  const controllerModule = pathToFileURL(
    fileURLToPath(new URL("../../src/tui/controller.ts", import.meta.url)),
  ).href;
  const pathsModule = pathToFileURL(
    fileURLToPath(new URL("../../src/tools/paths.ts", import.meta.url)),
  ).href;
  await writeFile(entrypoint, `
import { appendFileSync } from "node:fs";
import { main } from ${JSON.stringify(mainModule)};
import { AgentSession } from ${JSON.stringify(agentSessionModule)};
import { TuiController } from ${JSON.stringify(controllerModule)};
import { WorkspaceBoundary } from ${JSON.stringify(pathsModule)};

Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
Object.defineProperty(process.stdout, "columns", { value: 100, configurable: true });
Object.defineProperty(process.stdout, "rows", { value: 30, configurable: true });
process.stdin.setRawMode = () => process.stdin;

const record = (value) => appendFileSync(${JSON.stringify(observed)}, JSON.stringify(value) + "\\n");
let releasePreparation;
const preparationGate = new Promise((resolve) => { releasePreparation = resolve; });
const readableFile = WorkspaceBoundary.prototype.readableFile;
WorkspaceBoundary.prototype.readableFile = async function(path) {
  if (path === "slow.txt") {
    record("prepare:started");
    setImmediate(() => process.stdin.emit("data", Buffer.from("/cancel\\r")));
    await preparationGate;
    record("prepare:released");
  }
  return await readableFile.call(this, path);
};

AgentSession.prototype.prompt = async function(text) {
  record("prompt:" + text);
};
const abort = AgentSession.prototype.abort;
AgentSession.prototype.abort = async function(reason) {
  if (reason === "Cancelled by user") {
    record("abort:" + reason);
    releasePreparation();
    setTimeout(() => process.stdin.emit("data", Buffer.from("/quit\\r")), 100);
  }
  return await abort.call(this, reason);
};

let started = false;
const setStartup = TuiController.prototype.setStartup;
TuiController.prototype.setStartup = function(...args) {
  setStartup.apply(this, args);
  if (started) return;
  started = true;
  setImmediate(() => process.stdin.emit("data", Buffer.from('@"slow.txt"\\r')));
};

await main([
  "chat",
  "--workspace", ${JSON.stringify(workspace)},
  "--provider", "cancel-preparation-provider",
  "--model", "cancel-preparation-model",
  "--offline",
  "--no-session",
  "--approve",
], {
  extensionFactories: [{
    name: "cancel-preparation-provider-fixture",
    factory(ohm) {
      ohm.registerProvider("cancel-preparation-provider", {
        api: "openai-responses",
        apiKey: "fixture-key",
        baseUrl: "https://example.invalid/v1",
        models: [{
          id: "cancel-preparation-model",
          name: "Cancel Preparation Model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8000,
          maxTokens: 1000,
        }],
      });
    },
  }],
});
`, "utf8");

  const child = spawn(process.execPath, ["--import", "tsx", entrypoint], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      OHM_HOME: agentDir,
      OHM_OFFLINE: "1",
      TERM: "xterm-256color",
      NO_COLOR: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  context.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  await new Promise<void>((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Prompt preparation fixture timed out\nstdout:\n${stdout.slice(-8_000)}\nstderr:\n${stderr.slice(-8_000)}`));
    }, 30_000);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolveExit();
      else reject(new Error(`Prompt preparation fixture exited with ${code ?? signal}\nstdout:\n${stdout.slice(-8_000)}\nstderr:\n${stderr.slice(-8_000)}`));
    });
  });
  const records = (await readFile(observed, "utf8")).trim().split("\n").map((line) => parseJson(STRING_VALUE, line));
  assert.deepEqual(records.slice(0, 3), [
    "prepare:started",
    "abort:Cancelled by user",
    "prepare:released",
  ]);
  assert.doesNotMatch(records.join("\n"), /^prompt:/mu);
  assert.equal(stderr.replaceAll("\u001b[?25h", ""), "");
});

test("interactive CLI owns login cancellation alongside the active prompt", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-main-active-login-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const entrypoint = join(root, "entrypoint.mjs");
  const observed = join(root, "observed.jsonl");
  await Promise.all([mkdir(workspace), mkdir(agentDir)]);
  context.after(async () => await rm(root, { recursive: true, force: true }));

  const controllerModule = pathToFileURL(
    fileURLToPath(new URL("../../src/tui/controller.ts", import.meta.url)),
  ).href;
  await writeFile(entrypoint, `
import { appendFileSync } from "node:fs";
import { main } from ${JSON.stringify(mainModule)};
import { AgentSession } from ${JSON.stringify(agentSessionModule)};
import { TuiController } from ${JSON.stringify(controllerModule)};

Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
Object.defineProperty(process.stdout, "columns", { value: 100, configurable: true });
Object.defineProperty(process.stdout, "rows", { value: 30, configurable: true });
process.stdin.setRawMode = () => process.stdin;

const record = (value) => appendFileSync(${JSON.stringify(observed)}, JSON.stringify(value) + "\\n");
let steer;
const setSteering = TuiController.prototype.setSteering;
TuiController.prototype.setSteering = function(handler) {
  if (handler !== undefined) steer = handler;
  return setSteering.call(this, handler);
};
let releasePrompt;
const promptGate = new Promise((resolve) => { releasePrompt = resolve; });
AgentSession.prototype.prompt = async function(text) {
  record("prompt:" + text);
  setImmediate(() => {
    steer?.("/login active-login-provider");
  });
  await promptGate;
  record("prompt:settled");
};
const abort = AgentSession.prototype.abort;
AgentSession.prototype.abort = async function(reason) {
  if (reason === "Cancelled by user") {
    record("prompt:aborted");
    releasePrompt();
  }
  return await abort.call(this, reason);
};

const notify = TuiController.prototype.notify;
let quitting = false;
const requestQuit = () => { if (quitting) steer?.("/quit"); };
TuiController.prototype.notify = function(message, kind) {
  if (String(message).startsWith("Another command is active")) {
    record("command:busy");
    if (quitting) setTimeout(requestQuit, 50);
  }
  return notify.call(this, message, kind);
};
const choose = TuiController.prototype.choose;
TuiController.prototype.choose = async function(title, options, signal) {
  if (String(title).startsWith("Connect ")) {
    return options.find((option) => option.label === "Use a subscription or provider account").value;
  }
  return await choose.call(this, title, options, signal);
};
let started = false;
const setStartup = TuiController.prototype.setStartup;
TuiController.prototype.setStartup = function(...args) {
  setStartup.apply(this, args);
  if (started) return;
  started = true;
  setImmediate(() => process.stdin.emit("data", Buffer.from("hold\\r")));
};

await main([
  "chat",
  "--workspace", ${JSON.stringify(workspace)},
  "--provider", "active-login-provider",
  "--model", "active-login-model",
  "--offline",
  "--no-session",
  "--approve",
], {
  extensionFactories: [{
    name: "active-login-provider-fixture",
    factory(ohm) {
      ohm.registerProvider("active-login-provider", {
        api: "openai-responses",
        apiKey: "fixture-key",
        baseUrl: "https://example.invalid/v1",
        models: [{
          id: "active-login-model",
          name: "Active Login Model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8000,
          maxTokens: 1000,
        }],
        oauth: {
          name: "Active login",
          async login(interaction) {
            record("login:started");
            setImmediate(() => {
              record("second-command:sent");
              steer?.("/session");
            });
            setTimeout(() => steer?.("/cancel"), 50);
            return await new Promise((resolve, reject) => {
              const fallback = setTimeout(() => {
                record("login:fallback");
                resolve({ access: "fallback-access", expires: Date.now() + 60_000 });
              }, 500);
              const cancelled = () => {
                clearTimeout(fallback);
                record("login:aborted");
                quitting = true;
                setTimeout(requestQuit, 50);
                reject(interaction.signal?.reason);
              };
              if (interaction.signal?.aborted === true) cancelled();
              else interaction.signal?.addEventListener("abort", cancelled, { once: true });
            });
          },
          async refreshToken(credential) { return credential; },
          getApiKey(credential) { return credential.access; },
        },
      });
    },
  }],
});
`, "utf8");

  const child = spawn(process.execPath, ["--import", "tsx", entrypoint], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      OHM_HOME: agentDir,
      OHM_OFFLINE: "1",
      TERM: "xterm-256color",
      NO_COLOR: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  context.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  await new Promise<void>((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Active login fixture timed out\nstdout:\n${stdout.slice(-8_000)}\nstderr:\n${stderr.slice(-8_000)}`));
    }, 30_000);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolveExit();
      else reject(new Error(`Active login fixture exited with ${code ?? signal}\nstdout:\n${stdout.slice(-8_000)}\nstderr:\n${stderr.slice(-8_000)}`));
    });
  });
  const records = (await readFile(observed, "utf8")).trim().split("\n").map((line) => parseJson(STRING_VALUE, line));
  assert.ok(records.includes("command:busy"), `second command was not rejected immediately: ${records.join(", ")}`);
  assert.ok(records.includes("login:aborted"), `login was not cancelled: ${records.join(", ")}`);
  assert.ok(records.includes("prompt:aborted"), `active prompt was not cancelled: ${records.join(", ")}`);
  assert.ok(!records.includes("login:fallback"), `login outlived cancellation: ${records.join(", ")}`);
  assert.equal(stderr.replaceAll("\u001b[?25h", ""), "");
});

test("headless startup clamps inherited thinking, applies model suffixes, and honors explicit thinking", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-main-thinking-clamp-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const entrypoint = join(root, "entrypoint.mjs");
  const observed = join(root, "observed.txt");
  await Promise.all([mkdir(workspace), mkdir(agentDir)]);
  await writeFile(join(agentDir, "config.json"), `${JSON.stringify({
    defaultThinkingLevel: "max",
  })}\n`);
  context.after(async () => await rm(root, { recursive: true, force: true }));

  await writeFile(entrypoint, `
import { writeFileSync } from "node:fs";
import { main } from ${JSON.stringify(mainModule)};

await main([
  "--print",
  "--workspace", ${JSON.stringify(workspace)},
  "--offline",
  "--no-extensions",
  "--no-session",
  "--approve",
  "--provider", "inline-thinking",
  "--model", process.env.OHM_TEST_MODEL ?? "xhigh-only",
  ...(process.env.OHM_TEST_THINKING === undefined
    ? []
    : ["--thinking", process.env.OHM_TEST_THINKING]),
  "hello",
], {
  extensionFactories: [{
    name: "inline-thinking-provider",
    factory(ohm) {
      ohm.registerProvider("inline-thinking", {
        api: "openai-responses",
        apiKey: "fixture-key",
        baseUrl: "https://example.invalid/v1",
        models: [{
          id: "xhigh-only",
          name: "Xhigh-only model",
          reasoning: true,
          thinkingLevelMap: {
            off: null,
            minimal: null,
            low: null,
            medium: null,
            high: null,
            xhigh: "xhigh",
            max: null,
          },
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8000,
          maxTokens: 1000,
        }, {
          id: "max-and-xhigh",
          name: "Max and xhigh model",
          reasoning: true,
          thinkingLevelMap: {
            off: null,
            minimal: null,
            low: null,
            medium: null,
            high: null,
            xhigh: "xhigh",
            max: "max",
          },
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8000,
          maxTokens: 1000,
        }],
        streamSimple: async function* (model, _context, options) {
          writeFileSync(${JSON.stringify(observed)}, String(options?.reasoning));
          yield { type: "response_start", model: model.id };
          yield { type: "text_delta", part: 0, text: "clamped" };
          yield {
            type: "response_end",
            reason: "stop",
            state: { kind: "openai_responses", outputItems: [] },
          };
        },
      });
    },
  }],
});
`, "utf8");

  const result = await executeWithClosedStdin(process.execPath, ["--import", "tsx", entrypoint], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      OHM_HOME: agentDir,
      OHM_OFFLINE: "1",
    },
    timeout: 30_000,
  });
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, "clamped\n");
  assert.equal(await readFile(observed, "utf8"), "xhigh");

  await writeFile(join(agentDir, "config.json"), `${JSON.stringify({
    defaultThinkingLevel: "max",
  })}\n`);
  const inline = await executeWithClosedStdin(process.execPath, ["--import", "tsx", entrypoint], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      OHM_HOME: agentDir,
      OHM_OFFLINE: "1",
      OHM_TEST_MODEL: "max-and-xhigh:xhigh",
    },
    timeout: 30_000,
  });
  assert.equal(inline.stderr, "");
  assert.equal(inline.stdout, "clamped\n");
  assert.equal(await readFile(observed, "utf8"), "xhigh");

  await writeFile(join(agentDir, "config.json"), `${JSON.stringify({
    defaultThinkingLevel: "max",
  })}\n`);
  const explicit = await executeWithClosedStdin(process.execPath, ["--import", "tsx", entrypoint], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      OHM_HOME: agentDir,
      OHM_OFFLINE: "1",
      OHM_TEST_MODEL: "max-and-xhigh:xhigh",
      OHM_TEST_THINKING: "max",
    },
    timeout: 30_000,
  });
  assert.equal(explicit.stderr, "");
  assert.equal(explicit.stdout, "clamped\n");
  assert.equal(await readFile(observed, "utf8"), "max");
});

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await condition()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

function replacementFactory(marker: string): string {
  return `{
    name: "inline-owner-replacement",
    factory(ohm) {
      ohm.registerProvider("inline-owner", {
        name: "Inline Owner",
        api: "openai-responses",
        apiKey: "fixture-key",
        baseUrl: "https://example.invalid/v1",
        models: [{
          id: "inline-model",
          name: "Inline Model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8000,
          maxTokens: 1000,
        }],
      });
      ohm.on("session_start", (event) => {
        appendFileSync(${JSON.stringify(marker)}, \`start:\${event.reason}\\n\`);
      });
      ohm.registerCommand("replace-runtime", {
        async handler(_args, context) {
          const result = await context.newSession({
            async withSession(replacement) {
              await replacement.sendMessage({
                customType: "owner-replacement",
                content: "replacement ready",
                display: true,
              });
            },
          });
          if (result.cancelled) throw new Error("runtime replacement was cancelled");
        },
      });
    },
  }`;
}

test("main activates supplied extension factories and exposes their models to the invocation", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-main-inline-extension-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const entrypoint = join(root, "entrypoint.mjs");
  await mkdir(workspace);
  context.after(async () => await rm(root, { recursive: true, force: true }));

  await writeFile(entrypoint, `
import { main } from ${JSON.stringify(mainModule)};

await main([
  "--workspace", ${JSON.stringify(workspace)},
  "--offline",
  "--no-extensions",
  "--list-models", "inline-main",
], {
  extensionFactories: [{
    name: "inline-main-factory",
    factory(ohm) {
      ohm.registerProvider("inline-main", {
        name: "Inline Main",
        api: "openai-responses",
        apiKey: "fixture-key",
        baseUrl: "https://example.invalid/v1",
        models: [{
          id: "inline-model",
          name: "Inline Model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8000,
          maxTokens: 1000,
        }],
      });
    },
  }],
});
`);

  const result = await execute(process.execPath, ["--import", "tsx", entrypoint], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      OHM_HOME: agentDir,
      OHM_OFFLINE: "1",
    },
    timeout: 30_000,
  });

  assert.match(result.stdout, /^inline-main\/inline-model\t/u);
  assert.equal(result.stderr, "");
});

test("extension inspection commands include supplied extension factories", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-main-inline-inspection-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const entrypoint = join(root, "entrypoint.mjs");
  await mkdir(workspace);
  context.after(async () => await rm(root, { recursive: true, force: true }));

  await writeFile(entrypoint, `
import { main } from ${JSON.stringify(mainModule)};

await main([
  "extensions", "commands",
  "--json",
  "--workspace", ${JSON.stringify(workspace)},
], {
  extensionFactories: [{
    name: "inline-inspection-factory",
    factory(ohm) {
      ohm.registerCommand("inline-inspection", {
        description: "Inline command",
        async handler() {},
      });
    },
  }],
});
`);

  const result = await execute(process.execPath, ["--import", "tsx", entrypoint], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      OHM_HOME: agentDir,
      OHM_OFFLINE: "1",
    },
    timeout: 30_000,
  });
  const report = parseJson(RUNTIME_COMMAND_REPORT_VALUE, result.stdout);
  assert.deepEqual(report.runtime.map((entry) => entry.name), ["inline-inspection"]);
  assert.equal(result.stderr, "");
});

test("RPC mode retains supplied factories in its session runtime", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-main-inline-rpc-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const entrypoint = join(root, "entrypoint.mjs");
  const trustMarker = join(root, "rpc-trust.txt");
  await mkdir(join(workspace, ".ohm"), { recursive: true });
  await writeFile(join(workspace, ".ohm", "config.json"), "{}\n");
  context.after(async () => await rm(root, { recursive: true, force: true }));

  await writeFile(entrypoint, `
import { appendFileSync } from "node:fs";
import { main } from ${JSON.stringify(mainModule)};

await main([
  "--mode", "rpc",
  "--workspace", ${JSON.stringify(workspace)},
  "--offline",
  "--no-extensions",
  "--no-session",
], {
  extensionFactories: [{
    name: "inline-rpc-factory",
    factory(ohm) {
      ohm.on("project_trust", () => {
        appendFileSync(${JSON.stringify(trustMarker)}, "1");
        return { trusted: "yes" };
      });
      ohm.on("session_start", (_event, context) => {
        context.ui.notify("Inline RPC UI");
      });
      ohm.registerCommand("inline-rpc", {
        description: "Inline RPC command",
        async handler() {},
      });
    },
  }],
});
`);

  const child = spawn(process.execPath, ["--import", "tsx", entrypoint], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      OHM_HOME: agentDir,
      OHM_OFFLINE: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  child.stdin.end(`${JSON.stringify({ id: "commands", type: "get_commands" })}\n`);
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`RPC factory fixture timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 30_000);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolveExit({ code, signal });
    });
  });

  assert.deepEqual(exit, { code: 0, signal: null }, stderr);
  const responses = stdout.trim().split("\n").flatMap((line) => {
    try { return [parseJson(RPC_RECORD_VALUE, line)]; }
    catch { return []; }
  });
  const response = responses.find((entry) => entry.id === "commands");
  assert.equal(response?.success, true, stdout);
  assert.equal(response?.data?.commands?.some((entry) => entry.name === "inline-rpc"), true, stdout);
  const uiRequest = responses.find((entry) => entry.type === "extension_ui_request");
  assert.equal(uiRequest?.extensionId, "inline-inline-rpc-factory", stdout);
  assert.equal(await readFile(trustMarker, "utf8"), "1");
});

test("installed RPC mode rebinds extension commands through the session runtime owner", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-main-rpc-owner-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const entrypoint = join(root, "entrypoint.mjs");
  const marker = join(root, "session-starts.txt");
  await mkdir(workspace);
  context.after(async () => await rm(root, { recursive: true, force: true }));

  await writeFile(entrypoint, `
import { appendFileSync } from "node:fs";
import { main } from ${JSON.stringify(mainModule)};

await main([
  "--mode", "rpc",
  "--workspace", ${JSON.stringify(workspace)},
  "--offline",
  "--no-extensions",
  "--no-session",
  "--approve",
  "--provider", "inline-owner",
  "--model", "inline-model",
], {
  extensionFactories: [${replacementFactory(marker)}],
});
`);

  const child = spawn(process.execPath, ["--import", "tsx", entrypoint], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      OHM_HOME: agentDir,
      OHM_OFFLINE: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  context.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  child.stdin.write(`${JSON.stringify({ id: "replace", type: "prompt", message: "/replace-runtime" })}\n`);

  await waitFor(async () => {
    const starts = await readFile(marker, "utf8").catch(() => "");
    return starts.trim().split("\n").filter(Boolean).length >= 2
      && stdout.split("\n").some((line) => {
        try {
          const record = parseJson(RPC_RECORD_VALUE, line);
          return record.id === "replace" && record.success === true;
        } catch {
          return false;
        }
      });
  }, "RPC extension-owned session replacement");
  child.stdin.end();
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`RPC owner fixture timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 30_000);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolveExit({ code, signal });
    });
  });

  assert.deepEqual(exit, { code: 0, signal: null }, stderr);
  assert.deepEqual((await readFile(marker, "utf8")).trim().split("\n"), [
    "start:startup",
    "start:new",
  ]);
});

test("installed text and JSON modes rebind extension commands through the session runtime owner", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-main-print-owner-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));

  for (const mode of ["text", "json"] as const) {
    const workspace = join(root, `workspace-${mode}`);
    const agentDir = join(root, `agent-${mode}`);
    const entrypoint = join(root, `entrypoint-${mode}.mjs`);
    const marker = join(root, `session-starts-${mode}.txt`);
    await mkdir(workspace);
    const modeArguments = mode === "text" ? ["--print"] : ["--mode", "json"];
    await writeFile(entrypoint, `
import { appendFileSync } from "node:fs";
import { main } from ${JSON.stringify(mainModule)};

await main([
  ...${JSON.stringify(modeArguments)},
  "--workspace", ${JSON.stringify(workspace)},
  "--offline",
  "--no-extensions",
  "--no-session",
  "--approve",
  "--provider", "inline-owner",
  "--model", "inline-model",
  "/replace-runtime",
], {
  extensionFactories: [${replacementFactory(marker)}],
});
`);
    const result = await executeWithClosedStdin(process.execPath, ["--import", "tsx", entrypoint], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        OHM_HOME: agentDir,
        OHM_OFFLINE: "1",
      },
      timeout: 30_000,
    });
    assert.equal(result.stderr, "", `${mode}: ${result.stderr}`);
    assert.deepEqual((await readFile(marker, "utf8")).trim().split("\n"), [
      "start:startup",
      "start:new",
    ]);
    if (mode === "json") {
      const records = result.stdout.trim().split("\n").map((line) => parseJson(SESSION_EVENT_VALUE, line));
      assert.equal(records[0]?.type, "session");
      assert.equal(
        records.some((record) =>
          record.type === "entry_appended" && record.entry?.customType === "owner-replacement"),
        true,
      );
    } else assert.equal(result.stdout, "");
  }
});

test("installed JSON mode emits the public session event contract", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-main-json-events-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const entrypoint = join(root, "entrypoint.mjs");
  await mkdir(workspace);
  context.after(async () => await rm(root, { recursive: true, force: true }));

  await writeFile(entrypoint, `
import { main } from ${JSON.stringify(mainModule)};

await main([
  "--mode", "json",
  "--workspace", ${JSON.stringify(workspace)},
  "--offline",
  "--no-extensions",
  "--no-session",
  "--approve",
  "--provider", "inline-json",
  "--model", "inline-model",
  "hello",
], {
  extensionFactories: [{
    name: "inline-json-provider",
    factory(ohm) {
      ohm.registerProvider("inline-json", {
        api: "openai-responses",
        apiKey: "fixture-key",
        baseUrl: "https://example.invalid/v1",
        models: [{
          id: "inline-model",
          name: "Inline Model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8000,
          maxTokens: 1000,
        }],
        streamSimple: async function* () {
          yield { type: "response_start", model: "inline-model" };
          yield { type: "text_delta", part: 0, text: "hello back" };
          yield {
            type: "response_end",
            reason: "stop",
            state: { kind: "openai_responses", outputItems: [] },
          };
        },
      });
      ohm.on("session_start", () => {
        throw new Error("json startup failure sentinel");
      });
    },
  }],
});
`);

  const result = await executeWithClosedStdin(process.execPath, ["--import", "tsx", entrypoint], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      OHM_HOME: agentDir,
      OHM_OFFLINE: "1",
    },
    timeout: 30_000,
  });
  assert.equal(result.stderr, "");
  const records = result.stdout.trim().split("\n").map((line) => parseJson(RPC_RECORD_VALUE, line));
  const types = records.map((entry) => entry.type);
  assert.equal(types[0], "session");
  const extensionError = records.find((entry) => entry.type === "extension_error");
  assert.equal(extensionError?.extensionId, "inline-inline-json-provider");
  assert.equal(extensionError?.event, "session_start");
  assert.match(String(extensionError?.error), /json startup failure sentinel/u);
  for (const expected of ["agent_start", "turn_start", "message_start", "message_end", "turn_end", "agent_end", "agent_settled"]) {
    assert.equal(types.includes(expected), true, `missing ${expected}: ${types.join(", ")}`);
  }
  assert.equal(types.includes("run_started"), false);
  assert.equal(types.includes("message_appended"), false);
});

test("installed JSON mode keeps metadata and provider-failure stdout structured", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-main-json-provider-failure-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const extension = join(root, "provider.mjs");
  await mkdir(workspace);
  context.after(async () => await rm(root, { recursive: true, force: true }));

  await writeFile(extension, `
export default function activate(ohm) {
  console.log("extension startup notice");
  ohm.registerProvider("json-failure", {
    api: "openai-responses",
    apiKey: "fixture-key",
    baseUrl: "https://example.invalid/v1",
    models: [{
      id: "inline-model",
      name: "Inline Model",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8000,
      maxTokens: 1000,
    }],
    streamSimple: async function* () {
      yield { type: "response_start", model: "inline-model" };
      throw new Error("provider failure sentinel");
    },
  });
}
`);

  const listing = await executeWithClosedStdin(process.execPath, [
    "--import", "tsx", cliModule,
    "--mode", "json",
    "--workspace", workspace,
    "--offline",
    "--approve",
    "--extension", extension,
    "--list-models", "json-failure",
  ], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      OHM_HOME: agentDir,
      OHM_OFFLINE: "1",
    },
    timeout: 30_000,
  });
  const listingLines = listing.stdout.trim().split("\n");
  assert.equal(listingLines.length, 1, listing.stdout);
  const listed = parseJson(MODEL_LIST_VALUE, listingLines[0]!);
  assert.equal(listed.some((model) => model.provider === "json-failure" && model.id === "inline-model"), true);
  assert.match(listing.stderr, /extension startup notice/u);

  const child = spawn(process.execPath, [
    "--import", "tsx", cliModule,
    "--mode", "json",
    "--workspace", workspace,
    "--offline",
    "--no-session",
    "--approve",
    "--extension", extension,
    "--provider", "json-failure",
    "--model", "inline-model",
    "hello",
  ], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      OHM_HOME: agentDir,
      OHM_OFFLINE: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  child.stdin.end();
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`JSON failure fixture timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 30_000);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolveExit({ code, signal });
    });
  });

  assert.deepEqual(exit, { code: 1, signal: null }, `${stdout}\n${stderr}`);
  const records = stdout.trim().split("\n").map((line) => parseJson(MESSAGE_EVENT_VALUE, line));
  assert.equal(records.some((entry) =>
    entry.type === "message_end"
    && entry.message?.stopReason === "error"
    && entry.message.errorMessage === "provider failure sentinel"), true, stdout);
  assert.match(stderr, /extension startup notice/u);
  assert.doesNotMatch(stderr, /provider failure sentinel/u);
});

test("one-shot mode recovers accepted work before applying its requested model", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-main-recovery-order-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const sessionDirectory = join(root, "sessions");
  const entrypoint = join(root, "entrypoint.mjs");
  await mkdir(workspace);
  context.after(async () => await rm(root, { recursive: true, force: true }));

  await writeFile(entrypoint, `
import { main } from ${JSON.stringify(mainModule)};
import { SessionManager } from ${JSON.stringify(sessionManagerModule)};
import { sessionV4JsonHash } from ${JSON.stringify(sessionV4Module)};

const manager = SessionManager.create(${JSON.stringify(workspace)}, ${JSON.stringify(sessionDirectory)}, {
  id: "recovery-order",
});
manager.appendModelChange("inline-recovery", "inline-model");
manager.commitChanges([{
  type: "run_accepted",
  branchId: "main",
  operationId: "interrupted-operation",
  promptNodeId: "interrupted-prompt",
  sourceHeadId: manager.getLeafId(),
  acceptedAt: "2026-07-29T12:00:00.000Z",
  request: { prompt: "interrupted prompt" },
  selection: {
    provider: "inline-recovery",
    model: "inline-model",
    api: "openai-responses",
    thinkingLevel: "off",
    toolNames: [],
    toolsetFingerprint: sessionV4JsonHash([]),
  },
}]);
const sessionFile = manager.getSessionFile();
manager.closeV4Store();
if (sessionFile === undefined) throw new Error("persistent fixture did not create a session file");

await main([
  "--print",
  "--workspace", ${JSON.stringify(workspace)},
  "--session-dir", ${JSON.stringify(sessionDirectory)},
  "--session", sessionFile,
  "--offline",
  "--no-extensions",
  "--no-tools",
  "--approve",
  "--provider", "inline-recovery",
  "--model", "inline-model",
  "new prompt",
], {
  extensionFactories: [{
    name: "inline-recovery-provider",
    factory(ohm) {
      ohm.registerProvider("inline-recovery", {
        api: "openai-responses",
        apiKey: "fixture-key",
        baseUrl: "https://example.invalid/v1",
        models: [{
          id: "inline-model",
          name: "Inline Model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8000,
          maxTokens: 1000,
        }],
        streamSimple: async function* () {
          yield { type: "response_start", model: "inline-model" };
          yield { type: "text_delta", part: 0, text: "recovered then answered" };
          yield {
            type: "response_end",
            reason: "stop",
            state: { kind: "openai_responses", outputItems: [] },
          };
        },
      });
    },
  }],
});
`);

  const result = await executeWithClosedStdin(process.execPath, ["--import", "tsx", entrypoint], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      OHM_HOME: agentDir,
      OHM_OFFLINE: "1",
    },
    timeout: 30_000,
  });

  assert.equal(result.stderr, "");
  assert.equal(result.stdout, "recovered then answered\n");
});

test("interactive startup, resume, and installed RPC keep explicit never-repeat recovery reachable", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-main-interactive-recovery-order-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const sessionDirectory = join(root, "sessions");
  const entrypoint = join(root, "entrypoint.mjs");
  const observed = join(root, "observed.jsonl");
  await mkdir(workspace);
  context.after(async () => await rm(root, { recursive: true, force: true }));

  const controllerModule = pathToFileURL(
    fileURLToPath(new URL("../../src/tui/controller.ts", import.meta.url)),
  ).href;
  await writeFile(entrypoint, `
import { appendFileSync } from "node:fs";
import { main } from ${JSON.stringify(mainModule)};
import { AgentSession } from ${JSON.stringify(agentSessionModule)};
import { SessionManager } from ${JSON.stringify(sessionManagerModule)};
import { sessionV4JsonHash, sessionV4ToolInputHash } from ${JSON.stringify(sessionV4Module)};
import { TuiController } from ${JSON.stringify(controllerModule)};

Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
Object.defineProperty(process.stdout, "columns", { value: 100, configurable: true });
Object.defineProperty(process.stdout, "rows", { value: 30, configurable: true });
process.stdin.setRawMode = () => process.stdin;

const scenario = process.argv[2];
if (scenario !== "startup" && scenario !== "resume" && scenario !== "rpc") {
  throw new Error("invalid recovery scenario");
}
const record = (value) => appendFileSync(
  ${JSON.stringify(observed)},
  JSON.stringify({ scenario, ...value }) + "\\n",
);
const time = "2026-07-29T12:00:00.000Z";
const scenarioSessionDirectory = ${JSON.stringify(sessionDirectory)} + "-" + scenario;
const manager = SessionManager.create(${JSON.stringify(workspace)}, scenarioSessionDirectory, {
  id: "interactive-recovery-order-" + scenario,
});
manager.appendModelChange("inline-recovery", "saved-model");
const toolDefinition = {
  name: "unsafe_tool",
  description: "Never repeat this tool after an uncertain dispatch",
  inputSchema: { type: "object", additionalProperties: false, properties: {} },
};
const selection = {
  provider: "inline-recovery",
  model: "saved-model",
  api: "openai-responses",
  thinkingLevel: "off",
  toolNames: [toolDefinition.name],
  toolsetFingerprint: sessionV4JsonHash([toolDefinition]),
};
const sourceHeadId = manager.getLeafId();
manager.commitChanges([{
  type: "run_accepted",
  branchId: "main",
  operationId: "interrupted-operation",
  promptNodeId: "interrupted-prompt",
  sourceHeadId,
  acceptedAt: time,
  request: { prompt: "interrupted prompt" },
  selection,
}]);
manager.appendMessage({
  id: "interrupted-prompt",
  role: "user",
  content: [{ type: "text", text: "interrupted prompt" }],
  createdAt: time,
}, {
  nodeId: "interrupted-prompt",
  operationId: "interrupted-operation",
  parentId: sourceHeadId,
});
manager.commitChanges([{
  type: "run_step_selected",
  operationId: "interrupted-operation",
  step: 0,
  selectedAt: time,
  selection,
}, {
  type: "run_attempt",
  operationId: "interrupted-operation",
  attemptId: "interrupted-attempt",
  step: 0,
  attempt: 1,
  task: "provider",
  startedAt: time,
}]);
manager.appendMessage({
  id: "interrupted-assistant",
  role: "assistant",
  content: [{ type: "tool_call", callId: "unsafe-call", name: "unsafe_tool", arguments: {} }],
  createdAt: time,
}, {
  nodeId: "interrupted-assistant",
  operationId: "interrupted-operation",
});
manager.commitChanges([{
  type: "tool_effect_prepared",
  effectId: "unsafe-effect",
  operationId: "interrupted-operation",
  invocationId: "unsafe-invocation",
  callId: "unsafe-call",
  toolName: "unsafe_tool",
  policy: "never_repeat",
  effectiveInput: {},
  inputHash: sessionV4ToolInputHash({}),
  resultNodeId: "unsafe-result",
  step: 0,
  index: 0,
  assistantNodeId: "interrupted-assistant",
  toolsetFingerprint: selection.toolsetFingerprint,
  preparedAt: time,
}, {
  type: "tool_effect_dispatched",
  effectId: "unsafe-effect",
  dispatchId: "unsafe-dispatch",
  dispatchedAt: time,
}]);
const sessionFile = manager.getSessionFile();
manager.closeV4Store();
if (sessionFile === undefined) throw new Error("persistent fixture did not create a session file");

const originalSetModel = AgentSession.prototype.setModel;
AgentSession.prototype.setModel = async function(model, source) {
  record({ type: "set_model", model: model.id, suspended: this.suspendedRun?.operationId ?? null });
  return await originalSetModel.call(this, model, source);
};
const originalRecover = AgentSession.prototype.recoverInterruptedRun;
AgentSession.prototype.recoverInterruptedRun = async function(options = {}) {
  record({
    type: "recover",
    suspended: this.suspendedRun?.operationId ?? null,
    resolutions: options.resolutions ?? [],
  });
  return await originalRecover.call(this, options);
};

let started = false;
let recoveryRequested = false;
const originalSetStartup = TuiController.prototype.setStartup;
TuiController.prototype.setStartup = function(...args) {
  originalSetStartup.apply(this, args);
  if (started) return;
  started = true;
  const command = scenario === "startup" ? "/recover" : "/resume " + sessionFile;
  setImmediate(() => process.stdin.emit("data", Buffer.from(command + "\\r")));
};
const originalNotify = TuiController.prototype.notify;
TuiController.prototype.notify = function(message, kind) {
  record({ type: "notify", message: String(message), kind: kind ?? "status" });
  if (
    scenario === "resume"
    && !recoveryRequested
    && String(message).startsWith("Interrupted operation interrupted-operation needs a decision")
  ) {
    recoveryRequested = true;
    setImmediate(() => process.stdin.emit("data", Buffer.from("/recover\\r")));
  }
  if (String(message).startsWith("Recovered interrupted operation")) {
    setImmediate(() => process.stdin.emit("data", Buffer.from("continue safely\\r")));
  }
  return originalNotify.call(this, message, kind);
};

await main([
  "chat",
  ...(scenario === "rpc" ? ["--mode", "rpc"] : []),
  "--workspace", ${JSON.stringify(workspace)},
  "--session-dir", scenarioSessionDirectory,
  ...(scenario === "resume" ? ["--no-session"] : ["--session", sessionFile]),
  "--offline",
  "--no-extensions",
  "--approve",
  "--provider", "inline-recovery",
  "--model", "requested-model",
], {
  extensionFactories: [{
    name: "inline-recovery-provider",
    factory(ohm) {
      ohm.registerProvider("inline-recovery", {
        api: "openai-responses",
        apiKey: "fixture-key",
        baseUrl: "https://example.invalid/v1",
        models: ["saved-model", "requested-model"].map((id) => ({
          id,
          name: id,
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8000,
          maxTokens: 1000,
        })),
        streamSimple: async function* (model) {
          record({ type: "provider", model: model.id });
          yield { type: "response_start", model: model.id };
          yield { type: "text_delta", part: 0, text: "continued after explicit recovery" };
          yield {
            type: "response_end",
            reason: "stop",
            state: { kind: "openai_responses", outputItems: [] },
          };
          setImmediate(() => process.stdin.emit("data", Buffer.from("/quit\\r")));
        },
      });
      ohm.registerTool({
        name: "unsafe_tool",
        label: "Unsafe tool",
        description: "Never repeat this tool after an uncertain dispatch",
        parameters: { type: "object", additionalProperties: false, properties: {} },
        recovery: { mode: "never_repeat" },
        async execute() {
          record({ type: "unsafe_execute" });
          return { content: [{ type: "text", text: "must not execute" }] };
        },
      });
    },
  }],
});
`, "utf8");

  const errors: string[] = [];
  for (const scenario of ["startup", "resume"] as const) {
    const child = spawn(process.execPath, ["--import", "tsx", entrypoint, scenario], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        OHM_HOME: `${agentDir}-${scenario}`,
        OHM_OFFLINE: "1",
        TERM: "xterm-256color",
        NO_COLOR: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    context.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    await new Promise<void>((resolveExit, reject) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`Interactive ${scenario} recovery fixture timed out\nstdout:\n${stdout.slice(-8_000)}\nstderr:\n${stderr.slice(-8_000)}`));
      }, 30_000);
      child.once("error", reject);
      child.once("close", (code, signal) => {
        clearTimeout(timeout);
        if (code === 0) resolveExit();
        else reject(new Error(`Interactive ${scenario} recovery fixture exited with ${code ?? signal}\nstdout:\n${stdout.slice(-8_000)}\nstderr:\n${stderr.slice(-8_000)}`));
      });
    });
    errors.push(stderr);
  }

  const rpc = spawn(process.execPath, ["--import", "tsx", entrypoint, "rpc"], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      OHM_HOME: `${agentDir}-rpc`,
      OHM_OFFLINE: "1",
      NO_COLOR: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  context.after(() => { if (rpc.exitCode === null) rpc.kill("SIGKILL"); });
  let rpcStdout = "";
  let rpcStderr = "";
  rpc.stdout.setEncoding("utf8").on("data", (chunk: string) => { rpcStdout += chunk; });
  rpc.stderr.setEncoding("utf8").on("data", (chunk: string) => { rpcStderr += chunk; });
  rpc.stdin.write([
    JSON.stringify({
      id: "recover-rpc",
      type: "recover_interrupted_run",
      resolutions: [{ effectId: "unsafe-effect", outcome: "abandoned" }],
    }),
    JSON.stringify({ id: "prompt-rpc", type: "prompt", message: "continue safely" }),
    "",
  ].join("\n"));
  await waitFor(() => rpcStdout.split("\n").some((line) => {
    try { return parseJson(RPC_RECORD_VALUE, line).type === "agent_end"; }
    catch { return false; }
  }), "RPC recovery prompt completion");
  rpc.stdin.end();
  await new Promise<void>((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      rpc.kill("SIGKILL");
      reject(new Error(`RPC recovery fixture timed out\nstdout:\n${rpcStdout.slice(-8_000)}\nstderr:\n${rpcStderr.slice(-8_000)}`));
    }, 30_000);
    rpc.once("error", reject);
    rpc.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolveExit();
      else reject(new Error(`RPC recovery fixture exited with ${code ?? signal}\nstdout:\n${rpcStdout.slice(-8_000)}\nstderr:\n${rpcStderr.slice(-8_000)}`));
    });
  });
  errors.push(rpcStderr);
  const rpcResponses = rpcStdout.trim().split("\n").map((line) => parseJson(RPC_RECORD_VALUE, line));
  assert.deepEqual(rpcResponses.find((entry) => entry.id === "recover-rpc"), {
    id: "recover-rpc",
    type: "response",
    command: "recover_interrupted_run",
    success: true,
    data: { recovered: true, operationId: "interrupted-operation", blocked: [] },
  });
  assert.equal(rpcResponses.find((entry) => entry.id === "prompt-rpc")?.success, true);

  const records = (await readFile(observed, "utf8")).trim().split("\n")
    .map((line) => parseJson(RECOVERY_RECORD_VALUE, line));
  for (const scenario of ["startup", "resume"] as const) {
    const scenarioRecords = records.filter((entry) => entry.scenario === scenario);
    const modelSelections = scenarioRecords.filter((entry) => entry.type === "set_model");
    assert.ok(modelSelections.length > 0, scenario);
    assert.equal(modelSelections.every((entry) =>
      entry.model === "requested-model" && entry.suspended === null), true, scenario);
    assert.equal(scenarioRecords.some((entry) =>
      entry.type === "recover"
      && entry.suspended === "interrupted-operation"
      && entry.resolutions?.some((resolution) =>
        resolution.effectId === "unsafe-effect" && resolution.outcome === "abandoned") === true), true, scenario);
    assert.equal(scenarioRecords.some((entry) =>
      entry.type === "notify" && entry.message?.includes("abandoned 1 blocked tool call without replay") === true), true, scenario);
    assert.equal(scenarioRecords.some((entry) => entry.type === "unsafe_execute"), false, scenario);
    assert.equal(scenarioRecords.filter((entry) =>
      entry.type === "provider" && entry.model === "requested-model").length, 1, scenario);
    const manualResolution = scenarioRecords.findIndex((entry) =>
      entry.type === "recover" && entry.resolutions?.length === 1);
    const selectedModel = scenarioRecords.findLastIndex((entry) => entry.type === "set_model");
    const continuedPrompt = scenarioRecords.findIndex((entry) => entry.type === "provider");
    assert.ok(manualResolution < selectedModel, scenario);
    assert.ok(selectedModel < continuedPrompt, scenario);
  }
  const rpcRecords = records.filter((entry) => entry.scenario === "rpc");
  const rpcRecovery = rpcRecords.findIndex((entry) =>
    entry.type === "recover"
    && entry.suspended === "interrupted-operation"
    && entry.resolutions?.some((resolution) =>
      resolution.effectId === "unsafe-effect" && resolution.outcome === "abandoned") === true);
  const rpcModelSelection = rpcRecords.findIndex((entry) => entry.type === "set_model");
  const rpcPrompt = rpcRecords.findIndex((entry) => entry.type === "provider");
  assert.ok(rpcRecovery >= 0);
  assert.ok(rpcModelSelection > rpcRecovery);
  assert.ok(rpcPrompt > rpcModelSelection);
  assert.equal(rpcRecords[rpcModelSelection]?.model, "requested-model");
  assert.equal(rpcRecords[rpcModelSelection]?.suspended, null);
  assert.equal(rpcRecords[rpcPrompt]?.model, "requested-model");
  assert.equal(rpcRecords.some((entry) => entry.type === "unsafe_execute"), false);
  assert.doesNotMatch(errors.join("\n"), /Call recoverInterruptedRun\(\)/u);
});

test("RPC startup observer failures are isolated after cleaning up the runtime", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-main-rpc-startup-failure-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const entrypoint = join(root, "entrypoint.mjs");
  await mkdir(workspace);
  context.after(async () => await rm(root, { recursive: true, force: true }));

  await writeFile(entrypoint, `
import { main } from ${JSON.stringify(mainModule)};

await main([
  "--mode", "rpc",
  "--workspace", ${JSON.stringify(workspace)},
  "--offline",
  "--no-extensions",
  "--no-session",
], {
  extensionFactories: [{
    name: "inline-rpc-startup-failure",
    factory(ohm) {
      ohm.on("session_start", () => {
        throw new Error("rpc startup failure sentinel");
      });
    },
  }],
});
`);

  const child = spawn(process.execPath, ["--import", "tsx", entrypoint], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      OHM_HOME: agentDir,
      OHM_OFFLINE: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  child.stdin.end();
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`RPC startup failure fixture timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 30_000);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolveExit({ code, signal });
    });
  });

  assert.deepEqual(exit, { code: 0, signal: null }, stderr);
  const records = stdout.trim().split("\n").filter(Boolean).map((line) => parseJson(RPC_RECORD_VALUE, line));
  const extensionError = records.find((record) => record.type === "extension_error");
  assert.equal(extensionError?.extensionId, "inline-inline-rpc-startup-failure", stdout);
  assert.equal(extensionError?.event, "session_start", stdout);
  assert.match(String(extensionError?.error), /rpc startup failure sentinel/u);
  assert.equal(stderr, "");
});

test("normal main invocations let supplied factories resolve project trust", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-main-inline-project-trust-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const entrypoint = join(root, "entrypoint.mjs");
  const marker = join(root, "trust-calls.txt");
  await mkdir(join(workspace, ".ohm"), { recursive: true });
  await writeFile(join(workspace, ".ohm", "config.json"), "{}\n");
  context.after(async () => await rm(root, { recursive: true, force: true }));

  await writeFile(entrypoint, `
import { writeFile } from "node:fs/promises";
import { main } from ${JSON.stringify(mainModule)};

let trustCalls = 0;
await main([
  "--workspace", ${JSON.stringify(workspace)},
  "--offline",
  "--no-extensions",
  "--list-models", "inline-trust-model",
], {
  extensionFactories: [{
    name: "inline-trust-factory",
    factory(ohm) {
      ohm.on("project_trust", (event) => {
        trustCalls += 1;
        if (event.cwd !== ${JSON.stringify(workspace)}) throw new Error("Unexpected trust workspace");
        return { trusted: "yes" };
      });
      ohm.registerProvider("inline-trust-model", {
        name: "Inline Trust Model",
        api: "openai-responses",
        apiKey: "fixture-key",
        baseUrl: "https://example.invalid/v1",
        models: [{
          id: "trusted-model",
          name: "Trusted Model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8000,
          maxTokens: 1000,
        }],
      });
    },
  }],
});
await writeFile(${JSON.stringify(marker)}, String(trustCalls));
`);

  const result = await execute(process.execPath, ["--import", "tsx", entrypoint], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      OHM_HOME: agentDir,
      OHM_OFFLINE: "1",
    },
    timeout: 30_000,
  });

  assert.match(result.stdout, /^inline-trust-model\/trusted-model\t/u);
  assert.equal(result.stderr, "");
  assert.equal(await readFile(marker, "utf8"), "1");
});

test("project package and config commands share factory-driven trust resolution", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-main-inline-project-package-trust-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const packageRoot = join(root, "package");
  const entrypoint = join(root, "entrypoint.mjs");
  const marker = join(root, "trust-calls.txt");
  await mkdir(join(workspace, ".ohm"), { recursive: true });
  await mkdir(join(packageRoot, "extensions"), { recursive: true });
  await writeFile(join(workspace, ".ohm", "config.json"), "{}\n");
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({
    name: "inline-project-package",
    ohm: { extensions: ["extensions/index.mjs"] },
  }));
  await writeFile(join(packageRoot, "extensions", "index.mjs"), "export default () => {};\n");
  context.after(async () => await rm(root, { recursive: true, force: true }));

  await writeFile(entrypoint, `
import { writeFile } from "node:fs/promises";
import { main } from ${JSON.stringify(mainModule)};

let trustCalls = 0;
let disposals = 0;
const options = {
  extensionFactories: [{
    name: "inline-package-trust-factory",
    factory(ohm) {
      ohm.on("project_trust", () => {
        trustCalls += 1;
        return { trusted: "yes" };
      });
      ohm.onDispose(() => { disposals += 1; });
    },
  }],
};
await main([
  "install", ${JSON.stringify(packageRoot)},
  "--local",
  "--workspace", ${JSON.stringify(workspace)},
  "--json",
], options);
await main([
  "config",
  "--workspace", ${JSON.stringify(workspace)},
  "--json",
], options);
await writeFile(${JSON.stringify(marker)}, \`\${trustCalls},\${disposals}\`);
`);

  const result = await execute(process.execPath, ["--import", "tsx", entrypoint], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      OHM_HOME: agentDir,
      OHM_OFFLINE: "1",
    },
    timeout: 30_000,
  });

  assert.match(result.stdout, /"scope":"project"/u);
  assert.match(result.stdout, /inline-project-package/u);
  assert.equal(result.stderr, "");
  assert.equal(await readFile(marker, "utf8"), "2,2");
});
