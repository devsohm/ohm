import { createServeSessionRuntime as rootAdapter } from "ohm";
import { createServeSessionRuntime, type ServeSessionRuntime } from "ohm/serve";
import type { AgentSession } from "ohm/sdk";

declare const session: AgentSession;
const runtime: ServeSessionRuntime = createServeSessionRuntime(() => session);
const ownedRuntime = rootAdapter(() => session, {
  async start(signal) { await session.bindPlugins({ mode: "serve" }, signal); },
  recoverInterruptedRun(options) { return session.recoverInterruptedRun(options); },
  close() { return session.close(); },
});
void [runtime, ownedRuntime];
