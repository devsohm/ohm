import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import { OHM_VERSION } from "../../src/version.js";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function waitFor(check: () => boolean, message: () => string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(message());
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 20));
  }
}

const CONTEXT_SNAPSHOT_VALUE = Type.Object({
  threadId: Type.Optional(Type.String()),
  sessionName: Type.Optional(Type.String()),
  workspace: Type.Optional(Type.String()),
  releaseVersion: Type.Optional(Type.String()),
  provider: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  contextWindowTokens: Type.Optional(Type.Number()),
  thinking: Type.Optional(Type.String()),
  thinkingSupported: Type.Optional(Type.Boolean()),
  active: Type.Optional(Type.Boolean()),
  status: Type.Optional(Type.String()),
  autoCompaction: Type.Optional(Type.Boolean()),
});

function contextSnapshot(source: string): Static<typeof CONTEXT_SNAPSHOT_VALUE> {
  const value: unknown = JSON.parse(source);
  if (!Value.Check(CONTEXT_SNAPSHOT_VALUE, value)) {
    throw new Error("Footer context JSON does not match its test contract");
  }
  return value;
}

test("primary interactive CLI supplies complete controller and footer context", {
  skip: process.platform !== "linux" || spawnSync("script", ["--version"], { stdio: "ignore" }).status !== 0,
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-main-footer-context-"));
  const workspace = join(root, "workspace");
  const agentDirectory = join(root, "agent");
  const stateDirectory = join(root, "state");
  const entrypoint = join(root, "entrypoint.mjs");
  const controllerLog = join(root, "controller-context.jsonl");
  const footerSnapshotPath = join(root, "footer-snapshot.json");
  await mkdir(workspace);
  context.after(async () => await rm(root, { recursive: true, force: true }));

  const mainModule = new URL("../../src/cli/main.ts", import.meta.url).href;
  const controllerModule = new URL("../../src/tui/controller.ts", import.meta.url).href;
  await writeFile(entrypoint, `
import { appendFileSync, writeFileSync } from "node:fs";
import { main } from ${JSON.stringify(mainModule)};
import { TuiController } from ${JSON.stringify(controllerModule)};

for (const Terminal of [TuiController]) {
  const originalSetContext = Terminal.prototype.setContext;
  Terminal.prototype.setContext = function(context) {
    originalSetContext.call(this, context);
    appendFileSync(${JSON.stringify(controllerLog)}, JSON.stringify(context) + "\\n");
  };
}

await main([
  "chat",
  "--workspace", ${JSON.stringify(workspace)},
  "--provider", "footer-fixture",
  "--model", "footer-model",
  "--thinking", "high",
  "--name", "primary footer",
  "--approve",
  "--offline",
  "--no-extensions",
  "--no-session",
], {
  extensionFactories: [{
    name: "footer-context-fixture",
    factory(ohm) {
      ohm.registerProvider("footer-fixture", {
        name: "Footer Fixture",
        api: "openai-responses",
        apiKey: "fixture-key",
        baseUrl: "https://example.invalid/v1",
        models: [{
          id: "footer-model",
          name: "Footer Model",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 12345,
          maxTokens: 1024,
        }],
      });
      ohm.on("session_start", (_event, sessionContext) => {
        sessionContext.ui.setFooter((_tui, _theme, data) => ({
          render() {
            const snapshot = data.getSnapshot();
            if (
              snapshot.provider === "footer-fixture"
              && snapshot.model === "footer-model"
              && snapshot.active === false
            ) writeFileSync(${JSON.stringify(footerSnapshotPath)}, JSON.stringify(snapshot));
            return ["footer context fixture"];
          },
          invalidate() {},
        }));
      });
    },
  }],
});
`);

  const command = [process.execPath, "--import", "tsx", entrypoint].map(shellQuote).join(" ");
  const child = spawn("script", ["-qefc", command, "/dev/null"], {
    cwd: packageRoot,
    env: {
      ...process.env,
      OHM_HOME: agentDirectory,
      XDG_STATE_HOME: stateDirectory,
      OHM_OFFLINE: "1",
      TERM: "xterm-256color",
      NO_COLOR: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  context.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { output += chunk; });
  child.stderr.on("data", (chunk: string) => { output += chunk; });

  await waitFor(
    () => existsSync(footerSnapshotPath),
    () => `CLI footer never received the complete context:\n${output.slice(-16 * 1024)}`,
  );
  child.stdin.write("/exit\r");
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI did not exit:\n${output.slice(-16 * 1024)}`));
    }, 10_000);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolveExit({ code, signal });
    });
  });
  assert.equal(exit.signal, null, output);
  assert.equal(exit.code, 0, output);
  assert.equal(output.includes("\u001b[?1049h"), true);
  assert.equal(output.includes("\u001b[?1049l"), true);
  assert.equal(output.includes("\u001b[?1000h\u001b[?1002h\u001b[?1006h"), true);
  const mouseOff = output.lastIndexOf("\u001b[?1006l\u001b[?1002l\u001b[?1000l");
  const pasteOff = output.lastIndexOf("\u001b[?2004l");
  const screenOff = output.lastIndexOf("\u001b[?1049l");
  assert.ok(mouseOff >= 0 && mouseOff < screenOff, output);
  assert.ok(pasteOff >= 0 && pasteOff < screenOff, output);

  const controllerContexts = (await readFile(controllerLog, "utf8")).trim().split("\n")
    .map(contextSnapshot);
  const controllerContext = controllerContexts.findLast((snapshot) =>
    snapshot.provider === "footer-fixture" && snapshot.active === false);
  assert.ok(controllerContext);
  assert.ok(controllerContext.threadId !== undefined);
  assert.notEqual(controllerContext.threadId, "");
  assert.deepEqual({
    sessionName: controllerContext.sessionName,
    workspace: controllerContext.workspace,
    releaseVersion: controllerContext.releaseVersion,
    provider: controllerContext.provider,
    model: controllerContext.model,
    contextWindowTokens: controllerContext.contextWindowTokens,
    thinking: controllerContext.thinking,
    thinkingSupported: controllerContext.thinkingSupported,
    active: controllerContext.active,
    status: controllerContext.status,
    autoCompaction: controllerContext.autoCompaction,
  }, {
    sessionName: "primary footer",
    workspace,
    releaseVersion: OHM_VERSION,
    provider: "footer-fixture",
    model: "footer-model",
    contextWindowTokens: 12_345,
    thinking: "high",
    thinkingSupported: true,
    active: false,
    status: "idle",
    autoCompaction: true,
  });

  const footerSnapshot = contextSnapshot(await readFile(footerSnapshotPath, "utf8"));
  assert.deepEqual({
    sessionName: footerSnapshot.sessionName,
    workspace: footerSnapshot.workspace,
    releaseVersion: footerSnapshot.releaseVersion,
    provider: footerSnapshot.provider,
    model: footerSnapshot.model,
    contextWindowTokens: footerSnapshot.contextWindowTokens,
    thinking: footerSnapshot.thinking,
    thinkingSupported: footerSnapshot.thinkingSupported,
    active: footerSnapshot.active,
    status: footerSnapshot.status,
    autoCompaction: footerSnapshot.autoCompaction,
  }, {
    sessionName: "primary footer",
    workspace,
    releaseVersion: OHM_VERSION,
    provider: "footer-fixture",
    model: "footer-model",
    contextWindowTokens: 12_345,
    thinking: "high",
    thinkingSupported: true,
    active: false,
    status: "idle",
    autoCompaction: true,
  });
});
