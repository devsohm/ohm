import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

import type { SessionV4Commit } from "@ohm/kernel/session-v4";
import { loadRuntime, type LoadedRuntime } from "../src/cli/runtime.js";
import { RpcRuntimeDispatcher, type RpcSessionRuntime } from "../src/interfaces/rpc-runtime.js";
import type { RpcEntryPage, RpcResponse } from "../src/interfaces/rpc-protocol.js";
import { SessionManager } from "../src/storage/session-manager.js";

const DEFAULT_SAMPLES = 3;
const STARTUP_EXTENSION_COUNTS = [0, 10, 50] as const;
const LARGE_PACKAGE_ENTRY_COUNT = 8;
const COMMANDS_PER_LARGE_ENTRY = 32;

export interface RuntimePerformanceScenario {
  id: string;
  operation: "startup" | "refresh" | "resume" | "rpc-replay" | "event-page";
  fixture: {
    extensionCount?: number;
    runtimeEntryCount?: number;
    commandCount?: number;
    eventCount?: number;
    pageLimit?: number;
    cold?: boolean;
    materializedRowBudget?: number;
  };
  samplesMs: number[];
  materializedRows?: number[];
  maximumMaterializedRows?: number;
  minimumMs: number;
  medianMs: number;
  p95Ms: number;
  maximumMs: number;
  ceilingMs: number;
  passed: boolean;
}

export interface RuntimePerformanceReport {
  schemaVersion: 1;
  suite: "runtime-performance-v1";
  purpose: "runtime-regression-guard";
  deterministicFixtures: true;
  samplesPerScenario: number;
  environment: {
    platform: NodeJS.Platform;
    architecture: string;
    node: string;
  };
  scenarios: RuntimePerformanceScenario[];
  summary: {
    scenarios: number;
    passed: number;
  };
}

export interface RuntimePerformanceOptions {
  samples?: number;
}

interface MeasurementFixture {
  root: string;
  workspace: string;
  configHome: string;
  stateHome: string;
}

async function fixture(prefix: string): Promise<MeasurementFixture> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const workspace = join(root, "workspace");
  const configHome = join(root, "config");
  const stateHome = join(root, "state");
  await mkdir(workspace, { recursive: true });
  await mkdir(configHome, { mode: 0o700 });
  await mkdir(stateHome, { mode: 0o700 });
  await mkdir(join(configHome, "ohm"), { mode: 0o700 });
  await mkdir(join(configHome, "ohm", "extensions"), { mode: 0o700 });
  return { root, workspace, configHome, stateHome };
}

async function withEnvironment<T>(value: MeasurementFixture, operation: () => Promise<T>): Promise<T> {
  const previous = {
    config: process.env.XDG_CONFIG_HOME,
    state: process.env.XDG_STATE_HOME,
    agentDirectory: process.env.OHM_HOME,
  };
  process.env.XDG_CONFIG_HOME = value.configHome;
  process.env.XDG_STATE_HOME = value.stateHome;
  process.env.OHM_HOME = join(value.configHome, "ohm");
  try {
    return await operation();
  } finally {
    if (previous.config === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous.config;
    if (previous.state === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous.state;
    if (previous.agentDirectory === undefined) delete process.env.OHM_HOME;
    else process.env.OHM_HOME = previous.agentDirectory;
  }
}

function runtimeOptions(workspace: string) {
  return {
    workspace,
    extensions: true,
    extensionRuntime: true,
    skills: false,
    promptTemplates: false,
    themes: false,
  } as const satisfies NonNullable<Parameters<typeof loadRuntime>[0]>;
}

async function writeExtension(root: string, id: string, source: string): Promise<void> {
  const directory = join(root, id);
  await mkdir(join(directory, "extensions"), { recursive: true });
  await writeFile(join(directory, "package.json"), `${JSON.stringify({
    name: `@ohm-benchmark/${id}`,
    version: "1.0.0",
    private: true,
    type: "module",
    ohm: { extensions: ["extensions/index.mjs"] },
  }, null, 2)}\n`);
  await writeFile(join(directory, "extensions", "index.mjs"), source);
}

function commandExtensionSource(id: string): string {
  return `export default (ohm) => ohm.registerCommand(${JSON.stringify(`bench-${id}`)}, { async handler() {} });\n`;
}

async function startupSample(extensionCount: number): Promise<number> {
  const value = await fixture(`ohm-startup-${extensionCount}-`);
  let runtime: LoadedRuntime | undefined;
  try {
    const extensionRoot = join(value.configHome, "ohm", "extensions");
    for (let index = 0; index < extensionCount; index += 1) {
      const id = `startup-${String(index).padStart(2, "0")}`;
      await writeExtension(extensionRoot, id, commandExtensionSource(id));
    }
    return await withEnvironment(value, async () => {
      const started = performance.now();
      runtime = await loadRuntime(runtimeOptions(value.workspace));
      const elapsed = performance.now() - started;
      if (runtime.runtimeExtensions.commands().length !== extensionCount) {
        throw new Error(`Startup fixture activated ${runtime.runtimeExtensions.commands().length} of ${extensionCount} commands`);
      }
      return elapsed;
    });
  } finally {
    await runtime?.close().catch(() => undefined);
    await rm(value.root, { recursive: true, force: true });
  }
}

function largeEntrySource(entry: number, version: string): string {
  const registrations = Array.from({ length: COMMANDS_PER_LARGE_ENTRY }, (_, index) => {
    const name = `large-${entry}-${index}`;
    return `ohm.registerCommand(${JSON.stringify(name)}, { async handler() { globalThis.__ohmBenchmarkVersion = ${JSON.stringify(version)}; } });`;
  }).join("\n  ");
  return `export default function activate(ohm) {\n  ${registrations}\n}\n`;
}

async function writeLargePackage(extensionRoot: string, version: string): Promise<void> {
  const directory = join(extensionRoot, "large-package");
  await mkdir(join(directory, "extensions"), { recursive: true });
  const extensions = Array.from({ length: LARGE_PACKAGE_ENTRY_COUNT }, (_, index) => `extensions/entry-${index}.mjs`);
  await writeFile(join(directory, "package.json"), `${JSON.stringify({
    name: "@ohm-benchmark/large-package",
    version: "1.0.0",
    private: true,
    type: "module",
    ohm: { extensions },
  }, null, 2)}\n`);
  for (let index = 0; index < LARGE_PACKAGE_ENTRY_COUNT; index += 1) {
    await writeFile(join(directory, "extensions", `entry-${index}.mjs`), largeEntrySource(index, version));
  }
}

async function refreshSample(): Promise<number> {
  const value = await fixture("ohm-refresh-large-");
  let runtime: LoadedRuntime | undefined;
  try {
    const extensionRoot = join(value.configHome, "ohm", "extensions");
    await writeLargePackage(extensionRoot, "before");
    return await withEnvironment(value, async () => {
      runtime = await loadRuntime(runtimeOptions(value.workspace));
      await writeLargePackage(extensionRoot, "after");
      const started = performance.now();
      await runtime.refresh();
      const elapsed = performance.now() - started;
      const expected = LARGE_PACKAGE_ENTRY_COUNT * COMMANDS_PER_LARGE_ENTRY;
      if (runtime.runtimeExtensions.commands().length !== expected) {
        throw new Error(`Refresh fixture activated ${runtime.runtimeExtensions.commands().length} of ${expected} commands`);
      }
      return elapsed;
    });
  } finally {
    await runtime?.close().catch(() => undefined);
    await rm(value.root, { recursive: true, force: true });
  }
}

function sessionMessage(index: number) {
  return {
    id: `benchmark-message-${index}`,
    role: index % 2 === 0 ? "user" as const : "assistant" as const,
    content: [{ type: "text" as const, text: `Deterministic resume fixture message ${index}` }],
    createdAt: new Date(index * 1_000).toISOString(),
  };
}

interface SeededSession {
  path: string;
  directory: string;
}

function benchmarkNodeId(index: number): string {
  return index.toString(16).padStart(8, "0");
}

async function seedSession(value: MeasurementFixture, eventCount: number): Promise<SeededSession> {
  const directory = join(value.root, "sessions");
  const manager = SessionManager.inMemory(value.workspace, { id: `resume-${eventCount}` });
  const header = manager.getV4State().header;
  const records = [JSON.stringify(header)];
  for (let index = 0; index < eventCount; index += 1) {
    const message = sessionMessage(index);
    const nodeId = benchmarkNodeId(index);
    const commit: SessionV4Commit = {
      record: "commit",
      sequence: index + 1,
      commitId: `benchmark-commit-${index}`,
      committedAt: message.createdAt,
      changes: [{
        type: "conversation_node",
        node: {
          id: nodeId,
          parentId: index === 0 ? null : benchmarkNodeId(index - 1),
          nodeType: "message",
          role: message.role,
          content: message,
          createdAt: message.createdAt,
        },
      }, {
        type: "head",
        branchId: "main",
        nodeId,
      }],
    };
    records.push(JSON.stringify(commit));
  }
  await mkdir(directory, { mode: 0o700 });
  const path = join(directory, `resume-${eventCount}.jsonl`);
  await writeFile(
    path,
    `${records.join("\n")}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  return { path, directory };
}

async function resumeSample(eventCount: number): Promise<number> {
  const value = await fixture(`ohm-resume-${eventCount}-`);
  try {
    const seeded = await seedSession(value, eventCount);
    const started = performance.now();
    const manager = SessionManager.open(seeded.path, seeded.directory);
    try {
      const conversation = manager.buildSessionContext();
      const elapsed = performance.now() - started;
      if (conversation.messages.length !== eventCount) {
        throw new Error(`Resume fixture projected ${conversation.messages.length} of ${eventCount} messages`);
      }
      return elapsed;
    } finally {
      manager.closeV4Store();
    }
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
}

function rpcRuntime(runtime: LoadedRuntime): RpcSessionRuntime {
  return {
    get session() { return runtime.session; },
    async newSession() { throw new Error("Session replacement is outside this benchmark"); },
    async switchSession() { throw new Error("Session replacement is outside this benchmark"); },
    async fork() { throw new Error("Session replacement is outside this benchmark"); },
    setRebindSession() {},
    setBeforeSessionInvalidate() {},
  };
}

function entryPage(response: RpcResponse | undefined): RpcEntryPage {
  if (response === undefined || !response.success || !("data" in response)) {
    throw new Error(response === undefined ? "RPC command returned no response" : response.success ? "RPC response has no data" : response.error);
  }
  if (response.command !== "get_entries") throw new Error(`Expected get_entries response, received ${response.command}`);
  return response.data;
}

interface ColdPageSample {
  elapsedMs: number;
  materializedRows: number;
}

interface SessionRowObservation {
  restore(): void;
  rows(): number;
}

function observeSessionRowMaterialization(manager: SessionManager): SessionRowObservation {
  const getEntries = manager.getEntries;
  const getEntriesPage = manager.getEntriesPage;
  let materializedRows = 0;
  manager.getEntries = function observedEntries(): ReturnType<SessionManager["getEntries"]> {
    const entries = getEntries.call(this);
    materializedRows += entries.length;
    return entries;
  };
  manager.getEntriesPage = function observedEntriesPage(
    offset: number,
    limit: number,
  ): ReturnType<SessionManager["getEntriesPage"]> {
    const entries = getEntriesPage.call(this, offset, limit);
    materializedRows += entries.length;
    return entries;
  };
  return {
    restore() {
      manager.getEntries = getEntries;
      manager.getEntriesPage = getEntriesPage;
    },
    rows() { return materializedRows; },
  };
}

async function coldEventPageSample(eventCount: number): Promise<ColdPageSample> {
  const value = await fixture(`ohm-cold-page-${eventCount}-`);
  let runtime: LoadedRuntime | undefined;
  let dispatcher: RpcRuntimeDispatcher | undefined;
  let observation: ReturnType<typeof observeSessionRowMaterialization> | undefined;
  try {
    const seeded = await seedSession(value, eventCount);
    return await withEnvironment(value, async () => {
      runtime = await loadRuntime({ ...runtimeOptions(value.workspace), sessionFile: seeded.path, sessionDirectory: seeded.directory });
      dispatcher = new RpcRuntimeDispatcher({ runtime: rpcRuntime(runtime), output() {} });
      observation = observeSessionRowMaterialization(runtime.session.nativeSessionManager);
      const started = performance.now();
      const page = entryPage(
        await dispatcher.dispatch({ id: "benchmark", type: "get_entries", limit: 1 }),
      );
      const elapsed = performance.now() - started;
      const materializedRows = observation.rows();
      const first = page.entries[0];
      const firstMessage = first?.type === "message" ? first.message : undefined;
      const firstContent = firstMessage?.role === "user" && Array.isArray(firstMessage.content)
        ? firstMessage.content[0]
        : undefined;
      if (
        page.entries.length !== 1 ||
        first?.type !== "message" ||
        firstMessage?.role !== "user" ||
        firstContent?.type !== "text" ||
        firstContent.text !== "Deterministic resume fixture message 0"
      ) {
        throw new Error(`Cold page fixture ${eventCount} returned the wrong event`);
      }
      return { elapsedMs: elapsed, materializedRows };
    });
  } finally {
    observation?.restore();
    await dispatcher?.close().catch(() => undefined);
    await runtime?.close().catch(() => undefined);
    await rm(value.root, { recursive: true, force: true });
  }
}

async function rpcReplaySample(eventCount: number, pageLimit: number, timeoutMs: number): Promise<number> {
  const value = await fixture(`ohm-rpc-replay-${eventCount}-`);
  let runtime: LoadedRuntime | undefined;
  let dispatcher: RpcRuntimeDispatcher | undefined;
  try {
    const seeded = await seedSession(value, eventCount);
    return await withEnvironment(value, async () => {
      runtime = await loadRuntime({ ...runtimeOptions(value.workspace), sessionFile: seeded.path, sessionDirectory: seeded.directory });
      dispatcher = new RpcRuntimeDispatcher({ runtime: rpcRuntime(runtime), output() {} });
      const started = performance.now();
      let delivered = 0;
      let afterSequence = 0;
      for (;;) {
        const page = entryPage(await dispatcher.dispatch({
          id: `benchmark-${afterSequence}`,
          type: "get_entries",
          limit: pageLimit,
          afterSequence,
        }));
        delivered += page.entries.length;
        afterSequence = page.nextSequence;
        if (!page.hasMore) break;
      }
      const elapsed = performance.now() - started;
      if (elapsed > timeoutMs) throw new Error(`RPC replay timed out after ${timeoutMs}ms`);
      if (delivered !== eventCount) throw new Error(`RPC replay delivered ${delivered} of ${eventCount} entries`);
      return elapsed;
    });
  } finally {
    await dispatcher?.close().catch(() => undefined);
    await runtime?.close().catch(() => undefined);
    await rm(value.root, { recursive: true, force: true });
  }
}

function percentile(values: readonly number[], fraction: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)]!;
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

function scenario(
  id: string,
  operation: RuntimePerformanceScenario["operation"],
  fixtureValue: RuntimePerformanceScenario["fixture"],
  samples: number[],
  ceilingMs: number,
  materializedRows?: number[],
): RuntimePerformanceScenario {
  const roundedSamples = samples.map(rounded);
  const maximumMaterializedRows = materializedRows === undefined ? undefined : Math.max(...materializedRows);
  const materializedRowBudget = fixtureValue.materializedRowBudget;
  const result: RuntimePerformanceScenario = {
    id,
    operation,
    fixture: fixtureValue,
    samplesMs: roundedSamples,
    minimumMs: rounded(Math.min(...samples)),
    medianMs: rounded(percentile(samples, 0.5)),
    p95Ms: rounded(percentile(samples, 0.95)),
    maximumMs: rounded(Math.max(...samples)),
    ceilingMs,
    passed: Math.max(...samples) <= ceilingMs && (
      maximumMaterializedRows === undefined
      || materializedRowBudget === undefined
      || maximumMaterializedRows <= materializedRowBudget
    ),
  };
  if (materializedRows !== undefined && maximumMaterializedRows !== undefined) {
    result.materializedRows = materializedRows;
    result.maximumMaterializedRows = maximumMaterializedRows;
  }
  return result;
}

async function measure<T>(samples: number, operation: () => Promise<T>): Promise<T[]> {
  const values: T[] = [];
  for (let index = 0; index < samples; index += 1) values.push(await operation());
  return values;
}

export async function runRuntimePerformanceBenchmark(
  options: RuntimePerformanceOptions = {},
): Promise<RuntimePerformanceReport> {
  const samples = options.samples ?? DEFAULT_SAMPLES;
  if (!Number.isSafeInteger(samples) || samples < 1 || samples > 10) {
    throw new RangeError("Runtime performance samples must be from 1 through 10");
  }
  const scenarios: RuntimePerformanceScenario[] = [];
  for (const extensionCount of STARTUP_EXTENSION_COUNTS) {
    scenarios.push(scenario(
      `startup-${extensionCount}-extensions`,
      "startup",
      { extensionCount },
      await measure(samples, async () => await startupSample(extensionCount)),
      extensionCount === 50 ? 30_000 : extensionCount === 10 ? 15_000 : 10_000,
    ));
  }
  scenarios.push(scenario(
    "refresh-large-package",
    "refresh",
    {
      extensionCount: 1,
      runtimeEntryCount: LARGE_PACKAGE_ENTRY_COUNT,
      commandCount: LARGE_PACKAGE_ENTRY_COUNT * COMMANDS_PER_LARGE_ENTRY,
    },
    await measure(samples, refreshSample),
    30_000,
  ));
  const coldPage20k = await measure(samples, async () => await coldEventPageSample(20_000));
  scenarios.push(scenario(
    "cold-page-20000-linear-history",
    "event-page",
    { eventCount: 20_000, pageLimit: 1, cold: true, materializedRowBudget: 16 },
    coldPage20k.map((sample) => sample.elapsedMs),
    2_000,
    coldPage20k.map((sample) => sample.materializedRows),
  ));
  const coldPage16k = await measure(samples, async () => await coldEventPageSample(16_002));
  scenarios.push(scenario(
    "cold-page-16002-linear-history",
    "event-page",
    { eventCount: 16_002, pageLimit: 1, cold: true, materializedRowBudget: 16 },
    coldPage16k.map((sample) => sample.elapsedMs),
    2_000,
    coldPage16k.map((sample) => sample.materializedRows),
  ));
  const coldPage10k = await measure(samples, async () => await coldEventPageSample(10_000));
  scenarios.push(scenario(
    "cold-page-10000-linear-history",
    "event-page",
    {
      eventCount: 10_000,
      pageLimit: 1,
      cold: true,
      materializedRowBudget: 16,
    },
    coldPage10k.map((sample) => sample.elapsedMs),
    2_000,
    coldPage10k.map((sample) => sample.materializedRows),
  ));
  for (const eventCount of [100, 10_000] as const) {
    const replayPageLimit = eventCount === 10_000 ? 1 : 16;
    const replayCeilingMs = eventCount === 10_000 ? 20_000 : 10_000;
    scenarios.push(scenario(
      `resume-${eventCount}-events`,
      "resume",
      { eventCount },
      await measure(samples, async () => await resumeSample(eventCount)),
      eventCount === 10_000 ? 20_000 : 10_000,
    ));
    scenarios.push(scenario(
      `rpc-replay-${eventCount}-events`,
      "rpc-replay",
      { eventCount, pageLimit: replayPageLimit },
      await measure(samples, async () => await rpcReplaySample(eventCount, replayPageLimit, replayCeilingMs)),
      replayCeilingMs,
    ));
  }
  return {
    schemaVersion: 1,
    suite: "runtime-performance-v1",
    purpose: "runtime-regression-guard",
    deterministicFixtures: true,
    samplesPerScenario: samples,
    environment: { platform: process.platform, architecture: process.arch, node: process.version },
    scenarios,
    summary: { scenarios: scenarios.length, passed: scenarios.filter((entry) => entry.passed).length },
  };
}

async function main(): Promise<void> {
  const configured = process.env.OHM_BENCHMARK_SAMPLES;
  const options: RuntimePerformanceOptions = {};
  if (configured !== undefined) options.samples = Number(configured);
  const report = await runRuntimePerformanceBenchmark(options);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.summary.passed !== report.summary.scenarios) process.exitCode = 1;
}

const invoked = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invoked === import.meta.url) await main();
