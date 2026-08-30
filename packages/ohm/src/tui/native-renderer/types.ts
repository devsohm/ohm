import type { Theme } from "../theme.js";

/** Optional renderer presentation selected by the host controller. */
export interface OhmNativePresentationOptions {
  readonly theme?: Theme;
  /** Overrides the theme capability when the terminal cannot display Unicode. */
  readonly unicode?: boolean;
}

export type OhmTuiToolStatus =
  | "pending"
  | "running"
  | "completed"
  | "error"
  | "in_doubt"
  | "unknown";

export type OhmTuiToolDetailKind =
  | "input"
  | "output"
  | "progress"
  | "source"
  | "diff"
  | "error"
  | "metadata";

export interface OhmTuiToolDetail {
  readonly label: string;
  readonly value: string;
  readonly kind: OhmTuiToolDetailKind;
  /** Render retained display text through ohm's bounded Markdown parser. */
  readonly markdown?: boolean;
  /** Keep a short bounded preview visible while the card is collapsed. */
  readonly preview?: boolean;
  /** Retain the useful tail when the rendered value exceeds its row budget. */
  readonly tail?: boolean;
}

interface OhmTuiEntryBase {
  readonly id: string;
}

export interface OhmTuiUserEntry extends OhmTuiEntryBase {
  readonly kind: "user";
  readonly text: string;
}

export interface OhmTuiAssistantEntry extends OhmTuiEntryBase {
  readonly kind: "assistant";
  readonly text: string;
}

export interface OhmTuiThinkingEntry extends OhmTuiEntryBase {
  readonly kind: "thinking";
  readonly text: string;
  readonly status: "active" | "completed";
  /** Per-entry expansion state. Omission defers to the global reasoning action. */
  readonly expanded?: boolean;
}

export interface OhmTuiToolEntry extends OhmTuiEntryBase {
  readonly kind: "tool";
  readonly name: string;
  readonly status: OhmTuiToolStatus;
  /** Compact semantic target, command, pattern, or resource description. */
  readonly headline?: string;
  /** Truthful lifecycle label including elapsed time or terminal failure data. */
  readonly state?: string;
  readonly summary?: string;
  readonly input?: string;
  readonly output?: string;
  readonly details?: readonly OhmTuiToolDetail[];
  /** Per-call expansion state. Omission defers to the global tool-details action. */
  readonly expanded?: boolean;
  readonly truncated?: boolean;
}

export interface OhmTuiNoticeEntry extends OhmTuiEntryBase {
  readonly kind: "notice";
  readonly tone: "status" | "warning" | "error";
  /** Optional retained-entry heading, such as an extension type or diagnostic title. */
  readonly label?: string;
  readonly text: string;
  /** Compact body selected while a retained entry is collapsed. */
  readonly compactText?: string;
  readonly expandable?: boolean;
  /** Per-entry expansion state. Omission defers to the global details action. */
  readonly expanded?: boolean;
  /** The retained source exceeded the native snapshot byte budget. */
  readonly truncated?: boolean;
}

export type OhmTuiTranscriptEntry =
  | OhmTuiUserEntry
  | OhmTuiAssistantEntry
  | OhmTuiThinkingEntry
  | OhmTuiToolEntry
  | OhmTuiNoticeEntry;

export interface OhmTuiQueuedMessage {
  readonly id: string;
  readonly text: string;
}

export interface OhmTuiComposerSnapshot {
  readonly value: string;
  /** Grapheme offset in value. Defaults to the end when omitted. */
  readonly cursor?: number;
  readonly placeholder?: string;
  readonly label?: string;
  readonly prompt?: string;
  readonly mode?: string;
}

export interface OhmTuiStatusSnapshot {
  readonly connection: "connected" | "connecting" | "offline" | "error";
  readonly model?: string;
  readonly reasoning?: string;
  readonly activity?: string;
}

export interface OhmTuiTelemetrySnapshot {
  readonly contextTokens?: number;
  readonly contextWindowTokens?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly cacheHitPercent?: number;
  readonly cost?: number;
  readonly subscription?: boolean;
}

/**
 * A renderer-neutral description of the visible terminal state.
 *
 * Transcript entry IDs and queued-message IDs must remain stable while their
 * content changes. Callers update the current thinking entry instead of
 * appending streaming fragments. Completed thinking entries remain visible;
 * duplicate stable IDs are replaced in place.
 */
export interface OhmTuiSnapshot {
  readonly transcript: readonly OhmTuiTranscriptEntry[];
  readonly queuedMessages: readonly OhmTuiQueuedMessage[];
  readonly composer: OhmTuiComposerSnapshot;
  readonly status: OhmTuiStatusSnapshot;
  readonly telemetry: OhmTuiTelemetrySnapshot;
}
