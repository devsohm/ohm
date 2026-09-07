import type {
  PluginUISlotContribution,
  PluginUISlotPath,
  PluginUISlotRegistration,
  PluginUISlotService,
} from "../capabilities/ui-slots.js";
import {
  extensionUiSlotKey,
  extensionUiSlotPath,
  validatePluginUISlotContribution,
} from "../../tui/ui-slot-compositor.js";

/** Nominal identity for one generation-owned UI slot contribution. */
export class RuntimeUISlotOwnerToken {
  readonly #identity = true;

  constructor() {
    void this.#identity;
  }
}

export interface RuntimeUISlotOperationSink {
  set(
    path: PluginUISlotPath,
    key: string,
    contribution: PluginUISlotContribution,
    token: RuntimeUISlotOwnerToken,
  ): void;
  remove(path: PluginUISlotPath, key: string, token: RuntimeUISlotOwnerToken): void;
}

const unavailable = (): never => {
  throw new Error("Plugin UI slots require the full rich TUI");
};

export const UNAVAILABLE_PLUGIN_UI_SLOTS: PluginUISlotService = Object.freeze({
  set: unavailable,
  remove: unavailable,
});

interface RegistrationState {
  readonly path: PluginUISlotPath;
  readonly key: string;
  readonly token: RuntimeUISlotOwnerToken;
  disposed: boolean;
}

function registrationKey(path: PluginUISlotPath, key: string): string {
  return JSON.stringify([path, key]);
}

/** One generation's keyed slot registrations, shared by all callback facades. */
export class RuntimeUISlotRegistrations {
  readonly #signal: AbortSignal;
  readonly #sink: RuntimeUISlotOperationSink;
  readonly #assertActive: () => void;
  readonly #registrations = new Map<string, RegistrationState>();

  constructor(signal: AbortSignal, sink: RuntimeUISlotOperationSink, assertActive: () => void = () => signal.throwIfAborted()) {
    this.#signal = signal;
    this.#sink = sink;
    this.#assertActive = assertActive;
    signal.addEventListener("abort", () => {
      for (const state of this.#registrations.values()) {
        try { this.#sink.remove(state.path, state.key, state.token); }
        catch {}
        state.disposed = true;
      }
      this.#registrations.clear();
    }, { once: true });
  }

  service(available: boolean): PluginUISlotService {
    const access = (): void => {
      this.#assertActive();
      this.#signal.throwIfAborted();
      if (!available) throw new Error("Plugin UI slots require the full rich TUI");
    };
    return Object.freeze<PluginUISlotService>({
      set: (pathValue, keyValue, value) => {
        access();
        const path = extensionUiSlotPath(pathValue);
        const key = extensionUiSlotKey(keyValue);
        const selected = validatePluginUISlotContribution(path, value);
        const id = registrationKey(path, key);
        const token = new RuntimeUISlotOwnerToken();
        this.#sink.set(path, key, selected, token);
        const previous = this.#registrations.get(id);
        if (previous !== undefined) previous.disposed = true;
        const state: RegistrationState = { path, key, token, disposed: false };
        this.#registrations.set(id, state);
        const current = (): void => {
          access();
          if (state.disposed || this.#registrations.get(id) !== state) {
            throw new Error("Plugin UI slot registration is no longer active");
          }
        };
        return Object.freeze<PluginUISlotRegistration>({
          get disposed() { return state.disposed; },
          update: (next) => {
            current();
            const normalized = validatePluginUISlotContribution(path, next);
            this.#sink.set(path, key, normalized, token);
          },
          dispose: () => {
            if (state.disposed || this.#registrations.get(id) !== state) return;
            this.#sink.remove(path, key, token);
            state.disposed = true;
            this.#registrations.delete(id);
          },
        });
      },
      remove: (pathValue, keyValue) => {
        access();
        const path = extensionUiSlotPath(pathValue);
        const key = extensionUiSlotKey(keyValue);
        const id = registrationKey(path, key);
        const state = this.#registrations.get(id);
        if (state === undefined) return;
        this.#sink.remove(path, key, state.token);
        state.disposed = true;
        this.#registrations.delete(id);
      },
    });
  }
}
