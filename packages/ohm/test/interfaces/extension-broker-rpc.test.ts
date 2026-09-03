import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SettingsManager } from "../../src/core/settings-manager.js";
import { loadDirectExtensions } from "../../src/extensions/runtime.js";
import { ProviderRegistry } from "../../src/providers/registry.js";
import { AgentSession, type AgentSessionEvent } from "../../src/service/agent-session.js";
import { SessionManager } from "../../src/storage/session-manager.js";
import {
  RpcRuntimeDispatcher,
  type RpcRuntimeDispatcherOptions,
  type RpcSessionRuntime,
} from "../../src/interfaces/rpc-runtime.js";
import type { PortablePresentationEvent } from "../../src/interfaces/portable-presentation.js";
import type { ExtensionWireServiceDescriptor } from "../../src/extensions/wire-services.js";

test("RPC projects portable views and brokers versioned extension services and actions", async () => {
  const presentationListeners = new Set<(event: PortablePresentationEvent) => void>();
  const eventListeners = new Set<(event: AgentSessionEvent) => void | Promise<void>>();
  const outputs: Parameters<RpcRuntimeDispatcherOptions["output"]>[0][] = [];
  let presentationReady = false;
  let beforeSessionInvalidate: (() => void) | undefined;
  let rebindSession: ((session: AgentSession) => Promise<void>) | undefined;
  const descriptor: ExtensionWireServiceDescriptor = {
    protocolVersion: 1,
    name: "fixture.echo",
    version: 1,
    owner: "fixture.extension",
    requestSchema: { type: "object" },
    responseSchema: { type: "object" },
    maxRequestBytes: 1024,
    maxResponseBytes: 2048,
  };
  const presentation: PortablePresentationEvent = {
    type: "portable_presentation",
    protocolVersion: 1,
    operation: "show",
    owner: "fixture.extension",
    presentation: {
      protocolVersion: 1,
      id: "status",
      revision: 1,
      blocks: [{ type: "text", text: "Ready" }],
      actions: [],
    },
  };
  const session = {
    subscribe(listener: (event: AgentSessionEvent) => void | Promise<void>) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    onPortablePresentation(listener: (event: PortablePresentationEvent) => void) {
      if (!presentationReady) return () => undefined;
      presentationListeners.add(listener);
      return () => presentationListeners.delete(listener);
    },
    listPortablePresentations() { return presentationReady ? [presentation] : []; },
    listExtensionWireServices() { return [descriptor]; },
    async invokeExtensionWireService(request: { id: string; payload: unknown }) {
      return {
        protocolVersion: 1 as const,
        service: "fixture.echo",
        serviceVersion: 1,
        id: request.id,
        ok: true as const,
        payload: request.payload as never,
      };
    },
    async invokePortablePresentationAction(request: { owner: string; presentationId: string; revision: number; actionId: string }) {
      if (request.actionId === "secret") throw new Error("database password is hunter2");
      return {
        protocolVersion: 1 as const,
        owner: request.owner,
        presentationId: request.presentationId,
        revision: request.revision,
        actionId: request.actionId,
        result: { accepted: true },
      };
    },
  } as unknown as AgentSession;
  const runtime = {
    session,
    setBeforeSessionInvalidate(callback?: () => void) { beforeSessionInvalidate = callback; },
    setRebindSession(callback?: (session: AgentSession) => Promise<void>) { rebindSession = callback; },
  } as unknown as RpcSessionRuntime;
  const dispatcher = new RpcRuntimeDispatcher({
    runtime,
    output(value) { outputs.push(value); },
    bindSession(selected) {
      if (selected === session) {
        presentationReady = true;
        for (const listener of presentationListeners) listener(presentation);
      }
    },
  });
  await dispatcher.start();
  assert.deepEqual(outputs, [presentation], "initial snapshot and matching live event are emitted once");

  assert.deepEqual(await dispatcher.dispatch({ type: "get_portable_presentations", id: "views" }), {
    type: "response",
    id: "views",
    command: "get_portable_presentations",
    success: true,
    data: { presentations: [presentation] },
  });

  assert.deepEqual(await dispatcher.dispatch({ type: "get_extension_wire_services", id: "catalog" }), {
    type: "response",
    id: "catalog",
    command: "get_extension_wire_services",
    success: true,
    data: { services: [descriptor] },
  });
  assert.deepEqual(await dispatcher.dispatch({
    type: "extension_wire_request",
    id: "invoke",
    request: {
      protocolVersion: 1,
      service: "fixture.echo",
      serviceVersion: 1,
      id: "wire-1",
      payload: { text: "hello" },
    },
  }), {
    type: "response",
    id: "invoke",
    command: "extension_wire_request",
    success: true,
    data: {
      protocolVersion: 1,
      service: "fixture.echo",
      serviceVersion: 1,
      id: "wire-1",
      ok: true,
      payload: { text: "hello" },
    },
  });

  const rejectedAction = await dispatcher.dispatch({
    type: "presentation_action",
    id: "secret-action",
    protocolVersion: 1,
    owner: "fixture.extension",
    presentationId: "status",
    revision: 1,
    actionId: "secret",
    input: {},
  });
  assert.deepEqual(rejectedAction, {
    type: "response",
    id: "secret-action",
    command: "presentation_action",
    success: false,
    error: "Portable presentation action was rejected",
  });
  assert.deepEqual(await dispatcher.dispatch({
    type: "presentation_action",
    id: "action",
    protocolVersion: 1,
    owner: "fixture.extension",
    presentationId: "status",
    revision: 1,
    actionId: "acknowledge",
    input: {},
  }), {
    type: "response",
    id: "action",
    command: "presentation_action",
    success: true,
    data: {
      protocolVersion: 1,
      owner: "fixture.extension",
      presentationId: "status",
      revision: 1,
      actionId: "acknowledge",
      result: { accepted: true },
    },
  });

  const invalid = await dispatcher.dispatch({
    type: "extension_wire_request",
    id: "invalid",
    request: {},
    extra: true,
  } as never);
  assert.equal(invalid?.success, false);

  const emptySession = {
    subscribe() { return () => undefined; },
    onPortablePresentation() { return () => undefined; },
    listPortablePresentations() { return []; },
  } as unknown as AgentSession;
  assert.ok(beforeSessionInvalidate !== undefined);
  beforeSessionInvalidate();
  assert.ok(rebindSession !== undefined);
  await rebindSession(emptySession);
  assert.deepEqual(outputs.at(-1), {
    type: "portable_presentation",
    protocolVersion: 1,
    operation: "remove",
    owner: "fixture.extension",
    presentationId: "status",
    revision: 1,
  });
  await dispatcher.close();
  assert.equal(presentationListeners.size, 0);
});

test("RPC snapshots presentations created while a real AgentSession binds extensions", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "ohm-rpc-portable-session-"));
  context.after(async () => await rm(workspace, { recursive: true, force: true }));
  const host = await loadDirectExtensions([], {
    workspace,
    mode: "rpc",
    activationFailure: "throw",
    inlineExtensions: [{
      name: "rpc-portable-session",
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
    sessionManager: SessionManager.inMemory(workspace, { id: "rpc-portable" }),
    providers: new ProviderRegistry([]),
    settingsManager: SettingsManager.inMemory(),
    extensionRunner: host,
    tools: [],
  });
  context.after(async () => await session.close());
  const outputs: Parameters<RpcRuntimeDispatcherOptions["output"]>[0][] = [];
  const runtime = {
    session,
    setBeforeSessionInvalidate() {},
    setRebindSession() {},
  } as unknown as RpcSessionRuntime;
  const dispatcher = new RpcRuntimeDispatcher({
    runtime,
    output(value) { outputs.push(value); },
    async bindSession(selected) { await selected.bindExtensions({ mode: "rpc" }); },
  });
  context.after(async () => await dispatcher.close());

  await dispatcher.start();
  assert.equal(outputs.filter((event) => event.type === "portable_presentation").length, 1);
  assert.deepEqual(outputs[0], {
    type: "portable_presentation",
    protocolVersion: 1,
    operation: "show",
    owner: "inline-rpc-portable-session",
    presentation: {
      protocolVersion: 1,
      id: "real-session",
      revision: 0,
      blocks: [{ type: "text", text: "Bound" }],
      actions: [],
    },
  });
});
