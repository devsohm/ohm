import { resourcesConflict } from "./coordinator.js";
import type { ResourceClaim } from "./types.js";

const MAX_RESOURCE_ARBITER_WAITERS = 1_024;

export interface ToolResourceLease {
  release(): void;
}

interface PromiseReject {
  <Reason>(reason?: Reason): void;
}

interface Waiter {
  claims: ResourceClaim[];
  signal: AbortSignal;
  resolve: (lease: ToolResourceLease) => void;
  reject: PromiseReject;
  detach: () => void;
}

interface ActiveLease {
  claims: ResourceClaim[];
  released: boolean;
}

/** @internal Coordinates concrete tool resource claims across AgentSession instances. */
export class ToolResourceArbiter {
  readonly #active = new Set<ActiveLease>();
  readonly #waiters: Waiter[] = [];

  acquire(claims: readonly ResourceClaim[], signal: AbortSignal): Promise<ToolResourceLease> {
    signal.throwIfAborted();
    if (this.#waiters.length >= MAX_RESOURCE_ARBITER_WAITERS) {
      throw new Error("Tool resource arbiter queue is full");
    }
    const selected = claims.map((claim) => ({ ...claim }));
    return new Promise<ToolResourceLease>((resolve, reject) => {
      let waiter!: Waiter;
      const onAbort = (): void => {
        const index = this.#waiters.indexOf(waiter);
        if (index < 0) return;
        this.#waiters.splice(index, 1);
        waiter.detach();
        reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
        this.#pump();
      };
      waiter = {
        claims: selected,
        signal,
        resolve,
        reject,
        detach: () => signal.removeEventListener("abort", onAbort),
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.#waiters.push(waiter);
      if (signal.aborted) onAbort();
      else this.#pump();
    });
  }

  #pump(): void {
    while (this.#waiters.length > 0) {
      const waiter = this.#waiters[0]!;
      if (waiter.signal.aborted) {
        this.#waiters.shift();
        waiter.detach();
        waiter.reject(waiter.signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
        continue;
      }
      if ([...this.#active].some((lease) => resourcesConflict(lease.claims, waiter.claims))) return;
      this.#waiters.shift();
      waiter.detach();
      const active: ActiveLease = { claims: waiter.claims, released: false };
      this.#active.add(active);
      waiter.resolve(Object.freeze({
        release: () => {
          if (active.released) return;
          active.released = true;
          this.#active.delete(active);
          this.#pump();
        },
      }));
    }
  }
}
