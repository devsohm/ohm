import type { AgentSession } from "./agent-session.js";

const recoveryFinalizers = new WeakMap<AgentSession, {
  pending: Array<() => void | Promise<void>>;
  running?: Promise<void>;
}>();

/** Releases deferred recovery work when its session closes. */
export function clearAgentSessionRecoveryFinalizers(session: AgentSession): void {
  recoveryFinalizers.delete(session);
}

/** Queues internal work that must settle before post-recovery prompts are admitted. */
export function enqueueAgentSessionRecoveryFinalizer(
  session: AgentSession,
  finalize: () => void | Promise<void>,
): void {
  const state = recoveryFinalizers.get(session);
  if (state === undefined) recoveryFinalizers.set(session, { pending: [finalize] });
  else state.pending.push(finalize);
}

/** Runs queued recovery finalizers until they succeed, then removes them. */
export function runAgentSessionRecoveryFinalizer(session: AgentSession): Promise<void> | undefined {
  const state = recoveryFinalizers.get(session);
  if (state === undefined) return undefined;
  if (state.running !== undefined) return state.running;
  state.running = Promise.resolve().then(async () => {
    try {
      while (state.pending.length > 0) {
        await state.pending[0]!();
        state.pending.shift();
      }
      if (recoveryFinalizers.get(session) === state) recoveryFinalizers.delete(session);
    } finally {
      delete state.running;
    }
  });
  return state.running;
}

/** Defers requested selection until an interrupted run is explicitly recovered. */
export function deferAgentSessionSelection(
  session: AgentSession,
  selection: {
    model?: Parameters<AgentSession["setModel"]>[0];
    thinkingLevel?: string;
  },
): void {
  let pendingModel = selection.model === undefined ? undefined : structuredClone(selection.model);
  let pendingThinking = selection.thinkingLevel;
  if (pendingModel === undefined && pendingThinking === undefined) return;
  enqueueAgentSessionRecoveryFinalizer(session, async () => {
    try {
      if (pendingModel !== undefined) {
        const requestedModel = pendingModel;
        const entryCount = session.nativeSessionManager.getEntries().length;
        try {
          await session.setModel(requestedModel);
          pendingModel = undefined;
        } catch (error) {
          if (session.nativeSessionManager.getEntries().slice(entryCount).some((entry) =>
            entry.type === "model_change" &&
            entry.provider === requestedModel.provider &&
            entry.modelId === requestedModel.id)) pendingModel = undefined;
          throw error;
        }
      }
      if (pendingThinking !== undefined) {
        session.setThinkingLevel(pendingThinking);
        pendingThinking = undefined;
      }
    } catch (error) {
      throw new Error(
        "Interrupted run is recovered, but the requested model or thinking selection could not be applied",
        { cause: error },
      );
    }
  });
}
