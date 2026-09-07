import type { AgentSession } from "../service/agent-session.js";
import { inspectAgentSession } from "../service/session-inspection.js";
import type { InteractiveSessionOperationsTerminal } from "./interactive-session-operations.js";

function duration(start: string, end: string | null): string {
  if (end === null) return "unfinished";
  const elapsed = Date.parse(end) - Date.parse(start);
  return `${Math.max(0, elapsed)} ms`;
}

/** The interactive inspector projects the same snapshot returned by SDK, RPC, and HTTP. */
export async function showInteractiveInspection(
  session: AgentSession,
  terminal: Pick<InteractiveSessionOperationsTerminal, "choose" | "notify">,
  signal: AbortSignal,
): Promise<void> {
  const section = await terminal.choose("Inspect runtime", [
    { label: "Overview", value: "overview" },
    { label: "Context sources", value: "context" },
    { label: "Tools and owners", value: "tools" },
    { label: "Loaded plugins", value: "extensions" },
    { label: "Recent activity", value: "activity" },
  ], signal);
  signal.throwIfAborted();
  const snapshot = inspectAgentSession(session);
  let lines: string[];
  if (section === "context") {
    const prompt = snapshot.prompt;
    lines = prompt === null ? ["No provider prompt has been composed yet."] : [
      `Last composed prompt: ${prompt.bytes} bytes`,
      ...prompt.sources.map((source) => `${source.kind}: ${source.source} (${source.bytes} bytes)`),
      `Included tool definitions: ${prompt.tools.join(", ") || "none"}`,
      `Available skill descriptions: ${prompt.skills.map((skill) => skill.name).join(", ") || "none"}`,
      ...(prompt.truncated ? ["Prompt provenance was truncated at its metadata limit."] : []),
    ];
  } else if (section === "tools") {
    lines = snapshot.tools.map((tool) => `${tool.active ? "active" : "inactive"} · ${tool.name} ← ${tool.owner}\n  ${tool.source ?? "host"}`);
    if (snapshot.omitted.tools > 0) lines.push(`${snapshot.omitted.tools} additional tools omitted`);
  } else if (section === "extensions") {
    lines = snapshot.extensions.map((extension) => `${extension.id} · ${extension.scope}\n  ${extension.path}\n  ${extension.sha256}`);
    if (snapshot.omitted.extensions > 0) lines.push(`${snapshot.omitted.extensions} additional plugins omitted`);
  } else if (section === "activity") {
    lines = [
      "Recent runs",
      ...snapshot.activity.operations.map((operation) => `${operation.id} · ${operation.status} · ${duration(operation.acceptedAt, operation.finishedAt)}`
        + (operation.finishReason === null ? "" : ` · finish: ${operation.finishReason}`)
        + (operation.errorCategory === null ? "" : ` · error: ${operation.errorCategory}`)),
      "Recent tools (elapsed times can overlap for parallel calls)",
      ...snapshot.activity.toolEffects.map((effect) => `${effect.toolName} · ${effect.status} · ${duration(effect.lastDispatchedAt ?? effect.preparedAt, effect.finishedAt)}`),
    ];
  } else {
    lines = [
      `Session: ${snapshot.sessionId} · ${snapshot.state}`,
      `Workspace: ${snapshot.workspace}`,
      `Model: ${snapshot.model === null ? "none" : `${snapshot.model.provider}/${snapshot.model.id}`} · thinking: ${snapshot.thinkingLevel}`,
      `Tools: ${snapshot.counts.activeTools} active · plugins: ${snapshot.counts.extensions}`,
      `Model tool authorization: ${snapshot.toolPolicy.authorization.mode === "default_allow" ? "default allow" : "host handler"}`,
      `Dynamic gates: ${[
        ...(snapshot.toolPolicy.dynamicGates.pluginToolCall ? ["plugin tool_call"] : []),
        ...(snapshot.toolPolicy.dynamicGates.agentBeforeToolCall ? ["agent beforeToolCall"] : []),
      ].join(", ") || "none"}`,
      "Gate configuration is not a permission decision or a process/plugin sandbox.",
      snapshot.contextUsage === null ? "Context: unknown" : `Context: ${snapshot.contextUsage.tokens ?? "unknown"}/${snapshot.contextUsage.contextWindow} tokens`,
    ];
  }
  terminal.notify(lines.length === 0 ? "No entries in this section" : lines.join("\n"));
}
