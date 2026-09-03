import { fuzzyFilter } from "../fuzzy.js";
import { decodePrintableKey, matchesKey } from "../keys.js";
import type { Component } from "../tui.js";
import { truncateToWidth, visibleWidth } from "../utils.js";

export interface SelectItem<T = string> { value: T; label: string; description?: string }
export interface SelectListTheme {
  selectedPrefix: (value: string) => string;
  selectedText: (value: string) => string;
  description: (value: string) => string;
  scrollInfo: (value: string) => string;
  noMatch: (value: string) => string;
}
export interface SelectListTruncatePrimaryContext<T = string> {
  item: SelectItem<T>;
  text: string;
  maxWidth: number;
  columnWidth: number;
  isSelected: boolean;
  /** Backward-compatible alias for maxWidth. */
  width: number;
  /** Backward-compatible alias for isSelected. */
  selected: boolean;
}
export interface SelectListLayoutOptions<T = string> {
  enableSearch?: boolean;
  minPrimaryColumnWidth?: number;
  maxPrimaryColumnWidth?: number;
  truncatePrimary?: (context: SelectListTruncatePrimaryContext<T>) => string;
}

function boundedWidth(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(maximum, Math.trunc(value)));
}

function singleLine(value: string): string {
  return value.replace(/[\r\n]+/gu, " ").trim();
}

export class SelectList<T = string> implements Component {
  readonly #items: readonly SelectItem<T>[];
  readonly #height: number;
  readonly #theme: SelectListTheme;
  #selected = 0;
  #query = "";
  focused = false;
  onSelect?: (item: SelectItem<T>) => void;
  onCancel?: () => void;
  onSelectionChange?: (item: SelectItem<T>) => void;

  constructor(
    items: readonly SelectItem<T>[],
    height: number,
    theme: SelectListTheme,
    readonly options: SelectListLayoutOptions<T> = {},
  ) {
    this.#items = items;
    this.#height = Math.max(1, height);
    this.#theme = theme;
  }

  #visible(): readonly SelectItem<T>[] {
    return this.#query === ""
      ? this.#items
      : fuzzyFilter(this.#items, this.#query, (item) => `${item.label} ${item.description ?? ""}`);
  }

  getSelectedItem(): SelectItem<T> | undefined { return this.#visible()[this.#selected]; }
  setFilter(filter: string): void { this.#query = filter; this.#selected = 0; }
  setSelectedIndex(index: number): void { this.#select(index); }

  #select(index: number): void {
    const visible = this.#visible();
    const next = visible.length === 0 ? 0 : Math.max(0, Math.min(visible.length - 1, Math.trunc(index)));
    if (next === this.#selected) return;
    this.#selected = next;
    const selected = this.getSelectedItem();
    if (selected !== undefined) this.onSelectionChange?.(selected);
  }

  handleInput(data: string): void {
    const visible = this.#visible();
    if (matchesKey(data, "down")) this.#select(Math.min(visible.length - 1, this.#selected + 1));
    else if (matchesKey(data, "up")) this.#select(Math.max(0, this.#selected - 1));
    else if (matchesKey(data, "enter")) {
      const selected = this.getSelectedItem();
      if (selected !== undefined) this.onSelect?.(selected);
    } else if (matchesKey(data, "escape")) this.onCancel?.();
    else if (this.options.enableSearch) {
      const text = decodePrintableKey(data);
      if (text !== undefined && !data.startsWith("\x1b")) {
        this.#query += text;
        this.#selected = 0;
        const selected = this.getSelectedItem();
        if (selected !== undefined) this.onSelectionChange?.(selected);
      }
    }
  }

  render(width: number): string[] {
    const columns = Number.isFinite(width) ? Math.max(0, Math.trunc(width)) : 0;
    if (columns === 0) return [];
    const visible = this.#visible();
    if (visible.length === 0) return [truncateToWidth(this.#theme.noMatch("No matches"), columns)];
    const start = Math.max(0, Math.min(this.#selected, visible.length - this.#height));
    const shown = visible.slice(start, start + this.#height);
    const structured = this.options.minPrimaryColumnWidth !== undefined
      || this.options.maxPrimaryColumnWidth !== undefined
      || this.options.truncatePrimary !== undefined;
    const primaryWidth = structured ? this.#primaryWidth(shown, columns) : 0;
    return shown.map((item, offset) => {
      const selected = start + offset === this.#selected;
      return structured
        ? this.#renderStructured(item, selected, primaryWidth, columns)
        : this.#renderLegacy(item, selected, columns);
    });
  }

  invalidate(): void {}

  #primaryWidth(items: readonly SelectItem<T>[], columns: number): number {
    const prefixWidth = Math.max(2, visibleWidth(this.#theme.selectedPrefix("> ")));
    const available = Math.max(0, columns - prefixWidth);
    const natural = items.reduce((largest, item) => Math.max(largest, visibleWidth(singleLine(item.label))), 0);
    const maximum = boundedWidth(this.options.maxPrimaryColumnWidth, available, available);
    const minimum = Math.min(maximum, boundedWidth(this.options.minPrimaryColumnWidth, 0, available));
    return Math.max(minimum, Math.min(maximum, natural));
  }

  #renderStructured(item: SelectItem<T>, selected: boolean, columnWidth: number, columns: number): string {
    const prefix = selected ? this.#theme.selectedPrefix("> ") : "  ";
    const rawText = singleLine(item.label);
    const context: SelectListTruncatePrimaryContext<T> = {
      item,
      text: rawText,
      maxWidth: columnWidth,
      columnWidth,
      isSelected: selected,
      width: columnWidth,
      selected,
    };
    const custom = this.options.truncatePrimary?.(context);
    const primary = truncateToWidth(custom === undefined ? rawText : singleLine(custom), columnWidth, "", true);
    const label = selected ? this.#theme.selectedText(primary) : primary;
    const padding = " ".repeat(Math.max(0, columnWidth - visibleWidth(primary)));
    const detail = item.description === undefined ? "" : `  ${this.#theme.description(singleLine(item.description))}`;
    return truncateToWidth(`${prefix}${label}${padding}${detail}`, columns);
  }

  #renderLegacy(item: SelectItem<T>, selected: boolean, columns: number): string {
    const prefix = selected ? this.#theme.selectedPrefix("> ") : "  ";
    const label = selected ? this.#theme.selectedText(item.label) : item.label;
    const detail = item.description === undefined ? "" : ` ${this.#theme.description(item.description)}`;
    return truncateToWidth(`${prefix}${label}${detail}`, columns);
  }
}
