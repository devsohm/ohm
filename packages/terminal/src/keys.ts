export type KeyEventType = "press" | "repeat" | "release";

const SPECIAL = new Map<string, string>([
  ["\r", "enter"], ["\x7f", "backspace"], ["\t", "tab"], [" ", "space"], ["\x1b", "escape"],
  ["\x1b[A", "up"], ["\x1b[B", "down"], ["\x1b[C", "right"], ["\x1b[D", "left"],
  ["\x1b[H", "home"], ["\x1b[F", "end"], ["\x1b[5~", "pageup"], ["\x1b[6~", "pagedown"],
  ["\x1b[3~", "delete"], ["\x1b[11~", "f1"], ["\x1b[[E", "f5"],
]);

const MODIFIERS = ["shift", "alt", "shift+alt", "ctrl", "shift+ctrl", "alt+ctrl", "shift+alt+ctrl"];
const ESCAPE = "\x1b";
const CSI = `${ESCAPE}[`;
let kittyActive = false;

export type KeyId = string;

function modified(base: string, parameter: number): string {
  const prefix = MODIFIERS[parameter - 2];
  return prefix === undefined ? base : `${prefix}+${base}`;
}

function namedCode(code: number): string | undefined {
  if (code >= 48 && code <= 57) return String.fromCodePoint(code);
  if (code >= 65 && code <= 90) return String.fromCodePoint(code).toLowerCase();
  if (code >= 97 && code <= 122) return String.fromCodePoint(code);
  const names = new Map<number, string>([[13, "enter"], [57399, "0"], [57419, "up"], [57420, "down"], [57421, "right"], [57422, "left"]]);
  return names.get(code);
}

function csiBody(data: string): string | undefined {
  return data.startsWith(CSI) ? data.slice(CSI.length) : undefined;
}

function isPrintable(data: string): boolean {
  if (data.length === 0) return false;
  for (let index = 0; index < data.length; index += 1) {
    const code = data.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

export function normalizeKeyIdentifier(value: string): string {
  const parts = value.toLowerCase().split("+");
  const key = parts.pop() ?? "";
  const modifiers = new Set(parts.map((part) => part === "control" ? "ctrl" : part === "meta" ? "alt" : part));
  return [...["shift", "alt", "ctrl"].filter((name) => modifiers.has(name)), key].filter(Boolean).join("+");
}

export function parseKey(data: string): KeyId | undefined {
  if (data === "\n") return kittyActive ? "shift+enter" : "enter";
  const direct = SPECIAL.get(data);
  if (direct !== undefined) return direct;
  if (data.length === 1) {
    const code = data.charCodeAt(0);
    if (code >= 1 && code <= 26) return `ctrl+${String.fromCharCode(96 + code)}`;
    if (code >= 0x20) return data;
  }
  const body = csiBody(data);
  if (data.startsWith(ESCAPE) && body === undefined && [...data].length === 2) return `alt+${[...data][1]}`;
  const arrow = body === undefined ? null : /^1;(\d)([ABCDHF])$/u.exec(body);
  if (arrow !== null) {
    const names = new Map([["A", "up"], ["B", "down"], ["C", "right"], ["D", "left"], ["H", "home"], ["F", "end"]]);
    const base = names.get(arrow[2]!);
    return base === undefined ? undefined : modified(base, Number(arrow[1]));
  }
  const kitty = body === undefined ? null : /^(\d+)(?::\d+)?(?:;(\d+)(?::(\d))?)?u$/u.exec(body);
  if (kitty !== null) {
    const base = namedCode(Number(kitty[1]));
    return base === undefined ? undefined : modified(base, Number(kitty[2] ?? 1));
  }
  const old = body === undefined ? null : /^27;(\d+);(\d+)~$/u.exec(body);
  if (old !== null) {
    const base = namedCode(Number(old[2]));
    return base === undefined ? undefined : modified(base, Number(old[1]));
  }
  return undefined;
}

export function matchesKey(data: string, key: KeyId): boolean {
  return normalizeKeyIdentifier(parseKey(data) ?? "") === normalizeKeyIdentifier(key);
}

export function decodeKittyPrintable(data: string): string | undefined {
  const body = csiBody(data);
  const matched = body === undefined ? null : /^(\d+)(?::(\d+))?(?:;\d+(?::\d)?)?u$/u.exec(body);
  if (matched === null) return undefined;
  const code = Number(matched[2] ?? matched[1]);
  return code >= 0x20 && code <= 0x10ffff ? String.fromCodePoint(code) : undefined;
}

export function decodePrintableKey(data: string): string | undefined {
  const body = csiBody(data);
  const old = body === undefined ? null : /^27;\d+;(\d+)~$/u.exec(body);
  if (old !== null) return String.fromCodePoint(Number(old[1]));
  return decodeKittyPrintable(data) ?? (isPrintable(data) ? data : undefined);
}

export function isKeyRepeat(data: string): boolean { return /^\d+(?::\d+)?;\d+:2u$/u.test(csiBody(data) ?? ""); }
export function isKeyRelease(data: string): boolean { return /^\d+(?::\d+)?;\d+:3u$/u.test(csiBody(data) ?? ""); }
export function setKittyProtocolActive(value: boolean): void { kittyActive = value; }
export function isKittyProtocolActive(): boolean { return kittyActive; }

export const Key = {
  ctrl: (key: string): KeyId => `ctrl+${key}`,
  alt: (key: string): KeyId => `alt+${key}`,
  shift: (key: string): KeyId => `shift+${key}`,
};
