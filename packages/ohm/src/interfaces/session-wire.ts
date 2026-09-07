import type { AssistantMessageEvent, Usage } from "@ohm/models";

import type { AgentSessionEvent } from "../service/agent-session.js";

type WireAssistantEvent = {
  [Kind in AssistantMessageEvent["type"]]: Omit<Extract<AssistantMessageEvent, { type: Kind }>, "partial">;
}[AssistantMessageEvent["type"]];

/** Versioned machine updates carry increments, not repeated in-memory snapshots. */
export type SessionWireEvent = Exclude<AgentSessionEvent, { type: "message_update" }> | {
  type: "message_update";
  streamVersion: 1;
  usage: Usage;
  assistantMessageEvent: WireAssistantEvent;
};

/** @internal SDK subscribers keep the full event; JSON and RPC share this projection. */
export function projectSessionWireEvent(event: AgentSessionEvent): SessionWireEvent {
  if (event.type !== "message_update") return event;
  const progress = event.assistantMessageEvent;
  const snapshot = "partial" in progress ? progress.partial
    : progress.type === "done" ? progress.message : progress.error;
  const envelope = { type: "message_update", streamVersion: 1, usage: snapshot.usage } as const;
  if (!("partial" in progress)) return { ...envelope, assistantMessageEvent: progress };
  const { partial, ...increment } = progress;
  if (increment.type === "toolcall_start") {
    const call = partial.content[increment.contentIndex];
    if (call?.type === "toolCall") {
      return {
        ...envelope,
        assistantMessageEvent: { ...increment, id: call.id, name: call.name },
      };
    }
  }
  return { ...envelope, assistantMessageEvent: increment };
}
