import { writeFileSync } from "node:fs";

import { runPrintMode } from "../../src/modes/print-mode.js";
import { runRpcMode } from "../../src/modes/rpc-mode.js";
import type { AgentSessionRuntime } from "../../src/service/agent-session-runtime.js";

function modeRuntimeFixture<Value>(value: Value): AgentSessionRuntime {
  // SAFETY: each fixture below implements every AgentSessionRuntime member exercised by its selected public mode.
  return value as AgentSessionRuntime;
}

const mode = process.argv[2];
const readyPath = process.env["OHM_MODE_READY"];
const disposedPath = process.env["OHM_MODE_DISPOSED"];
if (readyPath === undefined || disposedPath === undefined) {
  throw new Error("Signal fixture paths are required");
}

const dispose = (): void => {
  writeFileSync(disposedPath, "disposed");
};

if (mode === "rpc") {
  const session = {
    async bindExtensions() {},
    subscribe() { return () => undefined; },
  };
  const runtime = modeRuntimeFixture({
    session,
    setBeforeSessionInvalidate() {},
    setRebindSession() {},
    async dispose() { dispose(); },
  });
  setTimeout(() => writeFileSync(readyPath, "ready"), 100);
  await runRpcMode(runtime);
} else if (mode === "print") {
  let finishPrompt: (() => void) | undefined;
  const keepAlive = setInterval(() => undefined, 1_000);
  process.once("SIGINT", () => {
    clearInterval(keepAlive);
    writeFileSync(readyPath, "handled-by-host");
    finishPrompt?.();
  });
  const session = {
    sessionManager: { getHeader: () => null, getEntries: () => [] },
    state: { messages: [] },
    suspendedRun: undefined,
    async bindExtensions() {},
    subscribe() { return () => undefined; },
    async prompt() {
      writeFileSync(readyPath, "ready");
      return await new Promise<void>((resolve) => {
        finishPrompt = resolve;
      });
    },
  };
  const runtime = modeRuntimeFixture({
    session,
    setBeforeSessionInvalidate() {},
    setRebindSession() {},
    async dispose() { dispose(); },
  });
  await runPrintMode(runtime, { mode: "text", initialMessage: "wait" });
} else {
  throw new Error(`Unknown public mode fixture: ${mode ?? ""}`);
}
