import type { TuiLimits } from "./types.js";

export class TuiSelectionCancelledError extends Error {
  constructor() {
    super("Selection cancelled");
    this.name = "TuiSelectionCancelledError";
  }
}

export const DEFAULT_TUI_LIMITS: TuiLimits = Object.freeze({
  maxTranscriptBytes: 2 * 1024 * 1024,
  maxTranscriptEntries: 2_000,
  maxToolPreviewBytes: 64 * 1024,
  maxEditorBytes: 256 * 1024,
  maxHistoryEntries: 100,
  maxUndoEntries: 100,
  maxPickerItems: 5_000,
});
