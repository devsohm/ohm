import {
  isErrorValue,
  isRecordValue,
  isStringValue,
} from "./value-guards.js";
import { readFileBounded } from "../tools/paths.js";
import type { KeyEvent } from "./keys.js";
import {
  KeybindingsManager as TerminalKeybindingsManager,
  type KeybindingDefinitions,
  type KeybindingsConfig,
} from "@ohm/terminal";

/** ohm actions contributed to the shared TUI keybinding registry. */
export interface AppKeybindings {
  "tui.transcript.searchOpen": true;
  "tui.transcript.searchNext": true;
  "tui.transcript.searchPrevious": true;
  "tui.transcript.searchClose": true;
  "app.interrupt": true;
  "app.clear": true;
  "app.exit": true;
  "app.suspend": true;
  "app.editor.external": true;
  "app.model.select": true;
  "app.thinking.cycle": true;
  "app.thinking.toggle": true;
  "app.tools.expand": true;
  "app.message.followUp": true;
  "app.message.dequeue": true;
  "app.message.copy": true;
  "app.clipboard.pasteImage": true;
  "app.session.resume": true;
  "app.session.new": true;
  "app.session.atlas": true;
  "app.session.toggleScope": true;
  "app.session.togglePath": true;
  "app.session.toggleSort": true;
  "app.session.toggleNamedFilter": true;
  "app.session.delete": true;
  "app.session.deleteNoninvasive": true;
  "app.tree.editLabel": true;
  "app.tree.filter.all": true;
  "app.tree.filter.cycleBackward": true;
  "app.tree.filter.cycleForward": true;
  "app.tree.filter.default": true;
  "app.tree.filter.labeledOnly": true;
  "app.tree.filter.noTools": true;
  "app.tree.filter.userOnly": true;
  "app.tree.foldOrUp": true;
  "app.tree.toggleLabelTimestamp": true;
  "app.tree.unfoldOrDown": true;
  "app.tree.togglePath": true;
}

declare module "@ohm/terminal" {
  interface Keybindings extends AppKeybindings {}
}

export const KEYBINDING_ACTIONS = [
  "tui.editor.cursorUp",
  "tui.editor.cursorDown",
  "tui.editor.cursorLeft",
  "tui.editor.cursorRight",
  "tui.editor.cursorWordLeft",
  "tui.editor.cursorWordRight",
  "tui.editor.cursorLineStart",
  "tui.editor.cursorLineEnd",
  "tui.editor.jumpForward",
  "tui.editor.jumpBackward",
  "tui.editor.pageUp",
  "tui.editor.pageDown",
  "tui.editor.deleteCharBackward",
  "tui.editor.deleteCharForward",
  "tui.editor.deleteWordBackward",
  "tui.editor.deleteWordForward",
  "tui.editor.deleteToLineStart",
  "tui.editor.deleteToLineEnd",
  "tui.editor.yank",
  "tui.editor.yankPop",
  "tui.editor.undo",
  "tui.editor.redo",
  "tui.input.newLine",
  "tui.input.submit",
  "tui.input.tab",
  "tui.input.copy",
  "tui.select.up",
  "tui.select.down",
  "tui.select.pageUp",
  "tui.select.pageDown",
  "tui.select.confirm",
  "tui.select.cancel",
  "tui.transcript.pageUp",
  "tui.transcript.pageDown",
  "tui.transcript.previousPrompt",
  "tui.transcript.nextPrompt",
  "tui.transcript.top",
  "tui.transcript.bottom",
  "tui.transcript.searchOpen",
  "tui.transcript.searchNext",
  "tui.transcript.searchPrevious",
  "tui.transcript.searchClose",
  "app.interrupt",
  "app.clear",
  "app.exit",
  "app.suspend",
  "app.editor.external",
  "app.model.select",
  "app.thinking.cycle",
  "app.thinking.toggle",
  "app.tools.expand",
  "app.message.followUp",
  "app.message.dequeue",
  "app.message.copy",
  "app.clipboard.pasteImage",
  "app.session.resume",
  "app.session.new",
  "app.session.atlas",
  "app.session.toggleScope",
  "app.session.togglePath",
  "app.session.toggleSort",
  "app.session.toggleNamedFilter",
  "app.session.delete",
  "app.session.deleteNoninvasive",
  "app.tree.editLabel",
  "app.tree.toggleLabelTimestamp",
  "app.tree.filter.default",
  "app.tree.filter.noTools",
  "app.tree.filter.userOnly",
  "app.tree.filter.labeledOnly",
  "app.tree.filter.all",
  "app.tree.filter.cycleForward",
  "app.tree.filter.cycleBackward",
  "app.tree.foldOrUp",
  "app.tree.unfoldOrDown",
  "app.tree.togglePath",
] as const;

export type KeybindingAction = typeof KEYBINDING_ACTIONS[number];
export interface KeybindingOverrides {
  "tui.editor.cursorUp"?: string | readonly string[];
  "tui.editor.cursorDown"?: string | readonly string[];
  "tui.editor.cursorLeft"?: string | readonly string[];
  "tui.editor.cursorRight"?: string | readonly string[];
  "tui.editor.cursorWordLeft"?: string | readonly string[];
  "tui.editor.cursorWordRight"?: string | readonly string[];
  "tui.editor.cursorLineStart"?: string | readonly string[];
  "tui.editor.cursorLineEnd"?: string | readonly string[];
  "tui.editor.jumpForward"?: string | readonly string[];
  "tui.editor.jumpBackward"?: string | readonly string[];
  "tui.editor.pageUp"?: string | readonly string[];
  "tui.editor.pageDown"?: string | readonly string[];
  "tui.editor.deleteCharBackward"?: string | readonly string[];
  "tui.editor.deleteCharForward"?: string | readonly string[];
  "tui.editor.deleteWordBackward"?: string | readonly string[];
  "tui.editor.deleteWordForward"?: string | readonly string[];
  "tui.editor.deleteToLineStart"?: string | readonly string[];
  "tui.editor.deleteToLineEnd"?: string | readonly string[];
  "tui.editor.yank"?: string | readonly string[];
  "tui.editor.yankPop"?: string | readonly string[];
  "tui.editor.undo"?: string | readonly string[];
  "tui.editor.redo"?: string | readonly string[];
  "tui.input.newLine"?: string | readonly string[];
  "tui.input.submit"?: string | readonly string[];
  "tui.input.tab"?: string | readonly string[];
  "tui.input.copy"?: string | readonly string[];
  "tui.select.up"?: string | readonly string[];
  "tui.select.down"?: string | readonly string[];
  "tui.select.pageUp"?: string | readonly string[];
  "tui.select.pageDown"?: string | readonly string[];
  "tui.select.confirm"?: string | readonly string[];
  "tui.select.cancel"?: string | readonly string[];
  "tui.transcript.pageUp"?: string | readonly string[];
  "tui.transcript.pageDown"?: string | readonly string[];
  "tui.transcript.previousPrompt"?: string | readonly string[];
  "tui.transcript.nextPrompt"?: string | readonly string[];
  "tui.transcript.top"?: string | readonly string[];
  "tui.transcript.bottom"?: string | readonly string[];
  "tui.transcript.searchOpen"?: string | readonly string[];
  "tui.transcript.searchNext"?: string | readonly string[];
  "tui.transcript.searchPrevious"?: string | readonly string[];
  "tui.transcript.searchClose"?: string | readonly string[];
  "app.interrupt"?: string | readonly string[];
  "app.clear"?: string | readonly string[];
  "app.exit"?: string | readonly string[];
  "app.suspend"?: string | readonly string[];
  "app.editor.external"?: string | readonly string[];
  "app.model.select"?: string | readonly string[];
  "app.thinking.cycle"?: string | readonly string[];
  "app.thinking.toggle"?: string | readonly string[];
  "app.tools.expand"?: string | readonly string[];
  "app.message.followUp"?: string | readonly string[];
  "app.message.dequeue"?: string | readonly string[];
  "app.message.copy"?: string | readonly string[];
  "app.clipboard.pasteImage"?: string | readonly string[];
  "app.session.resume"?: string | readonly string[];
  "app.session.new"?: string | readonly string[];
  "app.session.atlas"?: string | readonly string[];
  "app.session.toggleScope"?: string | readonly string[];
  "app.session.togglePath"?: string | readonly string[];
  "app.session.toggleSort"?: string | readonly string[];
  "app.session.toggleNamedFilter"?: string | readonly string[];
  "app.session.delete"?: string | readonly string[];
  "app.session.deleteNoninvasive"?: string | readonly string[];
  "app.tree.editLabel"?: string | readonly string[];
  "app.tree.toggleLabelTimestamp"?: string | readonly string[];
  "app.tree.filter.default"?: string | readonly string[];
  "app.tree.filter.noTools"?: string | readonly string[];
  "app.tree.filter.userOnly"?: string | readonly string[];
  "app.tree.filter.labeledOnly"?: string | readonly string[];
  "app.tree.filter.all"?: string | readonly string[];
  "app.tree.filter.cycleForward"?: string | readonly string[];
  "app.tree.filter.cycleBackward"?: string | readonly string[];
  "app.tree.foldOrUp"?: string | readonly string[];
  "app.tree.unfoldOrDown"?: string | readonly string[];
  "app.tree.togglePath"?: string | readonly string[];
}

const ACTIONS = new Set<string>(KEYBINDING_ACTIONS);
const SPECIAL_KEYS = new Set([
  "backspace", "begin", "capslock", "delete", "down", "end", "enter", "escape", "home", "insert", "left", "menu",
  "numlock", "pagedown", "pageup", "pause", "printscreen", "right", "scrolllock", "space", "tab", "up",
  ...Array.from({ length: 35 }, (_, index) => `f${index + 1}`),
  ...Array.from({ length: 10 }, (_, index) => `kp${index}`),
  "kpadd", "kpbegin", "kpdecimal", "kpdelete", "kpdivide", "kpend", "kpenter", "kpequal", "kphome", "kpinsert",
  "kpleft", "kpmultiply", "kppagedown", "kppageup", "kpright", "kpseparator", "kpsubtract", "kpup", "kpdown",
]);
const SYMBOL_KEYS = new Set("`-=[]\\;',./!@#$%^&*()_+|~{}:<>?".split(""));
const MAX_KEYBINDINGS_BYTES = 64 * 1024;

export const DEFAULT_KEYBINDINGS: Readonly<Record<KeybindingAction, readonly string[]>> = Object.freeze({
  "tui.editor.cursorUp": ["up"],
  "tui.editor.cursorDown": ["down"],
  "tui.editor.cursorLeft": ["left", "ctrl+b"],
  "tui.editor.cursorRight": ["right", "ctrl+f"],
  "tui.editor.cursorWordLeft": ["alt+left", "ctrl+left", "alt+b"],
  "tui.editor.cursorWordRight": ["alt+right", "ctrl+right", "alt+f"],
  "tui.editor.cursorLineStart": ["home", "ctrl+a"],
  "tui.editor.cursorLineEnd": ["end", "ctrl+e"],
  "tui.editor.jumpForward": ["ctrl+]"],
  "tui.editor.jumpBackward": ["ctrl+alt+]"],
  "tui.editor.pageUp": ["pageup"],
  "tui.editor.pageDown": ["pagedown"],
  "tui.editor.deleteCharBackward": ["backspace"],
  "tui.editor.deleteCharForward": ["delete"],
  "tui.editor.deleteWordBackward": ["ctrl+w", "alt+backspace"],
  "tui.editor.deleteWordForward": ["alt+d", "alt+delete"],
  "tui.editor.deleteToLineStart": ["ctrl+u"],
  "tui.editor.deleteToLineEnd": ["ctrl+k"],
  "tui.editor.yank": ["ctrl+y"],
  "tui.editor.yankPop": ["alt+y"],
  "tui.editor.undo": ["ctrl+z"],
  "tui.editor.redo": ["ctrl+shift+z"],
  "tui.input.newLine": ["shift+enter", "ctrl+j"],
  "tui.input.submit": ["enter"],
  "tui.input.tab": ["tab"],
  "tui.input.copy": ["ctrl+c"],
  "tui.select.up": ["up", "shift+tab"],
  "tui.select.down": ["down", "tab"],
  "tui.select.pageUp": ["pageup"],
  "tui.select.pageDown": ["pagedown"],
  "tui.select.confirm": ["enter"],
  "tui.select.cancel": ["escape", "ctrl+c"],
  "tui.transcript.pageUp": ["pageup"],
  "tui.transcript.pageDown": ["pagedown"],
  "tui.transcript.previousPrompt": ["ctrl+shift+up"],
  "tui.transcript.nextPrompt": ["ctrl+shift+down"],
  "tui.transcript.top": ["ctrl+home"],
  "tui.transcript.bottom": ["ctrl+end"],
  "tui.transcript.searchOpen": ["ctrl+shift+f"],
  "tui.transcript.searchNext": ["enter", "ctrl+g"],
  "tui.transcript.searchPrevious": ["shift+enter", "ctrl+shift+g"],
  "tui.transcript.searchClose": ["escape"],
  "app.interrupt": ["escape"],
  "app.clear": ["ctrl+c"],
  "app.exit": ["ctrl+d"],
  "app.suspend": [],
  "app.editor.external": ["ctrl+g"],
  "app.model.select": ["ctrl+l"],
  "app.thinking.cycle": ["shift+tab"],
  "app.thinking.toggle": ["ctrl+t"],
  "app.tools.expand": ["ctrl+o"],
  "app.message.followUp": ["alt+enter"],
  "app.message.dequeue": ["alt+up"],
  "app.message.copy": ["ctrl+x"],
  "app.clipboard.pasteImage": process.platform === "win32" ? ["alt+v"] : ["ctrl+v"],
  "app.session.resume": [],
  "app.session.new": [],
  "app.session.atlas": [],
  "app.session.toggleScope": ["ctrl+a"],
  "app.session.togglePath": ["ctrl+p"],
  "app.session.toggleSort": ["ctrl+s"],
  "app.session.toggleNamedFilter": ["ctrl+n"],
  "app.session.delete": ["ctrl+d"],
  "app.session.deleteNoninvasive": ["ctrl+backspace"],
  "app.tree.editLabel": ["shift+l"],
  "app.tree.toggleLabelTimestamp": ["shift+t"],
  "app.tree.filter.default": ["ctrl+d"],
  "app.tree.filter.noTools": ["ctrl+t"],
  "app.tree.filter.userOnly": ["ctrl+u"],
  "app.tree.filter.labeledOnly": ["ctrl+l"],
  "app.tree.filter.all": ["ctrl+a"],
  "app.tree.filter.cycleForward": ["ctrl+o"],
  "app.tree.filter.cycleBackward": ["ctrl+shift+o"],
  "app.tree.foldOrUp": ["ctrl+left", "alt+left"],
  "app.tree.unfoldOrDown": ["ctrl+right", "alt+right"],
  "app.tree.togglePath": ["ctrl+p"],
});

const COMPLETE_KEYBINDING_DEFINITIONS: KeybindingDefinitions = Object.freeze(Object.fromEntries(
  KEYBINDING_ACTIONS.map((action) => [action, { defaultKeys: [...DEFAULT_KEYBINDINGS[action]] }]),
));

export function normalizeKeybinding(value: string): string {
  const input = value.trim().toLowerCase();
  const parts = input === "+"
    ? ["+"]
    : input.endsWith("++")
      ? [...input.slice(0, -2).split("+"), "+"].map((part) => part.trim())
      : input.split("+").map((part) => part.trim());
  if (parts.some((part) => part === "")) throw new Error(`Invalid keybinding: ${value}`);
  const baseInput = parts.pop();
  if (baseInput === undefined) throw new Error(`Invalid keybinding: ${value}`);
  const modifiers = new Set(parts);
  if ([...modifiers].some((part) => !["ctrl", "shift", "alt", "super", "hyper", "meta"].includes(part)) || modifiers.size !== parts.length) {
    throw new Error(`Invalid keybinding modifiers: ${value}`);
  }
  const base = baseInput === "esc" ? "escape" : baseInput === "return" ? "enter" : baseInput;
  if (!SPECIAL_KEYS.has(base) && !/^[a-z0-9]$/u.test(base) && !SYMBOL_KEYS.has(base)) {
    throw new Error(`Unsupported keybinding key: ${value}`);
  }
  return [
    modifiers.has("ctrl") ? "ctrl" : undefined,
    modifiers.has("shift") ? "shift" : undefined,
    modifiers.has("alt") ? "alt" : undefined,
    modifiers.has("super") ? "super" : undefined,
    modifiers.has("hyper") ? "hyper" : undefined,
    modifiers.has("meta") ? "meta" : undefined,
    base,
  ]
    .filter(Boolean)
    .join("+");
}

export function keybindingForEvent(event: KeyEvent): string {
  const shiftedText = event.key === "text" && event.text !== undefined && /^[A-Z]$/u.test(event.text);
  const base = event.key === "newline" && event.ctrl
    ? "j"
    : event.key === "text" && event.text !== undefined && [...event.text].length === 1
      ? event.text.toLowerCase()
      : event.key.toLowerCase();
  return [
    event.ctrl ? "ctrl" : undefined,
    event.shift || shiftedText ? "shift" : undefined,
    event.alt ? "alt" : undefined,
    event.super ? "super" : undefined,
    event.hyper ? "hyper" : undefined,
    event.meta ? "meta" : undefined,
    base,
  ]
    .filter(Boolean)
    .join("+");
}

function bindingArray(value: string | readonly string[], action: string): string[] {
  const input = isStringValue(value) ? [value] : value;
  if (input.length > 16 || input.some((entry) => !isStringValue(entry) || entry.trim() === "")) {
    throw new Error(`Keybinding ${action} must contain at most 16 non-empty keys`);
  }
  return [...new Set(input.map(normalizeKeybinding))];
}

export interface KeybindingConflict {
  scope: "editor" | "selection" | "transcript" | "session" | "tree";
  key: string;
  actions: KeybindingAction[];
}

const EDITOR_ACTIONS = KEYBINDING_ACTIONS.filter((action) =>
  action.startsWith("tui.editor.")
  || action.startsWith("tui.input.")
  || (action.startsWith("app.")
    && !action.startsWith("app.session.toggle")
    && !action.startsWith("app.session.delete")
    && !action.startsWith("app.tree.")));
const SELECT_ACTIONS = KEYBINDING_ACTIONS.filter((action) => action.startsWith("tui.select."));
const TRANSCRIPT_ACTIONS = KEYBINDING_ACTIONS.filter((action) => action.startsWith("tui.transcript."));
const CONFLICT_SCOPES: ReadonlyArray<readonly [KeybindingConflict["scope"], readonly KeybindingAction[]]> = [
  ["editor", EDITOR_ACTIONS],
  ["selection", SELECT_ACTIONS],
  ["transcript", TRANSCRIPT_ACTIONS],
  ["session", [...SELECT_ACTIONS, ...KEYBINDING_ACTIONS.filter((action) => action.startsWith("app.session.toggle") || action.startsWith("app.session.delete"))]],
  ["tree", [...SELECT_ACTIONS, "app.message.copy", ...KEYBINDING_ACTIONS.filter((action) => action.startsWith("app.tree."))]],
];

function managerConfig(overrides: KeybindingOverrides): KeybindingsConfig {
  const config: KeybindingsConfig = {};
  for (const action of KEYBINDING_ACTIONS) {
    const selected = overrides[action];
    if (selected !== undefined) config[action] = bindingArray(selected, action);
  }
  return config;
}

function isStringArray<Value>(value: Value): value is Value & string[] {
  return Array.isArray(value) && value.every(isStringValue);
}

function isKeybindingDefinitions<Value>(value: Value): value is Value & KeybindingDefinitions {
  if (!isRecordValue(value)) return false;
  return Object.values(value).every((definition) =>
    isRecordValue(definition)
    && (isStringValue(definition.defaultKeys) || isStringArray(definition.defaultKeys))
    && (definition.description === undefined || isStringValue(definition.description)));
}

function isKeybindingOverrides<Value>(value: Value): value is Value & KeybindingOverrides {
  return isRecordValue(value) && Object.values(value).every((binding) =>
    binding === undefined || isStringValue(binding) || isStringArray(binding));
}

/** Application keybindings for direct terminal integrations. */
export class KeybindingsManager extends TerminalKeybindingsManager {
  constructor(definitions: KeybindingDefinitions, userBindings?: KeybindingsConfig);
  constructor(overrides?: KeybindingOverrides);
  constructor(
    definitionsOrOverrides?: KeybindingDefinitions | KeybindingOverrides,
    userBindings?: KeybindingsConfig,
  ) {
    const selected = definitionsOrOverrides ?? {};
    const definition = Object.values(selected)[0];
    const usesDefinitions = (
      userBindings !== undefined
        || (definitionsOrOverrides !== undefined && definition === undefined)
        || (definition !== undefined
        && isRecordValue(definition)
        && "defaultKeys" in definition)
    );
    let definitions: KeybindingDefinitions;
    let bindings: KeybindingsConfig | undefined;
    if (usesDefinitions) {
      if (!isKeybindingDefinitions(selected)) throw new TypeError("Keybinding definitions are invalid");
      definitions = selected;
      bindings = userBindings;
    } else {
      if (!isKeybindingOverrides(selected)) throw new TypeError("Keybinding overrides are invalid");
      definitions = COMPLETE_KEYBINDING_DEFINITIONS;
      bindings = managerConfig(selected);
    }
    super(definitions, bindings);
  }

  getEffectiveConfig(): KeybindingsConfig {
    return this.getResolvedBindings();
  }
}

export class Keybindings {
  readonly #manager: TerminalKeybindingsManager;

  constructor(overrides: KeybindingOverrides = {}) {
    this.#manager = new TerminalKeybindingsManager(COMPLETE_KEYBINDING_DEFINITIONS, managerConfig(overrides));
  }

  /** Complete live manager shared with public TUI components and direct extensions. */
  manager(): TerminalKeybindingsManager {
    return this.#manager;
  }

  matches(action: KeybindingAction, event: KeyEvent): boolean {
    return this.keys(action).includes(keybindingForEvent(event));
  }

  keys(action: KeybindingAction): string[] {
    return [...this.#manager.getKeys(action)];
  }

  actionsForKey(value: string): KeybindingAction[] {
    const normalized = normalizeKeybinding(value);
    return KEYBINDING_ACTIONS.filter((action) => this.keys(action).includes(normalized));
  }

  conflicts(): KeybindingConflict[] {
    const conflicts: KeybindingConflict[] = [];
    for (const [scope, actions] of CONFLICT_SCOPES) {
      const owners = new Map<string, KeybindingAction[]>();
      for (const action of actions) for (const key of this.keys(action)) {
        const selected = owners.get(key) ?? [];
        selected.push(action);
        owners.set(key, selected);
      }
      for (const [key, selected] of owners) {
        if (key === "ctrl+c" && selected.length === 2 && selected.includes("tui.input.copy") && selected.includes("app.clear")) continue;
        if (selected.length > 1) conflicts.push({ scope, key, actions: selected });
      }
    }
    return conflicts;
  }
}

export function parseKeybindingOverrides<Value>(value: Value): KeybindingOverrides {
  if (!isRecordValue(value)) throw new Error("Keybindings must be a JSON object");
  const input = value;
  const unknown = Object.keys(input).filter((action) => !ACTIONS.has(action));
  if (unknown.length > 0) throw new Error(`Unknown keybinding actions: ${unknown.join(", ")}`);
  const overrides: KeybindingOverrides = {};
  for (const action of KEYBINDING_ACTIONS) {
    const selected = input[action];
    if (selected === undefined) continue;
    if (!isStringValue(selected) && !isStringArray(selected)) {
      throw new Error(`Keybinding ${action} must be a string or string array`);
    }
    overrides[action] = selected;
  }
  return overrides;
}

export function parseKeybindings<Value>(value: Value): Keybindings {
  return new Keybindings(parseKeybindingOverrides(value));
}

export async function loadKeybindings(
  path: string,
  settingsOverrides: KeybindingOverrides = {},
): Promise<Keybindings> {
  let fileOverrides: KeybindingOverrides = {};
  try {
    const loaded = await readFileBounded(path, MAX_KEYBINDINGS_BYTES);
    if (loaded.truncated) throw new Error(`Keybindings file exceeds ${MAX_KEYBINDINGS_BYTES} bytes`);
    fileOverrides = parseKeybindingOverrides(JSON.parse(loaded.data.toString("utf8")));
  } catch (error) {
    if (!isErrorValue(error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  const configured = parseKeybindingOverrides(settingsOverrides);
  return new Keybindings({ ...fileOverrides, ...configured });
}
