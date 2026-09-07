import { boundedRedactedMessage } from "../../core/bounded-diagnostic.js";
import { errorMessage } from "../../core/errors.js";

const MAX_RUNTIME_FAILURE_BYTES = 4_096;

declare global {
  interface ErrorConstructor {
    isError(cause: unknown): cause is Error;
  }
}

export function boundedRuntimeFailureMessage(
  cause: unknown,
  maximumBytes = MAX_RUNTIME_FAILURE_BYTES,
): string {
  return boundedRedactedMessage(errorMessage(cause), maximumBytes);
}

export function runtimeError(cause: unknown): Error {
  return Error.isError(cause) ? cause : new Error(errorMessage(cause), { cause });
}

export function abortError(signal: AbortSignal) {
  return signal.reason ?? new DOMException("Aborted", "AbortError");
}

export async function withAbort<T>(value: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return await value;
  return await new Promise<T>((resolve, reject) => {
    const aborted = (): void => reject(abortError(signal));
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", aborted, { once: true });
    value.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

export async function runRuntimeCleanupPhase(
  cleanups: readonly (() => void | Promise<void>)[],
  timeoutMs: number,
  label: string,
): Promise<Error[]> {
  if (cleanups.length === 0) return [];
  const deadline = Date.now() + timeoutMs;
  const failures: Error[] = [];
  let pendingCount = 0;
  for (const cleanup of cleanups) {
    let settled = false;
    let failed = false;
    let failure: unknown;
    let returned: void | Promise<void>;
    try {
      returned = cleanup();
    } catch (cause) {
      settled = true;
      failed = true;
      failure = cause;
      returned = undefined;
    }
    const completion = Promise.resolve(returned).then(
      () => { settled = true; },
      (cause: unknown) => { settled = true; failed = true; failure = cause; },
    );
    const remaining = deadline - Date.now();
    if (!settled && remaining > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          completion,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, remaining);
            timer.unref();
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
    if (!settled) pendingCount += 1;
    else if (failed) {
      const prefix = `${label} failed: `;
      failures.push(new Error(
        `${prefix}${boundedRuntimeFailureMessage(failure, MAX_RUNTIME_FAILURE_BYTES - Buffer.byteLength(prefix, "utf8"))}`,
        { cause: failure },
      ));
    }
  }
  if (pendingCount > 0) {
    failures.push(new Error(
      `${label} timed out after ${timeoutMs}ms with ${pendingCount} cleanup callback(s) still pending`,
    ));
  }
  return failures;
}

export function onceRuntimeCleanup(cleanup: () => void | Promise<void>): () => Promise<void> {
  let flight: Promise<void> | undefined;
  return async () => {
    flight ??= Promise.resolve().then(cleanup);
    await flight;
  };
}
