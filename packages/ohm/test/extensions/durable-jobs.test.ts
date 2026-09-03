import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { getEventListeners } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Check } from "typebox/value";

import { isJsonObject, isJsonValue, type JsonObject, type JsonValue } from "../../src/core/json.js";
import { FUNCTION_VALUE, NUMBER_VALUE, STRING_VALUE } from "../../src/core/value-schemas.js";
import {
  DurableJobSupervisor,
  type ExtensionJobContext,
} from "../../src/extensions/durable-jobs.js";
import type { ExtensionAPI } from "../../src/extensions/direct.js";
import { loadDirectExtensions } from "../../src/extensions/runtime.js";
import type { RpcClientOptions } from "../../src/interfaces/rpc-client.js";
import type { RpcSessionState } from "../../src/interfaces/rpc-protocol.js";

interface MutableStoredHostFixture extends JsonObject {
  pid: number;
  token: string;
}

interface MutableStoredJobFixture extends JsonObject {
  id: string;
  state: string;
  updatedAt: number;
  label?: string;
  error?: string;
  host?: MutableStoredHostFixture;
}

interface MutableStoredPayloadFixture extends JsonObject {
  version: 1;
  jobs: MutableStoredJobFixture[];
}

interface MutableStoredEnvelopeFixture extends JsonObject {
  checksum: string;
  payload: MutableStoredPayloadFixture;
}

function isStoredHostFixture(value: JsonValue | undefined): value is MutableStoredHostFixture | undefined {
  return value === undefined
    || (isJsonObject(value) && Check(NUMBER_VALUE, value.pid) && Check(STRING_VALUE, value.token));
}

function isStoredJobFixture(value: JsonValue): value is MutableStoredJobFixture {
  return isJsonObject(value)
    && Check(STRING_VALUE, value.id)
    && Check(STRING_VALUE, value.state)
    && Check(NUMBER_VALUE, value.updatedAt)
    && (value.label === undefined || Check(STRING_VALUE, value.label))
    && (value.error === undefined || Check(STRING_VALUE, value.error))
    && isStoredHostFixture(value.host);
}

function isStoredEnvelopeFixture(value: JsonValue): value is MutableStoredEnvelopeFixture {
  if (!isJsonObject(value) || !Check(STRING_VALUE, value.checksum) || !isJsonObject(value.payload)) return false;
  return value.payload.version === 1
    && Array.isArray(value.payload.jobs)
    && value.payload.jobs.every(isStoredJobFixture);
}

function parseStoredEnvelopeFixture(serialized: string): MutableStoredEnvelopeFixture {
  const parsed: unknown = JSON.parse(serialized);
  if (!isJsonValue(parsed) || !isStoredEnvelopeFixture(parsed)) {
    throw new Error("Test durable store has an unexpected shape");
  }
  return parsed;
}

function parseSessionIdFixture(serialized: string): string {
  const parsed: unknown = JSON.parse(serialized);
  if (!isJsonObject(parsed) || !Check(STRING_VALUE, parsed.sessionId)) {
    throw new Error("Test child session header has no session id");
  }
  return parsed.sessionId;
}

async function temporaryOwner(context: test.TestContext, id = "fixture-extension") {
  const base = await mkdtemp(join(tmpdir(), "ohm-durable-jobs-"));
  const workspace = join(base, "workspace");
  const root = join(base, "state");
  await mkdir(workspace, { recursive: true });
  await mkdir(root, { recursive: true, mode: 0o700 });
  context.after(async () => await rm(base, { recursive: true, force: true }));
  const lifecycle = new AbortController();
  let active = true;
  let committed = true;
  return {
    base,
    root,
    workspace,
    lifecycle,
    owner: {
      key: {},
      id,
      root,
      workspace,
      projectTrusted: () => true,
      signal: lifecycle.signal,
      isActive: () => active,
      isCommitted: () => committed,
    },
    deactivate() { active = false; lifecycle.abort(new Error("test generation stopped")); },
    setCommitted(value: boolean) { committed = value; },
  };
}

function storedOwner(id: string): string {
  return createHash("sha256").update(id, "utf8").digest("hex");
}

function untilAborted(context: ExtensionJobContext): Promise<JsonValue | undefined> {
  return new Promise((_resolve, reject) => {
    const stop = (): void => reject(context.signal.reason ?? new DOMException("Aborted", "AbortError"));
    context.signal.addEventListener("abort", stop, { once: true });
  });
}

async function eventually<Value>(operation: () => Promise<Value>, accepts: (value: Value) => boolean): Promise<Value> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    const value = await operation();
    if (accepts(value)) return value;
    if (Date.now() >= deadline) throw new Error("Timed out waiting for durable state");
    await new Promise<void>((resolveValue) => setTimeout(resolveValue, 20));
  }
}

test("durable jobs enforce ownership, idempotence, cancellation, and explicit resume", async (context) => {
  const first = await temporaryOwner(context);
  const supervisor = new DurableJobSupervisor();
  context.after(async () => await supervisor.close());
  const jobs = supervisor.jobs(first.owner);
  let invocations = 0;

  const started = await jobs.start({
    kind: "fixture.work",
    idempotencyKey: "stable-work",
    metadata: { phase: "initial" },
  }, async (job) => {
    invocations += 1;
    await job.replaceMetadata({ phase: "running", attempt: job.attempt });
    return await untilAborted(job);
  });
  assert.equal(started.state, "running");
  assert.equal(invocations, 1);

  const duplicate = await jobs.start({
    kind: "fixture.work",
    idempotencyKey: "stable-work",
    metadata: { ignored: true },
  }, () => {
    invocations += 1;
    return { duplicate: true };
  });
  assert.equal(duplicate.id, started.id);
  assert.equal(invocations, 1);
  assert.deepEqual((await jobs.inspect(started.id)).metadata, { phase: "running", attempt: 1 });

  const otherJobs = supervisor.jobs({ ...first.owner, key: {}, id: "other-extension" });
  await assert.rejects(otherJobs.inspect(started.id), /Unknown durable job/u);

  const cancelled = await jobs.cancel(started.id);
  assert.equal(cancelled.state, "cancelled");
  assert.equal((await jobs.cancel(started.id)).state, "cancelled");
  assert.equal((await jobs.wait(started.id)).state, "cancelled");
  await assert.rejects(jobs.resume(started.id, () => ({ resumed: true })), /not interrupted/u);

  const failed = await jobs.start({ kind: "fixture.failure" }, () => {
    throw new Error("expected failure");
  });
  assert.equal((await jobs.wait(failed.id)).state, "failed");

  const metadataAdded = await jobs.start({ kind: "fixture.metadata" }, async (job) => {
    await job.replaceMetadata({ added: true });
    return undefined;
  });
  assert.deepEqual((await jobs.wait(metadataAdded.id)).metadata, { added: true });

  const timedOut = await jobs.start({ kind: "fixture.timeout", timeoutMs: 10 }, untilAborted);
  assert.equal((await jobs.wait(timedOut.id)).state, "timed_out");
  assert.deepEqual((await jobs.list({ state: "timed_out" })).map((job) => job.id), [timedOut.id]);
});

test("durable owner identities are stable and bounded independently of host labels", async (context) => {
  const fixture = await temporaryOwner(context, `long-extension-${"x".repeat(512)}`);
  const supervisor = new DurableJobSupervisor();
  context.after(async () => await supervisor.close());
  const jobs = supervisor.jobs(fixture.owner);
  const started = await jobs.start({ kind: "fixture.long-owner" }, () => ({ complete: true }));
  assert.equal((await jobs.wait(started.id)).state, "succeeded");

  const replacement = supervisor.jobs({ ...fixture.owner, key: {} });
  assert.equal((await replacement.inspect(started.id)).state, "succeeded");
  await assert.rejects(
    supervisor.jobs({ ...fixture.owner, key: {}, id: `${fixture.owner.id}-different` }).inspect(started.id),
    /Unknown durable job/u,
  );
});

test("durable JSON snapshots reject active objects without invoking extension code", async (context) => {
  const fixture = await temporaryOwner(context);
  const supervisor = new DurableJobSupervisor();
  context.after(async () => await supervisor.close());
  const jobs = supervisor.jobs(fixture.owner);
  let getterCalls = 0;
  const accessor: JsonObject = {};
  Object.defineProperty(accessor, "value", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "unsafe";
    },
  });
  await assert.rejects(
    jobs.start({ kind: "fixture.accessor", metadata: accessor }, () => undefined),
    /enumerable data properties/u,
  );
  assert.equal(getterCalls, 0);

  let toJsonCalls = 0;
  const activeSerializer: JsonObject = { value: "safe" };
  Object.defineProperty(activeSerializer, "toJSON", {
    enumerable: true,
    value() {
      toJsonCalls += 1;
      return { replaced: true };
    },
  });
  await assert.rejects(
    jobs.start({ kind: "fixture.to-json", metadata: activeSerializer }, () => undefined),
    /only JSON values/u,
  );
  assert.equal(toJsonCalls, 0);

  let proxyReads = 0;
  const proxy = new Proxy<JsonObject>({}, {
    get() {
      proxyReads += 1;
      return undefined;
    },
  });
  await assert.rejects(
    jobs.start({ kind: "fixture.proxy", metadata: proxy }, () => undefined),
    /must not contain proxies/u,
  );
  assert.equal(proxyReads, 0);
});

test("a new host recovers a stale running job as interrupted and can resume it once", async (context) => {
  const fixture = await temporaryOwner(context);
  const id = randomUUID();
  const now = Date.now();
  const payload = {
    version: 1 as const,
    jobs: [{
      id,
      owner: storedOwner(fixture.owner.id),
      kind: "fixture.restart",
      state: "running",
      createdAt: now,
      updatedAt: now,
      attempt: 1,
      timeoutMs: 60_000,
      idempotencyKey: "restart",
      host: { pid: process.pid, token: randomUUID() },
    }],
  };
  const checksum = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  await writeFile(join(fixture.root, "durable-jobs-v1.json"), `${JSON.stringify({ checksum, payload })}\n`, { mode: 0o600 });

  const replacementLifecycle = new AbortController();
  const replacementOwner = {
    ...fixture.owner,
    key: {},
    signal: replacementLifecycle.signal,
  };
  const replacementSupervisor = new DurableJobSupervisor();
  context.after(async () => {
    replacementLifecycle.abort();
    await replacementSupervisor.close();
  });
  const replacementJobs = replacementSupervisor.jobs(replacementOwner);
  const recovered = await replacementJobs.inspect(id);
  assert.equal(recovered.state, "interrupted");
  assert.match(recovered.error ?? "", /Previous host stopped/u);

  const resumed = await replacementJobs.resume(id, () => ({ recovered: true }));
  assert.equal(resumed.attempt, 2);
  const completed = await replacementJobs.wait(id);
  assert.equal(completed.state, "succeeded");
  assert.deepEqual(completed.result, { recovered: true });
  const duplicate = await replacementJobs.start(
    { kind: "fixture.restart", idempotencyKey: "restart" },
    () => ({ mustNotRun: true }),
  );
  assert.equal(duplicate.id, id);
  assert.equal(duplicate.attempt, 2);
});

test("concurrent hosts preserve another live host's ownership", async (context) => {
  const fixture = await temporaryOwner(context);
  const firstSupervisor = new DurableJobSupervisor();
  const secondSupervisor = new DurableJobSupervisor();
  context.after(async () => await Promise.allSettled([firstSupervisor.close(), secondSupervisor.close()]));
  const first = firstSupervisor.jobs(fixture.owner);
  const second = secondSupervisor.jobs({ ...fixture.owner, key: {} });
  const started = await first.start({ kind: "fixture.concurrent" }, untilAborted);

  assert.equal((await second.inspect(started.id)).state, "running");
  await assert.rejects(second.cancel(started.id), /another live host/u);
  assert.equal((await first.inspect(started.id)).state, "running");
  assert.equal((await first.cancel(started.id)).state, "cancelled");
  assert.equal((await second.inspect(started.id)).state, "cancelled");
});

test("resuming interrupted jobs preserves the atomic active-job ceiling", async (context) => {
  const fixture = await temporaryOwner(context);
  const now = Date.now();
  const ids = Array.from({ length: 9 }, () => randomUUID());
  const payload = {
    version: 1 as const,
    jobs: ids.map((id) => ({
      id,
      owner: storedOwner(fixture.owner.id),
      kind: "fixture.resume-cap",
      state: "interrupted",
      createdAt: now,
      updatedAt: now,
      attempt: 1,
      timeoutMs: 60_000,
    })),
  };
  const checksum = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  await writeFile(
    join(fixture.root, "durable-jobs-v1.json"),
    `${JSON.stringify({ checksum, payload })}\n`,
    { mode: 0o600 },
  );

  const supervisor = new DurableJobSupervisor();
  try {
    const jobs = supervisor.jobs(fixture.owner);
    for (const id of ids.slice(0, 8)) {
      assert.equal((await jobs.resume(id, untilAborted)).state, "running");
    }
    await assert.rejects(jobs.resume(ids[8]!, untilAborted), /cannot exceed 8 active durable jobs/u);
    assert.equal((await jobs.inspect(ids[8]!)).state, "interrupted");
  } finally {
    await supervisor.close();
  }
});

test("active job waits remove abort listeners after completion", async (context) => {
  const fixture = await temporaryOwner(context);
  const supervisor = new DurableJobSupervisor();
  context.after(async () => await supervisor.close());
  const jobs = supervisor.jobs(fixture.owner);
  let finish: (value: JsonValue) => void = () => undefined;
  const operation = new Promise<JsonValue>((resolveValue) => { finish = resolveValue; });
  const started = await jobs.start({ kind: "fixture.wait-listeners" }, async () => await operation);
  const cancellation = new AbortController();
  const waits = Array.from({ length: 8 }, async () => await jobs.wait(started.id, { signal: cancellation.signal }));
  finish({ complete: true });
  assert.ok((await Promise.all(waits)).every((status) => status.state === "succeeded"));
  assert.equal(getEventListeners(cancellation.signal, "abort").length, 0);
});

test("clean shutdown cancels its completed drain timer", async (context) => {
  const fixture = await temporaryOwner(context);
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const drainTimers = new Set<Parameters<typeof clearTimeout>[0]>();
  context.mock.method(globalThis, "setTimeout", (
    callback: (...argumentsValue: unknown[]) => void,
    milliseconds?: number,
    ...argumentsValue: unknown[]
  ) => {
    const timer = originalSetTimeout(callback, milliseconds, ...argumentsValue);
    if (milliseconds === 2_500) drainTimers.add(timer);
    return timer;
  });
  context.mock.method(globalThis, "clearTimeout", (timer: Parameters<typeof clearTimeout>[0]) => {
    if (timer !== undefined) drainTimers.delete(timer);
    originalClearTimeout(timer);
  });

  const supervisor = new DurableJobSupervisor();
  const jobs = supervisor.jobs(fixture.owner);
  await jobs.start({ kind: "fixture.close-drain" }, untilAborted);
  await supervisor.close();
  assert.equal(drainTimers.size, 0);
});

test("atomic job storage ignores abandoned temp files and rejects corrupt committed state", async (context) => {
  const fixture = await temporaryOwner(context);
  const supervisor = new DurableJobSupervisor();
  const jobs = supervisor.jobs(fixture.owner);
  const completed = await jobs.start({ kind: "fixture.storage" }, () => ({ ok: true }));
  await jobs.wait(completed.id);
  await supervisor.close();

  await writeFile(join(fixture.root, ".durable-jobs-v1.json.abandoned.tmp"), "{torn", { mode: 0o600 });
  const healthy = new DurableJobSupervisor();
  assert.equal((await healthy.jobs({ ...fixture.owner, key: {} }).list()).length, 1);
  await healthy.close();

  const storePath = join(fixture.root, "durable-jobs-v1.json");
  const envelope = parseStoredEnvelopeFixture(await readFile(storePath, "utf8"));
  envelope.payload.jobs[0]!.label = "tampered";
  await writeFile(storePath, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
  const corrupt = new DurableJobSupervisor();
  context.after(async () => await corrupt.close());
  await assert.rejects(
    corrupt.jobs({ ...fixture.owner, key: {} }).list(),
    /checksum does not match/u,
  );
});

test("a failed terminal write is recovered as interrupted instead of remaining live forever", async (context) => {
  const fixture = await temporaryOwner(context);
  const diagnostics: string[] = [];
  const supervisor = new DurableJobSupervisor();
  context.after(async () => await supervisor.close());
  const jobs = supervisor.jobs({
    ...fixture.owner,
    diagnostic(message: string) { diagnostics.push(message); },
  });
  let finish: () => void = () => undefined;
  const operation = new Promise<void>((resolveValue) => { finish = resolveValue; });
  const started = await jobs.start({ kind: "fixture.settlement-write" }, async () => {
    await operation;
    return { complete: true };
  });
  const storePath = join(fixture.root, "durable-jobs-v1.json");
  const validStore = await readFile(storePath);
  await writeFile(storePath, "{corrupt\n", { mode: 0o600 });
  finish();
  await eventually(async () => diagnostics.length, (length) => length > 0);
  await writeFile(storePath, validStore, { mode: 0o600 });

  const recovered = await jobs.wait(started.id);
  assert.equal(recovered.state, "interrupted");
  assert.match(recovered.error ?? "", /could not persist the job's terminal state/u);
  assert.match(diagnostics[0] ?? "", /settlement failed/u);
});

test("aggregate storage pruning preserves the job being settled and evicts old interrupted work", async (context) => {
  const completedFixture = await temporaryOwner(context);
  const large = "x".repeat(63 * 1024);
  const completedSupervisor = new DurableJobSupervisor();
  const completedJobs = completedSupervisor.jobs(completedFixture.owner);
  const completedIds: string[] = [];
  for (let index = 0; index < 9; index += 1) {
    const started = await completedJobs.start({ kind: "fixture.saturation", metadata: { large, index } }, () => ({ large, index }));
    const settled = await completedJobs.wait(started.id);
    assert.equal(settled.state, "succeeded");
    completedIds.push(started.id);
  }
  const retained = await completedJobs.list();
  assert.ok(retained.length < completedIds.length);
  assert.ok(retained.some((job) => job.id === completedIds.at(-1)));
  assert.ok((await stat(join(completedFixture.root, "durable-jobs-v1.json"))).size <= 1024 * 1024);
  await completedSupervisor.close();

  const interruptedFixture = await temporaryOwner(context);
  const interruptedIds: string[] = [];
  for (const count of [8, 8, 1]) {
    const supervisor = new DurableJobSupervisor();
    const jobs = supervisor.jobs({ ...interruptedFixture.owner, key: {} });
    for (let index = 0; index < count; index += 1) {
      const started = await jobs.start({ kind: "fixture.interrupted", metadata: { large } }, untilAborted);
      interruptedIds.push(started.id);
    }
    await supervisor.close();
  }
  const reader = new DurableJobSupervisor();
  context.after(async () => await reader.close());
  const interrupted = await reader.jobs({ ...interruptedFixture.owner, key: {} }).list();
  assert.ok(interrupted.length < interruptedIds.length);
  assert.ok(interrupted.every((job) => job.state === "interrupted"));
  await assert.rejects(
    reader.jobs({ ...interruptedFixture.owner, key: {} }).inspect(interruptedIds[0]!),
    /Unknown durable job/u,
  );
});

test("shutdown reports durable interruption write failures", async (context) => {
  const fixture = await temporaryOwner(context);
  const supervisor = new DurableJobSupervisor();
  const jobs = supervisor.jobs(fixture.owner);
  await jobs.start({ kind: "fixture.close-failure" }, untilAborted);
  await writeFile(join(fixture.root, "durable-jobs-v1.json"), "{corrupt\n", { mode: 0o600 });
  await assert.rejects(
    supervisor.close(),
    /could not persist every interruption/u,
  );
});

class FakeRpcClient {
  started = false;
  readonly calls: string[] = [];
  readonly #options: RpcClientOptions;
  #sessionId = "";
  #sessionFile = "";

  constructor(options: RpcClientOptions) {
    this.#options = options;
  }

  async start(): Promise<void> {
    const args = this.#options.args ?? [];
    assert.equal(this.#options.cliPath, undefined);
    assert.equal(this.#options.env, undefined);
    assert.ok(args.includes("--no-extensions"));
    const directoryIndex = args.indexOf("--session-dir");
    assert.ok(directoryIndex >= 0);
    const directory = args[directoryIndex + 1]!;
    const sessionIndex = args.indexOf("--session");
    if (sessionIndex >= 0) {
      this.#sessionFile = args[sessionIndex + 1]!;
      this.#sessionId = parseSessionIdFixture((await readFile(this.#sessionFile, "utf8")).split("\n")[0]!);
    } else {
      this.#sessionId = randomUUID();
      this.#sessionFile = join(directory, `fixture_${this.#sessionId}.jsonl`);
      await writeFile(this.#sessionFile, `${JSON.stringify({
        record: "session",
        version: 4,
        sessionId: this.#sessionId,
        createdAt: new Date().toISOString(),
        workspace: this.#options.cwd,
        cwd: this.#options.cwd,
      })}\n`, { mode: 0o600 });
    }
    this.started = true;
  }

  async stop(): Promise<void> { this.started = false; }
  async prompt(message: string): Promise<void> { this.calls.push(`prompt:${message}`); }
  async steer(message: string): Promise<void> { this.calls.push(`steer:${message}`); }
  async followUp(message: string): Promise<void> { this.calls.push(`follow:${message}`); }
  async abort(): Promise<void> { this.calls.push("abort"); }
  crash(): void { this.started = false; }
  async getState(): Promise<RpcSessionState> {
    return {
      isStreaming: false,
      isCompacting: false,
      pendingMessageCount: 0,
      steeringMode: "all",
      followUpMode: "all",
      sessionId: this.#sessionId,
      thinkingLevel: "off",
      sessionFile: this.#sessionFile,
      autoCompactionEnabled: true,
      messageCount: 0,
    };
  }
}

class GatedStartRpcClient extends FakeRpcClient {
  readonly #gate: Promise<void>;
  readonly #entered: () => void;

  constructor(options: RpcClientOptions, gate: Promise<void>, entered: () => void) {
    super(options);
    this.#gate = gate;
    this.#entered = entered;
  }

  override async start(): Promise<void> {
    this.#entered();
    await this.#gate;
    await super.start();
  }
}

class GatedAbortRpcClient extends FakeRpcClient {
  readonly #gate: Promise<void>;
  readonly #entered: () => void;
  abortFinished = false;
  stopBeforeAbort = false;

  constructor(options: RpcClientOptions, gate: Promise<void>, entered: () => void) {
    super(options);
    this.#gate = gate;
    this.#entered = entered;
  }

  override async abort(): Promise<void> {
    this.calls.push("abort");
    this.#entered();
    await this.#gate;
    this.abortFinished = true;
  }

  override async stop(): Promise<void> {
    if (!this.abortFinished) this.stopBeforeAbort = true;
    this.calls.push("stop");
    await super.stop();
  }
}

function failingRpcClient(message: string) {
  return {
    started: false,
    async start(): Promise<void> { throw new Error(message); },
    async stop(): Promise<void> {},
    async prompt(): Promise<void> {},
    async steer(): Promise<void> {},
    async followUp(): Promise<void> {},
    async abort(): Promise<void> {},
    async getState(): Promise<RpcSessionState> { throw new Error("RPC client did not start"); },
  };
}

test("child startup failures reject cleanly without an unhandled readiness promise", async (context) => {
  const fixture = await temporaryOwner(context);
  const supervisor = new DurableJobSupervisor({
    rpcClientFactory: () => failingRpcClient("expected startup failure"),
  });
  context.after(async () => await supervisor.close());
  const sessions = supervisor.childSessions(fixture.owner);

  await assert.rejects(sessions.spawn({ idempotencyKey: "startup-failure" }), /expected startup failure/u);
  const failed = await eventually(
    async () => (await sessions.list())[0],
    (status) => status?.state === "failed",
  );
  assert.equal(failed?.state, "failed");
  assert.match(failed?.error ?? "", /expected startup failure/u);
});

test("child session setup rejects a pre-existing directory symlink before chmod", {
  skip: process.platform === "win32",
}, async (context) => {
  const fixture = await temporaryOwner(context);
  const outside = join(fixture.base, "outside-child-sessions");
  await mkdir(outside);
  await chmod(outside, 0o755);
  const mode = (await stat(outside)).mode & 0o777;
  await symlink(outside, join(fixture.root, "child-sessions"), "dir");
  const supervisor = new DurableJobSupervisor();
  context.after(async () => await supervisor.close());

  await assert.rejects(
    supervisor.childSessions(fixture.owner).spawn(),
    /symbolic or non-canonical/u,
  );
  assert.equal((await stat(outside)).mode & 0o777, mode);
});

test("duplicate child spawns wait for the canonical V4 session identity", async (context) => {
  const fixture = await temporaryOwner(context);
  let releaseStart: () => void = () => undefined;
  let startEntered: () => void = () => undefined;
  const gate = new Promise<void>((resolveValue) => { releaseStart = resolveValue; });
  const entered = new Promise<void>((resolveValue) => { startEntered = resolveValue; });
  const supervisor = new DurableJobSupervisor({
    rpcClientFactory: (options) => new GatedStartRpcClient(options, gate, startEntered),
  });
  context.after(async () => await supervisor.close());
  const sessions = supervisor.childSessions(fixture.owner);

  const firstSpawn = sessions.spawn({ idempotencyKey: "same-child" });
  await entered;
  const duplicateSpawn = sessions.spawn({ idempotencyKey: "same-child" });
  const earlyDuplicate = await Promise.race([
    duplicateSpawn.then(() => "settled" as const),
    new Promise<"pending">((resolveValue) => setTimeout(() => resolveValue("pending"), 50)),
  ]);
  assert.equal(earlyDuplicate, "pending");

  releaseStart();
  const [started, duplicate] = await Promise.all([firstSpawn, duplicateSpawn]);
  assert.equal(duplicate.id, started.id);
  assert.equal(duplicate.sessionId, started.sessionId);
  assert.equal(duplicate.sessionFile, started.sessionFile);
  assert.ok(duplicate.sessionId !== undefined);
  assert.ok(duplicate.sessionFile !== undefined);
  assert.equal((await sessions.cancel(started.id)).state, "cancelled");
});

test("child cancellation finishes its bounded RPC abort before stopping transport", async (context) => {
  const fixture = await temporaryOwner(context);
  let releaseAbort: () => void = () => undefined;
  let abortEntered: () => void = () => undefined;
  const gate = new Promise<void>((resolveValue) => { releaseAbort = resolveValue; });
  const entered = new Promise<void>((resolveValue) => { abortEntered = resolveValue; });
  let client: GatedAbortRpcClient | undefined;
  const supervisor = new DurableJobSupervisor({
    rpcClientFactory(options) {
      client = new GatedAbortRpcClient(options, gate, abortEntered);
      return client;
    },
  });
  context.after(async () => await supervisor.close());
  const sessions = supervisor.childSessions(fixture.owner);
  const started = await sessions.spawn();

  const cancellation = sessions.cancel(started.id);
  await entered;
  await new Promise<void>((resolveValue) => setImmediate(resolveValue));
  assert.equal(client?.stopBeforeAbort, false);
  assert.equal(client?.started, true);
  releaseAbort();
  assert.equal((await cancellation).state, "cancelled");
  await eventually(async () => client?.started, (running) => running === false);
  assert.equal(client?.stopBeforeAbort, false);
  assert.deepEqual(client?.calls.slice(-2), ["abort", "stop"]);
});

test("child cancellation rejects generic jobs without mutation while generic cancellation supports children", async (context) => {
  const fixture = await temporaryOwner(context);
  const supervisor = new DurableJobSupervisor({
    rpcClientFactory: (options) => new FakeRpcClient(options),
  });
  context.after(async () => await supervisor.close());
  const jobs = supervisor.jobs(fixture.owner);
  const sessions = supervisor.childSessions(fixture.owner);
  const generic = await jobs.start({ kind: "fixture.generic" }, untilAborted);

  await assert.rejects(sessions.cancel(generic.id), /not a child session/u);
  assert.equal((await jobs.inspect(generic.id)).state, "running");
  assert.equal((await jobs.cancel(generic.id)).state, "cancelled");

  const child = await sessions.spawn();
  const cancelled = await jobs.cancel(child.id);
  assert.equal(cancelled.kind, "ohm.child-session");
  assert.equal(cancelled.state, "cancelled");
  assert.equal((await sessions.inspect(child.id)).state, "cancelled");
});

test("child sessions use host-owned V4 journals and reattach through a new RPC transport", async (context) => {
  const fixture = await temporaryOwner(context);
  const clients: FakeRpcClient[] = [];
  const factory = (options: RpcClientOptions): FakeRpcClient => {
    const client = new FakeRpcClient(options);
    clients.push(client);
    return client;
  };
  const firstSupervisor = new DurableJobSupervisor({ rpcClientFactory: factory });
  const first = firstSupervisor.childSessions(fixture.owner);
  const outside = join(fixture.base, "outside");
  await mkdir(outside);
  await assert.rejects(first.spawn({ cwd: outside }), /inside the host workspace/u);
  await assert.rejects(first.spawn({ tools: ["read,--session-dir,/tmp/escape"] }), /cannot contain commas/u);
  const started = await first.spawn({ idempotencyKey: "child", label: "review" });
  assert.equal(started.state, "running");
  assert.ok(started.sessionId !== undefined);
  assert.ok(started.sessionFile?.startsWith(fixture.root));
  await first.prompt(started.id, "begin");
  await first.steer(started.id, "check tests");
  await first.followUp(started.id, "summarize");
  assert.deepEqual(clients[0]?.calls, ["prompt:begin", "steer:check tests", "follow:summarize"]);
  assert.equal((await first.state(started.id)).sessionId, started.sessionId);
  assert.deepEqual((await first.list()).map((session) => session.id), [started.id]);
  await firstSupervisor.close();

  const nextLifecycle = new AbortController();
  const nextOwner = { ...fixture.owner, key: {}, signal: nextLifecycle.signal };
  const nextSupervisor = new DurableJobSupervisor({ rpcClientFactory: factory });
  context.after(async () => {
    nextLifecycle.abort();
    await nextSupervisor.close();
  });
  const next = nextSupervisor.childSessions(nextOwner);
  assert.equal((await next.inspect(started.id)).state, "interrupted");
  await assert.rejects(
    nextSupervisor.jobs(nextOwner).resume(started.id, () => ({ bypassed: true })),
    /host-reserved kind/u,
  );
  assert.equal((await next.inspect(started.id)).state, "interrupted");
  const reattached = await next.reattach(started.id);
  assert.equal(reattached.state, "running");
  assert.equal(reattached.attempt, 2);
  assert.equal(reattached.sessionId, started.sessionId);
  assert.equal(clients.length, 2);
  assert.ok(clients[1] !== undefined);
  await next.followUp(started.id, "second turn");
  assert.deepEqual(clients[1]?.calls, ["follow:second turn"]);
  assert.equal((await next.cancel(started.id)).state, "cancelled");
});

test("an unexpected child transport exit is interrupted and reattachable", async (context) => {
  const fixture = await temporaryOwner(context);
  const clients: FakeRpcClient[] = [];
  const supervisor = new DurableJobSupervisor({
    rpcClientFactory(options) {
      const client = new FakeRpcClient(options);
      clients.push(client);
      return client;
    },
  });
  context.after(async () => await supervisor.close());
  const sessions = supervisor.childSessions(fixture.owner);
  const started = await sessions.spawn();
  clients[0]!.crash();

  const interrupted = await eventually(
    async () => await sessions.inspect(started.id),
    (status) => status.state === "interrupted",
  );
  assert.equal(interrupted.sessionId, started.sessionId);
  assert.match(interrupted.error ?? "", /transport exited unexpectedly/u);

  const reattached = await sessions.reattach(started.id);
  assert.equal(reattached.state, "running");
  assert.equal(reattached.attempt, 2);
  assert.equal(reattached.sessionId, started.sessionId);
  assert.equal((await sessions.cancel(started.id)).state, "cancelled");
});

test("a transient reattach startup failure remains interrupted and can be retried", async (context) => {
  const fixture = await temporaryOwner(context);
  const originalSupervisor = new DurableJobSupervisor({
    rpcClientFactory: (options) => new FakeRpcClient(options),
  });
  const started = await originalSupervisor.childSessions(fixture.owner).spawn();
  await originalSupervisor.close();

  let attempts = 0;
  const replacementSupervisor = new DurableJobSupervisor({
    rpcClientFactory(options) {
      attempts += 1;
      return attempts === 1
        ? failingRpcClient("transient reattach failure")
        : new FakeRpcClient(options);
    },
  });
  context.after(async () => await replacementSupervisor.close());
  const replacementOwner = { ...fixture.owner, key: {} };
  const sessions = replacementSupervisor.childSessions(replacementOwner);

  await assert.rejects(sessions.reattach(started.id), /transient reattach failure/u);
  const interrupted = await eventually(
    async () => await sessions.inspect(started.id),
    (status) => status.state === "interrupted",
  );
  assert.equal(interrupted.attempt, 2);
  assert.match(interrupted.error ?? "", /reattachment failed/u);

  const reattached = await sessions.reattach(started.id);
  assert.equal(reattached.state, "running");
  assert.equal(reattached.attempt, 3);
  assert.equal(reattached.sessionId, started.sessionId);
  assert.equal((await sessions.cancel(started.id)).state, "cancelled");
});

test("a failed factory cannot recover or mutate the durable store before commit", async (context) => {
  const base = await mkdtemp(join(tmpdir(), "ohm-durable-rollback-"));
  const workspace = join(base, "workspace");
  const dataRoot = join(base, "extension-data");
  await mkdir(workspace);
  context.after(async () => await rm(base, { recursive: true, force: true }));
  let seedApi: ExtensionAPI | undefined;
  const seedHost = await loadDirectExtensions([], {
    workspace,
    dataRoot,
    activationFailure: "throw",
    inlineExtensions: [{ name: "durable-rollback", factory(api) { seedApi = api; } }],
  });
  assert.ok(seedApi !== undefined);
  const started = await seedApi.jobs.start({ kind: "fixture.rollback" }, untilAborted);
  const dataPaths = seedHost.extensionDataPaths("<inline:durable-rollback>");
  assert.ok(dataPaths !== undefined);
  await seedHost.close();

  const storePath = join(dataPaths.workspace, "durable-jobs-v1.json");
  const envelope = parseStoredEnvelopeFixture(await readFile(storePath, "utf8"));
  const stored = envelope.payload.jobs.find((job) => job.id === started.id);
  assert.ok(stored !== undefined);
  stored.state = "running";
  stored.updatedAt = Date.now();
  delete stored.error;
  stored.host = { pid: process.pid, token: randomUUID() };
  envelope.checksum = createHash("sha256").update(JSON.stringify(envelope.payload)).digest("hex");
  const before = `${JSON.stringify(envelope, null, 2)}\n`;
  await writeFile(storePath, before, { mode: 0o600 });

  let inspectionError = "";
  const failedHost = await loadDirectExtensions([], {
    workspace,
    dataRoot,
    activationFailure: "diagnostic",
    inlineExtensions: [{
      name: "durable-rollback",
      async factory(api) {
        try {
          await api.jobs.inspect(started.id);
        } catch (cause) {
          inspectionError = cause instanceof Error ? cause.message : String(cause);
        }
        throw new Error("expected factory rollback");
      },
    }],
  });
  await failedHost.close();

  assert.match(inspectionError, /before activation commits/u);
  assert.equal(await readFile(storePath, "utf8"), before);
});

test("every committed ExtensionAPI generation receives the durable host services", async (context) => {
  const base = await mkdtemp(join(tmpdir(), "ohm-durable-api-"));
  const workspace = join(base, "workspace");
  const dataRoot = join(base, "extension-data");
  await mkdir(workspace);
  context.after(async () => await rm(base, { recursive: true, force: true }));
  let firstApi: ExtensionAPI | undefined;
  let precommit: Promise<unknown> | undefined;
  const firstHost = await loadDirectExtensions([], {
    workspace,
    dataRoot,
    activationFailure: "throw",
    inlineExtensions: [{
      name: "durable-api",
      factory(api) {
        firstApi = api;
        precommit = api.jobs.start({ kind: "fixture.precommit" }, () => undefined);
        void precommit.catch(() => undefined);
      },
    }],
  });
  assert.ok(firstApi !== undefined);
  assert.ok(precommit !== undefined);
  await assert.rejects(precommit, /before activation commits/u);
  const running = await firstApi.jobs.start({ kind: "fixture.integration" }, untilAborted);
  assert.equal(running.state, "running");
  assert.equal(Check(FUNCTION_VALUE, firstApi.childSessions.spawn), true);
  await firstHost.close();

  let secondApi: ExtensionAPI | undefined;
  const secondHost = await loadDirectExtensions([], {
    workspace,
    dataRoot,
    activationFailure: "throw",
    inlineExtensions: [{ name: "durable-api", factory(api) { secondApi = api; } }],
  });
  context.after(async () => await secondHost.close());
  assert.ok(secondApi !== undefined);
  const restored = await secondApi.jobs.inspect(running.id);
  assert.equal(restored.state, "interrupted");
});
