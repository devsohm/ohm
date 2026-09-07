import { optionalProperties } from "../core/optional-properties.js";
import type { AgentSession } from "../service/agent-session.js";
import { inspectAgentSession } from "../service/session-inspection.js";
import type { ServeSessionRuntime } from "./server.js";

/** Adapt an existing session without creating another runtime or taking over host startup. */
export function createServeSessionRuntime(
  getSession: () => AgentSession,
  lifecycle: Partial<Pick<ServeSessionRuntime,
    "start" | "recoverInterruptedRun" | "close" | "onEvent" | "onPortablePresentation">> = {},
): ServeSessionRuntime {
  return {
    get sessionId() { return getSession().sessionId; },
    get suspendedRun() { return getSession().suspendedRun; },
    get summary() {
      const session = getSession();
      const state = session.state;
      return {
        ...optionalProperties(state.model === undefined ? undefined : {
          model: { provider: state.model.provider, api: state.model.api, id: state.model.id },
        }),
        thinkingLevel: state.thinkingLevel,
        isStreaming: state.isStreaming,
        isCompacting: session.isCompacting,
        isRetrying: session.isRetrying,
        pendingMessageCount: session.pendingMessageCount,
        hasSuspendedRun: state.suspendedRun !== undefined,
        messageCount: state.messages.length,
        toolCount: state.tools.length,
      };
    },
    getEntriesPage(offset, limit) {
      const session = getSession();
      return {
        ...session.sessionManager.getEntriesPage(offset, limit),
        leafId: session.sessionManager.getLeafId(),
        revision: session.nativeSessionManager.getTreeRevision(),
      };
    },
    onEvent(listener) {
      return lifecycle.onEvent === undefined ? getSession().onEvent(listener) : lifecycle.onEvent(listener);
    },
    onPortablePresentation(listener) {
      return lifecycle.onPortablePresentation === undefined
        ? getSession().onPortablePresentation(listener)
        : lifecycle.onPortablePresentation(listener);
    },
    listPortablePresentations() { return getSession().listPortablePresentations(); },
    inspect() { return inspectAgentSession(getSession()); },
    invokePortablePresentationAction(request, signal) {
      return getSession().invokePortablePresentationAction(request, signal);
    },
    listPluginWireServices() { return getSession().listPluginWireServices(); },
    invokePluginWireService(request, signal) {
      return getSession().invokePluginWireService(request, signal);
    },
    ...optionalProperties(lifecycle.start === undefined ? undefined : {
      start: lifecycle.start.bind(lifecycle),
    }),
    prompt(text, options) { return getSession().prompt(text, options); },
    recoverInterruptedRun(options) {
      return lifecycle.recoverInterruptedRun === undefined
        ? getSession().recoverInterruptedRun(options)
        : lifecycle.recoverInterruptedRun(options);
    },
    abort(reason) { return getSession().abort(reason); },
    close() { return lifecycle.close === undefined ? getSession().close() : lifecycle.close(); },
  };
}
