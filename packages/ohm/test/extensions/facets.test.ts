import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Type } from "typebox";

import type { ExtensionAPI } from "../../src/extensions/direct.js";
import type { ExtensionContext } from "../../src/extensions/capabilities/host.js";
import {
  EXTENSION_FACET_API_VERSION,
  MAX_EXTENSION_FACETS,
  extensionFacetApplies,
  extensionFacetStateServiceName,
  type ExtensionFacetRegistration,
  type ExtensionFacetSharedState,
  type ExtensionPortablePresentationRegistration,
} from "../../src/extensions/facets.js";
import { ExtensionFacetCoordinator } from "../../src/extensions/runtime-internal/facet-coordinator.js";
import {
  REPLICATED_JSON_STATE_LIMITS,
  type ReplicatedJsonState,
  type ReplicatedJsonStateDelta,
} from "../../src/extensions/replicated-state.js";
import {
  createExtensionWireServiceEndpoint,
  defineExtensionWireService,
  extensionWireServiceRegistryName,
  extensionWireServiceRequest,
  type ExtensionWireServiceEndpoint,
} from "../../src/extensions/wire-services.js";
import { loadDirectExtensions } from "../../src/extensions/runtime.js";
import {
  PORTABLE_PRESENTATION_LIMITS,
  PORTABLE_PRESENTATION_PROTOCOL_VERSION,
  createPortablePresentation,
  definePortablePresentationAction,
  type PortablePresentationActionRequest,
  type PortablePresentationDefinition,
  type PortablePresentationEvent,
} from "../../src/interfaces/portable-presentation.js";
import { MAX_RPC_LINE_BYTES, serializeJsonLine } from "../../src/interfaces/rpc.js";

const SERVICE = defineExtensionWireService({
  name: "facet.health",
  version: 1,
  requestSchema: Type.Object({ ping: Type.String() }, { additionalProperties: false }),
  responseSchema: Type.Object({ pong: Type.String() }, { additionalProperties: false }),
});

async function temporaryWorkspace(context: test.TestContext): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "ohm-facets-"));
  context.after(async () => await rm(path, { recursive: true, force: true }));
  return path;
}

test("facet lifecycles own worker services, per-session state, and portable presentations", async (context) => {
  const workspace = await temporaryWorkspace(context);
  const lifecycle: string[] = [];
  let api: ExtensionAPI | undefined;
  let worker: ExtensionFacetRegistration | undefined;
  let sessionState: ReplicatedJsonState | undefined;
  let sharedState: ExtensionFacetSharedState<{ count: number }> | undefined;
  const host = await loadDirectExtensions([], {
    workspace,
    mode: "rpc",
    activationFailure: "throw",
    inlineExtensions: [{
      name: "facet-fixture",
      async factory(extension) {
        api = extension;
        worker = await extension.facets.register({
          apiVersion: EXTENSION_FACET_API_VERSION,
          kind: "worker",
          name: "health",
          setup(facet) {
            lifecycle.push(`start:${facet.kind}:${facet.mode}`);
            sharedState = facet.states.open("shared", { count: 0 });
            facet.services.provide(SERVICE, ({ ping }) => ({ pong: ping }));
            return () => { lifecycle.push("stop:worker"); };
          },
        });
        await extension.facets.register({
          apiVersion: EXTENSION_FACET_API_VERSION,
          kind: "session",
          name: "state",
          setup(facet) {
            lifecycle.push(`start:${facet.kind}:${facet.mode}`);
            sessionState = facet.createState({ status: "ready" });
            const shared = facet.states.get<{ count: number }>("shared");
            assert.equal(shared, sharedState);
            shared?.update([{ type: "set", path: ["count"], value: 1 }]);
            return () => { lifecycle.push("stop:session"); };
          },
        });
        await extension.facets.register({
          apiVersion: EXTENSION_FACET_API_VERSION,
          kind: "presentation",
          name: "status",
          setup(facet) {
            lifecycle.push(`start:${facet.kind}:${facet.mode}`);
            facet.presentation.show({
              id: "status",
              revision: 1,
              blocks: [{ type: "text", text: "Ready" }],
              actions: [definePortablePresentationAction({
                id: "acknowledge",
                label: "Acknowledge",
                inputSchema: Type.Object({ note: Type.String() }, { additionalProperties: false }),
                run: (input) => ({ received: input.note }),
              })],
            });
            return () => { lifecycle.push("stop:presentation"); };
          },
        });
        for (const kind of ["rich-tui", "web", "desktop"] as const) {
          await extension.facets.register({
            apiVersion: EXTENSION_FACET_API_VERSION,
            kind,
            name: kind.replace("-", "_"),
            setup() { lifecycle.push(`unexpected:${kind}`); },
          });
        }
      },
    }],
  });
  context.after(async () => await host.close());
  assert.ok(api !== undefined);
  assert.ok(worker !== undefined);

  const presentations: PortablePresentationEvent[] = [];
  const unsubscribe = host.onPortablePresentation((event) => presentations.push(event));
  await host.dispatch("session_start", { reason: "startup", threadId: "facet-session" });
  assert.deepEqual(lifecycle, [
    "start:worker:worker",
    "start:session:rpc",
    "start:presentation:rpc",
  ]);
  const endpoint = api.services.get<ExtensionWireServiceEndpoint>(
    extensionWireServiceRegistryName(SERVICE),
  );
  assert.ok(endpoint !== undefined);
  assert.deepEqual(
    await endpoint.request(extensionWireServiceRequest(SERVICE, "health-1", { ping: "ready" })),
    {
      protocolVersion: 1,
      service: "facet.health",
      serviceVersion: 1,
      id: "health-1",
      ok: true,
      payload: { pong: "ready" },
    },
  );
  assert.deepEqual(sessionState?.snapshot().value, { status: "ready" });
  assert.deepEqual(sharedState?.snapshot().value, { count: 1 });
  assert.equal("close" in (sharedState ?? {}), false);
  const shown = presentations.find((event) => event.operation === "show");
  assert.ok(shown?.operation === "show");
  assert.deepEqual(await host.invokePortablePresentationAction({
    protocolVersion: PORTABLE_PRESENTATION_PROTOCOL_VERSION,
    owner: shown.owner,
    presentationId: shown.presentation.id,
    revision: shown.presentation.revision,
    actionId: "acknowledge",
    input: { note: "seen" },
  }), {
    protocolVersion: 1,
    owner: shown.owner,
    presentationId: "status",
    revision: 1,
    actionId: "acknowledge",
    result: { received: "seen" },
  });

  const stateService = extensionFacetStateServiceName(shown.owner, "shared");
  const stateDescriptor = host.extensionWireServices().find((service) => service.name === stateService);
  assert.ok(stateDescriptor !== undefined);
  assert.equal(stateDescriptor.owner, shown.owner);
  assert.ok(Array.isArray(stateDescriptor.responseSchema.anyOf));
  assert.ok(Object.isFrozen(stateDescriptor.requestSchema));
  assert.deepEqual(await host.invokeExtensionWireService({
    protocolVersion: 1,
    service: stateService,
    serviceVersion: 1,
    id: "state-1",
    payload: { operation: "deltas_since", revision: 0 },
  }), {
    protocolVersion: 1,
    service: stateService,
    serviceVersion: 1,
    id: "state-1",
    ok: true,
    payload: {
      operation: "deltas_since",
      deltas: [{
        protocolVersion: 1,
        baseRevision: 0,
        revision: 1,
        operations: [{ type: "set", path: ["count"], value: 1 }],
      }],
    },
  });

  await host.dispatch("session_shutdown", { reason: "quit" });
  assert.equal(sessionState?.closed, true);
  assert.equal(sharedState?.closed, false);
  assert.deepEqual(lifecycle.slice(-2), ["stop:session", "stop:presentation"]);
  assert.equal(presentations.at(-1)?.operation, "remove");
  await worker.dispose();
  assert.equal(api.services.get(extensionWireServiceRegistryName(SERVICE)), undefined);
  assert.equal(lifecycle.at(-1), "stop:worker");
  unsubscribe();
  await host.dispatch("session_start", { reason: "startup", threadId: "facet-session-2" });
  assert.equal(sharedState?.snapshot().revision, 2);
  assert.deepEqual(sharedState?.snapshot().value, { count: 1 });
  await host.dispatch("session_shutdown", { reason: "quit" });
  await host.close();
  assert.equal(sharedState?.closed, true);
});

test("wire service discovery rejects an oversized aggregate catalog deterministically", async (context) => {
  const workspace = await temporaryWorkspace(context);
  const description = "schema".repeat(8_000);
  const host = await loadDirectExtensions([], {
    workspace,
    activationFailure: "throw",
    inlineExtensions: [{
      name: "large-catalog",
      factory(extension) {
        for (let index = 0; index < 24; index += 1) {
          const contract = defineExtensionWireService({
            name: `catalog.fixture.${index}`,
            version: 1,
            requestSchema: Type.Object({ value: Type.String() }, {
              additionalProperties: false,
              description,
            }),
            responseSchema: Type.Object({ value: Type.String() }, {
              additionalProperties: false,
              description,
            }),
          });
          extension.services.register(
            extensionWireServiceRegistryName(contract),
            createExtensionWireServiceEndpoint(contract, ({ value }) => ({ value })),
          );
        }
      },
    }],
  });
  context.after(async () => await host.close());
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.throws(
      () => host.extensionWireServices(),
      /catalog exceeds 2097152 bytes/u,
    );
  }
});

test("named-state wire transport carries a locally valid maximum-sized delta", async (context) => {
  const workspace = await temporaryWorkspace(context);
  const host = await loadDirectExtensions([], {
    workspace,
    mode: "rpc",
    activationFailure: "throw",
    inlineExtensions: [{
      name: "edge-state",
      async factory(extension) {
        await extension.facets.register({
          apiVersion: EXTENSION_FACET_API_VERSION,
          kind: "worker",
          name: "state",
          setup(facet) {
            facet.states.open("edge", { blob: "" });
          },
        });
      },
    }],
  });
  context.after(async () => await host.close());
  await host.dispatch("session_start", { reason: "startup", threadId: "edge-state" });
  const descriptor = host.extensionWireServices().find((service) => service.name.endsWith(".edge"));
  assert.ok(descriptor !== undefined);
  assert.equal(descriptor.maxRequestBytes, 512 * 1024);

  const emptyDelta: ReplicatedJsonStateDelta = {
    protocolVersion: 1,
    baseRevision: 0,
    revision: 1,
    operations: [{ type: "set", path: ["blob"], value: "" }],
  };
  const emptyBytes = Buffer.byteLength(JSON.stringify(emptyDelta), "utf8");
  const delta: ReplicatedJsonStateDelta = {
    ...emptyDelta,
    operations: [{
      type: "set",
      path: ["blob"],
      value: "x".repeat(REPLICATED_JSON_STATE_LIMITS.maxDeltaBytes - emptyBytes - 8),
    }],
  };
  assert.ok(Buffer.byteLength(JSON.stringify(delta), "utf8") <= REPLICATED_JSON_STATE_LIMITS.maxDeltaBytes);
  assert.ok(Buffer.byteLength(JSON.stringify({ operation: "apply", delta }), "utf8") > 256 * 1024);
  const response = await host.invokeExtensionWireService({
    protocolVersion: 1,
    service: descriptor.name,
    serviceVersion: descriptor.version,
    id: "edge-state-apply",
    payload: { operation: "apply", delta } as never,
  });
  assert.equal(response.ok, true);
});

test("facet validation keeps rich terminal code host-only and reserves future web and desktop vocabulary", () => {
  assert.equal(extensionFacetApplies("session", "serve", { components: false }), true);
  assert.equal(extensionFacetApplies("presentation", "rpc", { components: false }), true);
  assert.equal(extensionFacetApplies("rich-tui", "tui", { components: true }), true);
  assert.equal(extensionFacetApplies("rich-tui", "tui", { components: false }), false);
  assert.equal(extensionFacetApplies("rich-tui", "rpc", { components: true }), false);
  assert.equal(extensionFacetApplies("web", "serve", { components: false }), false);
  assert.equal(extensionFacetApplies("desktop", "sdk", { components: false }), false);
});

test("worker presentations replay across TUI hosts and cross-facet removal clears rich projection", async () => {
  const lifecycle = new AbortController();
  const sessionStarts: Array<(context: ExtensionContext) => void | Promise<void>> = [];
  const sessionShutdowns: Array<() => void | Promise<void>> = [];
  const hosted = new Map<string, ExtensionPortablePresentationRegistration>();
  const widgets = new Map<string, readonly string[] | undefined>();
  const notifications: string[] = [];
  const coordinator = new ExtensionFacetCoordinator({
    owner: "fixture.extension",
    signal: lifecycle.signal,
    committed: () => false,
    extension: () => ({} as ExtensionAPI),
    onSessionStart(handler) {
      sessionStarts.push(handler);
      return () => {
        const index = sessionStarts.indexOf(handler);
        if (index >= 0) sessionStarts.splice(index, 1);
      };
    },
    onSessionShutdown(handler) {
      sessionShutdowns.push(handler);
      return () => {
        const index = sessionShutdowns.indexOf(handler);
        if (index >= 0) sessionShutdowns.splice(index, 1);
      };
    },
    showPresentation(definition: PortablePresentationDefinition, signal: AbortSignal) {
      let controller = createPortablePresentation("fixture.extension", definition, { signal });
      let disposed = false;
      const registration: ExtensionPortablePresentationRegistration = Object.freeze({
        get disposed() { return disposed; },
        get document() { return controller.document; },
        update(next: PortablePresentationDefinition) {
          controller = createPortablePresentation("fixture.extension", next, { signal });
        },
        async invoke(request: PortablePresentationActionRequest, actionSignal?: AbortSignal) {
          return await controller.invoke(request, actionSignal);
        },
        dispose() {
          disposed = true;
          hosted.delete(controller.document.id);
        },
      });
      hosted.set(controller.document.id, registration);
      return registration;
    },
    removePresentation(id) { hosted.get(id)?.dispose(); },
  });
  let removedView: ExtensionPortablePresentationRegistration | undefined;
  await coordinator.register({
    apiVersion: 1,
    kind: "worker",
    name: "views",
    setup(facet) {
      removedView = facet.presentation.show({
        id: "worker",
        blocks: [{ type: "text", text: "Worker" }],
      });
      facet.presentation.show({
        id: "persistent",
        blocks: [{ type: "text", text: "Persistent" }],
      });
    },
  });
  await coordinator.register({
    apiVersion: 1,
    kind: "session",
    name: "remover",
    setup(facet) { facet.presentation.remove("worker"); },
  });
  await coordinator.activateWorkers();
  const context = (components: boolean): ExtensionContext => ({
    mode: "tui",
    ui: {
      capabilities: {
        components,
        notifications: true,
        textWidgets: components,
      },
      setWidget(name: string, lines: readonly string[] | undefined) { widgets.set(name, lines); },
      notify(message: string) { notifications.push(message); },
    },
  }) as unknown as ExtensionContext;

  await sessionStarts[0]!(context(true));
  await sessionStarts[1]!(context(true));
  assert.deepEqual(widgets.get("facet:presentation:worker"), ["Worker"]);
  assert.deepEqual(widgets.get("facet:presentation:persistent"), ["Persistent"]);
  await sessionStarts[2]!(context(true));
  assert.equal(removedView?.disposed, true);
  assert.equal(widgets.get("facet:presentation:worker"), undefined);

  for (const shutdown of Array.from(sessionShutdowns)) await shutdown();
  for (const start of Array.from(sessionStarts)) await start(context(false));
  assert.deepEqual(notifications, ["Persistent"]);
  await coordinator.close();
});

test("failed facet setup cleans generation-owned state and services, and registration count is bounded", async (context) => {
  const workspace = await temporaryWorkspace(context);
  let api: ExtensionAPI | undefined;
  const host = await loadDirectExtensions([], {
    workspace,
    activationFailure: "throw",
    inlineExtensions: [(extension) => { api = extension; }],
  });
  context.after(async () => await host.close());
  assert.ok(api !== undefined);
  let failedState: ReplicatedJsonState | undefined;
  let failedSharedState: ExtensionFacetSharedState | undefined;
  await assert.rejects(api.facets.register({
    apiVersion: EXTENSION_FACET_API_VERSION,
    kind: "worker",
    name: "fails",
    setup(facet) {
      failedState = facet.createState({ transient: true });
      failedSharedState = facet.states.open("transient", { transient: true });
      facet.services.provide(SERVICE, () => ({ pong: "unreachable" }));
      throw new Error("setup failed");
    },
  }), /setup failed/u);
  const closedFailedState = failedState as ReplicatedJsonState | undefined;
  const closedFailedSharedState = failedSharedState as ExtensionFacetSharedState | undefined;
  assert.equal(closedFailedState?.closed, true);
  assert.equal(closedFailedSharedState?.closed, true);
  assert.equal(api.services.get(extensionWireServiceRegistryName(SERVICE)), undefined);
  assert.equal(host.extensionWireServices().some((service) => service.name.endsWith(".transient")), false);

  for (let index = 0; index < MAX_EXTENSION_FACETS * 2; index += 1) {
    const registration = await api.facets.register({
      apiVersion: EXTENSION_FACET_API_VERSION,
      kind: "web",
      name: "churn",
      setup() {},
    });
    await registration.dispose();
  }

  const registrations: ExtensionFacetRegistration[] = [];
  for (let index = 0; index < MAX_EXTENSION_FACETS; index += 1) {
    registrations.push(await api.facets.register({
      apiVersion: EXTENSION_FACET_API_VERSION,
      kind: "web",
      name: `future_${index}`,
      setup() {},
    }));
  }
  await assert.rejects(api.facets.register({
    apiVersion: EXTENSION_FACET_API_VERSION,
    kind: "web",
    name: "overflow",
    setup() {},
  }), /exceed/u);
  await Promise.all(registrations.map(async (registration) => await registration.dispose()));
});

test("a rolled-back extension generation never starts its worker facets", async (context) => {
  const workspace = await temporaryWorkspace(context);
  let workerStarts = 0;
  await assert.rejects(loadDirectExtensions([], {
    workspace,
    activationFailure: "throw",
    inlineExtensions: [{
      name: "rolled-back-worker",
      async factory(extension) {
        await extension.facets.register({
          apiVersion: EXTENSION_FACET_API_VERSION,
          kind: "worker",
          name: "must_not_start",
          setup() {
            workerStarts += 1;
          },
        });
        throw new Error("factory rollback");
      },
    }],
  }), /factory rollback/u);
  assert.equal(workerStarts, 0);
});

test("a committed extension generation starts worker facets before any session binds", async (context) => {
  const workspace = await temporaryWorkspace(context);
  let workerStarts = 0;
  let markSetupEntered!: () => void;
  let releaseSetup!: () => void;
  const setupEntered = new Promise<void>((resolve) => { markSetupEntered = resolve; });
  const setupGate = new Promise<void>((resolve) => { releaseSetup = resolve; });
  let loadSettled = false;
  const loading = loadDirectExtensions([], {
    workspace,
    activationFailure: "throw",
    inlineExtensions: [{
      name: "committed-worker",
      async factory(extension) {
        await extension.facets.register({
          apiVersion: EXTENSION_FACET_API_VERSION,
          kind: "worker",
          name: "starts_after_commit",
          async setup() {
            markSetupEntered();
            await setupGate;
            workerStarts += 1;
          },
        });
      },
    }],
  });
  void loading.then(
    () => { loadSettled = true; },
    () => { loadSettled = true; },
  );
  await setupEntered;
  await Promise.resolve();
  assert.equal(loadSettled, false);
  releaseSetup();
  const host = await loading;
  context.after(async () => await host.close());
  assert.equal(workerStarts, 1);
});

test("a committed worker setup failure is diagnosed without discarding other contributions", async (context) => {
  const workspace = await temporaryWorkspace(context);
  let api: ExtensionAPI | undefined;
  const host = await loadDirectExtensions([], {
    workspace,
    activationFailure: "throw",
    inlineExtensions: [{
      name: "failed-committed-worker",
      async factory(extension) {
        api = extension;
        extension.services.register("fixture.ready", Object.freeze({ ready: true }));
        await extension.facets.register({
          apiVersion: EXTENSION_FACET_API_VERSION,
          kind: "worker",
          name: "fails_after_commit",
          setup() {
            throw new Error("worker setup failed");
          },
        });
      },
    }],
  });
  context.after(async () => await host.close());
  assert.equal(api?.services.get<{ readonly ready: boolean }>("fixture.ready")?.ready, true);
  assert.match(
    host.diagnostics().map((entry) => entry.message).join("\n"),
    /Runtime worker facet activation failed: worker setup failed/u,
  );
});

test("portable presentation admission keeps every retained snapshot within its transport budget", async (context) => {
  const workspace = await temporaryWorkspace(context);
  const largeBlocks = Array.from({ length: 8 }, () => ({
    type: "text" as const,
    text: "x".repeat(63_000),
  }));
  let api: ExtensionAPI | undefined;
  let first: ExtensionPortablePresentationRegistration | undefined;
  const host = await loadDirectExtensions([], {
    workspace,
    activationFailure: "throw",
    inlineExtensions: [{
      name: "bounded-presentations",
      async factory(extension) {
        api = extension;
        await extension.facets.register({
          apiVersion: EXTENSION_FACET_API_VERSION,
          kind: "worker",
          name: "views",
          setup(facet) {
            first = facet.presentation.show({
              id: "small",
              revision: 1,
              blocks: [{ type: "text", text: "small" }],
            });
            for (let index = 0; index < 16; index += 1) {
              facet.presentation.show({
                id: `large_${index}`,
                revision: 1,
                blocks: largeBlocks,
              });
            }
          },
        });
      },
    }],
  });
  context.after(async () => await host.close());
  assert.ok(api !== undefined);
  assert.ok(first !== undefined);

  const snapshot = host.portablePresentations();
  assert.equal(snapshot.length, 17);
  assert.ok(
    Buffer.byteLength(JSON.stringify(snapshot), "utf8") <= PORTABLE_PRESENTATION_LIMITS.maxSnapshotBytes,
  );
  assert.ok(PORTABLE_PRESENTATION_LIMITS.maxSnapshotBytes <= MAX_RPC_LINE_BYTES / 2);
  assert.doesNotThrow(() => serializeJsonLine({
    type: "response",
    id: "snapshot",
    command: "get_portable_presentations",
    success: true,
    data: { presentations: snapshot },
  }));

  await assert.rejects(api.facets.register({
    apiVersion: EXTENSION_FACET_API_VERSION,
    kind: "worker",
    name: "overflow",
    setup(facet) {
      facet.presentation.show({
        id: "overflow",
        revision: 1,
        blocks: largeBlocks,
      });
    },
  }), /portable presentation snapshot exceeds 8388608 bytes/u);
  assert.equal(host.portablePresentations().length, 17);

  assert.throws(() => first?.update({
    id: "small",
    revision: 2,
    blocks: largeBlocks,
  }), /portable presentation snapshot exceeds 8388608 bytes/u);
  assert.equal(first.document.revision, 1);
  assert.equal(host.portablePresentations().length, 17);
});
