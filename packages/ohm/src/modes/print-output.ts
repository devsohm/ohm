import { writeMachineOutput } from "../interfaces/output-guard.js";
import { MAX_RPC_LINE_BYTES } from "../interfaces/rpc.js";
import { projectSessionWireEvent } from "../interfaces/session-wire.js";
import type { PluginError } from "../plugins/direct.js";
import type { AgentSession } from "../service/agent-session.js";
import { formatPluginError, projectPluginError, type ProjectedPluginError } from "./plugin-error.js";

const MAX_PENDING_WRITES = 1_024;

/** Shared one-shot output ownership; session/runtime cleanup remains with the host. */
export function createPrintOutput(
  mode: "text" | "json",
  writeOutput: (text: string) => void | Promise<void> = (text) => new Promise<void>((resolve, reject) => {
    writeMachineOutput(text, (error) => {
      if (error === undefined || error === null) resolve();
      else reject(error);
    });
  }),
) {
  const abort = new AbortController();
  let tail = Promise.resolve();
  let pendingWrites = 0;
  let pendingBytes = 0;
  let closed = false;
  let headerPending = mode === "json";
  let unsubscribe = (): void => undefined;
  const pendingPluginErrors: ProjectedPluginError[] = [];
  const unbind = (): void => { unsubscribe(); unsubscribe = (): void => undefined; };
  const write = (text: string): Promise<void> => {
    const bytes = Buffer.byteLength(text, "utf8");
    if (closed || abort.signal.aborted || pendingWrites >= MAX_PENDING_WRITES || bytes > MAX_RPC_LINE_BYTES - pendingBytes) {
      const error = abort.signal.aborted ? abort.signal.reason
        : new Error(closed ? "Print output is closed" : "Print output backlog exceeded its limit");
      abort.abort(error);
      const rejected = Promise.reject(error);
      void rejected.catch(() => undefined);
      return rejected;
    }
    pendingWrites += 1;
    pendingBytes += bytes;
    tail = tail.then(async () => {
      abort.signal.throwIfAborted();
      await writeOutput(text);
    }).finally(() => {
      pendingWrites -= 1;
      pendingBytes -= bytes;
    });
    // Do not await a run from its own event listener; the host drains this failure.
    void tail.catch((error) => { abort.abort(error); });
    return tail;
  };
  const drain = async (): Promise<void> => { await tail; abort.signal.throwIfAborted(); };
  return {
    signal: abort.signal,
    write,
    unbind,
    drain,
    reportPluginError(failure: PluginError): void {
      if (closed || abort.signal.aborted) return;
      if (mode !== "json") { console.error(formatPluginError(failure)); return; }
      const event = projectPluginError(failure);
      if (headerPending) {
        if (pendingPluginErrors.length >= MAX_PENDING_WRITES) {
          abort.abort(new Error("Print startup error backlog exceeded its limit"));
          return;
        }
        pendingPluginErrors.push(event);
      } else void write(`${JSON.stringify(event)}\n`);
    },
    async bind(session: AgentSession): Promise<void> {
      unbind();
      if (mode !== "json") return;
      unsubscribe = session.subscribe(async (event) => { await write(`${JSON.stringify(projectSessionWireEvent(event))}\n`); });
      if (!headerPending) return;
      headerPending = false;
      const header = session.sessionManager.getHeader();
      if (header !== null) void write(`${JSON.stringify(header)}\n`);
      for (const event of pendingPluginErrors.splice(0)) void write(`${JSON.stringify(event)}\n`);
      await drain();
    },
    async close(): Promise<void> {
      closed = true;
      unbind();
      pendingPluginErrors.length = 0;
      await drain();
    },
  };
}
