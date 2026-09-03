import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { EventEnvelope } from "../../src/core/events.js";
import { SettingsManager } from "../../src/core/settings-manager.js";
import { loadDirectExtensions } from "../../src/extensions/runtime.js";
import {
  EXTENSION_WIRE_SERVICE_LIMITS,
  type ExtensionWireServiceDescriptor,
  type ExtensionWireServiceRequest,
  type ExtensionWireServiceResponse,
} from "../../src/extensions/wire-services.js";
import { REPLICATED_JSON_STATE_LIMITS } from "../../src/extensions/replicated-state.js";
import {
  PORTABLE_PRESENTATION_LIMITS,
  type PortablePresentationActionRequest,
  type PortablePresentationActionResult,
  type PortablePresentationEvent,
} from "../../src/interfaces/portable-presentation.js";
import { ProviderRegistry } from "../../src/providers/registry.js";
import type {
  AgentSessionRecoveryOptions,
  AgentSessionRecoveryResult,
  AgentSessionSuspendedRun,
} from "../../src/service/agent-session.js";
import { AgentSession } from "../../src/service/agent-session.js";
import { SessionManager } from "../../src/storage/session-manager.js";
import {
  assertValidServeToken,
  startServeServer,
  type ServeServer,
  type ServeSessionFactory,
  type ServeSessionRuntime,
  type ServeSessionSummary,
} from "../../src/serve/server.js";

const TOKEN = "test-serve-token-0123456789abcdef";

interface PrivateServeSessionSummary extends ServeSessionSummary {
  messages: string[];
  systemPrompt: string;
  tools: string[];
}

interface CircularDetails {
  self?: CircularDetails;
}

class FakeSession implements ServeSessionRuntime {
  readonly abortReasons: string[] = [];
  readonly promptCalls: Array<{
    delivery: string | undefined;
    source: string | undefined;
    text: string;
  }> = [];
  closeCalls = 0;
  closeHandler: (() => void | Promise<void>) | undefined;
  promptAdmission = true;
  promptError: Error = new Error("Prompt was rejected");
  promptHandler: ((
    text: string,
    options: Parameters<ServeSessionRuntime["prompt"]>[1],
  ) => void | Promise<void>) | undefined;
  readonly recoveryCalls: AgentSessionRecoveryOptions[] = [];
  readonly wireRequests: ExtensionWireServiceRequest[] = [];
  readonly presentationActions: PortablePresentationActionRequest[] = [];
  readonly presentations: PortablePresentationEvent[] = [];
  readonly wireServices: ExtensionWireServiceDescriptor[] = [{
    protocolVersion: 1,
    name: "fixture.echo",
    version: 1,
    owner: "fixture.extension",
    requestSchema: { type: "object" },
    responseSchema: { type: "object" },
    maxRequestBytes: 1024,
    maxResponseBytes: 2048,
  }];
  recoveryResult: AgentSessionRecoveryResult = { recovered: false, blocked: [] };
  portablePresentationsReady = false;
  startCalls = 0;
  startHandler: ((signal: AbortSignal) => void | Promise<void>) | undefined;
  suspendedRun: AgentSessionSuspendedRun | undefined;
  readonly #listeners = new Set<(event: EventEnvelope) => void | Promise<void>>();
  readonly #presentationListeners = new Set<(event: PortablePresentationEvent) => void>();

  constructor(
    readonly sessionId: string,
    readonly summary: ServeSessionSummary = {
      thinkingLevel: "off",
      isStreaming: false,
      isCompacting: false,
      isRetrying: false,
      pendingMessageCount: 0,
      messageCount: 0,
      toolCount: 0,
      hasSuspendedRun: false,
    },
  ) {}

  onEvent(listener: (event: EventEnvelope) => void | Promise<void>): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  onPortablePresentation(listener: (event: PortablePresentationEvent) => void): () => void {
    if (!this.portablePresentationsReady) return () => undefined;
    this.#presentationListeners.add(listener);
    return () => this.#presentationListeners.delete(listener);
  }

  listPortablePresentations(): readonly PortablePresentationEvent[] {
    return this.portablePresentationsReady ? this.presentations : [];
  }

  listExtensionWireServices(): readonly ExtensionWireServiceDescriptor[] {
    return this.wireServices;
  }

  async invokeExtensionWireService(
    request: ExtensionWireServiceRequest,
    signal?: AbortSignal,
  ): Promise<ExtensionWireServiceResponse> {
    signal?.throwIfAborted();
    this.wireRequests.push(request);
    return {
      protocolVersion: 1,
      service: request.service,
      serviceVersion: request.serviceVersion,
      id: request.id,
      ok: true,
      payload: request.payload,
    };
  }

  async invokePortablePresentationAction(
    request: PortablePresentationActionRequest,
    signal?: AbortSignal,
  ): Promise<PortablePresentationActionResult> {
    signal?.throwIfAborted();
    this.presentationActions.push(request);
    return {
      protocolVersion: request.protocolVersion,
      owner: request.owner,
      presentationId: request.presentationId,
      revision: request.revision,
      actionId: request.actionId,
      result: { accepted: true },
    };
  }

  async prompt(
    text: string,
    options?: {
      preflightResult?: (succeeded: boolean) => void;
      signal?: AbortSignal;
      source?: "interactive" | "rpc" | "serve" | "extension";
      streamingBehavior?: "steer" | "followUp";
    },
  ): Promise<void> {
    this.promptCalls.push({
      delivery: options?.streamingBehavior,
      source: options?.source,
      text,
    });
    if (this.promptHandler !== undefined) {
      await this.promptHandler(text, options);
      return;
    }
    options?.signal?.throwIfAborted();
    options?.preflightResult?.(this.promptAdmission);
    if (!this.promptAdmission) throw this.promptError;
  }

  async recoverInterruptedRun(
    options: AgentSessionRecoveryOptions = {},
  ): Promise<AgentSessionRecoveryResult> {
    this.recoveryCalls.push(options);
    options.signal?.throwIfAborted();
    return this.recoveryResult;
  }

  async abort(reason?: string): Promise<void> {
    this.abortReasons.push(reason ?? "");
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    await this.closeHandler?.();
  }

  async start(signal: AbortSignal): Promise<void> {
    this.startCalls += 1;
    this.portablePresentationsReady = true;
    await this.startHandler?.(signal);
  }

  async emit(sequence: number): Promise<void> {
    const event: EventEnvelope = {
      eventId: `event-${sequence}`,
      threadId: this.sessionId,
      runId: "run-1",
      sequence,
      timestamp: new Date(sequence).toISOString(),
      schemaVersion: 1,
      event: { type: "run_state", state: sequence % 2 === 0 ? "streaming" : "preparing" },
    };
    await this.emitEnvelope(event);
  }

  async emitEnvelope(event: EventEnvelope): Promise<void> {
    for (const listener of this.#listeners) await listener(event);
  }

  emitPresentation(event: PortablePresentationEvent): void {
    const id = event.operation === "show" ? event.presentation.id : event.presentationId;
    const index = this.presentations.findIndex((candidate) =>
      candidate.operation === "show" && candidate.owner === event.owner && candidate.presentation.id === id);
    if (event.operation === "show") {
      if (index < 0) this.presentations.push(event);
      else this.presentations[index] = event;
    } else if (index >= 0) this.presentations.splice(index, 1);
    for (const listener of this.#presentationListeners) listener(event);
  }
}

function authHeaders(json = false): Headers {
  const headers = new Headers({ Authorization: `Bearer ${TOKEN}` });
  if (json) headers.set("Content-Type", "application/json");
  return headers;
}

async function closeAfter(server: ServeServer, operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
  } finally {
    await server.close();
  }
}

async function rawRequest(server: ServeServer, request: string): Promise<string> {
  const socket = connect({ host: server.host, port: server.port });
  let response = "";
  socket.setEncoding("latin1");
  socket.on("data", (chunk: string) => { response += chunk; });
  await new Promise<void>((resolveConnect, reject) => {
    socket.once("connect", resolveConnect);
    socket.once("error", reject);
  });
  socket.end(request);
  await new Promise<void>((resolveClose, reject) => {
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("Raw HTTP connection did not close"));
    }, 2_000);
    timeout.unref();
    socket.once("close", () => {
      clearTimeout(timeout);
      resolveClose();
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
  return response;
}

async function within<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

test("serve tokens use one shared strong ASCII token68 contract", () => {
  assert.doesNotThrow(() => assertValidServeToken(TOKEN));
  for (const token of [
    "x".repeat(31),
    "x".repeat(4_097),
    `${"x".repeat(32)} `,
    `${"x".repeat(32)}\t`,
    `${"x".repeat(32)}:`,
    `${"x".repeat(32)}🛠`,
  ]) {
    assert.throws(() => assertValidServeToken(token), /32 to 4,096 ASCII token68/u);
  }
});

test("serve requires its bearer token, including for health", async () => {
  const session = new FakeSession("unused");
  const factory: ServeSessionFactory = {
    async create() { return session; },
    async open() { return undefined; },
  };
  const server = await startServeServer({ token: TOKEN, sessionFactory: factory });
  await closeAfter(server, async () => {
    const missing = await fetch(`${server.origin}/health`);
    assert.equal(missing.status, 401);
    assert.equal(missing.headers.get("www-authenticate"), "Bearer");

    const wrong = await fetch(`${server.origin}/health`, {
      headers: { Authorization: "Bearer wrong-token" },
    });
    assert.equal(wrong.status, 401);

    const healthy = await fetch(`${server.origin}/health`, { headers: authHeaders() });
    assert.equal(healthy.status, 200);
    assert.deepEqual(await healthy.json(), { status: "ok" });
  });
});

test("serve closes early error connections and retains strict HTTP parsing", async () => {
  let createCalls = 0;
  const factory: ServeSessionFactory = {
    async create() {
      createCalls += 1;
      return new FakeSession("created");
    },
    async open() { return undefined; },
  };
  const server = await startServeServer({ token: TOKEN, sessionFactory: factory });
  await closeAfter(server, async () => {
    const oversized = await rawRequest(server, [
      "POST /v1/sessions HTTP/1.1",
      "Host: localhost",
      `Authorization: Bearer ${TOKEN}`,
      "Content-Type: application/json",
      "Content-Length: 9999999",
      "",
      "",
    ].join("\r\n"));
    assert.match(oversized, /^HTTP\/1\.1 413/u);
    assert.match(oversized, /\r\nConnection: close\r\n/iu);

    const smuggled = await rawRequest(server, [
      "POST /v1/sessions HTTP/1.1",
      "Host: localhost",
      `Authorization: Bearer ${TOKEN}`,
      "Content-Type: application/json",
      "Content-Length: 4",
      "Transfer-Encoding: chunked",
      "",
      "0",
      "",
      "",
    ].join("\r\n"));
    assert.match(smuggled, /^HTTP\/1\.1 400/u);
    assert.equal(createCalls, 0);
  });
});

test("serve rejects oversized and non-JSON request bodies", async () => {
  const factory: ServeSessionFactory = {
    async create() { return new FakeSession("created"); },
    async open() { return undefined; },
  };
  const server = await startServeServer({
    token: TOKEN,
    sessionFactory: factory,
    maxBodyBytes: 32,
  });
  await closeAfter(server, async () => {
    const oversized = await fetch(`${server.origin}/v1/sessions`, {
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify({ workspace: "x".repeat(64) }),
    });
    assert.equal(oversized.status, 413);

    const wrongType = await fetch(`${server.origin}/v1/sessions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "text/plain",
      },
      body: "{}",
    });
    assert.equal(wrongType.status, 415);
  });
});

test("serve default request admission covers advertised action, wire, and state payload limits", async () => {
  const session = new FakeSession("request-limits");
  const server = await startServeServer({
    token: TOKEN,
    sessionFactory: {
      async create() { return session; },
      async open() { return undefined; },
    },
  });
  await closeAfter(server, async () => {
    const created = await fetch(`${server.origin}/v1/sessions`, {
      method: "POST",
      headers: authHeaders(true),
      body: "{}",
    });
    assert.equal(created.status, 201);

    const wirePayload = "w".repeat(EXTENSION_WIRE_SERVICE_LIMITS.maxPayloadBytes - 2);
    assert.equal(
      Buffer.byteLength(JSON.stringify(wirePayload), "utf8"),
      EXTENSION_WIRE_SERVICE_LIMITS.maxPayloadBytes,
    );
    const wireRequest: ExtensionWireServiceRequest = {
      protocolVersion: 1,
      service: `s${"x".repeat(95)}`,
      serviceVersion: Number.MAX_SAFE_INTEGER,
      id: `i${"x".repeat(127)}`,
      payload: wirePayload,
    };
    const wireBody = JSON.stringify(wireRequest);
    assert.ok(Buffer.byteLength(wireBody, "utf8") > EXTENSION_WIRE_SERVICE_LIMITS.maxPayloadBytes);
    const wire = await fetch(`${server.origin}/v1/sessions/request-limits/wire-services`, {
      method: "POST",
      headers: authHeaders(true),
      body: wireBody,
    });
    assert.equal(wire.status, 200);
    await wire.arrayBuffer();

    const actionInput = "a".repeat(PORTABLE_PRESENTATION_LIMITS.maxActionInputBytes - 2);
    assert.equal(
      Buffer.byteLength(JSON.stringify(actionInput), "utf8"),
      PORTABLE_PRESENTATION_LIMITS.maxActionInputBytes,
    );
    const action: PortablePresentationActionRequest = {
      protocolVersion: 1,
      owner: `o${"x".repeat(255)}`,
      presentationId: `p${"x".repeat(127)}`,
      revision: Number.MAX_SAFE_INTEGER,
      actionId: `a${"x".repeat(127)}`,
      input: actionInput,
    };
    const acted = await fetch(`${server.origin}/v1/sessions/request-limits/presentation-actions`, {
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify(action),
    });
    assert.equal(acted.status, 200);
    await acted.arrayBuffer();

    const emptyDelta = {
      protocolVersion: 1,
      baseRevision: 0,
      revision: 1,
      operations: [{ type: "replace", value: "" }],
    } as const;
    const stateValue = "s".repeat(
      REPLICATED_JSON_STATE_LIMITS.maxDeltaBytes
        - Buffer.byteLength(JSON.stringify(emptyDelta), "utf8"),
    );
    const delta = {
      ...emptyDelta,
      operations: [{ type: "replace", value: stateValue }],
    } as const;
    assert.equal(
      Buffer.byteLength(JSON.stringify(delta), "utf8"),
      REPLICATED_JSON_STATE_LIMITS.maxDeltaBytes,
    );
    const state = await fetch(`${server.origin}/v1/sessions/request-limits/wire-services`, {
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify({
        protocolVersion: 1,
        service: "ohm.state.fixture.shared",
        serviceVersion: 1,
        id: "state-limit",
        payload: { operation: "apply", delta },
      }),
    });
    assert.equal(state.status, 200);
    await state.arrayBuffer();

    const beyondHeadroom = await fetch(`${server.origin}/v1/sessions/request-limits/wire-services`, {
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify({
        ...wireRequest,
        payload: "x".repeat(
          EXTENSION_WIRE_SERVICE_LIMITS.maxPayloadBytes + 64 * 1024,
        ),
      }),
    });
    assert.equal(beyondHeadroom.status, 413);
  });
});

test("serve creates, opens, inspects, prompts, and cancels canonical sessions", async () => {
  const created = new FakeSession("created");
  const opened = new FakeSession("opened");
  const createRequests: unknown[] = [];
  const openRequests: unknown[] = [];
  const factory: ServeSessionFactory = {
    async create(request) {
      createRequests.push(request);
      return created;
    },
    async open(request) {
      openRequests.push(request);
      return request.sessionId === opened.sessionId ? opened : undefined;
    },
  };
  const server = await startServeServer({ token: TOKEN, sessionFactory: factory });
  await closeAfter(server, async () => {
    const create = await fetch(`${server.origin}/v1/sessions`, {
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify({ workspace: "/workspace" }),
    });
    assert.equal(create.status, 201);
    assert.deepEqual(createRequests, [{ workspace: "/workspace" }]);
    assert.deepEqual(await create.json(), {
      sessionId: "created",
      state: {
        thinkingLevel: "off",
        isStreaming: false,
        isCompacting: false,
        isRetrying: false,
        pendingMessageCount: 0,
        messageCount: 0,
        toolCount: 0,
        hasSuspendedRun: false,
      },
    });

    const state = await fetch(`${server.origin}/v1/sessions/created`, {
      headers: authHeaders(),
    });
    assert.equal(state.status, 200);

    const prompt = await fetch(`${server.origin}/v1/sessions/created/prompts`, {
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify({ text: "inspect the workspace" }),
    });
    assert.equal(prompt.status, 202);
    assert.deepEqual(created.promptCalls, [{
      delivery: "followUp",
      text: "inspect the workspace",
      source: "serve",
    }]);

    const cancel = await fetch(`${server.origin}/v1/sessions/created/cancel`, {
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify({ reason: "stop now" }),
    });
    assert.equal(cancel.status, 200);
    assert.deepEqual(created.abortReasons, ["stop now"]);

    const open = await fetch(`${server.origin}/v1/sessions/open`, {
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify({ sessionId: "opened" }),
    });
    assert.equal(open.status, 200);
    assert.deepEqual(openRequests, [{ sessionId: "opened" }]);

    const missing = await fetch(`${server.origin}/v1/sessions/open`, {
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify({ sessionId: "missing" }),
    });
    assert.equal(missing.status, 404);
  });
});

test("serve exposes authenticated explicit recovery without choosing an outcome for the caller", async () => {
  const session = new FakeSession("recovery-session");
  const uncertainEffect = {
    effectId: "effect-write",
    callId: "call-write",
    name: "write",
    policy: "never_repeat" as const,
    status: "in_doubt" as const,
    step: 258,
    index: 0,
    inputHash: "a".repeat(64),
  };
  session.suspendedRun = {
    operationId: "run-interrupted",
    acceptedAt: "2026-08-08T12:00:00.000Z",
    cancelled: true,
    attempts: 1,
    claimedQueueIds: ["queue-1"],
    effects: [
      ...Array.from({ length: 257 }, (_, index) => ({
        ...uncertainEffect,
        effectId: `effect-settled-${index}`,
        callId: `call-settled-${index}`,
        status: "succeeded" as const,
        step: index,
      })),
      uncertainEffect,
    ],
  };
  const factory: ServeSessionFactory = {
    async create() { return session; },
    async open() { return undefined; },
  };
  const server = await startServeServer({ token: TOKEN, sessionFactory: factory });
  await closeAfter(server, async () => {
    await fetch(`${server.origin}/v1/sessions`, {
      method: "POST",
      headers: authHeaders(true),
      body: "{}",
    });

    const unauthorized = await fetch(
      `${server.origin}/v1/sessions/recovery-session/recovery`,
    );
    assert.equal(unauthorized.status, 401);

    const status = await fetch(
      `${server.origin}/v1/sessions/recovery-session/recovery`,
      { headers: authHeaders() },
    );
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), {
      sessionId: "recovery-session",
      suspendedRun: { ...session.suspendedRun, effects: [uncertainEffect] },
    });

    const blockedPrompt = await fetch(
      `${server.origin}/v1/sessions/recovery-session/prompts`,
      {
        method: "POST",
        headers: authHeaders(true),
        body: JSON.stringify({ text: "must wait for recovery" }),
      },
    );
    assert.equal(blockedPrompt.status, 409);
    assert.equal(session.promptCalls.length, 0);

    session.recoveryResult = {
      recovered: false,
      operationId: "run-interrupted",
      blocked: [{
        effectId: "effect-write",
        name: "write",
        reason: "This tool cannot be repeated safely. Supply an explicit resolution.",
      }],
    };
    const safeOnly = await fetch(
      `${server.origin}/v1/sessions/recovery-session/recovery`,
      {
        method: "POST",
        headers: authHeaders(true),
        body: "{}",
      },
    );
    assert.equal(safeOnly.status, 200);
    assert.deepEqual(await safeOnly.json(), {
      sessionId: "recovery-session",
      recovery: session.recoveryResult,
    });
    assert.equal(session.recoveryCalls.length, 1);
    assert.equal(session.recoveryCalls[0]?.resolutions, undefined);
    assert.equal(session.recoveryCalls[0]?.signal instanceof AbortSignal, true);

    for (const body of [
      { unexpected: true },
      { resolutions: [{ effectId: "effect-write", outcome: "abandoned", unexpected: true }] },
      {
        resolutions: [{
          effectId: "effect-write",
          outcome: "abandoned",
          result: { content: "not permitted", isError: false },
        }],
      },
      {
        resolutions: [
          { effectId: "effect-write", outcome: "abandoned" },
          { effectId: "effect-write", outcome: "abandoned" },
        ],
      },
      {
        resolutions: [{
          effectId: "effect-write",
          outcome: "succeeded",
          result: { content: "verified", isError: true },
        }],
      },
      {
        resolutions: [{
          effectId: "effect-write",
          outcome: "succeeded",
          result: { content: "verified", isError: false, unexpected: true },
        }],
      },
      {
        resolutions: Array.from({ length: 257 }, (_, index) => ({
          effectId: `effect-${index}`,
          outcome: "abandoned",
        })),
      },
    ]) {
      const invalid = await fetch(
        `${server.origin}/v1/sessions/recovery-session/recovery`,
        {
          method: "POST",
          headers: authHeaders(true),
          body: JSON.stringify(body),
        },
      );
      assert.equal(invalid.status, 400);
    }
    assert.equal(session.recoveryCalls.length, 1);

    const staleEffect = await fetch(
      `${server.origin}/v1/sessions/recovery-session/recovery`,
      {
        method: "POST",
        headers: authHeaders(true),
        body: JSON.stringify({
          resolutions: [{ effectId: "effect-already-settled", outcome: "abandoned" }],
        }),
      },
    );
    assert.equal(staleEffect.status, 409);
    assert.equal(session.recoveryCalls.length, 1);

    session.recoveryResult = {
      recovered: true,
      operationId: "run-interrupted",
      blocked: [],
    };
    const explicit = await fetch(
      `${server.origin}/v1/sessions/recovery-session/recovery`,
      {
        method: "POST",
        headers: authHeaders(true),
        body: JSON.stringify({
          resolutions: [{ effectId: "effect-write", outcome: "abandoned" }],
        }),
      },
    );
    assert.equal(explicit.status, 200);
    assert.deepEqual(await explicit.json(), {
      sessionId: "recovery-session",
      recovery: session.recoveryResult,
    });
    assert.deepEqual(session.recoveryCalls[1]?.resolutions, [{
      effectId: "effect-write",
      outcome: "abandoned",
    }]);
  });
});

test("serve admits prompts through preflight and supports explicit steering", async () => {
  const session = new FakeSession("prompt-delivery");
  const factory: ServeSessionFactory = {
    async create() { return session; },
    async open() { return undefined; },
  };
  const server = await startServeServer({ token: TOKEN, sessionFactory: factory });
  await closeAfter(server, async () => {
    await fetch(`${server.origin}/v1/sessions`, {
      method: "POST",
      headers: authHeaders(true),
      body: "{}",
    });
    const steering = await fetch(`${server.origin}/v1/sessions/prompt-delivery/prompts`, {
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify({ text: "change direction", delivery: "steer" }),
    });
    assert.equal(steering.status, 202);
    assert.deepEqual(session.promptCalls.at(-1), {
      delivery: "steer",
      source: "serve",
      text: "change direction",
    });

    const invalid = await fetch(`${server.origin}/v1/sessions/prompt-delivery/prompts`, {
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify({ text: "invalid", delivery: "later" }),
    });
    assert.equal(invalid.status, 400);
  });
});

test("serve never returns accepted when prompt admission fails", async () => {
  const session = new FakeSession("rejected");
  session.promptAdmission = false;
  const factory: ServeSessionFactory = {
    async create() { return session; },
    async open() { return undefined; },
  };
  const server = await startServeServer({ token: TOKEN, sessionFactory: factory });
  await closeAfter(server, async () => {
    await fetch(`${server.origin}/v1/sessions`, {
      method: "POST",
      headers: authHeaders(true),
      body: "{}",
    });
    const response = await fetch(`${server.origin}/v1/sessions/rejected/prompts`, {
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify({ text: "must not be lost" }),
    });
    assert.notEqual(response.status, 202);
    assert.deepEqual(await response.json(), { error: "Prompt was not accepted" });
  });
});

test("serve bounds pending prompt admission count with a stable capacity response", async () => {
  const session = new FakeSession("prompt-count-capacity");
  let entered!: () => void;
  const promptEntered = new Promise<void>((resolveEntered) => { entered = resolveEntered; });
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  session.promptHandler = async (_text, options) => {
    entered();
    await gate;
    options?.signal?.throwIfAborted();
    options?.preflightResult?.(true);
  };
  const server = await startServeServer({
    token: TOKEN,
    sessionFactory: {
      async create() { return session; },
      async open() { return undefined; },
    },
    maxPromptAdmissionsPerSession: 1,
  });
  await closeAfter(server, async () => {
    await fetch(`${server.origin}/v1/sessions`, {
      method: "POST",
      headers: authHeaders(true),
      body: "{}",
    });
    const active = fetch(`${server.origin}/v1/sessions/${session.sessionId}/prompts`, {
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify({ text: "active" }),
    });
    await within(promptEntered, 2_000, "active prompt admission");

    const full = await fetch(`${server.origin}/v1/sessions/${session.sessionId}/prompts`, {
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify({ text: "queued" }),
    });
    assert.equal(full.status, 503);
    assert.deepEqual(await full.json(), { error: "Prompt admission capacity reached" });
    assert.deepEqual(session.promptCalls.map((call) => call.text), ["active"]);

    release();
    assert.equal((await active).status, 202);
  });
});

test("serve bounds pending prompt admission by UTF-8 bytes", async () => {
  const session = new FakeSession("prompt-byte-capacity");
  let entered!: () => void;
  const promptEntered = new Promise<void>((resolveEntered) => { entered = resolveEntered; });
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  session.promptHandler = async (_text, options) => {
    entered();
    await gate;
    options?.signal?.throwIfAborted();
    options?.preflightResult?.(true);
  };
  const server = await startServeServer({
    token: TOKEN,
    sessionFactory: {
      async create() { return session; },
      async open() { return undefined; },
    },
    maxPromptAdmissionBytesPerSession: 4,
    maxPromptAdmissionsPerSession: 2,
  });
  await closeAfter(server, async () => {
    await fetch(`${server.origin}/v1/sessions`, {
      method: "POST",
      headers: authHeaders(true),
      body: "{}",
    });
    const active = fetch(`${server.origin}/v1/sessions/${session.sessionId}/prompts`, {
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify({ text: "é" }),
    });
    await within(promptEntered, 2_000, "UTF-8 prompt admission");

    const full = await fetch(`${server.origin}/v1/sessions/${session.sessionId}/prompts`, {
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify({ text: "€" }),
    });
    assert.equal(full.status, 503);
    assert.deepEqual(await full.json(), { error: "Prompt admission capacity reached" });
    assert.deepEqual(session.promptCalls.map((call) => call.text), ["é"]);

    release();
    assert.equal((await active).status, 202);
  });
});

test("serve releases an aborted queued prompt without executing it", async () => {
  const session = new FakeSession("aborted-queued-prompt");
  let entered!: () => void;
  const promptEntered = new Promise<void>((resolveEntered) => { entered = resolveEntered; });
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  session.promptHandler = async (text, options) => {
    if (text === "active") {
      entered();
      await gate;
    }
    options?.signal?.throwIfAborted();
    options?.preflightResult?.(true);
  };
  const server = await startServeServer({
    token: TOKEN,
    sessionFactory: {
      async create() { return session; },
      async open() { return undefined; },
    },
    maxPromptAdmissionsPerSession: 2,
  });
  await closeAfter(server, async () => {
    await fetch(`${server.origin}/v1/sessions`, {
      method: "POST",
      headers: authHeaders(true),
      body: "{}",
    });
    const active = fetch(`${server.origin}/v1/sessions/${session.sessionId}/prompts`, {
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify({ text: "active" }),
    });
    await within(promptEntered, 2_000, "active prompt admission");

    const controller = new AbortController();
    const queued = fetch(`${server.origin}/v1/sessions/${session.sessionId}/prompts`, {
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify({ text: "aborted" }),
      signal: controller.signal,
    });
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 25));
    assert.deepEqual(session.promptCalls.map((call) => call.text), ["active"]);
    controller.abort();
    await assert.rejects(queued, /abort/iu);
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 25));

    const replacement = fetch(`${server.origin}/v1/sessions/${session.sessionId}/prompts`, {
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify({ text: "replacement" }),
    });
    release();
    assert.equal((await active).status, 202);
    assert.equal((await replacement).status, 202);
    assert.deepEqual(
      session.promptCalls.map((call) => call.text),
      ["active", "replacement"],
    );
  });
});

test("serve session close drains queued prompt admissions without executing them", async () => {
  const session = new FakeSession("close-prompt-admissions");
  let entered!: () => void;
  const promptEntered = new Promise<void>((resolveEntered) => { entered = resolveEntered; });
  session.promptHandler = async (text, options) => {
    if (text !== "active") throw new Error("Queued prompt executed during close");
    entered();
    const signal = options?.signal;
    if (signal === undefined) throw new Error("Prompt admission signal is missing");
    await new Promise<never>((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
  const server = await startServeServer({
    token: TOKEN,
    sessionFactory: {
      async create() { return session; },
      async open() { return undefined; },
    },
    maxPromptAdmissionsPerSession: 2,
  });
  await closeAfter(server, async () => {
    await fetch(`${server.origin}/v1/sessions`, {
      method: "POST",
      headers: authHeaders(true),
      body: "{}",
    });
    const active = fetch(`${server.origin}/v1/sessions/${session.sessionId}/prompts`, {
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify({ text: "active" }),
    });
    await within(promptEntered, 2_000, "active prompt admission");
    const queued = fetch(`${server.origin}/v1/sessions/${session.sessionId}/prompts`, {
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify({ text: "queued" }),
    });
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 25));

    const closed = await fetch(`${server.origin}/v1/sessions/${session.sessionId}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    assert.equal(closed.status, 200);
    assert.equal((await active).status, 409);
    assert.equal((await queued).status, 409);
    assert.deepEqual(session.promptCalls.map((call) => call.text), ["active"]);
    assert.deepEqual(session.abortReasons, ["Serve session closed"]);
    assert.equal(session.closeCalls, 1);
  });
});

test("serve exposes a bounded state summary only", async () => {
  const summary: PrivateServeSessionSummary = {
    thinkingLevel: "high",
    isStreaming: true,
    isCompacting: false,
    isRetrying: true,
    pendingMessageCount: 2,
    messageCount: 7,
    toolCount: 4,
    hasSuspendedRun: false,
    messages: ["private"],
    systemPrompt: "private",
    tools: ["private"],
  };
  const session = new FakeSession("summary", summary);
  const server = await startServeServer({
    token: TOKEN,
    sessionFactory: {
      async create() { return session; },
      async open() { return undefined; },
    },
  });
  await closeAfter(server, async () => {
    const response = await fetch(`${server.origin}/v1/sessions`, {
      method: "POST",
      headers: authHeaders(true),
      body: "{}",
    });
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), {
      sessionId: "summary",
      state: {
        thinkingLevel: "high",
        isStreaming: true,
        isCompacting: false,
        isRetrying: true,
        pendingMessageCount: 2,
        messageCount: 7,
        toolCount: 4,
        hasSuspendedRun: false,
      },
    });
  });
});

async function readUntil(
  response: Response,
  predicate: (text: string) => boolean,
): Promise<string> {
  assert.ok(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (!predicate(text)) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text;
  } finally {
    await reader.cancel();
  }
}

test("serve projects portable presentations and brokers versioned extension services over HTTP", async () => {
  const session = new FakeSession("extension-broker");
  const presentation: PortablePresentationEvent = {
    type: "portable_presentation",
    protocolVersion: 1,
    operation: "show",
    owner: "fixture.extension",
    presentation: {
      protocolVersion: 1,
      id: "status",
      revision: 2,
      blocks: [{ type: "text", text: "Ready" }],
      actions: [],
    },
  };
  session.presentations.push(presentation);
  session.startHandler = () => session.emitPresentation(presentation);
  const server = await startServeServer({
    token: TOKEN,
    sessionFactory: {
      async create() { return session; },
      async open() { return undefined; },
    },
  });
  await closeAfter(server, async () => {
    const created = await fetch(`${server.origin}/v1/sessions`, {
      method: "POST",
      headers: authHeaders(true),
      body: "{}",
    });
    assert.equal(created.status, 201);

    const catalog = await fetch(
      `${server.origin}/v1/sessions/extension-broker/wire-services`,
      { headers: authHeaders() },
    );
    assert.equal(catalog.status, 200);
    assert.deepEqual(await catalog.json(), {
      sessionId: "extension-broker",
      services: session.wireServices,
    });

    const wireRequest: ExtensionWireServiceRequest = {
      protocolVersion: 1,
      service: "fixture.echo",
      serviceVersion: 1,
      id: "wire-http-1",
      payload: { text: "hello" },
    };
    const invoked = await fetch(
      `${server.origin}/v1/sessions/extension-broker/wire-services`,
      {
        method: "POST",
        headers: authHeaders(true),
        body: JSON.stringify(wireRequest),
      },
    );
    assert.equal(invoked.status, 200);
    assert.deepEqual(await invoked.json(), {
      sessionId: "extension-broker",
      result: {
        ...wireRequest,
        ok: true,
      },
    });
    assert.deepEqual(session.wireRequests, [wireRequest]);

    const snapshot = await fetch(
      `${server.origin}/v1/sessions/extension-broker/presentations`,
      { headers: authHeaders() },
    );
    assert.equal(snapshot.status, 200);
    assert.deepEqual(await snapshot.json(), {
      sessionId: "extension-broker",
      presentations: [presentation],
    });
    const stream = await fetch(
      `${server.origin}/v1/sessions/extension-broker/events`,
      { headers: authHeaders() },
    );
    const text = await readUntil(stream, (value) => value.includes("event: portable_presentation"));
    assert.match(text, /event: portable_presentation/u);
    assert.ok(text.includes(`data: ${JSON.stringify(presentation)}`));
    assert.equal(text.match(/event: portable_presentation/gu)?.length, 1);

    const action: PortablePresentationActionRequest = {
      protocolVersion: 1,
      owner: "fixture.extension",
      presentationId: "status",
      revision: 2,
      actionId: "acknowledge",
      input: { accepted: true },
    };
    const acted = await fetch(
      `${server.origin}/v1/sessions/extension-broker/presentation-actions`,
      {
        method: "POST",
        headers: authHeaders(true),
        body: JSON.stringify(action),
      },
    );
    assert.equal(acted.status, 200);
    assert.deepEqual(await acted.json(), {
      sessionId: "extension-broker",
      result: {
        protocolVersion: 1,
        owner: "fixture.extension",
        presentationId: "status",
        revision: 2,
        actionId: "acknowledge",
        result: { accepted: true },
      },
    });

    for (const [path, body] of [
      ["wire-services", { ...wireRequest, protocolVersion: 2 }],
      ["presentation-actions", { ...action, unexpected: true }],
    ] as const) {
      const invalid = await fetch(`${server.origin}/v1/sessions/extension-broker/${path}`, {
        method: "POST",
        headers: authHeaders(true),
        body: JSON.stringify(body),
      });
      assert.equal(invalid.status, 400);
    }
  });
});

test("serve snapshots presentations created while a real AgentSession starts", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "ohm-serve-portable-session-"));
  context.after(async () => await rm(workspace, { recursive: true, force: true }));
  const host = await loadDirectExtensions([], {
    workspace,
    mode: "serve",
    activationFailure: "throw",
    inlineExtensions: [{
      name: "serve-portable-session",
      async factory(extension) {
        await extension.facets.register({
          apiVersion: 1,
          kind: "worker",
          name: "view",
          setup(facet) {
            facet.presentation.show({
              id: "real-session",
              blocks: [{ type: "text", text: "Bound" }],
            });
          },
        });
      },
    }],
  });
  context.after(async () => await host.close());
  const session = await AgentSession.create({
    sessionManager: SessionManager.inMemory(workspace, { id: "serve-portable" }),
    providers: new ProviderRegistry([]),
    settingsManager: SettingsManager.inMemory(),
    extensionRunner: host,
    tools: [],
  });
  context.after(async () => await session.close());
  const runtime: ServeSessionRuntime = {
    sessionId: "serve-portable",
    summary: {
      thinkingLevel: "off",
      isStreaming: false,
      isCompacting: false,
      isRetrying: false,
      pendingMessageCount: 0,
      messageCount: 0,
      toolCount: 0,
      hasSuspendedRun: false,
    },
    suspendedRun: undefined,
    onEvent(listener) { return session.onEvent(listener); },
    onPortablePresentation(listener) { return session.onPortablePresentation(listener); },
    listPortablePresentations() { return session.listPortablePresentations(); },
    listExtensionWireServices() { return session.listExtensionWireServices(); },
    async invokeExtensionWireService(request, signal) {
      return await session.invokeExtensionWireService(request, signal);
    },
    async invokePortablePresentationAction(request, signal) {
      return await session.invokePortablePresentationAction(request, signal);
    },
    async start(signal) { await session.bindExtensions({ mode: "serve" }, signal); },
    async prompt(text, options) { return await session.prompt(text, options); },
    async recoverInterruptedRun(options) { return await session.recoverInterruptedRun(options); },
    async abort(reason) { await session.abort(reason); },
    async close() { await session.close(); },
  };
  const server = await startServeServer({
    token: TOKEN,
    sessionFactory: {
      async create() { return runtime; },
      async open() { return undefined; },
    },
  });
  await closeAfter(server, async () => {
    const created = await fetch(`${server.origin}/v1/sessions`, {
      method: "POST",
      headers: authHeaders(true),
      body: "{}",
    });
    assert.equal(created.status, 201);
    const snapshot = await fetch(
      `${server.origin}/v1/sessions/serve-portable/presentations`,
      { headers: authHeaders() },
    );
    assert.equal(snapshot.status, 200);
    const body = await snapshot.json() as { presentations: PortablePresentationEvent[] };
    assert.equal(body.presentations.length, 1);
    assert.equal(body.presentations[0]?.operation, "show");
    assert.equal(
      body.presentations[0]?.operation === "show"
        ? body.presentations[0].presentation.id
        : undefined,
      "real-session",
    );
  });
});

test("serve replays retained SSE events after Last-Event-ID and reports replay gaps", async () => {
  const session = new FakeSession("events");
  const factory: ServeSessionFactory = {
    async create() { return session; },
    async open() { return undefined; },
  };
  const server = await startServeServer({
    token: TOKEN,
    sessionFactory: factory,
    maxReplayEvents: 2,
  });
  await closeAfter(server, async () => {
    const create = await fetch(`${server.origin}/v1/sessions`, {
      method: "POST",
      headers: authHeaders(true),
      body: "{}",
    });
    assert.equal(create.status, 201);
    await session.emit(1);
    await session.emit(2);
    await session.emit(3);

    const replayHeaders = authHeaders();
    replayHeaders.set("Last-Event-ID", "1");
    const replay = await fetch(`${server.origin}/v1/sessions/events/events`, { headers: replayHeaders });
    assert.equal(replay.status, 200);
    const replayText = await readUntil(replay, (text) => text.includes("id: 3\n"));
    assert.doesNotMatch(replayText, /id: 1\n/u);
    assert.match(replayText, /id: 2\n/u);
    assert.match(replayText, /id: 3\n/u);
    assert.doesNotMatch(replayText, /event: replay_gap/u);

    const gapHeaders = authHeaders();
    gapHeaders.set("Last-Event-ID", "0");
    const gap = await fetch(`${server.origin}/v1/sessions/events/events`, { headers: gapHeaders });
    assert.equal(gap.status, 200);
    const gapText = await readUntil(gap, (text) => text.includes("id: 3\n"));
    assert.match(gapText, /event: replay_gap/u);
    assert.match(gapText, /"oldestAvailableId":2/u);
    assert.match(gapText, /id: 1\nevent: replay_gap/u);
    assert.match(gapText, /id: 2\n/u);
    assert.match(gapText, /id: 3\n/u);
  });
});

test("serve subscribes before runtime start so recovery events are replayable", async () => {
  const session = new FakeSession("started");
  session.startHandler = async () => {
    await session.emit(1);
  };
  const server = await startServeServer({
    token: TOKEN,
    sessionFactory: {
      async create() { return session; },
      async open() { return undefined; },
    },
  });
  await closeAfter(server, async () => {
    const create = await fetch(`${server.origin}/v1/sessions`, {
      method: "POST",
      headers: authHeaders(true),
      body: "{}",
    });
    assert.equal(create.status, 201);
    assert.equal(session.startCalls, 1);

    const stream = await fetch(`${server.origin}/v1/sessions/started/events`, {
      headers: authHeaders(),
    });
    const replay = await readUntil(stream, (text) => text.includes("id: 1\n"));
    assert.match(replay, /event: run_state/u);
  });
});

test("serve advances replay-gap IDs when no event fits the replay buffer", async () => {
  const session = new FakeSession("empty-replay");
  const server = await startServeServer({
    token: TOKEN,
    maxReplayBytes: 1,
    sessionFactory: {
      async create() { return session; },
      async open() { return undefined; },
    },
  });
  await closeAfter(server, async () => {
    await fetch(`${server.origin}/v1/sessions`, {
      method: "POST",
      headers: authHeaders(true),
      body: "{}",
    });
    await session.emit(1);
    const stream = await fetch(`${server.origin}/v1/sessions/empty-replay/events`, {
      headers: authHeaders(),
    });
    const replay = await readUntil(stream, (text) => text.includes("event: replay_gap"));
    assert.match(replay, /id: 1\nevent: replay_gap/u);
    assert.match(replay, /"oldestAvailableId":null/u);
  });
});

test("serve event observation never throws into the session runtime", async () => {
  const session = new FakeSession("observer");
  const server = await startServeServer({
    token: TOKEN,
    sessionFactory: {
      async create() { return session; },
      async open() { return undefined; },
    },
  });
  await closeAfter(server, async () => {
    await fetch(`${server.origin}/v1/sessions`, {
      method: "POST",
      headers: authHeaders(true),
      body: "{}",
    });
    const circular: CircularDetails = {};
    circular.self = circular;
    const invalid: EventEnvelope = {
      eventId: "invalid",
      threadId: "observer",
      sequence: 1,
      timestamp: new Date().toISOString(),
      schemaVersion: 1,
      event: { type: "warning", code: "invalid", message: "invalid" },
    };
    Object.defineProperty(invalid.event, "details", { value: circular });
    await assert.doesNotReject(async () => await session.emitEnvelope(invalid));
  });
});

test("serve bounds session and event-stream ownership", async () => {
  let createCalls = 0;
  const sessions: FakeSession[] = [];
  const factory: ServeSessionFactory = {
    async create() {
      createCalls += 1;
      const session = new FakeSession(`bounded-${createCalls}`);
      sessions.push(session);
      return session;
    },
    async open() { return undefined; },
  };
  const server = await startServeServer({
    token: TOKEN,
    sessionFactory: factory,
    maxSessions: 1,
    maxClientsPerSession: 1,
  });
  await closeAfter(server, async () => {
    const first = await fetch(`${server.origin}/v1/sessions`, {
      method: "POST",
      headers: authHeaders(true),
      body: "{}",
    });
    assert.equal(first.status, 201);

    const full = await fetch(`${server.origin}/v1/sessions`, {
      method: "POST",
      headers: authHeaders(true),
      body: "{}",
    });
    assert.equal(full.status, 503);
    assert.equal(createCalls, 1);

    const stream = await fetch(`${server.origin}/v1/sessions/bounded-1/events`, {
      headers: authHeaders(),
    });
    assert.equal(stream.status, 200);
    const extraStream = await fetch(`${server.origin}/v1/sessions/bounded-1/events`, {
      headers: authHeaders(),
    });
    assert.equal(extraStream.status, 503);
    await stream.body?.cancel();

    const closed = await fetch(`${server.origin}/v1/sessions/bounded-1`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    assert.equal(closed.status, 200);
    assert.deepEqual(await closed.json(), { closed: true, sessionId: "bounded-1" });
    assert.equal(sessions[0]?.closeCalls, 1);

    const replacement = await fetch(`${server.origin}/v1/sessions`, {
      method: "POST",
      headers: authHeaders(true),
      body: "{}",
    });
    assert.equal(replacement.status, 201);
    assert.equal(createCalls, 2);
  });
});

test("serve action routing does not shadow a valid session named open", async () => {
  const session = new FakeSession("open");
  const server = await startServeServer({
    token: TOKEN,
    sessionFactory: {
      async create() { return session; },
      async open() { return undefined; },
    },
  });
  await closeAfter(server, async () => {
    await fetch(`${server.origin}/v1/sessions`, {
      method: "POST",
      headers: authHeaders(true),
      body: "{}",
    });
    const state = await fetch(`${server.origin}/v1/sessions/open`, {
      headers: authHeaders(),
    });
    assert.equal(state.status, 200);
    const removed = await fetch(`${server.origin}/v1/sessions/open`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    assert.equal(removed.status, 200);
  });
});

test("serve applies the storage session ID contract before opening sessions", async () => {
  let openCalls = 0;
  const server = await startServeServer({
    token: TOKEN,
    sessionFactory: {
      async create() { throw new Error("not used"); },
      async open() {
        openCalls += 1;
        return undefined;
      },
    },
  });
  await closeAfter(server, async () => {
    const opened = await fetch(`${server.origin}/v1/sessions/open`, {
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify({ sessionId: "nested/session" }),
    });
    assert.equal(opened.status, 400);

    const state = await fetch(`${server.origin}/v1/sessions/%2Dedge`, {
      headers: authHeaders(),
    });
    assert.equal(state.status, 400);
    assert.equal(openCalls, 0);
  });
});

test("serve single-flights concurrent opens for one session", async () => {
  const session = new FakeSession("shared");
  let openCalls = 0;
  const server = await startServeServer({
    token: TOKEN,
    sessionFactory: {
      async create() { throw new Error("not used"); },
      async open() {
        openCalls += 1;
        await new Promise<void>((resolveWait) => setTimeout(resolveWait, 25));
        return session;
      },
    },
  });
  await closeAfter(server, async () => {
    const request = (): Promise<Response> => fetch(`${server.origin}/v1/sessions/open`, {
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify({ sessionId: "shared" }),
    });
    const [first, second] = await Promise.all([request(), request()]);
    assert.deepEqual([first.status, second.status], [200, 200]);
    assert.equal(openCalls, 1);
    assert.equal(session.closeCalls, 0);
  });
});

test("serve cancels an abandoned open before a late runtime can register", async () => {
  const session = new FakeSession("abandoned-open");
  let factorySignal: AbortSignal | undefined;
  let openEntered!: () => void;
  const entered = new Promise<void>((resolveEntered) => { openEntered = resolveEntered; });
  let factoryAborted!: () => void;
  const aborted = new Promise<void>((resolveAborted) => { factoryAborted = resolveAborted; });
  let releaseOpen!: () => void;
  const gate = new Promise<void>((resolveOpen) => { releaseOpen = resolveOpen; });
  let runtimeClosed!: () => void;
  const closed = new Promise<void>((resolveClosed) => { runtimeClosed = resolveClosed; });
  session.closeHandler = runtimeClosed;
  const server = await startServeServer({
    token: TOKEN,
    sessionFactory: {
      async create() { throw new Error("not used"); },
      async open(_request, signal) {
        factorySignal = signal;
        signal.addEventListener("abort", factoryAborted, { once: true });
        openEntered();
        await gate;
        return session;
      },
    },
  });
  await closeAfter(server, async () => {
    const controller = new AbortController();
    const opening = fetch(`${server.origin}/v1/sessions/open`, {
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify({ sessionId: session.sessionId }),
      signal: controller.signal,
    });
    await within(entered, 2_000, "abandoned open factory");
    controller.abort();
    try {
      await assert.rejects(opening, /abort/iu);
      await within(aborted, 2_000, "abandoned open cancellation");
      assert.equal(factorySignal?.aborted, true);
    } finally {
      releaseOpen();
    }
    await within(closed, 2_000, "late opened runtime cleanup");
    const state = await fetch(`${server.origin}/v1/sessions/${session.sessionId}`, {
      headers: authHeaders(),
    });
    assert.equal(state.status, 404);
    assert.equal(session.closeCalls, 1);
  });
});

test("serve keeps concurrent open flights separate across resolved workspaces", async () => {
  const firstSession = new FakeSession("shared-workspace-id");
  const secondSession = new FakeSession("shared-workspace-id");
  const workspaces: string[] = [];
  let bothEntered!: () => void;
  const entered = new Promise<void>((resolveEntered) => { bothEntered = resolveEntered; });
  let releaseOpen!: () => void;
  const gate = new Promise<void>((resolveOpen) => { releaseOpen = resolveOpen; });
  const server = await startServeServer({
    token: TOKEN,
    sessionFactory: {
      async resolveWorkspace(workspace) {
        if (workspace === "first-alias") return "/workspace/first";
        if (workspace === "second-alias") return "/workspace/second";
        return workspace ?? "/workspace/default";
      },
      async create() { throw new Error("not used"); },
      async open(request) {
        workspaces.push(request.workspace!);
        if (workspaces.length === 2) bothEntered();
        await gate;
        return request.workspace === "/workspace/first" ? firstSession : secondSession;
      },
    },
  });
  await closeAfter(server, async () => {
    const open = (workspace: string): Promise<Response> => fetch(`${server.origin}/v1/sessions/open`, {
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify({ sessionId: "shared-workspace-id", workspace }),
    });
    const first = open("first-alias");
    const second = open("second-alias");
    try {
      await within(entered, 2_000, "both workspace opens");
    } finally {
      releaseOpen();
    }
    const responses = await Promise.all([first, second]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
    assert.deepEqual(workspaces.sort(), ["/workspace/first", "/workspace/second"]);
    assert.equal(firstSession.closeCalls + secondSession.closeCalls, 1);

    const winner = responses[0]!.status === 200 ? "first-alias" : "second-alias";
    const loser = winner === "first-alias" ? "second-alias" : "first-alias";
    assert.equal((await open(winner)).status, 200);
    assert.equal((await open(loser)).status, 409);
    assert.equal(workspaces.length, 2);
  });
});

test("serve aborts one open waiter without cancelling the shared open", async () => {
  const session = new FakeSession("abortable-waiter");
  let factorySignal: AbortSignal | undefined;
  let openEntered!: () => void;
  const entered = new Promise<void>((resolveEntered) => { openEntered = resolveEntered; });
  let twoResolved!: () => void;
  const resolvedTwice = new Promise<void>((resolveResolved) => { twoResolved = resolveResolved; });
  let resolveCalls = 0;
  let openCalls = 0;
  let releaseOpen!: () => void;
  const gate = new Promise<void>((resolveOpen) => { releaseOpen = resolveOpen; });
  const server = await startServeServer({
    token: TOKEN,
    sessionFactory: {
      async resolveWorkspace() {
        resolveCalls += 1;
        if (resolveCalls === 2) twoResolved();
        return "/workspace/shared";
      },
      async create() { throw new Error("not used"); },
      async open(_request, signal) {
        openCalls += 1;
        factorySignal = signal;
        openEntered();
        await gate;
        signal.throwIfAborted();
        return session;
      },
    },
  });
  await closeAfter(server, async () => {
    const request = (workspace: string, signal?: AbortSignal): Promise<Response> => {
      const options: RequestInit = {
        method: "POST",
        headers: authHeaders(true),
        body: JSON.stringify({ sessionId: "abortable-waiter", workspace }),
      };
      if (signal !== undefined) options.signal = signal;
      return fetch(`${server.origin}/v1/sessions/open`, options);
    };
    const controller = new AbortController();
    const first = request("first-alias", controller.signal);
    const firstRejected = assert.rejects(first, /abort/iu);
    await within(entered, 2_000, "shared open factory");
    const second = request("second-alias");
    await within(resolvedTwice, 2_000, "both workspace resolutions");
    controller.abort();
    try {
      await firstRejected;
      assert.equal(factorySignal?.aborted, false);
    } finally {
      releaseOpen();
    }
    assert.equal((await second).status, 200);
    assert.equal(resolveCalls, 2);
    assert.equal(openCalls, 1);
    assert.equal(session.closeCalls, 0);
  });
});

test("serve keeps a closing session authoritative until its writer closes", async () => {
  const session = new FakeSession("closing");
  const replacement = new FakeSession("closing");
  let closeEntered!: () => void;
  const entered = new Promise<void>((resolveEntered) => { closeEntered = resolveEntered; });
  let releaseClose!: () => void;
  const closeGate = new Promise<void>((resolveClose) => { releaseClose = resolveClose; });
  session.closeHandler = async () => {
    closeEntered();
    await closeGate;
  };
  let openCalls = 0;
  const server = await startServeServer({
    token: TOKEN,
    sessionFactory: {
      async create() { return session; },
      async open() {
        openCalls += 1;
        return replacement;
      },
    },
  });
  await closeAfter(server, async () => {
    await fetch(`${server.origin}/v1/sessions`, {
      method: "POST",
      headers: authHeaders(true),
      body: "{}",
    });
    const closing = fetch(`${server.origin}/v1/sessions/closing`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    await entered;

    const overlappingOpen = await fetch(`${server.origin}/v1/sessions/open`, {
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify({ sessionId: "closing" }),
    });
    assert.equal(overlappingOpen.status, 409);
    assert.equal(openCalls, 0);

    releaseClose();
    assert.equal((await closing).status, 200);
    const reopened = await fetch(`${server.origin}/v1/sessions/open`, {
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify({ sessionId: "closing" }),
    });
    assert.equal(reopened.status, 200);
    assert.equal(openCalls, 1);
  });
});

test("serve shutdown waits for a session close already started by DELETE", async () => {
  const session = new FakeSession("closing-on-shutdown");
  let closeEntered!: () => void;
  const entered = new Promise<void>((resolveEntered) => { closeEntered = resolveEntered; });
  let releaseClose!: () => void;
  const closeGate = new Promise<void>((resolveClose) => { releaseClose = resolveClose; });
  session.closeHandler = async () => {
    closeEntered();
    await closeGate;
  };
  const server = await startServeServer({
    token: TOKEN,
    sessionFactory: {
      async create() { return session; },
      async open() { return undefined; },
    },
  });
  await fetch(`${server.origin}/v1/sessions`, {
    method: "POST",
    headers: authHeaders(true),
    body: "{}",
  });
  const deleting = fetch(`${server.origin}/v1/sessions/closing-on-shutdown`, {
    method: "DELETE",
    headers: authHeaders(),
  }).catch(() => undefined);
  await entered;

  const closing = server.close().then(() => "closed");
  const early = await Promise.race([
    closing,
    new Promise<string>((resolveWait) => setTimeout(() => resolveWait("waiting"), 50)),
  ]);
  assert.equal(early, "waiting");
  releaseClose();
  assert.equal(await closing, "closed");
  await deleting;
  assert.equal(session.closeCalls, 1);
});

test("serve closes without waiting for an in-flight factory socket", async () => {
  let factorySignal: AbortSignal | undefined;
  let entered!: () => void;
  const factoryEntered = new Promise<void>((resolveEntered) => { entered = resolveEntered; });
  const server = await startServeServer({
    token: TOKEN,
    sessionFactory: {
      async create(_request, signal): Promise<ServeSessionRuntime> {
        factorySignal = signal;
        entered();
        return await new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
      async open() { return undefined; },
    },
  });
  const pendingRequest = fetch(`${server.origin}/v1/sessions`, {
    method: "POST",
    headers: authHeaders(true),
    body: "{}",
  }).catch(() => undefined);
  await factoryEntered;
  const result = await Promise.race([
    server.close().then(() => "closed"),
    new Promise<string>((resolveWait) => setTimeout(() => resolveWait("timeout"), 500)),
  ]);
  assert.equal(result, "closed");
  assert.equal(factorySignal?.aborted, true);
  await pendingRequest;
});

test("serve delivers an SSE event larger than the writable high-water mark to a healthy reader", async () => {
  const session = new FakeSession("healthy-client");
  const server = await startServeServer({
    token: TOKEN,
    sessionFactory: {
      async create() { return session; },
      async open() { return undefined; },
    },
  });
  await closeAfter(server, async () => {
    await fetch(`${server.origin}/v1/sessions`, {
      method: "POST",
      headers: authHeaders(true),
      body: "{}",
    });
    const stream = await fetch(`${server.origin}/v1/sessions/healthy-client/events`, {
      headers: authHeaders(),
    });
    const marker = "healthy-large-event-complete";
    const received = readUntil(stream, (text) => text.includes(marker));
    await session.emitEnvelope({
      eventId: "large",
      threadId: "healthy-client",
      sequence: 1,
      timestamp: new Date().toISOString(),
      schemaVersion: 1,
      event: {
        type: "warning",
        code: "large",
        message: `${"x".repeat(256 * 1024)}${marker}`,
      },
    });
    const text = await within(received, 2_000, "large SSE event");
    assert.match(text, /id: 1\nevent: warning/u);
    assert.match(text, new RegExp(`${marker}"`, "u"));
  });
});

test("serve drops a stalled SSE reader after its bounded queue fills", async () => {
  const session = new FakeSession("stalled-client");
  const server = await startServeServer({
    token: TOKEN,
    sessionFactory: {
      async create() { return session; },
      async open() { return undefined; },
    },
  });
  await closeAfter(server, async () => {
    await fetch(`${server.origin}/v1/sessions`, {
      method: "POST",
      headers: authHeaders(true),
      body: "{}",
    });

    const socket = connect({ host: server.host, port: server.port });
    socket.setEncoding("latin1");
    socket.on("error", () => undefined);
    let response = "";
    const ready = new Promise<void>((resolveReady) => {
      socket.on("data", (chunk: string) => {
        response += chunk;
        if (response.includes("retry: 1000\n\n")) resolveReady();
      });
    });
    const closed = new Promise<void>((resolveClosed) => {
      socket.once("close", () => resolveClosed());
    });
    try {
      await within(new Promise<void>((resolveConnect, reject) => {
        socket.once("connect", resolveConnect);
        socket.once("error", reject);
      }), 2_000, "stalled SSE connection");
      socket.write([
        "GET /v1/sessions/stalled-client/events HTTP/1.1",
        `Host: ${server.host}:${server.port}`,
        `Authorization: Bearer ${TOKEN}`,
        "Accept: text/event-stream",
        "Connection: keep-alive",
        "",
        "",
      ].join("\r\n"));
      await within(ready, 2_000, "stalled SSE response");
      socket.pause();

      for (let sequence = 1; sequence <= 6; sequence += 1) {
        await session.emitEnvelope({
          eventId: `large-${sequence}`,
          threadId: "stalled-client",
          sequence,
          timestamp: new Date(sequence).toISOString(),
          schemaVersion: 1,
          event: {
            type: "warning",
            code: `large-${sequence}`,
            message: "x".repeat(256 * 1024),
          },
        });
      }
      await within(closed, 2_000, "stalled SSE eviction");

      const state = await fetch(`${server.origin}/v1/sessions/stalled-client`, {
        headers: authHeaders(),
      });
      assert.equal(state.status, 200);
    } finally {
      socket.destroy();
    }
  });
});

test("serve shutdown ends SSE clients and aborts then closes every session", async () => {
  const session = new FakeSession("shutdown");
  const factory: ServeSessionFactory = {
    async create() { return session; },
    async open() { return undefined; },
  };
  const server = await startServeServer({ token: TOKEN, sessionFactory: factory });
  const create = await fetch(`${server.origin}/v1/sessions`, {
    method: "POST",
    headers: authHeaders(true),
    body: "{}",
  });
  assert.equal(create.status, 201);

  const stream = await fetch(`${server.origin}/v1/sessions/shutdown/events`, {
    headers: authHeaders(),
  });
  assert.equal(stream.status, 200);
  assert.ok(stream.body);
  const reader = stream.body.getReader();
  const first = await reader.read();
  assert.equal(first.done, false);

  await server.close();
  const ended = await reader.read();
  assert.equal(ended.done, true);
  assert.deepEqual(session.abortReasons, ["Serve server closed"]);
  assert.equal(session.closeCalls, 1);
  await server.close();
});
