import { scheduleTimeout, type ManagedTimeout, validateTimerDelay } from "../internal-timer.js";
import type { Component } from "../tui.js";
import { truncateToWidth } from "../utils.js";
import {
  assertViewportTextRows,
  isViewportWindowSource,
  VIEWPORT_COMPONENT,
  VIEWPORT_POINTER_REGIONS,
  VIEWPORT_POINTER_TARGET,
  type ViewportComponent,
  type ViewportPointerEvent,
  type ViewportPointerRegion,
  type ViewportPointerRegionComponent,
  type ViewportPointerResponse,
  type ViewportPointerTarget,
} from "../viewport.js";

export type ScrollbarVisibility = "never" | "hidden" | "auto" | "always";
export type ScrollViewScrollbar = ScrollbarVisibility | {
  visibility?: ScrollbarVisibility;
  style?: (value: string) => string;
};
export interface ScrollViewOptions {
  axis?: "vertical";
  follow?: "none" | "end";
  overscroll?: "contain" | "chain";
  scrollbar?: ScrollViewScrollbar;
  scrollbarStyle?: (value: string) => string;
  scrollbarHideDelayMs?: number;
  primary?: boolean;
}
export interface ScrollViewScrollToOptions { disableFollow?: boolean }

interface ResolvedScrollbar {
  style: ((value: string) => string) | undefined;
  visibility: ScrollbarVisibility;
}

function dimension(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function isHidden(value: ScrollbarVisibility): boolean {
  return value === "never" || value === "hidden";
}

function scrollbarOptions(value: ScrollViewScrollbar | undefined): ResolvedScrollbar {
  if (value === undefined) return { style: undefined, visibility: "never" };
  if (value === "never" || value === "hidden" || value === "auto" || value === "always") {
    return { style: undefined, visibility: value };
  }
  return { style: value.style, visibility: value.visibility ?? "never" };
}

export class ScrollView implements ViewportComponent, ViewportPointerTarget, ViewportPointerRegionComponent {
  readonly [VIEWPORT_COMPONENT] = true as const;
  readonly [VIEWPORT_POINTER_TARGET] = true as const;
  readonly [VIEWPORT_POINTER_REGIONS] = true as const;
  scrollTop = 0;
  isFollowingEnd: boolean;
  readonly #hideDelay: number;
  #timer: ManagedTimeout | undefined;
  #height = 0;
  #contentHeight = 0;
  #requestRender: (() => void) | undefined;
  #dragging = false;
  #width = 0;
  #scrollbar: ScrollbarVisibility;
  #scrollbarStyle: (value: string) => string;
  #scrollbarActive = false;
  #transientScrollbarVisible = false;
  #paintPending = false;

  constructor(readonly child: Component, readonly options: ScrollViewOptions = {}) {
    if (options.axis !== undefined && options.axis !== "vertical") {
      throw new Error(`Unsupported scroll axis: ${String(options.axis)}`);
    }
    const selectedScrollbar = scrollbarOptions(options.scrollbar);
    this.isFollowingEnd = options.follow === "end";
    this.#scrollbar = selectedScrollbar.visibility;
    this.#scrollbarStyle = options.scrollbarStyle
      ?? selectedScrollbar.style
      ?? ((value) => `\x1b[7m${value}\x1b[0m`);
    this.#hideDelay = validateTimerDelay(
      options.scrollbarHideDelayMs === undefined ? 800 : options.scrollbarHideDelayMs,
      "scrollbar hide delay",
    );
  }

  get contentRows(): number { return this.#contentHeight; }
  get viewportRows(): number { return this.#height; }
  get viewportHeight(): number { return this.#height; }
  get maxScrollTop(): number { return Math.max(0, this.#contentHeight - this.#height); }
  get primary(): boolean { return this.options.primary ?? false; }
  get overscroll(): "contain" | "chain" { return this.options.overscroll ?? "contain"; }
  get scrollbar(): ScrollbarVisibility { return this.#scrollbar; }
  get scrollbarStyle(): (value: string) => string { return this.#scrollbarStyle; }
  get isScrollbarVisible(): boolean {
    if (this.#scrollbar === "always") return this.#height > 0;
    return this.#scrollbar === "auto"
      && this.#contentHeight > this.#height
      && this.#transientScrollbarVisible;
  }

  getContentWidth(width: number): number {
    const columns = dimension(width);
    return this.#scrollbar === "always" && columns > 1 ? columns - 1 : columns;
  }

  setScrollbar(scrollbar: ScrollViewScrollbar): void {
    const selected = scrollbarOptions(scrollbar);
    const nextStyle = selected.style ?? this.#scrollbarStyle;
    if (selected.visibility === this.#scrollbar && nextStyle === this.#scrollbarStyle) return;
    this.#scrollbar = selected.visibility;
    this.#scrollbarStyle = nextStyle;
    if (selected.visibility !== "auto") this.#hideTransientScrollbar();
    else if (this.#scrollbarActive) this.#showTransientScrollbar();
    this.#requestRender?.();
  }

  render(width: number): string[] { return this.child.render(width); }

  renderViewport(width: number, height: number, requestRender?: () => void): string[] {
    const columns = dimension(width);
    const contentColumns = this.getContentWidth(columns);
    this.#width = columns;
    this.#height = dimension(height);
    this.#requestRender = requestRender;
    this.#paintPending = false;
    const source = isViewportWindowSource(this.child) ? this.child : undefined;
    const contentHeight = source === undefined ? undefined : source.viewportRowCount(contentColumns);
    if (contentHeight !== undefined && (!Number.isSafeInteger(contentHeight) || contentHeight < 0)) {
      throw new RangeError("viewport row count must be a non-negative safe integer");
    }
    const all = source === undefined ? this.child.render(contentColumns) : undefined;
    if (all !== undefined) assertViewportTextRows(all);
    this.#contentHeight = all?.length ?? Math.trunc(contentHeight!);
    const maximum = this.maxScrollTop;
    if (this.isFollowingEnd) this.scrollTop = maximum;
    else this.scrollTop = Math.max(0, Math.min(this.scrollTop, maximum));
    const rendered = all?.slice(this.scrollTop, this.scrollTop + this.#height)
      ?? source!.renderViewportRows(contentColumns, this.scrollTop, this.#height, requestRender);
    assertViewportTextRows(rendered);
    const visible = rendered
      .slice(0, this.#height)
      .map((line) => truncateToWidth(line, contentColumns, "", true));
    while (visible.length < this.#height) visible.push(" ".repeat(contentColumns));
    this.#paintScrollbar(visible, columns, contentColumns, maximum);
    return visible;
  }

  scrollBy(rows: number): number {
    const amount = Number.isFinite(rows) ? Math.trunc(rows) : 0;
    const previous = this.scrollTop;
    const next = Math.max(0, Math.min(this.maxScrollTop, previous + amount));
    this.scrollTop = next;
    if (amount < 0) this.isFollowingEnd = false;
    else if (amount > 0 && next === this.maxScrollTop) this.isFollowingEnd = this.options.follow === "end";
    if (next !== previous) this.#showTransientScrollbar();
    this.#requestRender?.();
    return this.overscroll === "chain" ? amount - (next - previous) : 0;
  }

  scrollTo(scrollTop: number, options: ScrollViewScrollToOptions = {}): void {
    if (!Number.isFinite(scrollTop)) return;
    const previous = this.scrollTop;
    const next = Math.max(0, Math.min(this.maxScrollTop, Math.trunc(scrollTop)));
    this.scrollTop = next;
    this.isFollowingEnd = options.disableFollow !== true
      && this.options.follow === "end"
      && next === this.maxScrollTop;
    if (next !== previous) this.#showTransientScrollbar();
    this.#requestRender?.();
  }

  scrollToStart(): void { this.scrollTo(0, { disableFollow: true }); }
  scrollToEnd(): void {
    this.scrollTop = this.maxScrollTop;
    this.isFollowingEnd = true;
    this.#showTransientScrollbar();
    this.#requestRender?.();
  }

  viewportPointerRegions(): readonly ViewportPointerRegion[] {
    return [{
      component: this.child,
      row: -this.scrollTop,
      column: 0,
      width: this.getContentWidth(this.#width),
      height: this.#contentHeight,
    }];
  }

  setScrollbarActive(active: boolean): void {
    if (active === this.#scrollbarActive) {
      if (active) this.#showTransientScrollbar();
      return;
    }
    this.#scrollbarActive = active;
    if (active) this.#showTransientScrollbar();
    else this.#scheduleScrollbarHide();
  }

  handleViewportPointer(event: ViewportPointerEvent, width: number, height: number): ViewportPointerResponse {
    if (event.type === "wheel") return { handled: true, remainingRows: this.scrollBy(event.deltaRows ?? 0) };
    const maximum = Math.max(0, this.#contentHeight - height);
    const hasBar = !isHidden(this.#scrollbar) && maximum > 0 && height > 0 && width > 0;
    const thumb = hasBar
      ? Math.min(height - 1, Math.floor(this.scrollTop / maximum * Math.max(0, height - 1)))
      : -1;
    const onThumb = hasBar && event.column === width - 1 && event.row === thumb;
    if (event.type === "move" && !this.#dragging) {
      this.setScrollbarActive(onThumb);
      return { handled: onThumb };
    }
    if (event.type === "press" && onThumb && event.button === "left") {
      this.#dragging = true;
      this.setScrollbarActive(true);
      return { handled: true, capture: true };
    }
    if (event.type === "move" && this.#dragging) {
      const next = Math.round(Math.max(0, Math.min(height - 1, event.row)) / Math.max(1, height - 1) * maximum);
      this.scrollTo(next, { disableFollow: true });
      return { handled: true };
    }
    if (event.type === "release" && this.#dragging) {
      this.#dragging = false;
      return { handled: true, releaseCapture: true };
    }
    if (event.type === "cancel" || event.type === "leave") {
      this.#dragging = false;
      this.setScrollbarActive(false);
      return { releaseCapture: true };
    }
    return { handled: false };
  }

  dispose(): void { this.#timer?.clear(); }
  invalidate(): void { this.child.invalidate(); }

  #paintScrollbar(rows: string[], columns: number, contentColumns: number, maximum: number): void {
    if (this.#scrollbar === "always" && columns > contentColumns) {
      for (let index = 0; index < rows.length; index += 1) rows[index] = `${rows[index]} `;
    }
    if (!this.isScrollbarVisible || maximum <= 0 || columns <= 0 || rows.length === 0) return;
    const thumb = Math.min(rows.length - 1, Math.floor(this.scrollTop / maximum * Math.max(0, rows.length - 1)));
    const cell = truncateToWidth(this.#scrollbarStyle(" "), 1, "", true);
    rows[thumb] = `${truncateToWidth(rows[thumb]!, columns - 1, "", true)}${cell}`;
  }

  #showTransientScrollbar(): void {
    if (this.#scrollbar !== "auto") return;
    this.#timer?.clear();
    this.#timer = undefined;
    const changed = !this.#transientScrollbarVisible;
    this.#transientScrollbarVisible = true;
    if (!this.#scrollbarActive) this.#scheduleScrollbarHide();
    if (changed && this.#requestRender !== undefined) {
      this.#paintPending = true;
      this.#requestRender();
    }
  }

  #scheduleScrollbarHide(): void {
    this.#timer?.clear();
    this.#timer = undefined;
    if (this.#scrollbar !== "auto" || !this.#transientScrollbarVisible || this.#scrollbarActive) return;
    this.#timer = scheduleTimeout(() => {
      this.#timer = undefined;
      if (!this.#transientScrollbarVisible) return;
      this.#transientScrollbarVisible = false;
      if (!this.#paintPending) this.#requestRender?.();
    }, this.#hideDelay);
    this.#timer.unref();
  }

  #hideTransientScrollbar(): void {
    this.#timer?.clear();
    this.#timer = undefined;
    this.#transientScrollbarVisible = false;
  }
}
