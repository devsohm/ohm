import type { Terminal } from "./terminal.js";
import { type Component, TUI, type TuiPointerOptions } from "./tui.js";
import { fitViewportRows, renderViewport, type ViewportPointerRegion } from "./viewport.js";

/** Shared pointer options; fullscreen mouse reporting defaults to enabled. */
export type FullscreenTUIOptions = TuiPointerOptions;

/** Fixed-height terminal surface. The existing TUI class remains the main-screen surface. */
export class FullscreenTUI extends TUI {
  override readonly mode = "fullscreen";
  #root: Component | undefined;
  #fullscreenActive = false;

  constructor(terminal: Terminal, showHardwareCursor?: boolean, logDirectory?: string, options: FullscreenTUIOptions = {}) {
    super(terminal, showHardwareCursor, logDirectory, { ...options, mouse: options.mouse ?? true });
  }

  get root(): Component | undefined { return this.#root; }

  setRoot(component: Component | undefined): void {
    if (component === this.#root) return;
    super.clear();
    this.#root = component;
    if (component) super.addChild(component);
    this.requestRender(true);
  }

  /** Component-authoring alias for replacing the fixed-height layout root. */
  setLayoutRoot(component: Component | undefined): void { this.setRoot(component); }

  override addChild(component: Component): void {
    if (this.#root) throw new Error("FullscreenTUI accepts one root component; use a stack to compose children");
    this.#root = component;
    super.addChild(component);
  }

  override removeChild(component: Component): void {
    if (component !== this.#root) return;
    super.removeChild(component);
    this.#root = undefined;
  }

  override clear(): void {
    super.clear();
    this.#root = undefined;
  }

  override viewportPointerRegions(): readonly ViewportPointerRegion[] {
    return this.#root === undefined ? [] : [{ component: this.#root, row: 0, column: 0, width: this.terminal.columns, height: this.terminal.rows }];
  }

  override render(width: number): string[] {
    const columns = Math.max(0, Math.trunc(width));
    const rows = Math.max(0, Math.trunc(this.terminal.rows));
    if (!this.#root) return fitViewportRows([], columns, rows);
    return renderViewport(this.#root, columns, rows, () => this.requestRender());
  }

  protected override beforeTerminalStart(): void {
    this.#fullscreenActive = true;
    this.terminal.write("\x1b[?1049h\x1b[?7l\x1b[2J\x1b[H");
  }

  protected override beforeTerminalStop(): void {
    if (!this.#fullscreenActive) return;
    this.#fullscreenActive = false;
    this.terminal.write("\x1b[0m\x1b[?7h\x1b[?1049l");
  }
}
