import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

import type { JsonValue } from "../../core/json.js";
import { FUNCTION_VALUE } from "../../core/value-schemas.js";
import type {
  PortablePresentationActionRequest,
  PortablePresentationActionResult,
  PortablePresentationDefinition,
  PortablePresentationDocument,
} from "../../interfaces/portable-presentation.js";
import { projectPortablePresentationToLines } from "../../interfaces/portable-presentation.js";
import {
  createReplicatedJsonState,
  type ReplicatedJsonState,
  type ReplicatedJsonStateDelta,
  type ReplicatedJsonStateOptions,
} from "../replicated-state.js";
import {
  PLUGIN_FACET_API_VERSION,
  MAX_PLUGIN_FACETS,
  MAX_PLUGIN_FACET_STATES,
  pluginFacetApplies,
  pluginFacetStateServiceName,
  validatePluginFacetDefinition,
  type PluginFacetContext,
  type PluginFacetDefinition,
  type PluginFacetRegistration,
  type PluginFacetService,
  type PluginFacetSharedState,
  type PluginPortablePresentationRegistration,
} from "../facets.js";
import {
  createPluginWireServiceProvider,
  definePluginWireService,
  type PluginWireServiceContext,
  type PluginWireServiceContract,
  type PluginWireServiceProvider,
} from "../wire-services.js";
import type { PluginAPI } from "../capabilities/api.js";
import type { PluginContext } from "../capabilities/host.js";
import type { PluginRegistrationHandle } from "../capabilities/internal/api/registration.js";
import { abortError, withAbort } from "./generation-lifecycle.js";

interface FacetPresentationRegistration extends PluginPortablePresentationRegistration {}

export interface PluginFacetCoordinatorOptions {
  readonly owner: string;
  readonly signal: AbortSignal;
  committed(): boolean;
  extension(): PluginAPI;
  onSessionStart(handler: (context: PluginContext) => void | Promise<void>): () => void;
  onSessionShutdown(handler: () => void | Promise<void>): () => void;
  showPresentation(
    definition: PortablePresentationDefinition,
    signal: AbortSignal,
    project: (document: PortablePresentationDocument) => void,
  ): FacetPresentationRegistration;
  removePresentation(id: string): void;
}

interface FacetActivation {
  readonly abort: AbortController;
  readonly cleanup: readonly (() => void | Promise<void>)[];
}

interface RegisteredFacet {
  readonly definition: PluginFacetDefinition;
  readonly listeners: readonly (() => void)[];
  activation?: FacetActivation;
  disposed: boolean;
  tail: Promise<void>;
}

interface OwnedFacetState {
  readonly state: ReplicatedJsonState;
  readonly view: PluginFacetSharedState;
  readonly service: PluginRegistrationHandle;
}

interface OwnedFacetPresentation {
  readonly kind: PluginFacetDefinition["kind"];
  readonly registration: PluginPortablePresentationRegistration;
}

const MAX_WIRE_STATE_BYTES = 768 * 1024;
const STATE_WIRE_REQUEST_SCHEMA = Type.Union([
  Type.Object({ operation: Type.Literal("snapshot") }, { additionalProperties: false }),
  Type.Object({
    operation: Type.Literal("deltas_since"),
    revision: Type.Integer({ minimum: 0 }),
  }, { additionalProperties: false }),
  Type.Object({
    operation: Type.Literal("apply"),
    delta: Type.Unknown(),
  }, { additionalProperties: false }),
]);
const STATE_WIRE_RESPONSE_SCHEMA = Type.Union([
  Type.Object({
    operation: Type.Literal("snapshot"),
    snapshot: Type.Object({
      protocolVersion: Type.Literal(1),
      revision: Type.Integer({ minimum: 0 }),
      value: Type.Unknown(),
    }, { additionalProperties: false }),
  }, { additionalProperties: false }),
  Type.Object({
    operation: Type.Literal("deltas_since"),
    deltas: Type.Array(Type.Unknown()),
  }, { additionalProperties: false }),
]);

function joinedSignal(first: AbortSignal, second: AbortSignal | undefined): AbortSignal {
  return second === undefined ? first : AbortSignal.any([first, second]);
}

async function cleanupAll(cleanups: readonly (() => void | Promise<void>)[]): Promise<void> {
  const failures: unknown[] = [];
  for (const cleanup of [...cleanups].reverse()) {
    try { await cleanup(); }
    catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Plugin facet cleanup failed");
}

/** Internal lifecycle adapter behind the additive public facet capability. */
export class PluginFacetCoordinator implements PluginFacetService {
  readonly #options: PluginFacetCoordinatorOptions;
  readonly #registrations: RegisteredFacet[] = [];
  readonly #states = new Map<string, OwnedFacetState>();
  readonly #presentations = new Map<string, OwnedFacetPresentation>();
  readonly #sessionListeners: Array<() => void> = [];
  #session: PluginContext | undefined;
  #closed = false;

  constructor(options: PluginFacetCoordinatorOptions) {
    this.#options = options;
  }

  #projectPresentation(document: PortablePresentationDocument): void {
    const session = this.#session;
    if (session?.mode !== "tui") return;
    const capabilities = session.ui.capabilities ?? {
      components: false,
      notifications: false,
      textWidgets: false,
    };
    const lines = [...projectPortablePresentationToLines(document, {
      accessible: !capabilities.components,
    })];
    const key = `facet:presentation:${document.id}`;
    if (capabilities.textWidgets) session.ui.setWidget(key, lines);
    else if (capabilities.notifications) session.ui.notify(lines.join("\n"), "info");
  }

  #clearPresentation(id: string, session = this.#session): void {
    if (this.#options.signal.aborted) return;
    if (session?.mode === "tui" && session.ui.capabilities?.textWidgets === true) {
      session.ui.setWidget(`facet:presentation:${id}`, undefined);
    }
  }

  #bindSession(session: PluginContext): void {
    const replacing = this.#session !== undefined;
    if (this.#session !== undefined) {
      for (const id of this.#presentations.keys()) this.#clearPresentation(id, this.#session);
    }
    this.#session = session;
    for (const owned of this.#presentations.values()) {
      if (!replacing || owned.kind === "worker") this.#projectPresentation(owned.registration.document);
    }
  }

  #unbindSession(): void {
    const session = this.#session;
    if (session === undefined) return;
    for (const id of this.#presentations.keys()) this.#clearPresentation(id, session);
    this.#session = undefined;
  }

  #ensureSessionListeners(): void {
    if (this.#sessionListeners.length > 0) return;
    this.#sessionListeners.push(
      this.#options.onSessionStart((context) => { this.#bindSession(context); }),
      this.#options.onSessionShutdown(() => { this.#unbindSession(); }),
    );
  }

  async #removeState(name: string, view: PluginFacetSharedState): Promise<void> {
    const owned = this.#states.get(name);
    if (owned?.view !== view) return;
    this.#states.delete(name);
    owned.state.close();
    await owned.service.dispose();
  }

  #openState<T extends JsonValue>(
    name: string,
    initial: T,
    options: Omit<ReplicatedJsonStateOptions, "signal"> = {},
  ): PluginFacetSharedState<T> {
    this.#options.signal.throwIfAborted();
    const serviceName = pluginFacetStateServiceName(this.#options.owner, name);
    const existing = this.#states.get(name);
    if (existing !== undefined) {
      // SAFETY: a state name identifies one channel whose first opener fixes its value contract.
      return existing.view as PluginFacetSharedState<T>;
    }
    if (this.#states.size >= MAX_PLUGIN_FACET_STATES) {
      throw new RangeError(`Plugin facet states exceed ${MAX_PLUGIN_FACET_STATES} channels`);
    }
    if ((options.maxStateBytes ?? MAX_WIRE_STATE_BYTES) > MAX_WIRE_STATE_BYTES) {
      throw new RangeError(`Plugin facet state exceeds the ${MAX_WIRE_STATE_BYTES} byte wire limit`);
    }
    if ((options.maxHistoryBytes ?? MAX_WIRE_STATE_BYTES) > MAX_WIRE_STATE_BYTES) {
      throw new RangeError(`Plugin facet state history exceeds the ${MAX_WIRE_STATE_BYTES} byte wire limit`);
    }
    const state = createReplicatedJsonState(initial, {
      ...options,
      maxStateBytes: options.maxStateBytes ?? MAX_WIRE_STATE_BYTES,
      maxHistoryBytes: options.maxHistoryBytes ?? MAX_WIRE_STATE_BYTES,
      signal: this.#options.signal,
    });
    const view: PluginFacetSharedState<T> = Object.freeze({
      get closed() { return state.closed; },
      snapshot: state.snapshot.bind(state),
      update: state.update.bind(state),
      apply: state.apply.bind(state),
      deltasSince: state.deltasSince.bind(state),
      subscribe: state.subscribe.bind(state),
    });
    const contract = definePluginWireService({
      name: serviceName,
      version: 1,
      requestSchema: STATE_WIRE_REQUEST_SCHEMA,
      responseSchema: STATE_WIRE_RESPONSE_SCHEMA,
      maxRequestBytes: 512 * 1024,
      maxResponseBytes: 1024 * 1024,
    });
    try {
      const service = createPluginWireServiceProvider(
        this.#options.extension(),
        this.#options.signal,
      ).provide(contract, (request) => {
        if (request.operation === "snapshot") {
          return { operation: "snapshot" as const, snapshot: state.snapshot() };
        }
        if (request.operation === "deltas_since") {
          return {
            operation: "deltas_since" as const,
            deltas: [...state.deltasSince(request.revision)],
          };
        }
        // SAFETY: ReplicatedJsonState.apply validates and bounds the wire delta before committing it.
        return {
          operation: "snapshot" as const,
          snapshot: state.apply(request.delta as ReplicatedJsonStateDelta),
        };
      });
      this.#states.set(name, { state, view, service });
      return view;
    } catch (error) {
      state.close();
      throw error;
    }
  }

  async #stop(registration: RegisteredFacet, reason: string): Promise<void> {
    const activation = registration.activation;
    if (activation === undefined) return;
    delete registration.activation;
    activation.abort.abort(new Error(reason));
    await cleanupAll(activation.cleanup);
  }

  async #start(
    registration: RegisteredFacet,
    session: PluginContext | undefined,
    setupSignal?: AbortSignal,
  ): Promise<void> {
    if (registration.disposed || this.#closed) return;
    const definition = registration.definition;
    const uiCapabilities = session?.ui.capabilities ?? {
      components: false,
      notifications: false,
      textWidgets: false,
    };
    if (definition.kind !== "worker") {
      if (session === undefined || !pluginFacetApplies(definition.kind, session.mode, uiCapabilities)) return;
    }
    const abort = new AbortController();
    const cancelSetup = (): void => {
      if (setupSignal !== undefined) abort.abort(abortError(setupSignal));
    };
    setupSignal?.addEventListener("abort", cancelSetup, { once: true });
    if (setupSignal?.aborted === true) cancelSetup();
    const signal = joinedSignal(abort.signal, this.#options.signal);
    const cleanups: Array<() => void | Promise<void>> = [];
    const setupRollbacks: Array<() => void | Promise<void>> = [];
    const services = createPluginWireServiceProvider(this.#options.extension(), signal);
    const scopedServices: PluginWireServiceProvider = Object.freeze({
      provide<RequestSchema extends TSchema, ResponseSchema extends TSchema>(
        contract: PluginWireServiceContract<RequestSchema, ResponseSchema>,
        handler: (
          request: Static<RequestSchema>,
          context: PluginWireServiceContext,
        ) => Static<ResponseSchema> | Promise<Static<ResponseSchema>>,
      ): PluginRegistrationHandle {
        const handle = services.provide(contract, handler);
        cleanups.push(async () => { await handle.dispose(); });
        return handle;
      },
      get: services.get.bind(services),
    });
    const presentation = Object.freeze({
      show: (definitionValue: PortablePresentationDefinition): PluginPortablePresentationRegistration => {
        signal.throwIfAborted();
        const hosted = this.#options.showPresentation(definitionValue, signal, (document) => {
          this.#projectPresentation(document);
        });
        let disposed = false;
        const wrapped: PluginPortablePresentationRegistration = Object.freeze({
          get disposed() { return disposed || hosted.disposed; },
          get document() { return hosted.document; },
          update: (next: PortablePresentationDefinition) => {
            if (disposed) throw new Error("Portable presentation registration is disposed");
            hosted.update(next);
          },
          async invoke(
            request: PortablePresentationActionRequest,
            actionSignal?: AbortSignal,
          ): Promise<PortablePresentationActionResult> {
            if (disposed) throw new Error("Portable presentation registration is disposed");
            return await hosted.invoke(request, actionSignal);
          },
          dispose: () => {
            if (disposed) return;
            disposed = true;
            if (this.#presentations.get(hosted.document.id)?.registration === wrapped) {
              this.#presentations.delete(hosted.document.id);
            }
            try { this.#clearPresentation(hosted.document.id); }
            finally { hosted.dispose(); }
          },
        });
        this.#presentations.set(hosted.document.id, { kind: definition.kind, registration: wrapped });
        cleanups.push(() => wrapped.dispose());
        return wrapped;
      },
      remove: (id: string): void => {
        const shown = this.#presentations.get(id)?.registration;
        if (shown === undefined) this.#options.removePresentation(id);
        else shown.dispose();
      },
    });
    const createState = <T extends JsonValue>(
      initial: T,
      options: ReplicatedJsonStateOptions = {},
    ): ReplicatedJsonState<T> => {
      signal.throwIfAborted();
      const state = createReplicatedJsonState(initial, {
        ...options,
        signal: options.signal === undefined ? signal : AbortSignal.any([signal, options.signal]),
      });
      cleanups.push(() => state.close());
      return state;
    };
    const states = Object.freeze({
      open: <T extends JsonValue>(
        name: string,
        initial: T,
        options: Omit<ReplicatedJsonStateOptions, "signal"> = {},
      ): PluginFacetSharedState<T> => {
        signal.throwIfAborted();
        const existing = this.#states.get(name)?.view;
        const state = this.#openState(name, initial, options);
        if (existing === undefined) {
          setupRollbacks.push(async () => await this.#removeState(name, state));
        }
        return state;
      },
      get: <T extends JsonValue = JsonValue>(name: string): PluginFacetSharedState<T> | undefined => {
        signal.throwIfAborted();
        pluginFacetStateServiceName(this.#options.owner, name);
        // SAFETY: a state name identifies one channel whose first opener fixes its value contract.
        return this.#states.get(name)?.view as PluginFacetSharedState<T> | undefined;
      },
    });
    const contextBase = {
      apiVersion: PLUGIN_FACET_API_VERSION,
      kind: definition.kind,
      name: definition.name,
      signal,
      extension: this.#options.extension(),
      services: scopedServices,
      presentation,
      states,
      createState,
    };
    const context: PluginFacetContext = session === undefined
      ? Object.freeze({ ...contextBase, mode: "worker" })
      : Object.freeze({ ...contextBase, mode: session.mode, session });
    const setup = Promise.resolve().then(() => definition.setup(context));
    try {
      const cleanup = await withAbort(setup, setupSignal);
      signal.throwIfAborted();
      if (cleanup !== undefined) {
        if (!Value.Check(FUNCTION_VALUE, cleanup)) throw new TypeError("Plugin facet setup must return a cleanup function");
        cleanups.push(cleanup);
      }
      registration.activation = { abort, cleanup: cleanups };
    } catch (error) {
      abort.abort(new Error("Plugin facet setup failed"));
      if (setupSignal?.aborted === true) {
        void setup.then(async (lateCleanup) => {
          if (Value.Check(FUNCTION_VALUE, lateCleanup)) await lateCleanup();
        }).catch(() => undefined);
      }
      try { await cleanupAll([...setupRollbacks, ...cleanups]); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], "Plugin facet setup and cleanup failed"); }
      throw error;
    } finally {
      setupSignal?.removeEventListener("abort", cancelSetup);
    }
  }

  #enqueue(registration: RegisteredFacet, task: () => Promise<void>): Promise<void> {
    const operation = registration.tail.then(task, task);
    registration.tail = operation.catch(() => undefined);
    return operation;
  }

  async register(rawDefinition: PluginFacetDefinition): Promise<PluginFacetRegistration> {
    if (this.#closed) throw new Error("Plugin facet coordinator is closed");
    this.#options.signal.throwIfAborted();
    if (this.#registrations.filter((entry) => !entry.disposed).length >= MAX_PLUGIN_FACETS) {
      throw new RangeError(`Plugin facets exceed ${MAX_PLUGIN_FACETS} registrations`);
    }
    const definition = validatePluginFacetDefinition(rawDefinition);
    if (this.#registrations.some((entry) =>
      !entry.disposed && entry.definition.kind === definition.kind && entry.definition.name === definition.name)) {
      throw new TypeError(`Plugin facet ${definition.kind}:${definition.name} is already registered`);
    }
    this.#ensureSessionListeners();
    const registration: RegisteredFacet = {
      definition,
      listeners: [],
      disposed: false,
      tail: Promise.resolve(),
    };
    const listeners: Array<() => void> = [];
    if (definition.kind === "worker") {
      listeners.push(this.#options.onSessionStart(async () => {
        await this.#enqueue(registration, async () => {
          if (registration.activation === undefined) await this.#start(registration, undefined);
        });
      }));
    } else {
      listeners.push(this.#options.onSessionStart(async (context) => {
        await this.#enqueue(registration, async () => {
          await this.#stop(registration, "Plugin facet session was replaced");
          await this.#start(registration, context);
        });
      }));
      listeners.push(this.#options.onSessionShutdown(async () => {
        await this.#enqueue(registration, async () => {
          await this.#stop(registration, "Plugin facet session stopped");
        });
      }));
    }
    Object.assign(registration, { listeners: Object.freeze(listeners) });
    this.#registrations.push(registration);
    let disposed = false;
    const handle: PluginFacetRegistration = Object.freeze({
      get disposed() { return disposed; },
      kind: definition.kind,
      name: definition.name,
      dispose: async (): Promise<void> => {
        if (disposed) return;
        disposed = true;
        registration.disposed = true;
        for (const listener of [...listeners].reverse()) listener();
        try {
          await this.#enqueue(registration, async () => {
            await this.#stop(registration, "Plugin facet registration was disposed");
          });
        } finally {
          const index = this.#registrations.indexOf(registration);
          if (index >= 0) this.#registrations.splice(index, 1);
        }
      },
    });
    if (definition.kind === "worker" && this.#options.committed()) {
      try {
        await this.#enqueue(registration, async () => await this.#start(registration, undefined));
      } catch (error) {
        try { await handle.dispose(); }
        catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "Plugin worker facet setup and cleanup failed");
        }
        throw error;
      }
    }
    return handle;
  }

  /** Start worker facets only after the runtime has committed their generation. */
  async activateWorkers(signal?: AbortSignal): Promise<void> {
    if (this.#closed) return;
    const failures: unknown[] = [];
    for (const registration of this.#registrations) {
      if (registration.disposed || registration.definition.kind !== "worker") continue;
      try {
        await this.#enqueue(registration, async () => {
          if (registration.activation === undefined) await this.#start(registration, undefined, signal);
        });
      } catch (error) { failures.push(error); }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Plugin worker facet activation failed");
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const failures: unknown[] = [];
    for (const listener of [...this.#sessionListeners].reverse()) listener();
    this.#sessionListeners.length = 0;
    try { this.#unbindSession(); }
    catch (error) { failures.push(error); }
    for (const registration of [...this.#registrations].reverse()) {
      registration.disposed = true;
      for (const listener of [...registration.listeners].reverse()) listener();
      try {
        await this.#enqueue(registration, async () => {
          await this.#stop(registration, "Plugin facet coordinator closed");
        });
      } catch (error) { failures.push(error); }
    }
    this.#registrations.length = 0;
    for (const { state, service } of [...this.#states.values()].reverse()) {
      state.close();
      try { await service.dispose(); }
      catch (error) { failures.push(error); }
    }
    this.#states.clear();
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Plugin facet coordinator cleanup failed");
  }
}
