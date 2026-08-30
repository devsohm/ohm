import type {
  SettingsManager,
  ThinkingLevel,
  TransportSetting,
} from "../core/settings-manager.js";
import type { AgentSession } from "../service/agent-session.js";
import type { TuiController } from "../tui/controller.js";
import type { TuiOperatorPreferences, TuiSettingItem } from "../tui/types.js";
import { normalizeThemeSetting } from "../tui/theme.js";

const BOOLEAN_VALUES = ["on", "off"] as const;

function booleanItem(
  id: string,
  label: string,
  description: string,
  enabled: boolean,
): TuiSettingItem {
  return { id, label, description, value: enabled ? "on" : "off", values: BOOLEAN_VALUES };
}

function numericValues(current: number, choices: readonly number[]): string[] {
  return [...new Set([current, ...choices])].sort((left, right) => left - right).map(String);
}

export function tuiOperatorPreferences(settings: SettingsManager): TuiOperatorPreferences {
  return {
    hideThinkingBlock: false,
    showCacheMissNotices: settings.getShowCacheMissNotices(),
    externalEditor: settings.getExternalEditorCommand(),
    treeFilterMode: settings.getTreeFilterMode(),
    editorPaddingX: settings.getEditorPaddingX(),
    outputPad: settings.getOutputPad(),
    autocompleteMaxVisible: settings.getAutocompleteMaxVisible(),
    showHardwareCursor: settings.getShowHardwareCursor(),
    showImages: settings.getShowImages(),
    imageWidthCells: settings.getImageWidthCells(),
    clearOnShrink: settings.getClearOnShrink(),
    showTerminalProgress: settings.getShowTerminalProgress(),
    codeBlockIndent: settings.getCodeBlockIndent(),
    fullscreenScrollbar: settings.getFullscreenScrollbar(),
    fullscreenCopyOnSelect: settings.getFullscreenCopyOnSelect(),
  };
}

export function interactiveSettingItems(
  settings: SettingsManager,
  session: Pick<AgentSession,
    "autoCompactionEnabled" | "thinkingLevel" | "getAvailableThinkingLevels">,
  themes: readonly string[],
): TuiSettingItem[] {
  const selectedTheme = normalizeThemeSetting(settings.getThemeSetting() ?? "signal");
  const thinkingLevels = [...new Set([session.thinkingLevel, ...session.getAvailableThinkingLevels()])];
  const availableThemes = [...new Set([selectedTheme, ...themes])].sort((left, right) => left.localeCompare(right));
  return [
    booleanItem("auto-compact", "Automatic compaction", "Compact context before the model limit is reached", session.autoCompactionEnabled),
    { id: "compaction-trigger", label: "Compaction trigger", description: "Context-window percentage that starts compaction", value: String(settings.getCompactionTriggerPercent()), values: numericValues(settings.getCompactionTriggerPercent(), [50, 60, 70, 75, 80, 85, 88, 90, 92, 95]) },
    { id: "thinking-level", label: "Reasoning level", description: "Default reasoning effort for the active model", value: session.thinkingLevel, values: thinkingLevels.length === 0 ? ["off"] : thinkingLevels },
    { id: "steering-mode", label: "Steering queue", description: "Deliver queued steering one message at a time or all together", value: settings.getSteeringMode(), values: ["one-at-a-time", "all"] },
    { id: "follow-up-mode", label: "Follow-up queue", description: "Deliver follow-ups one message at a time or all together", value: settings.getFollowUpMode(), values: ["one-at-a-time", "all"] },
    { id: "transport", label: "Codex transport", description: "Automatic cached WebSocket with safe HTTPS/SSE fallback by default, or an explicit transport; applies after /refresh", value: settings.getTransport(), values: ["auto", "sse", "websocket", "websocket-cached"] },
    { id: "http-idle-timeout", label: "HTTP idle timeout", description: "Provider inactivity timeout in milliseconds; applies after /refresh", value: String(settings.getHttpIdleTimeoutMs()), values: numericValues(settings.getHttpIdleTimeoutMs(), [0, 30_000, 60_000, 120_000, 300_000, 600_000, 1_800_000]) },
    booleanItem("show-images", "Show terminal images", "Render supported image attachments in the transcript", settings.getShowImages()),
    { id: "image-width", label: "Image width", description: "Maximum terminal image width in cells", value: String(settings.getImageWidthCells()), values: numericValues(settings.getImageWidthCells(), [40, 60, 80, 100, 120]) },
    booleanItem("auto-resize-images", "Resize large images", "Resize oversized image inputs before sending them to providers", settings.getImageAutoResize()),
    booleanItem("block-images", "Block image inputs", "Reject image inputs instead of sending them to providers", settings.getBlockImages()),
    booleanItem("skill-commands", "Skill commands", "Expose discovered skills as slash commands", settings.getEnableSkillCommands()),
    { id: "theme", label: "Theme", description: "Built-in mono/signal or a trusted extension theme", value: selectedTheme, values: availableThemes.length === 0 ? [selectedTheme] : availableThemes },
    booleanItem("cache-miss-notices", "Cache reuse estimates", "Show request-level prompt-cache reuse estimates", settings.getShowCacheMissNotices()),
    booleanItem("collapse-changelog", "Condensed changelog", "Collapse the startup changelog by default", settings.getCollapseChangelog()),
    { id: "double-escape", label: "Double-Escape action", description: "Action opened by pressing Escape twice", value: settings.getDoubleEscapeAction(), values: ["atlas", "none"] },
    { id: "tree-filter", label: "Atlas journal filter", description: "Journal entries shown by default in Session Atlas", value: settings.getTreeFilterMode(), values: ["default", "no-tools", "user-only", "labeled-only", "all"] },
    booleanItem("hardware-cursor", "Hardware cursor", "Show the terminal hardware cursor in the editor", settings.getShowHardwareCursor()),
    { id: "editor-padding", label: "Editor padding", description: "Horizontal editor padding in cells", value: String(settings.getEditorPaddingX()), values: numericValues(settings.getEditorPaddingX(), [0, 1, 2, 3]) },
    { id: "output-padding", label: "Output padding", description: "Horizontal transcript padding in cells", value: String(settings.getOutputPad()), values: ["0", "1"] },
    { id: "autocomplete-rows", label: "Autocomplete rows", description: "Maximum visible autocomplete rows", value: String(settings.getAutocompleteMaxVisible()), values: numericValues(settings.getAutocompleteMaxVisible(), [3, 5, 7, 10, 15, 20]) },
    booleanItem("quiet-startup", "Quiet startup", "Suppress the normal startup report", settings.getQuietStartup()),
    { id: "project-trust", label: "Default project trust", description: "Default policy for loading project-owned resources", value: settings.getDefaultProjectTrust(), values: ["ask", "always", "never"] },
    booleanItem("clear-on-shrink", "Clear vacated rows", "Clear and redraw after the terminal shrinks", settings.getClearOnShrink()),
    booleanItem("terminal-progress", "Terminal progress", "Show host-terminal progress while ohm is working", settings.getShowTerminalProgress()),
    { id: "fullscreen-scrollbar", label: "Fullscreen scrollbar", description: "Show the transcript scrollbar automatically, always, or keep it hidden", value: settings.getFullscreenScrollbar(), values: ["auto", "always", "hidden"] },
    booleanItem("fullscreen-copy-on-select", "Copy on selection", "Copy selected transcript text when the mouse button is released", settings.getFullscreenCopyOnSelect()),
    booleanItem("anthropic-usage-warning", "Anthropic API billing warning", "Warn before Anthropic bearer-token requests that may incur Console/API charges", settings.getWarnings().anthropicExtraUsage !== false),
  ];
}

function enabled(value: string): boolean {
  if (value === "on") return true;
  if (value === "off") return false;
  throw new Error(`Expected on or off, received ${value}`);
}

function integer(value: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Expected an integer from ${minimum} through ${maximum}`);
  }
  return parsed;
}

function queueMode(value: string): "all" | "one-at-a-time" {
  if (value === "all" || value === "one-at-a-time") return value;
  throw new Error(`Expected all or one-at-a-time, received ${value}`);
}

function transportSetting(value: string): TransportSetting {
  if (value === "auto" || value === "sse" || value === "websocket" || value === "websocket-cached") {
    return value;
  }
  throw new Error(`Unknown transport setting: ${value}`);
}

function thinkingLevel(value: string): ThinkingLevel {
  if (
    value === "off" || value === "minimal" || value === "low" || value === "medium" ||
    value === "high" || value === "xhigh" || value === "max"
  ) return value;
  throw new Error(`Unknown thinking level: ${value}`);
}

function doubleEscapeAction(value: string): "atlas" | "none" {
  if (value === "atlas" || value === "none") return value;
  throw new Error(`Unknown double-Escape action: ${value}`);
}

function treeFilterMode(value: string): "default" | "no-tools" | "user-only" | "labeled-only" | "all" {
  if (
    value === "default" || value === "no-tools" || value === "user-only" ||
    value === "labeled-only" || value === "all"
  ) return value;
  throw new Error(`Unknown Atlas journal filter: ${value}`);
}

function projectTrust(value: string): "ask" | "always" | "never" {
  if (value === "ask" || value === "always" || value === "never") return value;
  throw new Error(`Unknown project trust setting: ${value}`);
}

function outputPadding(value: string): 0 | 1 {
  const parsed = integer(value, 0, 1);
  if (parsed === 0 || parsed === 1) return parsed;
  throw new Error(`Expected output padding 0 or 1, received ${value}`);
}

function fullscreenScrollbar(value: string): "auto" | "always" | "hidden" {
  if (value === "auto" || value === "always" || value === "hidden") return value;
  throw new Error(`Unknown fullscreen scrollbar setting: ${value}`);
}

export function applyInteractiveSetting(
  item: Pick<TuiSettingItem, "id">,
  value: string,
  settings: SettingsManager,
  session: Pick<AgentSession,
    "setAutoCompactionEnabled" | "setSteeringMode" | "setFollowUpMode" | "setThinkingLevel">,
  terminal: Pick<TuiController, "setTheme" | "setDoubleEscapeAction" | "setOperatorPreferences">,
): void {
  switch (item.id) {
    case "auto-compact": session.setAutoCompactionEnabled(enabled(value)); return;
    case "compaction-trigger": settings.setCompactionTriggerPercent(integer(value, 50, 95)); return;
    case "show-images": settings.setShowImages(enabled(value)); break;
    case "image-width": settings.setImageWidthCells(integer(value, 1, 500)); break;
    case "auto-resize-images": settings.setImageAutoResize(enabled(value)); return;
    case "block-images": settings.setBlockImages(enabled(value)); return;
    case "skill-commands": settings.setEnableSkillCommands(enabled(value)); return;
    case "steering-mode": session.setSteeringMode(queueMode(value)); return;
    case "follow-up-mode": session.setFollowUpMode(queueMode(value)); return;
    case "transport": settings.setTransport(transportSetting(value)); return;
    case "http-idle-timeout": settings.setHttpIdleTimeoutMs(integer(value, 0, 2_147_483_647)); return;
    case "thinking-level": settings.setDefaultThinkingLevel(thinkingLevel(value)); session.setThinkingLevel(value); return;
    case "theme": terminal.setTheme(value); settings.setTheme(value); return;
    case "cache-miss-notices": settings.setShowCacheMissNotices(enabled(value)); break;
    case "collapse-changelog": settings.setCollapseChangelog(enabled(value)); return;
    case "double-escape": {
      const action = doubleEscapeAction(value);
      settings.setDoubleEscapeAction(action);
      terminal.setDoubleEscapeAction(action);
      return;
    }
    case "tree-filter": settings.setTreeFilterMode(treeFilterMode(value)); break;
    case "hardware-cursor": settings.setShowHardwareCursor(enabled(value)); break;
    case "project-trust": settings.setDefaultProjectTrust(projectTrust(value)); return;
    case "editor-padding": settings.setEditorPaddingX(integer(value, 0, 3)); break;
    case "output-padding": settings.setOutputPad(outputPadding(value)); break;
    case "autocomplete-rows": settings.setAutocompleteMaxVisible(integer(value, 3, 20)); break;
    case "quiet-startup": settings.setQuietStartup(enabled(value)); return;
    case "clear-on-shrink": settings.setClearOnShrink(enabled(value)); break;
    case "terminal-progress": settings.setShowTerminalProgress(enabled(value)); break;
    case "fullscreen-scrollbar": settings.setFullscreenScrollbar(fullscreenScrollbar(value)); break;
    case "fullscreen-copy-on-select": settings.setFullscreenCopyOnSelect(enabled(value)); break;
    case "anthropic-usage-warning": settings.setWarnings({ ...settings.getWarnings(), anthropicExtraUsage: enabled(value) }); return;
    default: throw new Error(`Unknown interactive setting: ${item.id}`);
  }
  terminal.setOperatorPreferences(tuiOperatorPreferences(settings));
}
