import { optionalProperties } from "../core/optional-properties.js";
import type { AgentSession } from "../service/agent-session.js";
import type { TuiContext } from "../tui/types.js";
import { OHM_VERSION } from "../version.js";

export interface InteractiveTuiSession {
  readonly sessionId: AgentSession["sessionId"];
  readonly nativeModel: undefined | {
    readonly provider: string;
    readonly id: string;
    readonly info?: { readonly contextTokens?: number };
  };
  readonly thinkingLevel: AgentSession["thinkingLevel"];
  readonly autoCompactionEnabled: AgentSession["autoCompactionEnabled"];
  supportsThinking(): ReturnType<AgentSession["supportsThinking"]>;
  isSubscription(): boolean;
  getContextUsage(): ReturnType<AgentSession["getContextUsage"]>;
}

export function createInteractiveTuiContext(
  session: InteractiveTuiSession,
  workspace: string,
  sessionName: string | undefined,
  active: boolean,
  options: { includeContextUsage?: boolean; operationOnly?: boolean } = {},
): TuiContext {
  const model = session.nativeModel;
  const contextUsage = options.includeContextUsage === false
    ? undefined
    : session.getContextUsage();
  const contextTokens = contextUsage?.tokens;
  return {
    threadId: session.sessionId,
    sessionName,
    workspace,
    releaseVersion: OHM_VERSION,
    provider: model?.provider,
    model: model?.id,
    contextWindowTokens: model?.info?.contextTokens,
    ...optionalProperties(contextTokens === null || contextTokens === undefined ? undefined : { contextTokens }),
    ...optionalProperties(contextUsage?.source === undefined ? undefined : { contextSource: contextUsage.source }),
    thinking: session.thinkingLevel,
    thinkingSupported: model === undefined ? undefined : session.supportsThinking(),
    subscription: model === undefined || !session.isSubscription() ? undefined : true,
    active,
    status: active ? options.operationOnly === true ? "working" : "streaming" : "idle",
    autoCompaction: session.autoCompactionEnabled,
    ...optionalProperties(contextUsage?.autoCompactionThresholdPercent === undefined ? undefined : { autoCompactionThresholdPercent: contextUsage.autoCompactionThresholdPercent }),
  };
}
