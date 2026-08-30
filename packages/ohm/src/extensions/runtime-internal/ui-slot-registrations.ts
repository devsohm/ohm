import type {
  ExtensionUISlotContribution,
  ExtensionUISlotPath,
  ExtensionUISlotRegistration,
  ExtensionUISlotService,
} from "../capabilities/ui-slots.js";
import {
  extensionUiSlotKey,
  extensionUiSlotPath,
  validateExtensionUISlotContribution,
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
    path: ExtensionUISlotPath,
    key: string,
    contribution: ExtensionUISlotContribution,
    token: RuntimeUISlotOwnerToken,
  ): void;
  remove(path: ExtensionUISlotPath, key: string, token: RuntimeUISlotOwnerToken): void;
}

const unavailable = (): never => {
  throw new Error("Extension UI slots require the full rich TUI");
};

export const UNAVAILABLE_EXTENSION_UI_SLOTS: ExtensionUISlotService = Object.freeze({
  set: unavailable,
  remove: unavailable,
});

interface RegistrationState {
  readonly path: ExtensionUISlotPath;
  readonly key: string;
  readonly token: RuntimeUISlotOwnerToken;
  disposed: boolean;
}

function registrationKey(path: ExtensionUISlotPath, key: string): string {
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

  service(available: boolean): ExtensionUISlotService {
    const access = (): void => {
      this.#assertActive();
      this.#signal.throwIfAborted();
      if (!available) throw new Error("Extension UI slots require the full rich TUI");
    };
    return Object.freeze<ExtensionUISlotService>({
      set: (pathValue, keyValue, value) => {
        access();
        const path = extensionUiSlotPath(pathValue);
        const key = extensionUiSlotKey(keyValue);
        const selected = validateExtensionUISlotContribution(path, value);
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
            throw new Error("Extension UI slot registration is no longer active");
          }
        };
        return Object.freeze<ExtensionUISlotRegistration>({
          get disposed() { return state.disposed; },
          update: (next) => {
            current();
            const normalized = validateExtensionUISlotContribution(path, next);
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
