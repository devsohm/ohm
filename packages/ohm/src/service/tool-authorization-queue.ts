function abortReason(signal: AbortSignal): AbortSignal["reason"] {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

async function settleWithSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(abortReason(signal)));
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
    if (signal.aborted) onAbort();
  });
}

/** @internal Serializes host-owned approval transactions without making queued cancellation wait. */
export class ToolAuthorizationQueue {
  #tail: Promise<void> = Promise.resolve();

  async run<T>(signal: AbortSignal, operation: () => Promise<T> | T): Promise<T> {
    const previous = this.#tail.catch(() => undefined);
    const current = previous.then(async () => {
      signal.throwIfAborted();
      return await operation();
    });
    this.#tail = current.then(() => undefined, () => undefined);
    return await settleWithSignal(current, signal);
  }
}
