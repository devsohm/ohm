import type { AgentSession, AgentSessionModelCycleOptions, SessionWireEvent } from "ohm";
import { createAgentSession } from "ohm/sdk";
import { SessionManager, type SessionContext, type SessionHistoryPage } from "ohm/storage";
import type { OverlayBounds, OverlayHandle, TuiPointerOptions, ViewportPointerEvent } from "ohm/tui";

const cycle: AgentSessionModelCycleOptions = { models: [{ selector: "provider/model", thinkingLevel: "high" }], persist: false };
declare const session: AgentSession;
void session.cycleModel("forward", cycle);
void session.cycleThinkingLevel({ persist: false });
void createAgentSession({ sessionManager: SessionManager.inMemory(process.cwd()) });
if (session.sessionFile !== undefined) {
  const manager = SessionManager.openSnapshot(session.sessionFile);
  const history: SessionHistoryPage = manager.getHistoryPage();
  const selection: Pick<SessionContext, "model" | "thinkingLevel"> & { hasPersistedThinking: boolean } = manager.getPersistedSelection();
  void [history, selection];
}
declare const event: SessionWireEvent;
if (event.type === "message_update") {
  const version: 1 = event.streamVersion;
  void version;
  if (event.assistantMessageEvent.type === "text_delta") void event.assistantMessageEvent.delta;
  // @ts-expect-error Cumulative SDK snapshots are not part of the machine wire.
  void event.message;
}
declare const overlay: OverlayHandle;
const bounds: Readonly<OverlayBounds> | undefined = overlay.getBounds();
const pointerOptions: TuiPointerOptions = { mouse: true };
declare const pointer: ViewportPointerEvent;
void [bounds, pointerOptions, pointer.shift, pointer.clickCount];
