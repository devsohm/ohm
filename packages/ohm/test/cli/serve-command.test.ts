import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { Type } from "typebox";
import { Value } from "typebox/value";

import {
  sessionV4ToolInputHash,
  type SessionV4RunSelection,
} from "@ohm/kernel/session-v4";

import { defaultSecretRedactor } from "../../src/auth/redaction.js";
import {
  assertLoopbackServeHost,
  runServeCommand,
} from "../../src/cli/serve-command.js";
import { parseManagementArguments } from "../../src/cli/management-args.js";
import type { JsonValue } from "../../src/core/json.js";
import { OBJECT_VALUE } from "../../src/core/value-schemas.js";
import { SessionManager } from "../../src/storage/session-manager.js";

const TOKEN = `ohm-serve-${"a".repeat(32)}`;
const repositoryRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const mainModule = pathToFileURL(
  fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url)),
).href;
const SESSION_ID_RESPONSE_VALUE = Type.Object({ sessionId: Type.Optional(Type.String()) }, { additionalProperties: true });
const CREATED_SESSION_RESPONSE_VALUE = Type.Object({
  sessionId: Type.Optional(Type.String()),
  state: Type.Optional(Type.Object({
    model: Type.Optional(Type.Object({
      provider: Type.Optional(Type.String()),
      id: Type.Optional(Type.String()),
    }, { additionalProperties: true })),
    thinkingLevel: Type.Optional(Type.String()),
  }, { additionalProperties: true })),
}, { additionalProperties: true });
const EXTENSION_CALL_VALUE = Type.Object({
  mode: Type.Optional(Type.String()),
  source: Type.Optional(Type.String()),
  text: Type.Optional(Type.String()),
}, { additionalProperties: true });
const INSPECTION_RESPONSE_VALUE = Type.Object({
  sessionId: Type.String(),
  thinkingLevel: Type.String(),
}, { additionalProperties: true });
const OPENED_SESSION_RESPONSE_VALUE = Type.Object({
  state: Type.Optional(Type.Object({ hasSuspendedRun: Type.Optional(Type.Boolean()) }, { additionalProperties: true })),
}, { additionalProperties: true });
const RECOVERY_STATUS_RESPONSE_VALUE = Type.Object({
  suspendedRun: Type.Optional(Type.Object({
    operationId: Type.Optional(Type.String()),
    effects: Type.Optional(Type.Array(Type.Object({}, { additionalProperties: true }))),
  }, { additionalProperties: true })),
}, { additionalProperties: true });

function createInterruptedServeSession(
  workspace: string,
  sessionDirectory: string,
): string {
  const sessionId = "serve-recovery";
  const manager = SessionManager.create(workspace, sessionDirectory, { id: sessionId });
  const timestamp = "2026-08-08T12:00:00.000Z";
  const operationId = "serve-recovery-operation";
  const promptNodeId = "serve-recovery-prompt";
  const assistantNodeId = "serve-recovery-assistant";
  const effectId = "serve-recovery-effect";
  const selection: SessionV4RunSelection = {
    provider: "serve-fixture",
    model: "serve-model",
    api: "openai-responses",
    thinkingLevel: "xhigh",
    toolNames: ["write"],
    toolsetFingerprint: "serve-recovery-toolset",
  };
  try {
    manager.commitChanges([{
      type: "run_accepted",
      branchId: "main",
      operationId,
      promptNodeId,
      sourceHeadId: null,
      acceptedAt: timestamp,
      request: { prompt: "resume after explicit recovery" },
      selection,
    }]);
    manager.appendMessage({
      id: promptNodeId,
      role: "user",
      content: [{ type: "text", text: "resume after explicit recovery" }],
      createdAt: timestamp,
    }, { nodeId: promptNodeId, operationId, parentId: null });
    manager.commitChanges([{
      type: "run_step_selected",
      operationId,
      step: 0,
      selectedAt: timestamp,
      selection,
    }, {
      type: "run_attempt",
      operationId,
      attemptId: "serve-recovery-attempt",
      step: 0,
      attempt: 1,
      task: "provider",
      startedAt: timestamp,
    }]);
    manager.appendMessage({
      id: assistantNodeId,
      role: "assistant",
      content: [{ type: "text", text: "Calling write" }],
      createdAt: timestamp,
    }, { nodeId: assistantNodeId, operationId, parentId: promptNodeId });
    const input = { path: "recovery.txt", content: "uncertain" };
    manager.commitChanges([{
      type: "tool_effect_prepared",
      effectId,
      operationId,
      invocationId: "serve-recovery-invocation",
      callId: "serve-recovery-call",
      toolName: "write",
      policy: "never_repeat",
      effectiveInput: input,
      inputHash: sessionV4ToolInputHash(input),
      resultNodeId: "serve-recovery-result",
      step: 0,
      index: 0,
      assistantNodeId,
      toolsetFingerprint: selection.toolsetFingerprint,
      preparedAt: timestamp,
    }, {
      type: "tool_effect_dispatched",
      effectId,
      dispatchId: "serve-recovery-dispatch",
      dispatchedAt: timestamp,
    }, {
      type: "run_cancel",
      operationId,
      cancelId: "serve-recovery-cancel",
      requestedAt: timestamp,
      reason: "caller cancelled before the tool result settled",
    }]);
  } finally {
    manager.closeV4Store();
  }
  return sessionId;
}

async function unusedLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address === null || !Value.Check(OBJECT_VALUE, address) || !("port" in address)) {
    server.close();
    throw new Error("Test server did not expose a TCP port");
  }
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => {
      if (error === undefined) resolveClose();
      else reject(error);
    });
  });
  return address.port;
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await condition()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 20));
  }
}

test("serve CLI accepts only explicit loopback hosts", () => {
  for (const host of ["127.0.0.1", "localhost", "::1"]) {
    assert.doesNotThrow(() => assertLoopbackServeHost(host));
  }
  for (const host of ["0.0.0.0", "::", "192.0.2.1", "example.com", "LOCALHOST"]) {
    assert.throws(
      () => assertLoopbackServeHost(host),
      /--host must be 127\.0\.0\.1, localhost, or ::1/u,
    );
  }
});

test("serve CLI validates and globally redacts its bearer token before binding", async () => {
  await assert.rejects(
    runServeCommand(parseManagementArguments(["serve"]), { environment: {} }),
    /OHM_SERVE_TOKEN is required/u,
  );
  await assert.rejects(
    runServeCommand(parseManagementArguments(["serve"]), {
      environment: { OHM_SERVE_TOKEN: "too-short" },
    }),
    /OHM_SERVE_TOKEN is invalid/u,
  );
  await assert.rejects(
    runServeCommand(parseManagementArguments(["serve"]), {
      environment: { OHM_SERVE_TOKEN: `${"a".repeat(32)} with-space` },
    }),
    /OHM_SERVE_TOKEN is invalid/u,
  );

  await assert.rejects(
    runServeCommand(parseManagementArguments(["serve", "--host", "0.0.0.0"]), {
      environment: { OHM_SERVE_TOKEN: TOKEN },
    }),
    /ohm serve does not provide TLS/u,
  );
  assert.equal(defaultSecretRedactor.redact(`token=${TOKEN}`), "token=[REDACTED]");
});

test("serve command starts offline, creates one canonical session, and stops cleanly", {
  skip: process.platform === "win32",
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-serve-command-"));
  const workspace = join(root, "workspace");
  const agentDirectory = join(root, "agent");
  const sessionDirectory = join(root, "sessions");
  const entrypoint = join(root, "serve-entrypoint.mjs");
  const providerMarker = join(root, "provider-called");
  const extensionMarker = join(root, "extension-called");
  const replacementMarker = join(root, "replacement-called");
  const lifecycleMarker = join(root, "extension-lifecycle");
  const discoveryMarker = join(root, "plugin-discovery");
  const refreshMarker = join(root, "session-refreshed");
  const port = await unusedLoopbackPort();
  await Promise.all([mkdir(workspace), mkdir(agentDirectory)]);
  await Promise.all([
    mkdir(join(agentDirectory, "extensions")),
    mkdir(join(agentDirectory, "skills", "unrelated-serve"), { recursive: true }),
    mkdir(join(agentDirectory, "prompts")),
  ]);
  await Promise.all([
    writeFile(join(agentDirectory, "extensions", "unrelated.mjs"), 'throw new Error("no-plugins must suppress unrelated code");'),
    writeFile(join(agentDirectory, "skills", "unrelated-serve", "SKILL.md"), "---\nname: unrelated-serve\ndescription: Unrelated serve skill\n---\nUnrelated body."),
    writeFile(join(agentDirectory, "prompts", "unrelated-serve.md"), "Unrelated prompt."),
  ]);
  const interruptedSessionId = createInterruptedServeSession(workspace, sessionDirectory);
  await writeFile(join(agentDirectory, "config.json"), `${JSON.stringify({
    defaultProvider: "serve-fixture",
    defaultModel: "serve-model",
    defaultThinkingLevel: "max",
  })}\n`);
  await writeFile(entrypoint, `
import { appendFileSync } from "node:fs";
import { main } from ${JSON.stringify(mainModule)};
let extensionGeneration = 0;
await main(${JSON.stringify([
    "serve",
    "--host", "127.0.0.1",
    "--port", String(port),
    "--workspace", workspace,
    "--session-dir", sessionDirectory,
    "--offline",
    "--no-plugins",
  ])}, {
  pluginFactories: [{
    name: "serve-fixture-provider",
    async factory(ohm) {
      const generation = ++extensionGeneration;
      await ohm.facets.register({
        apiVersion: 1,
        kind: "worker",
        name: "view",
        setup(facet) {
          facet.presentation.show({
            id: "serve-generation",
            blocks: [{ type: "text", text: "generation " + generation }],
          });
          ohm.registerCommand("serve-remove-view", {
            handler() { facet.presentation.remove("serve-generation"); },
          });
        },
      });
      ohm.on("session_start", async (event) => {
        if (event.reason === "refresh") ohm.setThinkingLevel("low");
        appendFileSync(${JSON.stringify(discoveryMarker)}, JSON.stringify(await ohm.getDiscoveryView()) + "\\n");
      });
      ohm.on("session_shutdown", (event) => {
        appendFileSync(${JSON.stringify(lifecycleMarker)}, generation + ":shutdown:" + event.reason + "\\n");
      });
      ohm.onDispose(() => {
        appendFileSync(${JSON.stringify(lifecycleMarker)}, generation + ":dispose\\n");
        if (generation === 3) throw new Error("serve lifecycle cleanup fixture");
      });
      ohm.registerCommand("serve-new-session", {
        async handler(_args, context) {
          appendFileSync(${JSON.stringify(replacementMarker)}, JSON.stringify(
            await context.newSession(),
          ) + "\\n");
        },
      });
      ohm.registerCommand("serve-refresh", {
        async handler(_args, context) {
          await context.refresh();
          appendFileSync(${JSON.stringify(refreshMarker)}, "refreshed\\n");
        },
      });
      ohm.on("input", (event, context) => {
        appendFileSync(${JSON.stringify(extensionMarker)}, JSON.stringify({
          mode: context.mode,
          source: event.source,
          text: event.text,
        }) + "\\n");
        return {
          action: "transform",
          text: event.text + " through direct extension",
          ...(event.images === undefined ? {} : { images: event.images }),
        };
      });
      ohm.registerProvider("serve-fixture", {
        api: "openai-responses",
        apiKey: "fixture-key",
        baseUrl: "https://example.invalid/v1",
        models: [{
          id: "serve-model",
          name: "Serve Model",
          reasoning: true,
          thinkingLevelMap: {
            off: null,
            minimal: null,
            low: "low",
            medium: null,
            high: null,
            xhigh: "xhigh",
            max: null,
          },
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8000,
          maxTokens: 1000,
        }],
        streamSimple: async function* (_model, context) {
          appendFileSync(${JSON.stringify(providerMarker)}, JSON.stringify(context) + "\\n");
          yield { type: "response_start", model: "serve-model" };
          yield { type: "text_delta", part: 0, text: "served response" };
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

  const child = spawn(process.execPath, ["--import", "tsx", entrypoint], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      OHM_HOME: agentDirectory,
      OHM_OFFLINE: "1",
      OHM_SERVE_TOKEN: TOKEN,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  context.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  });

  await waitFor(
    () => stdout.includes(`ohm serve listening at http://127.0.0.1:${port}`),
    "serve startup",
  );
  const headers = {
    Authorization: `Bearer ${TOKEN}`,
    "Content-Type": "application/json",
  };
  const health = await fetch(`http://127.0.0.1:${port}/health`, {
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(health.status, 200);

  const created = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
    method: "POST",
    headers,
    body: "{}",
    signal: AbortSignal.timeout(30_000),
  });
  const createdText = await created.text();
  assert.equal(created.status, 201, createdText);
  const createdBody: JsonValue = JSON.parse(createdText);
  if (!Value.Check(CREATED_SESSION_RESPONSE_VALUE, createdBody)) throw new Error("Invalid created-session response");
  assert.equal(createdBody.state?.model?.provider, "serve-fixture");
  assert.equal(createdBody.state?.model?.id, "serve-model");
  assert.equal(createdBody.state?.thinkingLevel, "xhigh");
  assert.doesNotMatch(await readFile(discoveryMarker, "utf8"), /unrelated-serve|ohm-dev/u);
  const sessionPath = encodeURIComponent(createdBody.sessionId ?? "");

  const recoveryStatus = await fetch(
    `http://127.0.0.1:${port}/v1/sessions/${sessionPath}/recovery`,
    { headers, signal: AbortSignal.timeout(10_000) },
  );
  assert.equal(recoveryStatus.status, 200);
  assert.deepEqual(await recoveryStatus.json(), {
    sessionId: createdBody.sessionId,
    suspendedRun: null,
  });

  const recovery = await fetch(
    `http://127.0.0.1:${port}/v1/sessions/${sessionPath}/recovery`,
    {
      method: "POST",
      headers,
      body: "{}",
      signal: AbortSignal.timeout(10_000),
    },
  );
  assert.equal(recovery.status, 200);
  assert.deepEqual(await recovery.json(), {
    sessionId: createdBody.sessionId,
    recovery: { recovered: false, blocked: [] },
  });

  const replacement = await fetch(
    `http://127.0.0.1:${port}/v1/sessions/${sessionPath}/prompts`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "/serve-new-session" }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  assert.equal(replacement.status, 202, await replacement.text());
  await waitFor(async () => {
    try {
      return (await readFile(replacementMarker, "utf8")).trim() !== "";
    } catch {
      return false;
    }
  }, "serve extension replacement guard");
  assert.deepEqual(JSON.parse((await readFile(replacementMarker, "utf8")).trim()), {
    cancelled: true,
  });
  const identity = await fetch(
    `http://127.0.0.1:${port}/v1/sessions/${sessionPath}`,
    { headers, signal: AbortSignal.timeout(10_000) },
  );
  assert.equal(identity.status, 200);
  const identityBody: JsonValue = await identity.json();
  if (!Value.Check(SESSION_ID_RESPONSE_VALUE, identityBody)) throw new Error("Invalid session identity response");
  assert.equal(identityBody.sessionId, createdBody.sessionId);

  const prompted = await fetch(
    `http://127.0.0.1:${port}/v1/sessions/${sessionPath}/prompts`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "reply through the fixture provider" }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  assert.equal(prompted.status, 202, await prompted.text());
  try {
    await waitFor(async () => {
      try {
        return (await readFile(providerMarker, "utf8")).includes("through direct extension");
      } catch {
        return false;
      }
    }, "serve provider call");
  } catch (error) {
    throw new Error(`Serve provider did not run\nstdout:\n${stdout}\nstderr:\n${stderr}`, {
      cause: error,
    });
  }
  const extensionCall: JsonValue = JSON.parse((await readFile(extensionMarker, "utf8")).trim());
  if (!Value.Check(EXTENSION_CALL_VALUE, extensionCall)) throw new Error("Invalid extension call record");
  assert.deepEqual(extensionCall, {
    mode: "serve",
    source: "serve",
    text: "reply through the fixture provider",
  });
  assert.match(await readFile(providerMarker, "utf8"), /through direct extension/u);

  let historyText = "";
  await waitFor(async () => {
    const history = await fetch(`http://127.0.0.1:${port}/v1/sessions/${sessionPath}/entries`, {
      headers, signal: AbortSignal.timeout(10_000),
    });
    assert.equal(history.status, 200);
    historyText = await history.text();
    return historyText.includes("served response");
  }, "serve durable history projection");
  assert.match(historyText, /reply through the fixture provider through direct extension/u);
  assert.doesNotMatch(historyText, /providerState|outputItems/u);

  const opened = await fetch(`http://127.0.0.1:${port}/v1/sessions/open`, {
    method: "POST",
    headers,
    body: JSON.stringify({ sessionId: interruptedSessionId }),
    signal: AbortSignal.timeout(30_000),
  });
  const openedText = await opened.text();
  assert.equal(opened.status, 200, openedText);
  const openedBody: JsonValue = JSON.parse(openedText);
  if (!Value.Check(OPENED_SESSION_RESPONSE_VALUE, openedBody)) throw new Error("Invalid opened-session response");
  assert.equal(openedBody.state?.hasSuspendedRun, true);

  const interruptedPath = encodeURIComponent(interruptedSessionId);
  const interruptedStatus = await fetch(
    `http://127.0.0.1:${port}/v1/sessions/${interruptedPath}/recovery`,
    { headers, signal: AbortSignal.timeout(10_000) },
  );
  assert.equal(interruptedStatus.status, 200);
  const interruptedStatusBody: JsonValue = await interruptedStatus.json();
  if (!Value.Check(RECOVERY_STATUS_RESPONSE_VALUE, interruptedStatusBody)) throw new Error("Invalid recovery status response");
  assert.equal(interruptedStatusBody.suspendedRun?.operationId, "serve-recovery-operation");
  assert.deepEqual(interruptedStatusBody.suspendedRun?.effects, [{
    effectId: "serve-recovery-effect",
    callId: "serve-recovery-call",
    name: "write",
    policy: "never_repeat",
    status: "in_doubt",
    step: 0,
    index: 0,
    inputHash: sessionV4ToolInputHash({ path: "recovery.txt", content: "uncertain" }),
  }]);

  const resolved = await fetch(
    `http://127.0.0.1:${port}/v1/sessions/${interruptedPath}/recovery`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        resolutions: [{
          effectId: "serve-recovery-effect",
          outcome: "abandoned",
        }],
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  const resolvedText = await resolved.text();
  assert.equal(resolved.status, 200, resolvedText);
  assert.deepEqual(JSON.parse(resolvedText), {
    sessionId: interruptedSessionId,
    recovery: {
      recovered: true,
      operationId: "serve-recovery-operation",
      blocked: [],
    },
  });

  const resumedPrompt = await fetch(
    `http://127.0.0.1:${port}/v1/sessions/${interruptedPath}/prompts`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "recovered session is ready" }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  assert.equal(resumedPrompt.status, 202, await resumedPrompt.text());
  await waitFor(async () => {
    try {
      return (await readFile(providerMarker, "utf8")).includes("recovered session is ready");
    } catch {
      return false;
    }
  }, "recovered serve provider call");

  const closed = await fetch(`http://127.0.0.1:${port}/v1/sessions/${sessionPath}`, {
    method: "DELETE",
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(closed.status, 200, await closed.text());
  await waitFor(async () => {
    try {
      return (await readFile(lifecycleMarker, "utf8")).includes("1:dispose");
    } catch {
      return false;
    }
  }, "deleted serve session lifecycle");
  assert.deepEqual((await readFile(lifecycleMarker, "utf8")).trim().split("\n"), [
    "1:shutdown:quit",
    "1:dispose",
  ]);

  const closedAgain = await fetch(`http://127.0.0.1:${port}/v1/sessions/${sessionPath}`, {
    method: "DELETE",
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(closedAgain.status, 404);
  assert.deepEqual((await readFile(lifecycleMarker, "utf8")).trim().split("\n"), [
    "1:shutdown:quit",
    "1:dispose",
  ]);

  const failureFixture = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
    method: "POST",
    headers,
    body: "{}",
    signal: AbortSignal.timeout(30_000),
  });
  const failureFixtureText = await failureFixture.text();
  assert.equal(failureFixture.status, 201, failureFixtureText);
  const failureFixtureBody: JsonValue = JSON.parse(failureFixtureText);
  if (!Value.Check(SESSION_ID_RESPONSE_VALUE, failureFixtureBody)) throw new Error("Invalid failure fixture response");
  const failureSessionId = failureFixtureBody.sessionId;
  assert.ok(failureSessionId);
  const failedClosure = await fetch(
    `http://127.0.0.1:${port}/v1/sessions/${encodeURIComponent(failureSessionId)}`,
    { method: "DELETE", headers, signal: AbortSignal.timeout(30_000) },
  );
  assert.equal(failedClosure.status, 500);
  assert.deepEqual(await failedClosure.json(), { error: "Internal server error" });
  await waitFor(async () => {
    try {
      return (await readFile(lifecycleMarker, "utf8")).includes("3:dispose");
    } catch {
      return false;
    }
  }, "failed serve cleanup containment");
  assert.deepEqual((await readFile(lifecycleMarker, "utf8")).trim().split("\n"), [
    "1:shutdown:quit",
    "1:dispose",
    "3:shutdown:quit",
    "3:dispose",
  ]);
  const failedClosureAgain = await fetch(
    `http://127.0.0.1:${port}/v1/sessions/${encodeURIComponent(failureSessionId)}`,
    { method: "DELETE", headers, signal: AbortSignal.timeout(10_000) },
  );
  assert.equal(failedClosureAgain.status, 404);

  const refreshEvents = await fetch(
    `http://127.0.0.1:${port}/v1/sessions/${interruptedPath}/events`,
    { headers, signal: AbortSignal.timeout(20_000) },
  );
  assert.equal(refreshEvents.status, 200);
  assert.ok(refreshEvents.body);
  const eventReader = refreshEvents.body.getReader();
  context.after(async () => { await eventReader.cancel().catch(() => undefined); });
  const eventDecoder = new TextDecoder();
  let refreshEventText = "";
  const readRefreshEventsUntil = async (label: string, predicate: (text: string) => boolean): Promise<void> => {
    try {
      while (!predicate(refreshEventText)) {
        const chunk = await eventReader.read();
        assert.equal(chunk.done, false, "serve stream ended before refreshed events arrived");
        refreshEventText += eventDecoder.decode(chunk.value, { stream: true });
      }
    } catch (cause) {
      throw new Error(`Serve stream did not deliver ${label}: ${refreshEventText.slice(-2_048)}`, { cause });
    }
  };
  await readRefreshEventsUntil("initial presentation", (text) => text.includes("generation 2"));
  refreshEventText = "";
  const refreshed = await fetch(
    `http://127.0.0.1:${port}/v1/sessions/${interruptedPath}/prompts`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "/serve-refresh" }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  assert.equal(refreshed.status, 202, await refreshed.text());
  await waitFor(async () => {
    try {
      return (await readFile(refreshMarker, "utf8")).includes("refreshed");
    } catch {
      return false;
    }
  }, "serve runtime refresh");
  const refreshedSummary = await fetch(
    `http://127.0.0.1:${port}/v1/sessions/${interruptedPath}`,
    { headers, signal: AbortSignal.timeout(10_000) },
  );
  assert.equal(refreshedSummary.status, 200);
  const refreshedSummaryBody: JsonValue = await refreshedSummary.json();
  if (!Value.Check(CREATED_SESSION_RESPONSE_VALUE, refreshedSummaryBody)) throw new Error("Invalid refreshed session response");
  assert.equal(refreshedSummaryBody.sessionId, interruptedSessionId);
  assert.equal(refreshedSummaryBody.state?.thinkingLevel, "low");
  const refreshedInspection = await fetch(
    `http://127.0.0.1:${port}/v1/sessions/${interruptedPath}/inspection`,
    { headers, signal: AbortSignal.timeout(10_000) },
  );
  assert.equal(refreshedInspection.status, 200);
  const refreshedInspectionBody: JsonValue = await refreshedInspection.json();
  if (!Value.Check(INSPECTION_RESPONSE_VALUE, refreshedInspectionBody)) throw new Error("Invalid refreshed inspection response");
  assert.equal(refreshedInspectionBody.sessionId, interruptedSessionId);
  assert.equal(refreshedInspectionBody.thinkingLevel, "low");
  await readRefreshEventsUntil("refreshed presentation", (text) => text.includes("generation 4"));
  assert.match(refreshEventText, /"operation":"remove"/u);
  assert.equal(refreshEventText.match(/generation 4/gu)?.length, 1);
  const refreshedPresentations = await fetch(
    `http://127.0.0.1:${port}/v1/sessions/${interruptedPath}/presentations`,
    { headers, signal: AbortSignal.timeout(10_000) },
  );
  assert.equal(refreshedPresentations.status, 200);
  const refreshedPresentationText = await refreshedPresentations.text();
  assert.match(refreshedPresentationText, /generation 4/u);
  assert.doesNotMatch(refreshedPresentationText, /generation 2/u);
  refreshEventText = "";

  const refreshedPrompt = await fetch(
    `http://127.0.0.1:${port}/v1/sessions/${interruptedPath}/prompts`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "reply after runtime refresh" }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  assert.equal(refreshedPrompt.status, 202, await refreshedPrompt.text());
  await waitFor(async () => {
    const history = await fetch(`http://127.0.0.1:${port}/v1/sessions/${interruptedPath}/entries`, {
      headers, signal: AbortSignal.timeout(10_000),
    });
    assert.equal(history.status, 200);
    return (await history.text()).includes("reply after runtime refresh through direct extension");
  }, "refreshed serve durable history projection");
  await readRefreshEventsUntil("refreshed run", (text) => text.includes("event: run_completed"));
  assert.match(refreshEventText, /event: run_state/u);
  assert.match(refreshEventText, /reply after runtime refresh through direct extension/u);
  assert.equal(refreshEventText.match(/event: text_delta/gu)?.length, 1);
  assert.match(await readFile(providerMarker, "utf8"), /reply after runtime refresh through direct extension/u);
  refreshEventText = "";
  const removedView = await fetch(
    `http://127.0.0.1:${port}/v1/sessions/${interruptedPath}/prompts`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "/serve-remove-view" }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  assert.equal(removedView.status, 202, await removedView.text());
  await readRefreshEventsUntil("presentation removal", (text) => text.includes('"operation":"remove"'));
  assert.equal(refreshEventText.match(/"operation":"remove"/gu)?.length, 1);
  const removedPresentations = await fetch(
    `http://127.0.0.1:${port}/v1/sessions/${interruptedPath}/presentations`,
    { headers, signal: AbortSignal.timeout(10_000) },
  );
  assert.equal(removedPresentations.status, 200);
  assert.deepEqual(await removedPresentations.json(), { sessionId: interruptedSessionId, presentations: [] });
  await eventReader.cancel();

  assert.equal(child.kill("SIGTERM"), true);
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveExit, reject) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`Serve command did not stop\nstdout:\n${stdout}\nstderr:\n${stderr}`));
      }, 30_000);
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        clearTimeout(timeout);
        resolveExit({ code, signal });
      });
    },
  );
  assert.deepEqual(exit, { code: 143, signal: null }, stderr);
  assert.deepEqual((await readFile(lifecycleMarker, "utf8")).trim().split("\n"), [
    "1:shutdown:quit",
    "1:dispose",
    "3:shutdown:quit",
    "3:dispose",
    "2:shutdown:refresh",
    "2:dispose",
    "4:shutdown:quit",
    "4:dispose",
  ]);
  assert.doesNotMatch(`${stdout}\n${stderr}`, new RegExp(TOKEN, "u"));
});
