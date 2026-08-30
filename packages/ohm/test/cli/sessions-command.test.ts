import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { Type } from "typebox";
import { Value } from "typebox/value";

import { inspectSessionFiles } from "../../src/cli/sessions-command.js";
import { TrustStore } from "../../src/config/trust.js";

const DOCTOR_REPORT_VALUE = Type.Object({
  invalid: Type.Array(Type.Object({ path: Type.String() }, { additionalProperties: true })),
}, { additionalProperties: true });

async function writeCorruptSession(directory: string, workspace: string, id: string): Promise<string> {
  const path = join(directory, `${id}.jsonl`);
  await mkdir(directory, { recursive: true });
  await writeFile(path, `${JSON.stringify({
    record: "session",
    version: 4,
    sessionId: id,
    createdAt: "2026-07-21T00:00:00.000Z",
    workspace,
    cwd: workspace,
  })}\n{broken\n`);
  return path;
}

function runDoctor(
  agentDirectory: string,
  workspace: string,
  args: string[] = [],
  overrides: NodeJS.ProcessEnv = {},
) {
  const environment: NodeJS.ProcessEnv = { ...process.env, OHM_HOME: agentDirectory };
  delete environment.OHM_SESSION_DIR;
  Object.assign(environment, overrides);
  return spawnSync(process.execPath, [
    "--import", "tsx", resolve("src/bin/ohm.ts"),
    "sessions", "doctor", "--json", "--workspace", workspace,
    ...args,
  ], {
    cwd: resolve("."),
    env: environment,
    encoding: "utf8",
    timeout: 10_000,
  });
}

test("session doctor reports complete-line corruption while accepting an incomplete tail", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-session-doctor-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const timestamp = "2026-07-21T00:00:00.000Z";
  const header = (id: string) => JSON.stringify({
    record: "session",
    version: 4,
    sessionId: id,
    createdAt: timestamp,
    workspace: root,
    cwd: root,
  });
  const message = JSON.stringify({
    record: "commit",
    sequence: 1,
    commitId: "commit-1",
    committedAt: timestamp,
    changes: [{
      type: "conversation_node",
      node: {
        id: "message1",
        parentId: null,
        nodeType: "message",
        role: "assistant",
        content: { id: "assistant1", role: "assistant", content: [], createdAt: timestamp },
        createdAt: timestamp,
      },
    }, {
      type: "head",
      branchId: "main",
      nodeId: "message1",
    }],
  });
  const valid = join(root, "valid.jsonl");
  const corrupt = join(root, "corrupt.jsonl");
  const recoverable = join(root, "recoverable.jsonl");
  await writeFile(valid, `${header("valid")}\n${message}\n`);
  await writeFile(corrupt, `${header("corrupt")}\n{broken\n`);
  await writeFile(recoverable, `${header("recoverable")}\n${message}\n{"record":"commit"`);

  const report = await inspectSessionFiles({ workspace: root, sessionDirectory: root, allWorkspaces: true });

  assert.equal(report.checked, 3);
  assert.equal(report.valid, 2);
  assert.equal(report.healthy, false);
  assert.deepEqual(report.invalid.map((entry) => entry.path), [corrupt]);
  assert.match(report.invalid[0]?.error ?? "", /line 2 is not valid JSON/u);
  assert.match(await readFile(corrupt, "utf8"), /\{broken\n$/u);
});

test("session doctor uses CLI, environment, and effective settings directory precedence", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-session-doctor-resolution-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const agentDirectory = join(root, ".ohm");
  const globalDirectory = join(root, "global-sessions");
  const projectDirectory = join(root, "project-sessions");
  const environmentDirectory = join(root, "environment-sessions");
  const invocationDirectory = join(root, "invocation-sessions");
  await mkdir(join(workspace, ".ohm"), { recursive: true });
  await mkdir(agentDirectory, { recursive: true });
  await writeFile(join(agentDirectory, "config.json"), `${JSON.stringify({ sessionDir: globalDirectory })}\n`);
  await writeFile(join(workspace, ".ohm", "config.json"), `${JSON.stringify({ sessionDir: projectDirectory })}\n`);
  const globalSession = await writeCorruptSession(globalDirectory, workspace, "global");
  const projectSession = await writeCorruptSession(projectDirectory, workspace, "project");
  const environmentSession = await writeCorruptSession(environmentDirectory, workspace, "environment");
  const invocationSession = await writeCorruptSession(invocationDirectory, workspace, "invocation");

  const selectedPath = (result: ReturnType<typeof runDoctor>): string => {
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stderr, "");
    const report = Value.Parse(DOCTOR_REPORT_VALUE, JSON.parse(result.stdout));
    assert.equal(report.invalid.length, 1);
    return report.invalid[0]!.path;
  };

  assert.equal(selectedPath(runDoctor(agentDirectory, workspace)), globalSession);
  await new TrustStore(join(agentDirectory, "trusted-workspaces.json")).trust(workspace);
  assert.equal(selectedPath(runDoctor(agentDirectory, workspace)), projectSession);
  assert.equal(
    selectedPath(runDoctor(agentDirectory, workspace, [], { OHM_SESSION_DIR: environmentDirectory })),
    environmentSession,
  );
  assert.equal(
    selectedPath(runDoctor(
      agentDirectory,
      workspace,
      ["--session-dir", invocationDirectory],
      { OHM_SESSION_DIR: environmentDirectory },
    )),
    invocationSession,
  );

  await writeFile(join(agentDirectory, "trusted-workspaces.json"), "{broken\n");
  assert.equal(
    selectedPath(runDoctor(agentDirectory, workspace, ["--session-dir", invocationDirectory])),
    invocationSession,
  );
});
