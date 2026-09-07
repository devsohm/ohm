import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { getEventListeners } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Check } from "typebox/value";

import { isJsonObject, isJsonValue, type JsonObject, type JsonValue } from "../../src/core/json.js";
import { NUMBER_VALUE, STRING_VALUE } from "../../src/core/value-schemas.js";
import {
  DurableJobSupervisor,
  type PluginJobContext,
} from "../../src/plugins/durable-jobs.js";
import type { PluginAPI } from "../../src/plugins/direct.js";
import { loadDirectPlugins } from "../../src/plugins/runtime.js";

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

async function temporaryOwner(context: test.TestContext, id = "fixture-extension") {
  const base = await mkdtemp(join(tmpdir(), "ohm-durable-jobs-"));
  const root = join(base, "state");
  await mkdir(root, { recursive: true, mode: 0o700 });
  context.after(async () => await rm(base, { recursive: true, force: true }));
  const lifecycle = new AbortController();
  let active = true;
  let committed = true;
  return {
    base,
    root,
    lifecycle,
    owner: {
      key: {},
      id,
      root,
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

function untilAborted(context: PluginJobContext): Promise<JsonValue | undefined> {
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

test("legacy host-reserved jobs remain inspectable and cancellable but cannot execute", async (context) => {
  const fixture = await temporaryOwner(context);
  const id = randomUUID();
  const now = Date.now();
  const metadata = { sessionId: "retained-session", sessionFile: "legacy.sqlite" };
  const payload = {
    version: 1,
    jobs: [{
      id, owner: storedOwner(fixture.owner.id), kind: "ohm.child-session",
      state: "interrupted", createdAt: now, updatedAt: now, attempt: 1,
      timeoutMs: 60_000, metadata,
    }],
  };
  const checksum = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  await writeFile(join(fixture.root, "durable-jobs-v1.json"), `${JSON.stringify({ checksum, payload })}\n`, { mode: 0o600 });
  const supervisor = new DurableJobSupervisor();
  context.after(async () => await supervisor.close());
  const jobs = supervisor.jobs(fixture.owner);
  const retained = await jobs.inspect(id);
  assert.deepEqual(retained.metadata, metadata);
  let invoked = false;
  await assert.rejects(jobs.resume(id, () => {
    invoked = true;
    return null;
  }), /legacy host-reserved/u);
  assert.equal(invoked, false);
  assert.deepEqual(await jobs.inspect(id), retained);
  assert.equal((await jobs.cancel(id)).state, "cancelled");
  const stored = parseStoredEnvelopeFixture(await readFile(join(fixture.root, "durable-jobs-v1.json"), "utf8"));
  assert.equal(stored.payload.jobs[0]?.id, id);
  assert.equal(stored.payload.jobs[0]?.state, "cancelled");
  assert.deepEqual(stored.payload.jobs[0]?.["metadata"], metadata);
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


test("a failed factory cannot recover or mutate the durable store before commit", async (context) => {
  const base = await mkdtemp(join(tmpdir(), "ohm-durable-rollback-"));
  const workspace = join(base, "workspace");
  const dataRoot = join(base, "extension-data");
  await mkdir(workspace);
  context.after(async () => await rm(base, { recursive: true, force: true }));
  let seedApi: PluginAPI | undefined;
  const seedHost = await loadDirectPlugins([], {
    workspace,
    dataRoot,
    activationFailure: "throw",
    inlinePlugins: [{ name: "durable-rollback", factory(api) { seedApi = api; } }],
  });
  assert.ok(seedApi !== undefined);
  const started = await seedApi.jobs.start({ kind: "fixture.rollback" }, untilAborted);
  const dataPaths = seedHost.pluginDataPaths("<inline:durable-rollback>");
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
  const failedHost = await loadDirectPlugins([], {
    workspace,
    dataRoot,
    activationFailure: "diagnostic",
    inlinePlugins: [{
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

test("every committed PluginAPI generation receives the durable host services", async (context) => {
  const base = await mkdtemp(join(tmpdir(), "ohm-durable-api-"));
  const workspace = join(base, "workspace");
  const dataRoot = join(base, "extension-data");
  await mkdir(workspace);
  context.after(async () => await rm(base, { recursive: true, force: true }));
  let firstApi: PluginAPI | undefined;
  let precommit: Promise<unknown> | undefined;
  const firstHost = await loadDirectPlugins([], {
    workspace,
    dataRoot,
    activationFailure: "throw",
    inlinePlugins: [{
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
  assert.equal("childSessions" in firstApi, false);
  await firstHost.close();

  let secondApi: PluginAPI | undefined;
  const secondHost = await loadDirectPlugins([], {
    workspace,
    dataRoot,
    activationFailure: "throw",
    inlinePlugins: [{ name: "durable-api", factory(api) { secondApi = api; } }],
  });
  context.after(async () => await secondHost.close());
  assert.ok(secondApi !== undefined);
  assert.equal("childSessions" in secondApi, false);
  const restored = await secondApi.jobs.inspect(running.id);
  assert.equal(restored.state, "interrupted");
});
