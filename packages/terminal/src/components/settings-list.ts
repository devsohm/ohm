import { fuzzyFilter } from "../fuzzy.js";
import { decodePrintableKey, matchesKey } from "../keys.js";
import type { Component } from "../tui.js";
import { truncateToWidth } from "../utils.js";

export interface SettingItem {
  id: string;
  label: string;
  currentValue: string;
  values?: readonly string[];
  description?: string;
  submenu?: (
    currentValue: string,
    done: (selectedValue?: string, options?: { navigateTo?: string }) => void,
  ) => Component;
}
export interface SettingsListTheme {
  label: (value: string, selected: boolean) => string;
  value: (value: string, selected: boolean) => string;
  description: (value: string) => string;
  cursor: string;
  hint: (value: string) => string;
}
export interface SettingsListOptions { enableSearch?: boolean }

export class SettingsList implements Component {
  #selected = 0;
  #query = "";
  #submenu: Component | undefined;
  #synchronousNavigation = false;

  constructor(
    readonly items: readonly SettingItem[],
    readonly height: number,
    readonly theme: SettingsListTheme,
    readonly onChange: (id: string, value: string) => void,
    readonly onCancel: () => void,
    readonly options: SettingsListOptions = {},
  ) {}

  #visible(): readonly SettingItem[] {
    return this.#query === ""
      ? this.items
      : fuzzyFilter(this.items, this.#query, (item) => `${item.label} ${item.description ?? ""}`);
  }

  updateValue(id: string, newValue: string): void {
    const item = this.items.find((candidate) => candidate.id === id);
    if (item !== undefined) item.currentValue = newValue;
  }

  selectItem(id: string): void {
    const index = this.#visible().findIndex((item) => item.id === id);
    if (index >= 0) this.#selected = index;
  }

  #apply(): void {
    const item = this.#visible()[this.#selected];
    if (item === undefined) return;
    if (item.submenu !== undefined) {
      this.#openSubmenu(item);
      return;
    }
    if (item.values === undefined || item.values.length === 0) return;
    const current = item.currentValue;
    const index = item.values.indexOf(current);
    const next = item.values[(index + 1) % item.values.length]!;
    item.currentValue = next;
    this.onChange(item.id, next);
  }

  #openSubmenu(item: SettingItem): void {
    let completed = false;
    let component: Component | undefined;
    const done = (selectedValue?: string, options?: { navigateTo?: string }): void => {
      if (completed) return;
      completed = true;
      if (selectedValue !== undefined) {
        item.currentValue = selectedValue;
        this.onChange(item.id, selectedValue);
      }
      if (this.#submenu === component) this.#submenu = undefined;
      if (options?.navigateTo !== undefined
        && options.navigateTo !== item.id
        && !this.#synchronousNavigation) {
        const target = this.#visible().findIndex((candidate) => candidate.id === options.navigateTo);
        if (target >= 0) {
          this.#selected = target;
          this.#synchronousNavigation = true;
          try { this.#apply(); } finally { this.#synchronousNavigation = false; }
        } else this.selectItem(item.id);
      } else this.selectItem(item.id);
    };
    component = item.submenu!(item.currentValue, done);
    if (!completed) this.#submenu = component;
  }

  handleInput(data: string): void {
    if (this.#submenu !== undefined) {
      this.#submenu.handleInput?.(data);
      return;
    }
    const visible = this.#visible();
    if (matchesKey(data, "down")) this.#selected = visible.length === 0 ? 0 : Math.min(visible.length - 1, this.#selected + 1);
    else if (matchesKey(data, "up")) this.#selected = Math.max(0, this.#selected - 1);
    else if (matchesKey(data, "escape")) this.onCancel();
    else if (matchesKey(data, "enter") || (matchesKey(data, "space") && this.#query === "")) this.#apply();
    else if (this.options.enableSearch) {
      const text = decodePrintableKey(data);
      if (text !== undefined && !data.startsWith("\x1b")) {
        this.#query += text;
        this.#selected = 0;
      }
    }
  }

  render(width: number): string[] {
    if (this.#submenu !== undefined) return this.#submenu.render(width);
    const columns = Number.isFinite(width) ? Math.max(0, Math.trunc(width)) : 0;
    if (columns === 0) return [];
    const visible = this.#visible();
    if (visible.length === 0) return [truncateToWidth(this.theme.hint("No settings"), columns)];
    const visibleHeight = Number.isFinite(this.height) ? Math.max(1, Math.trunc(this.height)) : 1;
    const start = Math.max(0, Math.min(this.#selected, visible.length - visibleHeight));
    return visible.slice(start, start + visibleHeight).map((item, offset) => {
      const selected = start + offset === this.#selected;
      return truncateToWidth(
        `${selected ? this.theme.cursor : " ".repeat(this.theme.cursor.length)}`
          + `${this.theme.label(item.label, selected)}: ${this.theme.value(item.currentValue, selected)}`
          + `${item.description === undefined ? "" : ` ${this.theme.description(item.description)}`}`,
        columns,
      );
    });
  }

  invalidate(): void { this.#submenu?.invalidate(); }
}
