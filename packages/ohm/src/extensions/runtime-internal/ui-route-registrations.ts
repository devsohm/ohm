import { boundedJsonSnapshot } from "@ohm/kernel/runtime/core/bounded-json";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { isJsonValue, type JsonValue } from "../../core/json.js";
import type {
  RuntimeUiComponentFactory,
  RuntimeUiComponentHandle,
} from "../../tui/components.js";
import { sanitizeTerminalText } from "../../tui/unicode.js";
import type {
  ExtensionUIRouteDefinition,
  ExtensionUIRouteHost,
  ExtensionUIRouteOpenOptions,
  ExtensionUIRouteRegistration,
  ExtensionUIRouteService,
  ExtensionUIRouteSnapshot,
} from "../capabilities/ui-routes.js";

export const MAX_EXTENSION_UI_ROUTES_PER_GENERATION = 32;
export const MAX_EXTENSION_UI_ROUTE_DATA_BYTES = 64 * 1024;

const MAX_ROUTE_DATA_VALUES = 8_192;
const MAX_ROUTE_DATA_CONTAINERS = 4_096;
const MAX_ROUTE_DATA_DEPTH = 59;
const ROUTE_NAME = /^[a-z][a-z0-9-]{0,63}$/u;
const ROUTE_NAME_VALUE = Type.String();
const ROUTE_DEFINITION_VALUE = Type.Object({
  title: Type.String(),
  render: Type.Function([], Type.Unknown()),
});
const ROUTE_OPEN_OPTIONS_VALUE = Type.Object({
  data: Type.Optional(Type.Unknown()),
});
const JSON_CONTAINER_VALUE = Type.Union([
  Type.Array(Type.Unknown()),
  Type.Object({}, { additionalProperties: true }),
]);

/** Nominal identity for a generation-owned route registration or mount. */
export class RuntimeUIRouteOwnerToken {
  readonly #identity = true;

  constructor() {
    void this.#identity;
  }
}

export interface RuntimeUIRouteOperationSink {
  /**
   * Replace the active route and return its exact component handle. The sink may
   * restore the normal host view if construction fails. `onClosed` must run
   * whenever this exact mount closes, including replacement and host closure.
   */
  open(
    name: string,
    title: string,
    factory: RuntimeUiComponentFactory<void>,
    data: JsonValue | undefined,
    token: RuntimeUIRouteOwnerToken,
    onClosed: () => void,
  ): RuntimeUiComponentHandle;
  /** Close only the mount owning this exact token; stale tokens are no-ops. */
  close(token: RuntimeUIRouteOwnerToken): void;
}

const unavailable = (): never => {
  throw new Error("Extension UI routes require the full rich TUI");
};

export const UNAVAILABLE_EXTENSION_UI_ROUTES: ExtensionUIRouteService = Object.freeze({
  register: unavailable,
  open: unavailable,
  list: () => Object.freeze([]),
  current: () => undefined,
  close() {},
});

interface RegistrationState {
  readonly name: string;
  readonly title: string;
  readonly render: ExtensionUIRouteDefinition["render"];
  readonly token: RuntimeUIRouteOwnerToken;
  disposed: boolean;
}

interface CurrentState {
  readonly registrationToken: RuntimeUIRouteOwnerToken;
  readonly mountToken: RuntimeUIRouteOwnerToken;
  readonly snapshot: ExtensionUIRouteSnapshot;
}

function routeName(value: string): string {
  if (!Value.Check(ROUTE_NAME_VALUE, value) || !ROUTE_NAME.test(value)) {
    throw new TypeError("Extension UI route names must match [a-z][a-z0-9-]{0,63}");
  }
  return value;
}

function routeDefinition(value: ExtensionUIRouteDefinition): Omit<RegistrationState, "name" | "token" | "disposed"> {
  if (!Value.Check(ROUTE_DEFINITION_VALUE, value)) {
    throw new TypeError("Extension UI route definition must be an object");
  }
  const { title, render } = value;
  if (
    Buffer.byteLength(title, "utf8") < 1
    || Buffer.byteLength(title, "utf8") > 256
    || title.trim() === ""
    || title.includes("\n")
    || title.includes("\r")
    || sanitizeTerminalText(title) !== title
  ) {
    throw new TypeError("Extension UI route titles must contain 1-256 bytes of single-line terminal-safe text");
  }
  return Object.freeze({ title, render });
}

function deepFreezeJson(value: JsonValue): JsonValue {
  const pending: JsonValue[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (Value.Check(JSON_CONTAINER_VALUE, current) && !Object.isFrozen(current)) {
      Object.freeze(current);
      for (const child of Object.values(current)) pending.push(child);
    }
  }
  return value;
}

function routeData(options: ExtensionUIRouteOpenOptions | undefined): JsonValue | undefined {
  if (options === undefined) return undefined;
  if (!Value.Check(ROUTE_OPEN_OPTIONS_VALUE, options)) {
    throw new TypeError("Extension UI route open options must be an object");
  }
  if (options.data === undefined) return undefined;
  const snapshot = boundedJsonSnapshot(options.data, {
    label: "Extension UI route data",
    maximumBytes: MAX_EXTENSION_UI_ROUTE_DATA_BYTES,
    maximumValues: MAX_ROUTE_DATA_VALUES,
    maximumContainers: MAX_ROUTE_DATA_CONTAINERS,
    maximumDepth: MAX_ROUTE_DATA_DEPTH,
  });
  const parsed = JSON.parse(snapshot.serialized);
  if (!isJsonValue(parsed)) throw new TypeError("Extension UI route data did not serialize as JSON");
  return deepFreezeJson(parsed);
}

function listedSnapshot(state: RegistrationState): ExtensionUIRouteSnapshot {
  return Object.freeze({ name: state.name, title: state.title });
}

/** One generation's bounded, exact-token route catalog and active mount. */
export class RuntimeUIRouteRegistrations {
  readonly #signal: AbortSignal;
  readonly #sink: RuntimeUIRouteOperationSink;
  readonly #assertActive: () => void;
  readonly #registrations = new Map<string, RegistrationState>();
  #current: CurrentState | undefined;
  #opening = false;

  constructor(
    signal: AbortSignal,
    sink: RuntimeUIRouteOperationSink,
    assertActive: () => void = () => signal.throwIfAborted(),
  ) {
    this.#signal = signal;
    this.#sink = sink;
    this.#assertActive = assertActive;
    signal.addEventListener("abort", () => {
      for (const state of this.#registrations.values()) state.disposed = true;
      this.#registrations.clear();
      const current = this.#current;
      this.#current = undefined;
      if (current !== undefined) {
        try { this.#sink.close(current.mountToken); }
        catch {}
      }
    }, { once: true });
  }

  service(available: boolean): ExtensionUIRouteService {
    const active = (): void => {
      this.#assertActive();
      this.#signal.throwIfAborted();
    };
    const access = (): void => {
      active();
      if (!available) throw new Error("Extension UI routes require the full rich TUI");
    };
    const open = (
      state: RegistrationState,
      options?: ExtensionUIRouteOpenOptions,
    ): RuntimeUiComponentHandle => {
      access();
      if (this.#opening) throw new Error("Extension UI route navigation is already in progress");
      if (state.disposed || this.#registrations.get(state.name) !== state) {
        throw new Error(`Extension UI route registration is no longer active: ${state.name}`);
      }
      const data = routeData(options);
      const mountToken = new RuntimeUIRouteOwnerToken();
      const previous = this.#current;
      let closed = false;
      const factory: RuntimeUiComponentFactory<void> = (host) => {
        const routeHostBase = {
          signal: host.signal,
          requestRender: () => host.requestRender(),
          close: (value) => host.close(value),
          name: state.name,
        } satisfies ExtensionUIRouteHost;
        const routeHost: ExtensionUIRouteHost = Object.freeze(
          data === undefined ? routeHostBase : Object.assign(routeHostBase, { data }),
        );
        return state.render(routeHost);
      };
      this.#opening = true;
      try {
        const handle = this.#sink.open(
          state.name,
          state.title,
          factory,
          data,
          mountToken,
          () => {
            closed = true;
            if (this.#current?.mountToken === mountToken) this.#current = undefined;
          },
        );
        if (state.disposed || this.#registrations.get(state.name) !== state) {
          handle.close();
          throw new Error(`Extension UI route registration is no longer active: ${state.name}`);
        }
        if (closed) {
          if (this.#current === previous) this.#current = undefined;
        } else {
          const snapshotBase = { name: state.name, title: state.title };
          const snapshot: ExtensionUIRouteSnapshot = Object.freeze(
            data === undefined ? snapshotBase : { ...snapshotBase, data },
          );
          this.#current = { registrationToken: state.token, mountToken, snapshot };
        }
        return handle;
      } finally {
        this.#opening = false;
      }
    };
    return Object.freeze<ExtensionUIRouteService>({
      register: (nameValue, definitionValue) => {
        access();
        const name = routeName(nameValue);
        const definition = routeDefinition(definitionValue);
        const previous = this.#registrations.get(name);
        if (previous === undefined && this.#registrations.size >= MAX_EXTENSION_UI_ROUTES_PER_GENERATION) {
          throw new RangeError(
            `Extension UI routes are limited to ${MAX_EXTENSION_UI_ROUTES_PER_GENERATION} registrations per generation`,
          );
        }
        const current = this.#current;
        if (previous !== undefined && current?.registrationToken === previous.token) {
          this.#sink.close(current.mountToken);
          if (this.#current?.mountToken === current.mountToken) this.#current = undefined;
        }
        const state: RegistrationState = {
          name,
          title: definition.title,
          render: definition.render,
          token: new RuntimeUIRouteOwnerToken(),
          disposed: false,
        };
        this.#registrations.set(name, state);
        if (previous !== undefined) previous.disposed = true;
        return Object.freeze<ExtensionUIRouteRegistration>({
          get disposed() { return state.disposed; },
          name,
          title: state.title,
          open: (options) => open(state, options),
          dispose: () => {
            if (state.disposed || this.#registrations.get(name) !== state) return;
            const current = this.#current;
            if (current?.registrationToken === state.token) {
              this.#sink.close(current.mountToken);
              if (this.#current?.mountToken === current.mountToken) this.#current = undefined;
            }
            state.disposed = true;
            this.#registrations.delete(name);
          },
        });
      },
      open: (nameValue, options) => {
        access();
        const name = routeName(nameValue);
        const state = this.#registrations.get(name);
        if (state === undefined) throw new Error(`Extension UI route is not registered: ${name}`);
        return open(state, options);
      },
      list: () => {
        active();
        if (!available) return Object.freeze([]);
        return Object.freeze([...this.#registrations.values()].map(listedSnapshot));
      },
      current: () => {
        active();
        if (!available) return undefined;
        return this.#current?.snapshot;
      },
      close: () => {
        active();
        if (!available) return;
        const current = this.#current;
        if (current === undefined) return;
        this.#sink.close(current.mountToken);
        if (this.#current?.mountToken === current.mountToken) this.#current = undefined;
      },
    });
  }
}
