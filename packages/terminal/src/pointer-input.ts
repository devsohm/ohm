import type { Component, TuiPointerOptions } from "./tui.js";
import { getOsc8LinkAtColumn } from "./utils.js";
import { dispatchViewportPointer, targetLocation, type PointerLocation, type ViewportPointerEvent } from "./viewport.js";

const ESCAPE = "\x1b";
const REPORT = `${ESCAPE}\\[<([0-9]{1,3});([0-9]{1,5});([0-9]{1,5})([Mm])|${ESCAPE}\\[([IO])`;

function button(code: number): ViewportPointerEvent["button"] {
  const selected = code & 3;
  return selected === 0 ? "left" : selected === 1 ? "middle" : selected === 2 ? "right" : "none";
}

function safeLinkTarget(value: string): string | undefined {
  if (value.length < 1 || value.length > 4_096) return undefined;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x20 || (code >= 0x7f && code <= 0x9f)) return undefined;
  }
  try {
    const parsed = new URL(value);
    if (!["http:", "https:", "mailto:"].includes(parsed.protocol)
      || parsed.username !== "" || parsed.password !== "") return undefined;
    return parsed.href.length <= 4_096 ? parsed.href : undefined;
  } catch { return undefined; }
}

interface Click {
  event: ViewportPointerEvent;
  time: number;
  dragged: boolean;
  openLink: boolean;
}

/** One pointer lifecycle for the main-screen and fixed-height surfaces. */
export class TerminalPointer {
  readonly enabled: boolean;
  readonly #wheelRows: number;
  readonly #openUrl: TuiPointerOptions["openUrl"];
  #disable = "";
  #capture: PointerLocation | undefined;
  #hover: PointerLocation | undefined;
  #press: Click | undefined;
  #lastClick: Click | undefined;

  constructor(options: TuiPointerOptions) {
    this.enabled = options.mouse ?? false;
    this.#wheelRows = Math.trunc(options.wheelScrollLines ?? 3);
    if (!Number.isSafeInteger(this.#wheelRows) || this.#wheelRows < 1 || this.#wheelRows > 100) {
      throw new RangeError("Wheel scroll lines must be 1 to 100");
    }
    this.#openUrl = options.openUrl;
  }

  start(): string {
    if (!this.enabled) return "";
    const term = process.env.TERM?.toLowerCase() ?? "";
    const limited = process.env.TMUX !== undefined || process.env.ZELLIJ !== undefined
      || process.env.STY !== undefined || term.startsWith("tmux") || term.startsWith("screen");
    this.#disable = `\x1b[?1006l\x1b[?1004l${limited ? "" : "\x1b[?1003l"}\x1b[?1002l\x1b[?1000l`;
    return `\x1b[?1000h\x1b[?1002h${limited ? "" : "\x1b[?1003h"}\x1b[?1004h\x1b[?1006h`;
  }

  stop(): string {
    const disable = this.#disable;
    this.#disable = "";
    return disable;
  }

  #notify(location: PointerLocation, type: "cancel" | "leave"): void {
    location.target.handleViewportPointer({
      type, row: -1, column: -1, button: "none", shift: false, alt: false,
      ctrl: false, clickCount: 0, dragging: false,
    }, location.width, location.height);
  }

  cancel(): void {
    const capture = this.#capture;
    const hover = this.#hover;
    this.#capture = undefined;
    this.#hover = undefined;
    this.#press = undefined;
    this.#lastClick = undefined;
    if (capture !== undefined) this.#notify(capture, "cancel");
    if (hover !== undefined && hover.target !== capture?.target) this.#notify(hover, "cancel");
  }

  /** Drop targets removed by a component's own layout, not only explicit host removals. */
  reconcile(root: Component, width: number, height: number): void {
    const bounds = { row: 0, column: 0, width, height };
    const cancelled = new Set<PointerLocation["target"]>();
    for (const field of ["capture", "hover"] as const) {
      const previous = field === "capture" ? this.#capture : this.#hover;
      if (previous === undefined) continue;
      const next = targetLocation(root, previous.target, bounds);
      if (field === "capture") this.#capture = next;
      else this.#hover = next;
      if (next === undefined) {
        if (!cancelled.has(previous.target)) this.#notify(previous, "cancel");
        cancelled.add(previous.target);
        this.#press = undefined;
        this.#lastClick = undefined;
      }
    }
  }

  handle(data: string, root: Component, width: number, height: number, frame: readonly string[], requestRender: () => void): { consume?: boolean; data?: string } | undefined {
    if (!this.enabled) return undefined;
    let output = "";
    let start = 0;
    let seen = false;
    for (const match of data.matchAll(new RegExp(REPORT, "gu"))) {
      seen = true;
      output += data.slice(start, match.index);
      start = match.index + match[0].length;
      if (match[5] !== undefined) {
        if (match[5] === "O") this.cancel();
        continue;
      }
      const code = Number(match[1]);
      const column = Number(match[2]) - 1;
      const row = Number(match[3]) - 1;
      if (row < 0 || column < 0 || row > 9_999 || column > 9_999 || code >= 128) continue;
      const wheel = (code & 64) !== 0;
      const motion = (code & 32) !== 0;
      const direction = code & 3;
      if (wheel && direction > 1) continue;
      const release = match[4] === "m" || (!motion && direction === 3);
      const event: ViewportPointerEvent = {
        type: wheel ? "wheel" : release ? "release" : motion ? "move" : "press",
        row, column, button: wheel ? "none" : button(code),
        shift: (code & 4) !== 0, alt: (code & 8) !== 0, ctrl: (code & 16) !== 0,
        clickCount: 0, dragging: motion && direction !== 3,
      };
      if (wheel) event.deltaRows = direction === 0 ? -this.#wheelRows : this.#wheelRows;
      this.#dispatch(event, root, width, height, frame, requestRender);
    }
    if (!seen) return undefined;
    output += data.slice(start);
    return output === "" ? { consume: true } : { data: output };
  }

  #dispatch(event: ViewportPointerEvent, root: Component, width: number, height: number, frame: readonly string[], requestRender: () => void): void {
    const time = Date.now();
    if (event.type === "press") {
      const last = this.#lastClick;
      const repeated = last !== undefined && time >= last.time && time - last.time <= 500
        && last.event.row === event.row && last.event.column === event.column
        && last.event.button === event.button && last.event.shift === event.shift
        && last.event.alt === event.alt && last.event.ctrl === event.ctrl;
      event.clickCount = repeated ? Math.min(3, (last.event.clickCount ?? 0) + 1) : 1;
      this.#press = { event, time, dragged: false, openLink: false };
    } else if (this.#press !== undefined && (event.type === "move" || event.type === "release")) {
      this.#press.dragged ||= event.row !== this.#press.event.row || event.column !== this.#press.event.column;
      event.clickCount = this.#press.event.clickCount ?? 1;
      if (event.type === "release") event.dragging = this.#press.dragged;
    }
    const result = dispatchViewportPointer(root, event, width, height, this.#capture?.target);
    const bounds = { row: 0, column: 0, width, height };
    if (event.type === "press" && this.#press !== undefined) {
      this.#press.openLink = event.button === "left" && !result.handled;
    } else if (event.type === "release") {
      const press = this.#press;
      this.#press = undefined;
      const clicked = press !== undefined && !press.dragged
        && (event.button === press.event.button || event.button === "none");
      this.#lastClick = clicked ? { ...press, time } : undefined;
      if (clicked && press.openLink && !result.handled) {
        const target = safeLinkTarget(getOsc8LinkAtColumn(frame[event.row] ?? "", event.column) ?? "");
        if (target !== undefined) this.#openUrl?.(target);
      }
    } else if (event.type === "wheel") this.#lastClick = undefined;
    if (event.type === "move" && this.#capture === undefined) {
      if (this.#hover !== undefined && this.#hover.target !== result.target) this.#notify(this.#hover, "leave");
      this.#hover = result.target === undefined ? undefined : targetLocation(root, result.target, bounds);
    }
    if (result.capture !== undefined) this.#capture = targetLocation(root, result.capture, bounds);
    if (result.releaseCapture === true || event.type === "release") this.#capture = undefined;
    if (result.handled) requestRender();
  }
}
