/** Stable extension-owned composition points inside the session viewport. */
export const EXTENSION_UI_SLOT_PATHS = [
  "session.header",
  "session.beforeEditor",
  "session.afterEditor",
  "session.footer",
] as const;

export type ExtensionUISlotPath = (typeof EXTENSION_UI_SLOT_PATHS)[number];

/**
 * `prepend` contributions precede `append` contributions at the same slot.
 * `replace` is supported only by `session.header` and `session.footer`.
 */
export type ExtensionUISlotPlacement = "prepend" | "append" | "replace";

export interface ExtensionUISlotContribution {
  /** Plain terminal-safe lines. ANSI and other control text is rejected. */
  readonly lines: readonly string[];
  readonly placement?: ExtensionUISlotPlacement;
  /** Lower values render first. The default is zero. */
  readonly order?: number;
}

export interface ExtensionUISlotRegistration {
  readonly disposed: boolean;
  /** Atomically replace this registration's content without changing its tie-break position. */
  update(contribution: ExtensionUISlotContribution): void;
  /** Remove this exact registration. A superseded handle cannot remove its replacement. */
  dispose(): void;
}

export interface ExtensionUISlotService {
  /** Register or atomically replace one generation-owned key. */
  set(
    path: ExtensionUISlotPath,
    key: string,
    contribution: ExtensionUISlotContribution,
  ): ExtensionUISlotRegistration;
  /** Remove the current registration for one generation-owned key. */
  remove(path: ExtensionUISlotPath, key: string): void;
}
