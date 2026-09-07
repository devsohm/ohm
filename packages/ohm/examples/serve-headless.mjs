import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { DefaultResourceLoader, SettingsManager } from "ohm/core";
import { getPluginRuntimeHost } from "ohm/plugins";
import { decodeSSE, ProviderRegistry, readJsonResponse } from "ohm/providers";
import { AgentSession } from "ohm/service";
import { createServeSessionRuntime, startServeServer } from "ohm/serve";
import { SessionManager } from "ohm/storage";
import { createScriptedProvider } from "ohm/testing";

const object = (properties) => Type.Object(properties, { additionalProperties: true });
const counter = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const streamId = Type.String({ pattern: "^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$" });
const pageSchema = object({
  entries: Type.Array(object({ id: Type.String() }), { maxItems: 1 }),
  sequenceStart: counter, nextSequence: counter, totalEntries: counter, hasMore: Type.Boolean(),
  snapshot: Type.String({ pattern: "^[a-f0-9]{64}$" }), eventCursor: counter, streamId,
});
const envelopeSchema = object({ schemaVersion: Type.Literal(1), threadId: Type.String(),
  event: object({ type: Type.String() }) });

/** A fixed local contract proof, not a general-purpose HTTP client. */
export async function runServeClientProof() {
  const workspace = await mkdtemp(join(tmpdir(), "ohm-headless-example-"));
  const token = randomBytes(32).toString("hex");
  const deadline = AbortSignal.timeout(10_000);
  const provider = createScriptedProvider({ scripts: [
    { kind: "turn", content: [{ type: "text", text: "x".repeat(80), fragments: Array(80).fill("x") }] },
    { kind: "turn", content: [{ type: "text", text: "cancel this response" }], eventDelayMs: 1_000 },
  ] });
  let sessionFile;
  let server;
  const createRuntime = async (reopen = false) => {
    const settingsManager = SettingsManager.inMemory();
    const resources = new DefaultResourceLoader({
      cwd: workspace, agentDir: join(workspace, "agent"), settingsManager,
      offline: true, noPluginCode: true, noContextFiles: true, noSkills: true,
      noPromptTemplates: true, noThemes: true,
      pluginFactories: [{ name: "headless-proof", async factory(plugin) {
        await plugin.facets.register({ apiVersion: 1, kind: "worker", name: "status", setup(facet) {
          facet.services.provide({ name: "proof.echo", version: 1,
            requestSchema: Type.String(), responseSchema: Type.String(),
          }, (value) => value);
          facet.presentation.show({ id: "status", blocks: [{ type: "text", text: "Ready" }],
            actions: [{ id: "acknowledge", label: "Acknowledge", inputSchema: Type.Object({}),
              run: () => ({ accepted: true }) }],
          });
        } });
      } }],
    });
    await resources.refresh();
    const pluginHost = getPluginRuntimeHost(resources.getPlugins().runtime);
    let manager;
    try {
      manager = reopen
        ? SessionManager.open(sessionFile)
        : SessionManager.create(workspace, join(workspace, "sessions"), { id: "headless-proof" });
      sessionFile = manager.getSessionFile();
      const session = await AgentSession.create({ sessionManager: manager, resourceLoader: resources,
        providers: new ProviderRegistry([provider]), settingsManager, tools: [],
        model: { provider: provider.id, id: provider.models[0].id,
          api: "openai-chat-completions", info: provider.models[0] },
      });
      return createServeSessionRuntime(() => session, {
        start: (signal) => session.bindPlugins({ mode: "serve" }, signal),
        async close() { try { await session.close(); } finally { await pluginHost?.close(); } },
      });
    } catch (error) {
      try { manager?.closeV4Store(); } finally { await pluginHost?.close(); }
      throw error;
    }
  };
  try {
    server = await startServeServer({ token, maxReplayEvents: 64, sessionFactory: {
      create: () => createRuntime(), open: () => createRuntime(true),
    } });
    const base = `${server.origin}/v1/sessions`;
    const url = `${base}/headless-proof`;
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const request = async (target, method = "GET", body, extra = {}) => {
      const options = { method, headers: { ...headers, ...extra }, signal: deadline };
      if (body !== undefined) options.body = JSON.stringify(body);
      return await fetch(target, options);
    };
    const json = async (target, schema, method = "GET", body) => {
      const response = await request(target, method, body);
      assert.ok(response.ok, `HTTP ${response.status}`);
      return Value.Parse(schema, await readJsonResponse(response, 2 * 1024 * 1024));
    };
    const connect = (cursor) => request(`${url}/events`, "GET", undefined, {
      "last-event-id": String(cursor.eventCursor), "x-ohm-stream-id": cursor.streamId,
    });
    const until = async (response, cursor, eventName) => {
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-ohm-stream-id"), cursor.streamId);
      assert.ok(response.body);
      for await (const record of decodeSSE(response.body, { maxEventBytes: 1024 * 1024, maxStreamBytes: 8 * 1024 * 1024 })) {
        const id = Value.Parse(counter, Number(record.id));
        assert.ok(id > cursor.eventCursor);
        cursor.eventCursor = id;
        if (record.event === "replay_gap") {
          assert.equal(eventName, "replay_gap", "Restart committed-history recovery after another gap");
          return;
        }
        const envelope = Value.Parse(envelopeSchema, JSON.parse(record.data));
        assert.equal(envelope.threadId, "headless-proof");
        assert.equal(record.event, envelope.event.type);
        if (record.event === eventName) return;
      }
      assert.fail(`Stream ended before ${eventName}`);
    };
    // Subscribe from the FIRST page's cursor before reading later pages. This
    // fixed proof has no concurrent writer while paging; retain no live deltas.
    const history = async () => {
      let page = await json(`${url}/entries?limit=1`, pageSchema);
      const cursor = { streamId: page.streamId, eventCursor: page.eventCursor };
      const response = await connect(cursor);
      assert.equal(response.status, 200);
      const entries = [];
      let bytes = 0;
      const snapshot = page.snapshot;
      try {
        for (;;) {
          assert.equal(page.snapshot, snapshot);
          assert.equal(page.streamId, cursor.streamId);
          assert.equal(page.sequenceStart, entries.length + (page.entries.length === 0 ? 0 : 1));
          entries.push(...page.entries);
          assert.ok(entries.length <= 128, "This small proof bounds its assembled history to 128 entries");
          bytes += Buffer.byteLength(JSON.stringify(page.entries));
          assert.ok(bytes <= 1024 * 1024, "This small proof bounds its assembled history to 1 MiB");
          assert.equal(page.nextSequence, entries.length);
          if (!page.hasMore) break;
          assert.ok(page.entries.length > 0);
          page = await json(`${url}/entries?limit=1&afterSequence=${page.nextSequence}&snapshot=${snapshot}`, pageSchema);
        }
        assert.equal(entries.length, page.totalEntries);
        assert.equal(new Set(entries.map((entry) => entry.id)).size, entries.length);
        return { entries, cursor };
      } finally {
        await response.body?.cancel();
      }
    };

    await json(base, object({ sessionId: Type.Literal("headless-proof") }), "POST", {});
    await json(`${url}/inspection`, object({ schemaVersion: Type.Literal(1), state: Type.Literal("idle") }));
    const catalog = await json(`${url}/wire-services`, object({ services: Type.Array(object({
      name: Type.String(), version: counter, requestSchema: Type.Object({}, { additionalProperties: true }),
    })) }));
    const echo = catalog.services.find((service) => service.name === "proof.echo");
    assert.ok(echo);
    await json(`${url}/wire-services`, object({ result: object({ ok: Type.Literal(true), payload: Type.Literal("hello") }) }),
      "POST", { protocolVersion: 1, service: echo.name, serviceVersion: echo.version, id: "echo", payload: "hello" });
    const views = await json(`${url}/presentations`, object({ presentations: Type.Array(object({
      owner: Type.String(), presentation: object({ id: Type.String(), revision: counter }),
    }), { minItems: 1 }) }));
    const view = views.presentations[0];
    await json(`${url}/presentation-actions`, object({ result: object({ result: object({ accepted: Type.Literal(true) }) }) }),
      "POST", { protocolVersion: 1, owner: view.owner, presentationId: view.presentation.id,
        revision: view.presentation.revision, actionId: "acknowledge", input: {} });

    const initial = await history();
    const cursor = { ...initial.cursor };
    const first = await connect(cursor);
    await json(`${url}/prompts`, object({}), "POST", { text: "Give the scripted reply." });
    await until(first, cursor, "text_completed"); // Closing the iterator disconnects this client, not the run.
    const disconnectedCursor = cursor.eventCursor;
    await until(await connect(cursor), cursor, "run_completed");
    assert.ok(cursor.eventCursor > disconnectedCursor);
    const gapCursor = { ...initial.cursor };
    await until(await connect(gapCursor), gapCursor, "replay_gap");
    const recovered = await history();
    assert.ok(recovered.entries.length > 1, "The recovery must exercise more than one page");

    const cancellation = await connect(recovered.cursor);
    await json(`${url}/prompts`, object({}), "POST", { text: "Cancel this scripted run." });
    await json(`${url}/cancel`, object({ cancelled: Type.Literal(true) }), "POST", { reason: "Client stopped the task." });
    await until(cancellation, recovered.cursor, "run_cancelled");
    const beforeReopen = await history();
    await json(url, object({}), "DELETE");
    await json(`${base}/open`, object({ sessionId: Type.Literal("headless-proof") }), "POST", { sessionId: "headless-proof" });
    const stale = await connect({ streamId: beforeReopen.cursor.streamId, eventCursor: 0 });
    await stale.body?.cancel();
    assert.equal(stale.status, 409);
    const reopened = await history();
    assert.notEqual(reopened.cursor.streamId, beforeReopen.cursor.streamId);
    assert.deepEqual(reopened.entries, beforeReopen.entries);
    return { discoveredServices: catalog.services.length, actionAccepted: true, cancelled: true,
      retainedReplay: true, replayGapRecovered: true, staleStreamRejected: true, committedHistoryPreserved: true };
  } finally {
    try { await server?.close(); } finally { await rm(workspace, { recursive: true, force: true }); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (["--help", "-h"].includes(process.argv[2])) console.log("node examples/serve-headless.mjs");
  else console.log(JSON.stringify(await runServeClientProof()));
}
