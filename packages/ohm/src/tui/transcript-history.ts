import type { TuiTranscriptItem } from "./types.js";

/** Internal read-only bridge: journal cursors never change the active session. */
export interface TuiTranscriptHistoryRequest {
  before?: string;
  after?: string;
  from?: string;
  edge?: "oldest";
  /** First visible message when leaving the live, bounded viewport. */
  beforeVisibleId?: string;
  limit?: number;
  maxBytes?: number;
  query?: string;
}

export interface TuiTranscriptHistoryPage {
  items: readonly TuiTranscriptItem[];
  firstId?: string;
  lastId?: string;
  from?: string;
  focusId?: string;
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
}

export interface TuiTranscriptHistorySearchResult {
  matches: readonly { id: string; preview: string }[];
  hasMore: boolean;
  cursor?: string;
}

export interface TuiTranscriptHistory {
  page(request: TuiTranscriptHistoryRequest, signal: AbortSignal): Promise<TuiTranscriptHistoryPage>;
  search(query: string, cursor: { before?: string; after?: string }, signal: AbortSignal): Promise<TuiTranscriptHistorySearchResult>;
}
