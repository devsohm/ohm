import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { isJsonObject, type JsonObject, type JsonValue } from "../../src/core/json.js";

const repositoryRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const cliModule = fileURLToPath(new URL("../../src/bin/ohm.ts", import.meta.url));
const rpcRuntimeModule = new URL("../../src/interfaces/rpc-runtime.ts", import.meta.url).href;

async function runInstalledRpc(
  root: string,
  commands: readonly object[],
  imports: readonly string[] = [],
): Promise<{
  exit: { code: number | null; signal: NodeJS.Signals | null };
  records: JsonObject[];
  stderr: string;
}> {
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  await mkdir(workspace, { recursive: true });
  const child = spawn(process.execPath, [
    "--import", "tsx",
    ...imports.flatMap((specifier) => ["--import", specifier]),
    cliModule,
    "--mode", "rpc",
    "--workspace", workspace,
    "--offline",
    "--no-extensions",
    "--no-session",
    "--approve",
  ], {
    cwd: repositoryRoot,
    env: { ...process.env, OHM_HOME: agentDir, OHM_OFFLINE: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  child.stdin.end(`${commands.map((command) => JSON.stringify(command)).join("\n")}\n`);
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Installed RPC fixture timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 30_000);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
  const records: JsonObject[] = [];
  for (const line of stdout.trim().split("\n").filter(Boolean)) {
    const value: JsonValue = JSON.parse(line);
    if (!isJsonObject(value)) throw new Error("Installed RPC output record was not an object");
    records.push(value);
  }
  return { exit, records, stderr };
}

test("installed RPC reports fatal backlog overload once and exits 1", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-rpc-exit-status-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const blockDispatch = `data:text/javascript,${encodeURIComponent(`
    const nativeSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = function(callback, delay, ...args) {
      return nativeSetTimeout(callback, delay === 5_000 ? 25 : delay, ...args);
    };
    const { RpcRuntimeDispatcher } = await import(${JSON.stringify(rpcRuntimeModule)});
    RpcRuntimeDispatcher.prototype.dispatch = async function() {
      await new Promise(() => {});
    };
  `)}`;
  const commands = Array.from({ length: 1_089 }, (_, index) => ({ id: String(index), type: "get_state" }));

  const result = await runInstalledRpc(root, commands, [blockDispatch]);

  assert.deepEqual(result.exit, { code: 1, signal: null }, result.stderr);
  assert.deepEqual(result.records, [{
    id: "1088",
    type: "response",
    command: "get_state",
    success: false,
    error: "RPC command backlog exceeded 1024",
  }]);
  assert.equal(result.stderr, "");
});

test("installed RPC keeps an ordinary command rejection at exit 0", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-rpc-command-status-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));

  const result = await runInstalledRpc(root, [{ id: "unknown", type: "future" }]);

  assert.deepEqual(result.exit, { code: 0, signal: null }, result.stderr);
  assert.deepEqual(result.records, [{
    id: "unknown",
    type: "response",
    command: "future",
    success: false,
    error: "Unknown command: future",
  }]);
  assert.equal(result.stderr, "");
});
