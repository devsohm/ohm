import {
  renderTranscriptFrame,
  type TranscriptRenderOptions,
} from "../layout.js";
import type { TerminalImagePlacement } from "../terminal-image.js";
import type { Theme } from "../theme.js";
import type { TranscriptEntry, TuiRawBlock } from "../types.js";

export interface OhmTuiTranscriptContentOptions extends TranscriptRenderOptions {
  readonly columns: number;
  readonly theme: Theme;
}

/**
 * A transcript-only frame fragment. Image rows are zero-based within `block`
 * and must be offset by the owner when the fragment is placed in a full frame.
 */
export interface OhmTuiTranscriptContentProjection {
  readonly block: TuiRawBlock;
  readonly images: readonly TerminalImagePlacement[];
}

/**
 * Projects rich transcript content without reading input or writing terminal
 * protocols. The caller retains ownership of extension renderer invocation,
 * image resolution, viewport placement, and terminal lifecycle.
 */
export function projectOhmTuiTranscriptContent(
  entries: readonly TranscriptEntry[],
  { columns, theme, ...options }: OhmTuiTranscriptContentOptions,
): OhmTuiTranscriptContentProjection {
  const frame = renderTranscriptFrame(entries, columns, theme, options);
  return {
    block: {
      lines: Object.freeze(frame.text === "" ? [] : frame.text.split("\n")),
    },
    images: Object.freeze([...(frame.images ?? [])]),
  };
}
