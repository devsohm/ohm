import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  evaluateRiskCoverage,
  formatRiskCoverageFailure,
  parseRiskCoverageConfig,
  parseV8Coverage,
  removeRiskCoverageGroupArtifacts,
  runRiskCoverageCheck,
  selectRiskCoverageTests,
  validateRiskCoverageTargets,
} from "../../benchmarks/risk-coverage.js";
import { parseJsonObject } from "./json-fixture.js";

test("risk coverage failure diagnostics preserve early failures and process metadata", () => {
  const trailingOutput = "✓ later passing test\n".repeat(1_000);
  const stderr = Buffer.from(`✗ original failure marker\n${trailingOutput}`, "utf8");
  assert.ok(stderr.length > 16 * 1024);
  const formatted = formatRiskCoverageFailure("service-storage", {
    exitCode: 1,
    signal: "SIGTERM",
    stdout: Buffer.from("coverage worker output\n", "utf8"),
    stderr,
    stdoutBytes: 23,
    stderrBytes: stderr.length + 512,
    timedOut: false,
    cancelled: false,
  });
  assert.match(formatted.diagnostic, /original failure marker/u);
  assert.match(formatted.diagnostic, /later passing test/u);
  assert.match(formatted.message, /exitCode=1, signal=SIGTERM/u);
  assert.match(formatted.message, /stdout=23\/23 retained\/observed bytes/u);
  assert.match(formatted.message, new RegExp(`stderr=${stderr.length}/${stderr.length + 512} retained/observed bytes`, "u"));
});

test("risk coverage evaluates each configured module independently", () => {
  const parsed = parseV8Coverage(JSON.stringify({
    type: "v8",
    files: [{
      sourcePath: "src/plugins/runtime.ts",
      summary: {
        lines: { total: 100, covered: 95, pct: 95 },
        branches: { total: 20, covered: 16, pct: 80 },
        functions: { total: 10, covered: 9, pct: 90 },
      },
    }],
  }), process.cwd());
  const [result] = evaluateRiskCoverage({
    schemaVersion: 1,
    excludedTests: ["test/live/"],
    targets: [{ file: "src/plugins/runtime.ts", minimum: { lines: 90, branches: 85, functions: 90 } }],
    groups: [{
      id: "extension-runtime",
      targets: ["src/plugins/runtime.ts"],
      testPrefixes: ["test/plugins/"],
      testExcludes: [],
    }],
  }, parsed);
  assert.deepEqual(result, {
    file: "src/plugins/runtime.ts",
    actual: { lines: 95, branches: 80, functions: 90 },
    minimum: { lines: 90, branches: 85, functions: 90 },
    passed: false,
    failures: ["branches"],
  });
});

test("risk coverage configuration retains the high-risk module baselines", async () => {
  const config = parseJsonObject(await readFile(
    new URL("../../benchmarks/risk-coverage.config.json", import.meta.url),
    "utf8",
  ), "risk coverage configuration");
  assert.deepEqual(config.excludedTests, ["test/live/"]);
  assert.deepEqual(config.targets, [
    { file: "src/plugins/runtime.ts", minimum: { lines: 90, branches: 68, functions: 90 } },
    { file: "src/cli/main.ts", minimum: { lines: 84, branches: 68, functions: 74 } },
    { file: "src/tui/controller.ts", minimum: { lines: 91, branches: 78, functions: 85 } },
    { file: "src/service/agent-session.ts", minimum: { lines: 94, branches: 85, functions: 90 } },
    { file: "src/storage/session-manager.ts", minimum: { lines: 97, branches: 88, functions: 97 } },
    { file: "src/storage/session-entry-projection.ts", minimum: { lines: 97, branches: 88, functions: 97 } },
    { file: "src/serve/server.ts", minimum: { lines: 99, branches: 84, functions: 98 } },
  ]);
  assert.deepEqual(config.groups, [
    {
      id: "extension-runtime",
      targets: ["src/plugins/runtime.ts"],
      testPrefixes: ["test/plugins/", "test/cli/", "test/service/", "test/storage/"],
      testExcludes: ["test/cli/process-signal-cleanup.test.ts"],
    },
    {
      id: "cli-tui",
      targets: ["src/cli/main.ts", "src/tui/controller.ts"],
      testPrefixes: ["test/cli/", "test/tui/"],
      testExcludes: ["test/cli/process-signal-cleanup.test.ts"],
    },
    {
      id: "service-runtime",
      targets: ["src/service/agent-session.ts"],
      testPrefixes: ["test/storage/", "test/service/", "test/cli/", "test/core/", "test/plugins/", "test/tools/"],
      testExcludes: ["test/cli/process-signal-cleanup.test.ts"],
    },
    {
      id: "session-storage",
      targets: ["src/storage/session-manager.ts", "src/storage/session-entry-projection.ts"],
      testPrefixes: ["test/storage/", "test/service/"],
      testExcludes: [],
    },
    {
      id: "serve-transport",
      targets: ["src/serve/server.ts"],
      testPrefixes: ["test/serve/"],
      testExcludes: [],
    },
  ]);
});

test("risk coverage groups use prefixes and exact exclusions", () => {
  const selected = selectRiskCoverageTests([
    "test/plugins/runtime.test.ts",
    "test/plugins/managed-package-host-imports.test.ts",
    "test/plugins/managed-package-host-imports.test.ts.backup.test.ts",
    "test/service/harness.test.ts",
  ], {
    id: "extension-runtime",
    targets: ["src/plugins/runtime.ts"],
    testPrefixes: ["test/plugins/"],
    testExcludes: ["test/plugins/managed-package-host-imports.test.ts"],
  });
  assert.deepEqual(selected, [
    "test/plugins/runtime.test.ts",
    "test/plugins/managed-package-host-imports.test.ts.backup.test.ts",
  ]);
});

test("risk coverage config rejects traversal and incomplete target ownership", () => {
  const base = {
    schemaVersion: 1,
    excludedTests: ["test/live/"],
    targets: [
      { file: "src/plugins/runtime.ts", minimum: { lines: 90, branches: 68, functions: 90 } },
      { file: "src/cli/main.ts", minimum: { lines: 84, branches: 68, functions: 74 } },
    ],
    groups: [{
      id: "runtime",
      targets: ["src/plugins/runtime.ts"],
      testPrefixes: ["test/plugins/"],
      testExcludes: [],
    }],
  };
  assert.throws(() => parseRiskCoverageConfig(base), /exactly one group/u);
  assert.throws(() => parseRiskCoverageConfig({
    ...base,
    targets: base.targets.slice(0, 1),
    groups: [{ ...base.groups[0], testPrefixes: ["test/../extensions/"] }],
  }), /testPrefixes are invalid/u);
});

test("risk coverage preflight rejects stale and non-file source targets", async () => {
  const root = await mkdtemp(join(tmpdir(), "ohm-risk-targets-"));
  const config = parseRiskCoverageConfig({
    schemaVersion: 1,
    excludedTests: ["test/live/"],
    targets: [
      { file: "src/current.ts", minimum: { lines: 90, branches: 80, functions: 90 } },
      { file: "src/stale.ts", minimum: { lines: 90, branches: 80, functions: 90 } },
    ],
    groups: [{
      id: "runtime",
      targets: ["src/current.ts", "src/stale.ts"],
      testPrefixes: ["test/plugins/"],
      testExcludes: [],
    }],
  });
  try {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src/current.ts"), "export {};\n", "utf8");
    await assert.rejects(
      validateRiskCoverageTargets(config, root),
      /Risk coverage target src\/stale\.ts is missing or unreadable; update benchmarks\/risk-coverage\.config\.json/u,
    );
    await mkdir(join(root, "src/stale.ts"));
    await assert.rejects(
      validateRiskCoverageTargets(config, root),
      /Risk coverage target src\/stale\.ts is not a regular file; update benchmarks\/risk-coverage\.config\.json/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("risk coverage group cleanup removes only a validated direct child", async () => {
  const root = await mkdtemp(join(tmpdir(), "ohm-risk-cleanup-"));
  try {
    await mkdir(join(root, "completed", "v8"), { recursive: true });
    await mkdir(join(root, "pending"), { recursive: true });
    await writeFile(join(root, "completed", "v8", "raw.json"), "{}\n", "utf8");
    await writeFile(join(root, "pending", "evidence.txt"), "keep\n", "utf8");

    await removeRiskCoverageGroupArtifacts(root, "completed");

    await assert.rejects(readFile(join(root, "completed", "v8", "raw.json")), { code: "ENOENT" });
    assert.equal(await readFile(join(root, "pending", "evidence.txt"), "utf8"), "keep\n");
    await assert.rejects(
      removeRiskCoverageGroupArtifacts(root, "../pending"),
      /artifact path must be a direct child/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("risk coverage retains failed raw artifacts and the original error when diagnostics throw", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-risk-retained-"));
  const previousRunnerTemp = process.env.RUNNER_TEMP;
  context.after(async () => {
    if (previousRunnerTemp === undefined) delete process.env.RUNNER_TEMP;
    else process.env.RUNNER_TEMP = previousRunnerTemp;
    await rm(root, { recursive: true, force: true });
  });
  process.env.RUNNER_TEMP = root;
  const failure = new SyntaxError("incomplete coverage JSON");
  const raw = Buffer.from('{"result":[{"url":"unfinished');
  let rawPath = "";
  let diagnostic = "";
  context.mock.method(process.stderr, "write", (chunk: string | Uint8Array) => {
    diagnostic += String(chunk);
    throw new Error("diagnostic output unavailable");
  });

  await assert.rejects(runRiskCoverageCheck(async ({ argv }) => {
    const argument = argv.find((value) => value.startsWith("--temp-directory="));
    assert.ok(argument);
    const directory = argument.slice("--temp-directory=".length);
    await mkdir(directory, { recursive: true });
    rawPath = join(directory, "coverage-fixture.json");
    await writeFile(rawPath, raw);
    throw failure;
  }), (error) => error === failure);

  const retained = dirname(dirname(dirname(rawPath)));
  assert.equal(dirname(retained), root);
  assert.equal(diagnostic, `[risk coverage] Artifacts retained at ${retained}\n`);
  assert.deepEqual(await readFile(rawPath), raw);
});

test("risk coverage cleans only its own temporary root after passing or below-threshold reports", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "ohm-risk-success-"));
  const previousRunnerTemp = process.env.RUNNER_TEMP;
  context.after(async () => {
    if (previousRunnerTemp === undefined) delete process.env.RUNNER_TEMP;
    else process.env.RUNNER_TEMP = previousRunnerTemp;
    await rm(root, { recursive: true, force: true });
  });
  process.env.RUNNER_TEMP = root;
  const sibling = join(root, "unrelated-evidence.txt");
  await writeFile(sibling, "keep\n");

  for (const percentage of [100, 0]) {
    let temporary = "";
    const report = await runRiskCoverageCheck(async ({ argv }) => {
      const argument = argv.find((value) => value.startsWith("--reports-dir="));
      assert.ok(argument);
      const directory = argument.slice("--reports-dir=".length);
      temporary = dirname(dirname(directory));
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "coverage-report.json"), JSON.stringify({
        files: argv.filter((value) => value.startsWith("--include=")).map((value) => ({
          sourcePath: value.slice("--include=".length),
          summary: { lines: { pct: percentage }, branches: { pct: percentage }, functions: { pct: percentage } },
        })),
      }));
      return {
        exitCode: 0, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0),
        stdoutBytes: 0, stderrBytes: 0, timedOut: false, cancelled: false, durationMs: 1,
      };
    });

    assert.equal(report.passed, percentage === 100);
    assert.equal(dirname(temporary), root);
    await assert.rejects(readFile(join(temporary, "extension-runtime", "report", "coverage-report.json")), { code: "ENOENT" });
    await assert.rejects(readFile(temporary), { code: "ENOENT" });
    assert.equal(await readFile(sibling, "utf8"), "keep\n");
  }
});
