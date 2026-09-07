import { defaultSecretRedactor } from "../auth/redaction.js";
import type { AgentSession } from "./agent-session.js";

const MAX_ITEMS = 128;

/** Inspect effective runtime metadata without reading message bodies or credentials. */
export function inspectAgentSession(session: AgentSession) {
  const redactor = defaultSecretRedactor;
  const text = (value: string): string => redactor.redact(value).slice(0, 1_024);
  const extensions = session.getLoadedPlugins();
  const tools = session.getAllTools();
  const active = new Set(session.getActiveTools());
  const composition = session.getPromptComposition();
  const model = session.model;
  const activity = session.nativeSessionManager.getRecentActivity();
  return {
    schemaVersion: 1 as const,
    sessionId: session.sessionId,
    workspace: text(session.cwd),
    state: session.isCompacting ? "compacting" as const
      : session.isStreaming ? "running" as const
        : session.suspendedRun !== undefined ? "suspended" as const
        : session.isIdle ? "idle" as const : "running" as const,
    model: model === undefined ? null : { provider: text(model.provider), id: text(model.id), api: text(model.api) },
    thinkingLevel: session.thinkingLevel,
    toolPolicy: session.getToolPolicy(),
    contextUsage: session.getContextUsage() ?? null,
    prompt: composition === undefined ? null : {
      ...composition,
      sources: composition.sources.map((source) => ({ ...source, source: text(source.source) })),
      tools: composition.tools.map(text),
      skills: composition.skills.map((skill) => ({ name: text(skill.name), manifestPath: text(skill.manifestPath) })),
    },
    tools: tools.slice(0, MAX_ITEMS).map((tool) => ({
      name: text(tool.name),
      active: active.has(tool.name),
      source: tool.sourceInfo === undefined ? null : text(tool.sourceInfo.path),
      owner: text(extensions.find((extension) => extension.path === tool.sourceInfo?.path)?.id
        ?? tool.sourceInfo?.source ?? "host"),
    })),
    extensions: extensions.slice(0, MAX_ITEMS).map((extension) => ({
      id: text(extension.id),
      path: text(extension.path),
      sha256: extension.sha256,
      scope: extension.scope ?? "invocation",
    })),
    counts: { tools: tools.length, activeTools: active.size, extensions: extensions.length },
    omitted: { tools: Math.max(0, tools.length - MAX_ITEMS), extensions: Math.max(0, extensions.length - MAX_ITEMS) },
    activity: {
      operations: activity.operations,
      toolEffects: activity.toolEffects.map((effect) => ({ ...effect, toolName: text(effect.toolName) })),
    },
  };
}

export type AgentSessionInspection = ReturnType<typeof inspectAgentSession>;
