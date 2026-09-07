/** Stable extension-owned composition points inside the session viewport. */
export const PLUGIN_UI_SLOT_PATHS = [
  "session.header",
  "session.beforeEditor",
  "session.afterEditor",
  "session.footer",
] as const;

export type PluginUISlotPath = (typeof PLUGIN_UI_SLOT_PATHS)[number];

/**
 * `prepend` contributions precede `append` contributions at the same slot.
 * `replace` is supported only by `session.header` and `session.footer`.
 */
export type PluginUISlotPlacement = "prepend" | "append" | "replace";

export interface PluginUISlotContribution {
  /** Plain terminal-safe lines. ANSI and other control text is rejected. */
  readonly lines: readonly string[];
  readonly placement?: PluginUISlotPlacement;
  /** Lower values render first. The default is zero. */
  readonly order?: number;
}

export interface PluginUISlotRegistration {
  readonly disposed: boolean;
  /** Atomically replace this registration's content without changing its tie-break position. */
  update(contribution: PluginUISlotContribution): void;
  /** Remove this exact registration. A superseded handle cannot remove its replacement. */
  dispose(): void;
}

export interface PluginUISlotService {
  /** Register or atomically replace one generation-owned key. */
  set(
    path: PluginUISlotPath,
    key: string,
    contribution: PluginUISlotContribution,
  ): PluginUISlotRegistration;
  /** Remove the current registration for one generation-owned key. */
  remove(path: PluginUISlotPath, key: string): void;
}
