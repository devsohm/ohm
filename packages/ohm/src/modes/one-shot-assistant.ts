import type { AgentMessage } from "@ohm/kernel";

import type { AgentSession } from "../service/agent-session.js";

export type OneShotAssistantMessage = Extract<AgentMessage, { role: "assistant" }>;

export interface OneShotAssistantBoundary {
	readonly session: AgentSession;
	readonly entryIds: ReadonlySet<string>;
}

/** Capture durable history before one prompt so older assistants cannot become its result. */
export function captureOneShotAssistantBoundary(session: AgentSession): OneShotAssistantBoundary {
	return {
		session,
		entryIds: new Set(session.sessionManager.getEntries().map((entry) => entry.id)),
	};
}

/** Return only the newest assistant appended by this prompt on the same session generation. */
export function latestOneShotAssistant(
	boundary: OneShotAssistantBoundary,
	currentSession: AgentSession,
): OneShotAssistantMessage | undefined {
	if (currentSession !== boundary.session) return undefined;
	for (const entry of currentSession.sessionManager.getEntries().toReversed()) {
		if (boundary.entryIds.has(entry.id)) continue;
		if (entry.type === "message" && entry.message.role === "assistant") return entry.message;
	}
	return undefined;
}
