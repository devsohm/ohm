import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { createDiagnosticBundle } from "../../src/cli/diagnostics-command.js";
import { createLocalLogsReport } from "../../src/cli/logs-command.js";
import { createLocalStatsReport } from "../../src/cli/stats-command.js";
import { MAX_DIRECTORY_SCAN_ENTRIES } from "../../src/core/local-observability.js";

const LOGS_REPORT_VALUE = Type.Object({
  kind: Type.String(),
  level: Type.String(),
  configuration: Type.Object({ status: Type.String() }, { additionalProperties: true }),
  redrawDebugPath: Type.String(),
  diagnosticsDirectory: Type.String(),
  crashDirectory: Type.String(),
  sessionDirectory: Type.String(),
  files: Type.Array(Type.Object({
    path: Type.String(),
    sizeBytes: Type.Number(),
    modifiedAt: Type.String(),
  }, { additionalProperties: true })),
  totalBytes: Type.Number(),
  partial: Type.Boolean(),
}, { additionalProperties: true });
const INVALID_CONFIG_LOGS_REPORT_VALUE = Type.Object({
  level: Type.String(),
  directory: Type.String(),
  configuration: Type.Object({
    status: Type.String(),
    warning: Type.Optional(Type.String()),
  }, { additionalProperties: true }),
  files: Type.Array(Type.Object({ path: Type.String() }, { additionalProperties: true })),
}, { additionalProperties: true });

async function writeUnrecognizedEntries(directory: string, count: number): Promise<void> {
  const batchSize = 256;
  for (let offset = 0; offset < count; offset += batchSize) {
    await Promise.all(Array.from(
      { length: Math.min(batchSize, count - offset) },
      async (_, index) => await writeFile(join(directory, `unrelated-${offset + index}.tmp`), ""),
    ));
  }
}

test("logs reports only local file metadata and keeps JSON stdout parseable", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-logs-command-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const agentDirectory = join(root, ".ohm");
  const logs = join(agentDirectory, "logs");
  const diagnostics = join(agentDirectory, "diagnostics");
  const crash = join(agentDirectory, "crash");
  const sessions = join(agentDirectory, "sessions");
  const workspaceSessions = join(sessions, "--workspace--");
  await Promise.all([
    mkdir(logs, { recursive: true }),
    mkdir(diagnostics, { recursive: true }),
    mkdir(crash, { recursive: true }),
    mkdir(workspaceSessions, { recursive: true }),
  ]);
  await writeFile(join(agentDirectory, "config.json"), `${JSON.stringify({ observability: { level: "debug" } })}\n`);
  await writeFile(
    join(logs, "ohm-20260808T120000-1-abcdef123456-000.jsonl"),
    "LOG_CONTENT_SENTINEL\n",
    { mode: 0o600 },
  );
  await writeFile(join(logs, "ohm-debug.log"), "REDRAW_CONTENT_SENTINEL\n", { mode: 0o600 });
  await writeFile(join(diagnostics, "support.json"), "DIAGNOSTIC_CONTENT_SENTINEL\n", { mode: 0o600 });
  await writeFile(
    join(crash, "ohm-crash-20260808T120000-1-abcdef123456.json"),
    "CRASH_CONTENT_SENTINEL\n",
    { mode: 0o600 },
  );
  await writeFile(join(crash, "unrelated.txt"), "UNRELATED_CONTENT_SENTINEL\n", { mode: 0o600 });
  await writeFile(join(workspaceSessions, "session.jsonl"), "SESSION_CONTENT_SENTINEL\n", { mode: 0o600 });

  const result = spawnSync(process.execPath, [
    "--import", "tsx", resolve("src/bin/ohm.ts"), "logs", "--json",
  ], {
    cwd: resolve("."),
    env: { ...process.env, OHM_HOME: agentDirectory },
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.doesNotMatch(
    result.stdout,
    /LOG_CONTENT_SENTINEL|REDRAW_CONTENT_SENTINEL|DIAGNOSTIC_CONTENT_SENTINEL|CRASH_CONTENT_SENTINEL|SESSION_CONTENT_SENTINEL|UNRELATED_CONTENT_SENTINEL/u,
  );
  const parsed = JSON.parse(result.stdout);
  if (!Value.Check(LOGS_REPORT_VALUE, parsed)) throw new Error("Invalid local logs report");
  assert.equal(parsed.kind, "ohm-local-logs");
  assert.equal(parsed.level, "debug");
  assert.equal(parsed.configuration.status, "valid");
  assert.equal(parsed.redrawDebugPath, join(logs, "ohm-debug.log"));
  assert.equal(parsed.diagnosticsDirectory, join(agentDirectory, "diagnostics"));
  assert.equal(parsed.crashDirectory, join(agentDirectory, "crash"));
  assert.equal(parsed.sessionDirectory, sessions);
  assert.equal(parsed.files.length, 1);
  assert.equal(parsed.files[0]?.path.endsWith(".jsonl"), true);
  assert.equal(parsed.totalBytes, Buffer.byteLength("LOG_CONTENT_SENTINEL\n"));
  assert.equal(parsed.partial, false);
});

test("logs remains usable when global configuration is malformed", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-logs-invalid-config-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const agentDirectory = join(root, ".ohm");
  const logs = join(agentDirectory, "logs");
  await mkdir(logs, { recursive: true });
  await writeFile(
    join(agentDirectory, "config.json"),
    '{"observability":{"level":"debug"},"note":"CONFIG_PRIVATE_SENTINEL",\n',
  );
  const logPath = join(logs, "ohm-20260808T120000-1-abcdef123456-000.jsonl");
  await writeFile(logPath, "LOG_CONTENT_SENTINEL\n", { mode: 0o600 });

  const result = spawnSync(process.execPath, [
    "--import", "tsx", resolve("src/bin/ohm.ts"), "logs", "--json",
  ], {
    cwd: resolve("."),
    env: { ...process.env, OHM_HOME: agentDirectory, OHM_LOG_LEVEL: "error" },
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const parsed = JSON.parse(result.stdout);
  if (!Value.Check(INVALID_CONFIG_LOGS_REPORT_VALUE, parsed)) throw new Error("Invalid malformed-config logs report");
  assert.equal(parsed.level, "error");
  assert.equal(parsed.directory, logs);
  assert.deepEqual(parsed.files.map((file) => file.path), [logPath]);
  assert.equal(parsed.configuration.status, "invalid");
  assert.match(parsed.configuration.warning ?? "", /config.*could not be loaded/iu);
  assert.ok(Buffer.byteLength(parsed.configuration.warning ?? "") <= 512);
  assert.doesNotMatch(JSON.stringify(parsed.configuration), /CONFIG_PRIVATE_SENTINEL/u);
  assert.doesNotMatch(result.stdout, /LOG_CONTENT_SENTINEL/u);
});

test("bounded log listing is marked partial in logs, stats, and diagnostics", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-log-listing-bound-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const agentDirectory = join(root, ".ohm");
  const logs = join(agentDirectory, "logs");
  await mkdir(logs, { recursive: true });
  await writeUnrecognizedEntries(logs, MAX_DIRECTORY_SCAN_ENTRIES + 1);
  const environment = { ...process.env, OHM_HOME: agentDirectory } satisfies NodeJS.ProcessEnv;

  assert.equal((await createLocalLogsReport(environment)).partial, true);
  assert.equal((await createLocalStatsReport(environment)).source.partial, true);
  assert.equal((await createDiagnosticBundle({
    workspace: root,
    environment,
    homeDirectory: root,
  })).observability.partial, true);
});
