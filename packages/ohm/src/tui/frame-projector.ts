import type { TranscriptRenderOptions } from "./layout.js";
import type { Theme } from "./theme.js";
import type { Frame, TuiControllerOptions, TuiViewState } from "./types.js";
import type { RuntimeUiBlock } from "./components.js";
import type { OhmTranscriptSearchMatch } from "./native-renderer/transcript-search.js";
import type { OhmNativeToolDetailCache } from "./native-renderer/view.js";

export const INTERNAL_TUI_TOOL_DETAIL_CACHE: unique symbol = Symbol("ohm.tui.tool-detail-cache");

export interface TuiFrameProjectionRequest {
  readonly view: TuiViewState;
  readonly size: Readonly<{ columns: number; rows: number }>;
  readonly theme: Theme;
  readonly transcriptOptions: TranscriptRenderOptions;
  readonly themeName: string;
  readonly color: boolean;
  readonly unicode: boolean;
  readonly thinkingExpanded: boolean;
  readonly toolDetailsExpanded: boolean;
  readonly hideReasoningBlock: boolean;
  readonly editorPaddingX: number;
  readonly outputPad: 0 | 1;
  readonly codeBlockIndent: string;
  /** Controller-owned mutation revision for safe retained transcript layout reuse. */
  readonly transcriptRevision?: number;
  /** @internal Controller-owned native tool-detail wrap state. */
  readonly [INTERNAL_TUI_TOOL_DETAIL_CACHE]?: OhmNativeToolDetailCache;
}

/** Internal lineage attached only to controller-owned persistent structured blocks. */
export interface TuiPersistentPointerSource {
  readonly token: object;
  readonly rows: readonly (number | undefined)[];
}

export const INTERNAL_TUI_PERSISTENT_POINTER_SOURCE: unique symbol = Symbol("ohm.tui.persistent-pointer-source");

export type TuiPersistentPointerBlock = RuntimeUiBlock & {
  readonly [INTERNAL_TUI_PERSISTENT_POINTER_SOURCE]?: TuiPersistentPointerSource;
};

export interface TuiPersistentPointerMap {
  readonly rows: readonly {
    readonly row: number;
    readonly left: number;
    readonly right: number;
    readonly token: object;
    readonly localRow: number;
    readonly localColumn: number;
  }[];
}

export const INTERNAL_TUI_PERSISTENT_POINTER_MAP: unique symbol = Symbol("ohm.tui.persistent-pointer-map");

export interface TuiTranscriptSearchProjection {
  readonly query: string;
  readonly matches: readonly OhmTranscriptSearchMatch[];
  readonly selectedMatch?: number;
  readonly truncated: boolean;
}

export const INTERNAL_TUI_TRANSCRIPT_SEARCH: unique symbol = Symbol("ohm.tui.transcript-search");

export type TuiProjectedFrame = Frame & {
  readonly cursor: NonNullable<Frame["cursor"]>;
  readonly [INTERNAL_TUI_PERSISTENT_POINTER_MAP]?: TuiPersistentPointerMap;
  readonly [INTERNAL_TUI_TRANSCRIPT_SEARCH]?: TuiTranscriptSearchProjection;
};

export const INTERNAL_TUI_FRAME_PROJECTOR_CLEAR: unique symbol = Symbol("ohm.tui.frame-projector-clear");

export type TuiFrameProjector = {
  (request: Readonly<TuiFrameProjectionRequest>): TuiProjectedFrame;
  readonly [INTERNAL_TUI_FRAME_PROJECTOR_CLEAR]?: () => void;
};

export const INTERNAL_TUI_FRAME_PROJECTOR: unique symbol = Symbol("ohm.tui.frame-projector");

export type InternalTuiControllerOptions = TuiControllerOptions & {
  readonly [INTERNAL_TUI_FRAME_PROJECTOR]?: TuiFrameProjector;
  readonly [INTERNAL_TUI_TOOL_DETAIL_CACHE]?: OhmNativeToolDetailCache;
};
