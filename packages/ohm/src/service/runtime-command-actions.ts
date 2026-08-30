import { optionalProperties } from "../core/optional-properties.js";
import type { ExtensionCommandContextActions } from "../extensions/direct.js";
import { extensionSessionManager } from "../extensions/session-contract.js";
import type { AgentSession } from "./agent-session.js";
import type { AgentSessionRuntime } from "./agent-session-runtime.js";

/** Bind one extension generation to the runtime owner that replaces its session. */
export function createAgentSessionRuntimeCommandActions(
  runtime: AgentSessionRuntime,
  session: AgentSession,
  options: {
    refresh?: (signal: AbortSignal) => Promise<AgentSession | void>;
    afterRefresh?: (session: AgentSession) => Promise<void>;
  } = {},
): ExtensionCommandContextActions {
  const assertOrigin = (signal?: AbortSignal): void => {
    signal?.throwIfAborted();
    if (runtime.session !== session) {
      throw new Error("Extension command context is stale after session replacement");
    }
  };
  return {
    waitForIdle: async (signal) => {
      assertOrigin(signal);
      await session.waitForIdle();
      assertOrigin(signal);
    },
    newSession: async (commandOptions = {}, signal) => {
      assertOrigin(signal);
      return await runtime.newSession({
        ...optionalProperties(commandOptions.parentSession === undefined ? undefined : { parentSession: commandOptions.parentSession }),
        ...optionalProperties(commandOptions.setup === undefined ? undefined : {
          setup: async (manager) => await commandOptions.setup?.(extensionSessionManager(manager)),
        }),
        ...optionalProperties(commandOptions.withSession === undefined ? undefined : {
          withSession: async (context) => await commandOptions.withSession?.(context),
        }),
        ...optionalProperties(signal === undefined ? undefined : { signal }),
      }, session);
    },
    fork: async (entryId, commandOptions = {}, signal) => {
      assertOrigin(signal);
      const result = await runtime.fork(entryId, {
        ...optionalProperties(commandOptions.position === undefined ? undefined : { position: commandOptions.position }),
        ...optionalProperties(commandOptions.withSession === undefined ? undefined : {
          withSession: async (context) => await commandOptions.withSession?.(context),
        }),
        ...optionalProperties(signal === undefined ? undefined : { signal }),
      }, session);
      return { cancelled: result.cancelled };
    },
    navigateTree: async (targetId, commandOptions = {}, signal) => {
      assertOrigin(signal);
      const result = await session.navigateTree(targetId, commandOptions);
      assertOrigin(signal);
      return { cancelled: result.cancelled };
    },
    switchSession: async (sessionPath, commandOptions = {}, signal) => {
      assertOrigin(signal);
      return await runtime.switchSession(sessionPath, {
        ...optionalProperties(commandOptions.withSession === undefined ? undefined : {
          withSession: async (context) => await commandOptions.withSession?.(context),
        }),
        ...optionalProperties(signal === undefined ? undefined : { signal }),
      }, session);
    },
    refresh: async (signal) => {
      assertOrigin(signal);
      await runtime.refreshSession(
        session,
        async (operationSignal) => {
          if (options.refresh === undefined) {
            await session.refresh({ signal: operationSignal });
            return;
          }
          return await options.refresh(operationSignal);
        },
        {
          ...optionalProperties(signal === undefined ? undefined : { signal }),
          ...optionalProperties(options.afterRefresh === undefined ? undefined : { withSession: options.afterRefresh }),
        },
      );
    },
  };
}
