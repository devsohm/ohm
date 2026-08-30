import { optionalProperties } from "./optional-properties.js";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { types as utilTypes } from "node:util";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import type { ThinkingBudgets } from "@ohm/models";
import { isJsonObject, type JsonObject, type JsonValue } from "./json.js";
import {
  MAX_MODEL_SCOPE_SELECTORS,
  exactModelSelector,
  isExactModelSelector,
} from "./model-scope.js";
import { BOOLEAN_VALUE, NUMBER_VALUE, STRING_VALUE } from "./value-schemas.js";

const MAX_SETTINGS_BYTES = 256 * 1024;
const CONFIG_SCHEMA = "https://raw.githubusercontent.com/devsohm/ohm/v0.1.0/packages/ohm/resources/schemas/config-v1.json";
const SETTINGS_RECORD_VALUE = Type.Record(Type.String(), Type.Unknown());

type SettingsInputRecord = Static<typeof SETTINGS_RECORD_VALUE>;

export const SETTINGS_KEYS = [
  "lastChangelogVersion",
  "defaultProvider",
  "defaultModel",
  "defaultThinkingLevel",
  "enabledModels",
  "modelThinkingLevels",
  "transport",
  "steeringMode",
  "followUpMode",
  "theme",
  "compaction",
  "branchSummary",
  "retry",
  "observability",
  "showCacheMissNotices",
  "externalEditor",
  "shellPath",
  "quietStartup",
  "defaultProjectTrust",
  "shellCommandPrefix",
  "npmCommand",
  "collapseChangelog",
  "packages",
  "extensions",
  "skills",
  "prompts",
  "themes",
  "enableSkillCommands",
  "tools",
  "terminal",
  "images",
  "doubleEscapeAction",
  "treeFilterMode",
  "thinkingBudgets",
  "editorPaddingX",
  "outputPad",
  "autocompleteMaxVisible",
  "showHardwareCursor",
  "fullscreenScrollbar",
  "fullscreenCopyOnSelect",
  "markdown",
  "warnings",
  "sessionDir",
  "httpProxy",
  "httpIdleTimeoutMs",
  "websocketConnectTimeoutMs",
  "keybindings",
] as const;

export type SettingsScope = "global" | "project";
export type DefaultProjectTrust = "ask" | "always" | "never";
export type FullscreenScrollbar = "auto" | "always" | "hidden";
export type ObservabilityLevel = "off" | "error" | "info" | "debug";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type TransportSetting = "auto" | "sse" | "websocket" | "websocket-cached";
type QueueMode = "all" | "one-at-a-time";

export interface PackageSourceOptions extends JsonObject {
  source: string;
  autoload?: boolean;
  manifest?: "legacy";
  extensions?: string[];
  prompts?: string[];
  skills?: string[];
  themes?: string[];
}

export type PackageSource = string | PackageSourceOptions;

export interface RetrySettings extends JsonObject {
  enabled: boolean;
  maxRetries: number;
  baseDelayMs: number;
}

export interface ProviderRetrySettings extends JsonObject {
  timeoutMs?: number;
  maxRetries: number;
  maxRetryDelayMs: number;
}

export interface ImageSettings extends JsonObject {
  autoResize?: boolean | null;
  blockImages?: boolean | null;
}

export interface ObservabilitySettings extends JsonObject {
  level?: ObservabilityLevel | null;
}

export interface WarningSettings extends JsonObject {
  anthropicExtraUsage?: boolean;
}

export interface ToolSettings extends JsonObject {
  enabled?: string[];
  excluded: string[];
}

interface CompactionSettings extends JsonObject {
  enabled?: boolean | null;
  triggerPercent?: number | null;
  reserveTokens?: number | null;
  recentTokens?: number | null;
}

interface BranchSummarySettings extends JsonObject {
  reserveTokens?: number | null;
  skipPrompt?: boolean | null;
}

interface ProviderRetryConfiguration extends JsonObject {
  timeoutMs?: number | null;
  maxRetries?: number | null;
  maxRetryDelayMs?: number | null;
}

interface RetryConfiguration extends JsonObject {
  enabled?: boolean | null;
  maxRetries?: number | null;
  baseDelayMs?: number | null;
  provider?: ProviderRetryConfiguration | null;
}

interface ToolConfiguration extends JsonObject {
  enabled?: string[] | null;
  excluded?: string[] | null;
}

interface TerminalSettings extends JsonObject {
  showImages?: boolean | null;
  imageWidthCells?: number | null;
  clearOnShrink?: boolean | null;
  showTerminalProgress?: boolean | null;
}

interface ThinkingBudgetSettings extends JsonObject {
  minimal?: number | null;
  low?: number | null;
  medium?: number | null;
  high?: number | null;
  xhigh?: number | null;
  max?: number | null;
}

interface MarkdownSettings extends JsonObject {
  codeBlockIndent?: string | null;
}

interface WarningConfiguration extends JsonObject {
  anthropicExtraUsage?: boolean | null;
}

interface CompactionSummary {
  enabled: boolean;
  triggerPercent: number;
}

interface BranchSummary {
  reserveTokens: number;
  skipPrompt: boolean;
}

export interface Settings extends JsonObject {
  $schema?: string;
  lastChangelogVersion?: string | null;
  defaultProvider?: string | null;
  defaultModel?: string | null;
  defaultThinkingLevel?: ThinkingLevel | null;
  enabledModels?: string[] | null;
  modelThinkingLevels?: Record<string, ThinkingLevel | null> | null;
  transport?: TransportSetting | null;
  steeringMode?: QueueMode | null;
  followUpMode?: QueueMode | null;
  theme?: string | null;
  compaction?: CompactionSettings | null;
  branchSummary?: BranchSummarySettings | null;
  retry?: RetryConfiguration | null;
  observability?: ObservabilitySettings | null;
  showCacheMissNotices?: boolean | null;
  externalEditor?: string | null;
  shellPath?: string | null;
  quietStartup?: boolean | null;
  defaultProjectTrust?: DefaultProjectTrust | null;
  shellCommandPrefix?: string | null;
  npmCommand?: string[] | null;
  collapseChangelog?: boolean | null;
  packages?: PackageSource[] | null;
  extensions?: string[] | null;
  skills?: string[] | null;
  prompts?: string[] | null;
  themes?: string[] | null;
  enableSkillCommands?: boolean | null;
  tools?: ToolConfiguration | null;
  terminal?: TerminalSettings | null;
  images?: ImageSettings | null;
  doubleEscapeAction?: "atlas" | "none" | null;
  treeFilterMode?: "default" | "no-tools" | "user-only" | "labeled-only" | "all" | null;
  thinkingBudgets?: ThinkingBudgetSettings | null;
  editorPaddingX?: number | null;
  outputPad?: 0 | 1 | null;
  autocompleteMaxVisible?: number | null;
  showHardwareCursor?: boolean | null;
  fullscreenScrollbar?: FullscreenScrollbar | null;
  fullscreenCopyOnSelect?: boolean | null;
  markdown?: MarkdownSettings | null;
  warnings?: WarningConfiguration | null;
  sessionDir?: string | null;
  httpProxy?: string | null;
  httpIdleTimeoutMs?: number | string | null;
  websocketConnectTimeoutMs?: number | string | null;
  keybindings?: Record<string, string | string[] | null> | null;
}

export type PersistedSettings = Settings;

export interface SettingsError {
  scope: SettingsScope;
  error: Error;
}

export interface SettingsStorage {
  withLock(
    scope: SettingsScope,
    operation: (current: string | undefined) => string | undefined,
  ): void;
}

export interface SettingsManagerCreateOptions {
  projectTrusted?: boolean;
}

interface ScopeState {
  raw: JsonObject;
  settings: Settings;
  loadable: boolean;
}

interface ScopeStates {
  global: ScopeState;
  project: ScopeState;
}

interface ScopePatches {
  global: JsonObject;
  project: JsonObject;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function setOwn(target: JsonObject, key: string, value: JsonValue): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function cleanSettings(value: JsonObject): Settings {
  const cleaned = stripNullsObject(value);
  delete cleaned.$schema;
  validateSettings(cleaned);
  return cleaned;
}

function stripNulls(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map((entry) => stripNulls(entry));
  if (!isJsonObject(value)) return value;
  return stripNullsObject(value);
}

function stripNullsObject(value: JsonObject): JsonObject {
  const result: JsonObject = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== null) setOwn(result, key, stripNulls(entry));
  }
  return result;
}

function mergeSettings(base: Settings, overlay: Settings): Settings;
function mergeSettings(base: JsonValue, overlay: JsonValue): JsonValue;
function mergeSettings(base: JsonValue, overlay: JsonValue): JsonValue {
  if (overlay === null) return clone(base);
  if (!isJsonObject(base) || !isJsonObject(overlay)) return clone(overlay);
  const result = clone(base);
  for (const [key, value] of Object.entries(overlay)) {
    if (value === null) continue;
    setOwn(result, key, isJsonObject(value) && isJsonObject(result[key])
      ? mergeSettings(result[key], value)
      : clone(value));
  }
  return result;
}

function applyPatch(base: JsonObject, patch: JsonObject): JsonObject {
  const result = clone(base);
  for (const [key, value] of Object.entries(patch)) {
    setOwn(result, key, isJsonObject(value) && isJsonObject(result[key])
      ? applyPatch(result[key], value)
      : clone(value));
  }
  return result;
}

function errorFromThrown<T>(thrown: T): Error {
  if (utilTypes.isNativeError(thrown)) return thrown;
  return new Error("[Thrown object]", { cause: thrown });
}

function invalid(path: string, expected: string): never {
  throw new Error(`${path} must be ${expected}`);
}

function nullable<T>(value: T): boolean {
  return value === null || value === undefined;
}

function stringValue<T>(value: T, path: string, nonEmpty = false): void {
  if (nullable(value)) return;
  if (!Value.Check(STRING_VALUE, value) || (nonEmpty && value.trim().length === 0)) {
    invalid(path, nonEmpty ? "a non-empty string" : "a string");
  }
}

function booleanValue<T>(value: T, path: string): void {
  if (!nullable(value) && !Value.Check(BOOLEAN_VALUE, value)) invalid(path, "a boolean");
}

function integerValue<T>(value: T, path: string, minimum: number, maximum: number): void {
  if (nullable(value)) return;
  if (!Value.Check(NUMBER_VALUE, value) || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    invalid(path, `an integer from ${minimum} to ${maximum}`);
  }
}

function retryInteger<T>(value: T, path: string, minimum: number, maximum: number): void {
  try {
    integerValue(value, `settings.${path}`, minimum, maximum);
  } catch {
    throw new Error(`Invalid ${path} setting`);
  }
}

function enumValue<T>(value: T, path: string, values: readonly string[]): void {
  if (nullable(value)) return;
  if (!Value.Check(STRING_VALUE, value) || !values.includes(value)) {
    invalid(path, `one of ${values.join(", ")}`);
  }
}

function objectValue<T>(value: T, path: string): (T & SettingsInputRecord) | undefined {
  if (nullable(value)) return undefined;
  if (!Value.Check(SETTINGS_RECORD_VALUE, value)) invalid(path, "an object");
  return value;
}

function stringArray<T>(value: T, path: string, nonEmpty = false): void {
  if (nullable(value)) return;
  if (!Array.isArray(value) || value.some((entry) =>
    !Value.Check(STRING_VALUE, entry) || (nonEmpty && entry.trim().length === 0))) {
    invalid(path, nonEmpty ? "an array of non-empty strings" : "an array of strings");
  }
}

function validateTimeout<T>(value: T, name: string): void {
  if (nullable(value) || value === "") return;
  let number: number;
  if (value === "disabled") number = 0;
  else if (Value.Check(STRING_VALUE, value)) number = Number(value.trim());
  else if (Value.Check(NUMBER_VALUE, value)) number = value;
  else number = Number.NaN;
  if (!Number.isFinite(number) || number < 0 || number > 2_147_483_647) {
    throw new Error(`Invalid ${name} setting`);
  }
}

function validateSettings<T>(settings: T): asserts settings is T & Settings {
  if (!Value.Check(SETTINGS_RECORD_VALUE, settings)) invalid("settings", "an object");
  if (settings.$schema !== undefined && settings.$schema !== CONFIG_SCHEMA) {
    invalid("config.$schema", CONFIG_SCHEMA);
  }
  for (const key of [
    "lastChangelogVersion", "defaultProvider", "defaultModel", "theme", "externalEditor", "shellPath",
    "shellCommandPrefix", "sessionDir", "httpProxy",
  ]) stringValue(settings[key], `settings.${key}`);
  enumValue(settings.defaultThinkingLevel, "settings.defaultThinkingLevel", ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  stringArray(settings.enabledModels, "settings.enabledModels", true);
  if (Array.isArray(settings.enabledModels)) {
    if (settings.enabledModels.length > MAX_MODEL_SCOPE_SELECTORS) {
      invalid("settings.enabledModels", `an array with at most ${MAX_MODEL_SCOPE_SELECTORS} entries`);
    }
    for (const [index, selector] of settings.enabledModels.entries()) {
      if (!isExactModelSelector(selector)) invalid(`settings.enabledModels[${index}]`, "an exact provider/model reference");
    }
  }
  const modelThinkingLevels = objectValue(settings.modelThinkingLevels, "settings.modelThinkingLevels");
  if (modelThinkingLevels !== undefined) {
    if (Object.keys(modelThinkingLevels).length > MAX_MODEL_SCOPE_SELECTORS) {
      invalid("settings.modelThinkingLevels", `an object with at most ${MAX_MODEL_SCOPE_SELECTORS} entries`);
    }
    for (const [selector, level] of Object.entries(modelThinkingLevels)) {
      if (!isExactModelSelector(selector)) invalid(`settings.modelThinkingLevels.${selector}`, "an exact provider/model reference");
      enumValue(level, `settings.modelThinkingLevels.${selector}`, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
    }
  }
  enumValue(settings.transport, "settings.transport", ["auto", "sse", "websocket", "websocket-cached"]);
  enumValue(settings.steeringMode, "settings.steeringMode", ["all", "one-at-a-time"]);
  enumValue(settings.followUpMode, "settings.followUpMode", ["all", "one-at-a-time"]);
  enumValue(settings.defaultProjectTrust, "settings.defaultProjectTrust", ["ask", "always", "never"]);
  enumValue(settings.doubleEscapeAction, "settings.doubleEscapeAction", ["atlas", "none"]);
  enumValue(settings.treeFilterMode, "settings.treeFilterMode", ["default", "no-tools", "user-only", "labeled-only", "all"]);

  for (const key of [
    "showCacheMissNotices", "quietStartup", "collapseChangelog", "enableSkillCommands", "showHardwareCursor",
    "fullscreenCopyOnSelect",
  ]) booleanValue(settings[key], `settings.${key}`);
  enumValue(settings.fullscreenScrollbar, "settings.fullscreenScrollbar", ["auto", "always", "hidden"]);
  for (const key of ["extensions", "skills", "prompts", "themes", "npmCommand"]) {
    stringArray(settings[key], `settings.${key}`);
  }

  if (!nullable(settings.packages)) {
    if (!Array.isArray(settings.packages)) invalid("settings.packages", "an array");
    settings.packages.forEach((entry, index) => {
      if (Value.Check(STRING_VALUE, entry)) {
        if (entry.trim().length === 0) invalid(`settings.packages[${index}]`, "a non-empty string or package object");
        return;
      }
      const source = objectValue(entry, `settings.packages[${index}]`);
      if (source === undefined) invalid(`settings.packages[${index}]`, "a non-empty string or package object");
      stringValue(source.source, `settings.packages[${index}].source`, true);
      booleanValue(source.autoload, `settings.packages[${index}].autoload`);
      if (!nullable(source.manifest) && source.manifest !== "legacy") invalid(`settings.packages[${index}].manifest`, "legacy");
      for (const field of ["extensions", "prompts", "skills", "themes"]) {
        stringArray(source[field], `settings.packages[${index}].${field}`);
      }
    });
  }

  const compaction = objectValue(settings.compaction, "settings.compaction");
  if (compaction !== undefined) {
    booleanValue(compaction.enabled, "settings.compaction.enabled");
    integerValue(compaction.triggerPercent, "settings.compaction.triggerPercent", 50, 95);
    integerValue(compaction.reserveTokens, "settings.compaction.reserveTokens", 1, Number.MAX_SAFE_INTEGER);
    integerValue(compaction.recentTokens, "settings.compaction.recentTokens", 1, Number.MAX_SAFE_INTEGER);
  }
  const branch = objectValue(settings.branchSummary, "settings.branchSummary");
  if (branch !== undefined) {
    integerValue(branch.reserveTokens, "settings.branchSummary.reserveTokens", 0, Number.MAX_SAFE_INTEGER);
    booleanValue(branch.skipPrompt, "settings.branchSummary.skipPrompt");
  }
  const retry = objectValue(settings.retry, "settings.retry");
  if (retry !== undefined) {
    booleanValue(retry.enabled, "settings.retry.enabled");
    retryInteger(retry.maxRetries, "retry.maxRetries", 0, Number.MAX_SAFE_INTEGER - 1);
    retryInteger(retry.baseDelayMs, "retry.baseDelayMs", 0, 2_147_483_647);
    const provider = objectValue(retry.provider, "settings.retry.provider");
    if (provider !== undefined) {
      retryInteger(provider.timeoutMs, "retry.provider.timeoutMs", 0, 2_147_483_647);
      retryInteger(provider.maxRetries, "retry.provider.maxRetries", 0, Number.MAX_SAFE_INTEGER - 1);
      retryInteger(provider.maxRetryDelayMs, "retry.provider.maxRetryDelayMs", 0, 2_147_483_647);
    }
  }
  const observability = objectValue(settings.observability, "settings.observability");
  if (observability !== undefined) enumValue(observability.level, "settings.observability.level", ["off", "error", "info", "debug"]);
  const tools = objectValue(settings.tools, "settings.tools");
  if (tools !== undefined) {
    stringArray(tools.enabled, "settings.tools.enabled", true);
    stringArray(tools.excluded, "settings.tools.excluded", true);
  }
  const terminal = objectValue(settings.terminal, "settings.terminal");
  if (terminal !== undefined) {
    booleanValue(terminal.showImages, "settings.terminal.showImages");
    integerValue(terminal.imageWidthCells, "settings.terminal.imageWidthCells", 1, Number.MAX_SAFE_INTEGER);
    booleanValue(terminal.clearOnShrink, "settings.terminal.clearOnShrink");
    booleanValue(terminal.showTerminalProgress, "settings.terminal.showTerminalProgress");
  }
  const images = objectValue(settings.images, "settings.images");
  if (images !== undefined) {
    booleanValue(images.autoResize, "settings.images.autoResize");
    booleanValue(images.blockImages, "settings.images.blockImages");
  }
  const budgets = objectValue(settings.thinkingBudgets, "settings.thinkingBudgets");
  if (budgets !== undefined) {
    for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"]) {
      integerValue(budgets[level], `settings.thinkingBudgets.${level}`, 0, Number.MAX_SAFE_INTEGER);
    }
  }
  integerValue(settings.editorPaddingX, "settings.editorPaddingX", 0, 3);
  integerValue(settings.outputPad, "settings.outputPad", 0, 1);
  integerValue(settings.autocompleteMaxVisible, "settings.autocompleteMaxVisible", 3, 20);
  const markdown = objectValue(settings.markdown, "settings.markdown");
  if (markdown !== undefined && !nullable(markdown.codeBlockIndent)) {
    if (!Value.Check(STRING_VALUE, markdown.codeBlockIndent) || !/^ {0,8}$/u.test(markdown.codeBlockIndent)) {
      invalid("settings.markdown.codeBlockIndent", "zero through eight spaces");
    }
  }
  const warnings = objectValue(settings.warnings, "settings.warnings");
  if (warnings !== undefined) booleanValue(warnings.anthropicExtraUsage, "settings.warnings.anthropicExtraUsage");
  validateTimeout(settings.httpIdleTimeoutMs, "httpIdleTimeoutMs");
  validateTimeout(settings.websocketConnectTimeoutMs, "websocketConnectTimeoutMs");
  const keybindings = objectValue(settings.keybindings, "settings.keybindings");
  if (keybindings !== undefined) {
    for (const [key, value] of Object.entries(keybindings)) {
      const path = `settings.keybindings.${key}`;
      if (value === null) continue;
      if (Value.Check(STRING_VALUE, value)) {
        if (value.trim().length === 0) invalid(path, "a non-empty string, an array, or null");
        continue;
      }
      if (!Array.isArray(value) || value.length > 16 || value.some((entry) =>
        !Value.Check(STRING_VALUE, entry) || entry.trim().length === 0)) {
        invalid(path, "a non-empty string, an array of non-empty strings, or null");
      }
    }
  }
}

function parseDocument(contents: string | undefined): JsonObject {
  if (contents === undefined) return {};
  if (Buffer.byteLength(contents) > MAX_SETTINGS_BYTES) {
    throw new Error(`Settings file exceeds ${MAX_SETTINGS_BYTES} bytes`);
  }
  if (contents.trim().length === 0) throw new Error("Settings file is empty");
  const parsed: unknown = JSON.parse(contents);
  if (
    Value.Check(SETTINGS_RECORD_VALUE, parsed)
    && (parsed.doubleEscapeAction === "tree" || parsed.doubleEscapeAction === "fork")
  ) parsed.doubleEscapeAction = "atlas";
  validateSettings(parsed);
  return parsed;
}

function timeoutSetting(value: JsonValue | undefined, fallback: number, name: string): number {
  validateTimeout(value, name);
  if (value === undefined || value === null || value === "") return fallback;
  if (value === "disabled") return 0;
  return Math.floor(Number(value));
}

function expandHome(path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return path;
}

export class InMemorySettingsStorage implements SettingsStorage {
  readonly #values: Partial<Record<SettingsScope, string>> = {};

  withLock(scope: SettingsScope, operation: (current: string | undefined) => string | undefined): void {
    const next = operation(this.#values[scope]);
    if (next !== undefined) this.#values[scope] = next;
  }
}

export class FileSettingsStorage implements SettingsStorage {
  readonly #paths: Record<SettingsScope, string>;

  constructor(workspace: string, agentDirectory: string) {
    this.#paths = {
      global: join(resolve(agentDirectory), "config.json"),
      project: join(resolve(workspace), ".ohm", "config.json"),
    };
  }

  path(scope: SettingsScope): string {
    return this.#paths[scope];
  }

  #read(scope: SettingsScope): string | undefined {
    const path = this.#paths[scope];
    const directory = dirname(path);
    if (existsSync(directory) && lstatSync(directory).isSymbolicLink()) {
      throw new Error(`Settings directory is a symbolic link: ${directory}`);
    }
    if (!existsSync(path)) return undefined;
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink()) throw new Error(`Settings file is a symbolic link: ${path}`);
    if (!metadata.isFile()) throw new Error(`Settings path is not a regular file: ${path}`);
    if (metadata.size > MAX_SETTINGS_BYTES) throw new Error(`Settings file exceeds ${MAX_SETTINGS_BYTES} bytes`);
    return readFileSync(path, "utf8");
  }

  withLock(scope: SettingsScope, operation: (current: string | undefined) => string | undefined): void {
    const current = this.#read(scope);
    const next = operation(current);
    if (next === undefined) return;
    if (Buffer.byteLength(next) > MAX_SETTINGS_BYTES) throw new Error(`Settings file exceeds ${MAX_SETTINGS_BYTES} bytes`);
    const path = this.#paths[scope];
    const directory = dirname(path);
    if (existsSync(directory) && lstatSync(directory).isSymbolicLink()) {
      throw new Error(`Settings directory is a symbolic link: ${directory}`);
    }
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
      throw new Error(`Settings file is a symbolic link: ${path}`);
    }
    const temporary = join(directory, `.${basename(path)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`);
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporary, "wx", 0o600);
      writeFileSync(descriptor, next, "utf8");
      closeSync(descriptor);
      descriptor = undefined;
      chmodSync(temporary, 0o600);
      renameSync(temporary, path);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
}

export class SettingsManager {
  readonly #storage: SettingsStorage;
  readonly #states: ScopeStates = {
    global: { raw: {}, settings: {}, loadable: true },
    project: { raw: {}, settings: {}, loadable: true },
  };
  readonly #pending: ScopePatches = { global: {}, project: {} };
  readonly #errors: SettingsError[] = [];
  #overrides: Settings = {};
  #projectTrusted: boolean;
  readonly #projectTrustBlocked: boolean;
  #revision = 0;
  #refreshGeneration = 0;

  private constructor(storage: SettingsStorage, options: SettingsManagerCreateOptions = {}, projectTrustBlocked = false) {
    this.#storage = storage;
    this.#projectTrustBlocked = projectTrustBlocked;
    this.#projectTrusted = options.projectTrusted ?? true;
    if (projectTrustBlocked) this.#projectTrusted = false;
    this.#loadInto("global");
    if (this.#projectTrusted) this.#loadInto("project");
  }

  static create(workspace: string, agentDirectory: string, options: SettingsManagerCreateOptions = {}): SettingsManager {
    const projectSettingsDirectory = resolve(workspace, ".ohm");
    const userSettingsDirectory = resolve(agentDirectory);
    const collision = process.platform === "win32"
      ? projectSettingsDirectory.toLowerCase() === userSettingsDirectory.toLowerCase()
      : projectSettingsDirectory === userSettingsDirectory;
    return new SettingsManager(new FileSettingsStorage(workspace, agentDirectory), options, collision);
  }

  static fromStorage(storage: SettingsStorage, options: SettingsManagerCreateOptions = {}): SettingsManager {
    return new SettingsManager(storage, options);
  }

  static inMemory<T>(settings?: T, options: SettingsManagerCreateOptions = {}): SettingsManager {
    const input = settings === undefined ? {} : settings;
    validateSettings(input);
    const storage = new InMemorySettingsStorage();
    storage.withLock("global", () => JSON.stringify(input));
    return new SettingsManager(storage, options);
  }

  #record<T>(scope: SettingsScope, thrown: T): Error {
    const error = errorFromThrown(thrown);
    this.#errors.push({ scope, error });
    return error;
  }

  #readScope(scope: SettingsScope): ScopeState {
    let contents: string | undefined;
    this.#storage.withLock(scope, (current) => {
      contents = current;
      return undefined;
    });
    const raw = parseDocument(contents);
    return { raw, settings: cleanSettings(raw), loadable: true };
  }

  #loadInto(scope: SettingsScope): boolean {
    try {
      this.#states[scope] = this.#readScope(scope);
      return true;
    } catch (error) {
      this.#states[scope].loadable = false;
      this.#record(scope, error);
      return false;
    }
  }

  #effective(): Settings {
    const project = this.#projectTrusted ? this.#states.project.settings : {};
    return mergeSettings(mergeSettings(this.#states.global.settings, project), this.#overrides);
  }

  #update(scope: SettingsScope, patch: JsonObject): void {
    if (scope === "project" && !this.#projectTrusted) {
      throw new Error("Project settings are not writable because this project is not trusted");
    }
    const raw = applyPatch(this.#states[scope].raw, patch);
    validateSettings(raw);
    this.#states[scope] = { raw, settings: cleanSettings(raw), loadable: this.#states[scope].loadable };
    this.#pending[scope] = applyPatch(this.#pending[scope], patch);
    this.#revision += 1;
  }

  #set(key: string, value: JsonValue): void {
    this.#update("global", { [key]: value });
  }

  #setNested(parent: string, key: string, value: JsonValue): void {
    this.#update("global", { [parent]: { [key]: value } });
  }

  getSettings(): Settings { return clone(this.#effective()); }
  getGlobalSettings(): Settings { return clone(this.#states.global.settings); }
  getProjectSettings(): Settings { return this.#projectTrusted ? clone(this.#states.project.settings) : {}; }
  updateGlobalSettings(patch: Settings): void { this.#update("global", patch); }
  updateProjectSettings(patch: Settings): void { this.#update("project", patch); }
  applyOverrides(overrides: Settings): void {
    const candidate = mergeSettings(this.#effective(), overrides);
    validateSettings(candidate);
    this.#overrides = clone(overrides);
    this.#revision += 1;
  }

  isProjectTrusted(): boolean { return this.#projectTrusted; }
  setProjectTrusted(trusted: boolean): void {
    const next = trusted && !this.#projectTrustBlocked;
    if (next && !this.#projectTrusted) this.#loadInto("project");
    this.#projectTrusted = next;
    this.#revision += 1;
  }

  getLoadErrors(): SettingsError[] { return [...this.#errors]; }
  drainErrors(): SettingsError[] { return this.#errors.splice(0); }

  async #flushScope(scope: SettingsScope): Promise<void> {
    const patch = this.#pending[scope];
    if (Object.keys(patch).length === 0) return;
    try {
      let written: JsonObject | undefined;
      this.#storage.withLock(scope, (current) => {
        const disk = parseDocument(current);
        written = applyPatch(disk, patch);
        validateSettings(written);
        const serialized = `${JSON.stringify(written, null, 2)}\n`;
        if (Buffer.byteLength(serialized) > MAX_SETTINGS_BYTES) {
          throw new Error(`Settings file exceeds ${MAX_SETTINGS_BYTES} bytes`);
        }
        return serialized;
      });
      if (written !== undefined) {
        this.#states[scope] = { raw: written, settings: cleanSettings(written), loadable: true };
        this.#pending[scope] = {};
      }
    } catch (error) {
      this.#record(scope, error);
    }
  }

  async flush(): Promise<void> {
    await this.#flushScope("global");
    if (this.#projectTrusted) await this.#flushScope("project");
  }

  async #refreshAndCommit(options: { validate?: (settings: Readonly<Settings>) => void | Promise<void> } = {}): Promise<number> {
    const generation = ++this.#refreshGeneration;
    const revision = this.#revision;
    const candidates: Partial<Record<SettingsScope, ScopeState>> = {};
    const failures: SettingsError[] = [];
    for (const scope of ["global", "project"] as const) {
      if (scope === "project" && !this.#projectTrusted) continue;
      try {
        const disk = this.#readScope(scope);
        const raw = applyPatch(disk.raw, this.#pending[scope]);
        candidates[scope] = { raw, settings: cleanSettings(raw), loadable: true };
      } catch (error) {
        failures.push({ scope, error: this.#record(scope, error) });
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((entry) => entry.error),
        `Settings could not be loaded: ${failures.map((entry) => `${entry.scope}: ${entry.error.message}`).join("; ")}`,
      );
    }
    const effective = mergeSettings(candidates.global?.settings ?? {}, candidates.project?.settings ?? {});
    await options.validate?.(clone(effective));
    if (generation !== this.#refreshGeneration || revision !== this.#revision) {
      throw new Error("Settings changed while refresh validation was in progress");
    }
    if (candidates.global !== undefined) this.#states.global = candidates.global;
    if (candidates.project !== undefined) this.#states.project = candidates.project;
    this.#overrides = {};
    this.#revision += 1;
    return this.#revision;
  }

  async refresh(options: { validate?: (settings: Readonly<Settings>) => void | Promise<void> } = {}): Promise<void> {
    await this.#refreshAndCommit(options);
  }

  refreshForTransaction(options: { validate?: (settings: Readonly<Settings>) => void | Promise<void> } = {}): Promise<number> {
    return this.#refreshAndCommit(options);
  }

  createRollback(): (expectedRevision?: number) => boolean {
    const states = clone(this.#states);
    const pending = clone(this.#pending);
    const overrides = clone(this.#overrides);
    const revision = this.#revision;
    return (expectedRevision?: number): boolean => {
      if (expectedRevision !== undefined && this.#revision !== expectedRevision) return false;
      if (expectedRevision === undefined && this.#revision !== revision) return false;
      this.#states.global = states.global;
      this.#states.project = states.project;
      this.#pending.global = pending.global;
      this.#pending.project = pending.project;
      this.#overrides = overrides;
      this.#revision += 1;
      return true;
    };
  }

  getLastChangelogVersion(): string | undefined { return this.#effective().lastChangelogVersion ?? undefined; }
  setLastChangelogVersion(value: string): void { this.#set("lastChangelogVersion", value); }
  getDefaultProvider(): string | undefined { return this.#effective().defaultProvider ?? undefined; }
  setDefaultProvider(value: string): void { this.#set("defaultProvider", value); }
  getDefaultModel(): string | undefined { return this.#effective().defaultModel ?? undefined; }
  setDefaultModel(value: string): void { this.#set("defaultModel", value); }
  setDefaultModelAndProvider(provider: string, model: string): void { this.#update("global", { defaultProvider: provider, defaultModel: model }); }
  getDefaultThinkingLevel(): ThinkingLevel | undefined { return this.#effective().defaultThinkingLevel ?? undefined; }
  setDefaultThinkingLevel(value: ThinkingLevel): void { this.#set("defaultThinkingLevel", value); }
  getEnabledModels(): string[] | undefined { return clone(this.#effective().enabledModels ?? undefined); }
  setEnabledModels(value: readonly string[]): void { this.#set("enabledModels", [...value]); }
  getModelThinkingLevels() {
    const configured = this.#effective().modelThinkingLevels;
    const levels: Record<string, ThinkingLevel> = {};
    for (const [selector, level] of Object.entries(configured ?? {})) {
      if (level !== null) levels[selector] = level;
    }
    return levels;
  }
  getModelThinkingLevel(provider: string, modelId: string): ThinkingLevel | undefined {
    return this.#effective().modelThinkingLevels?.[exactModelSelector(provider, modelId)] ?? undefined;
  }
  setModelThinkingLevel(provider: string, modelId: string, value: ThinkingLevel): void {
    this.#setNested("modelThinkingLevels", exactModelSelector(provider, modelId), value);
  }
  removeModelThinkingLevel(provider: string, modelId: string): void {
    this.#setNested("modelThinkingLevels", exactModelSelector(provider, modelId), null);
  }
  getTransport(): TransportSetting { return this.#effective().transport ?? "auto"; }
  setTransport(value: TransportSetting): void { this.#set("transport", value); }
  getSteeringMode(): QueueMode { return this.#effective().steeringMode ?? "one-at-a-time"; }
  setSteeringMode(value: QueueMode): void { this.#set("steeringMode", value); }
  getFollowUpMode(): QueueMode { return this.#effective().followUpMode ?? "one-at-a-time"; }
  setFollowUpMode(value: QueueMode): void { this.#set("followUpMode", value); }
  getThemeSetting(): string | undefined { return this.#effective().theme ?? undefined; }
  getTheme(): string | undefined {
    const theme = this.getThemeSetting();
    return theme?.includes("/") === true ? undefined : theme;
  }
  setTheme(value: string): void { this.#set("theme", value); }

  getCompactionEnabled(): boolean { return this.#effective().compaction?.enabled ?? true; }
  setCompactionEnabled(value: boolean): void { this.#setNested("compaction", "enabled", value); }
  getCompactionTriggerPercentOverride(): number | undefined {
    return this.#effective().compaction?.triggerPercent ?? undefined;
  }
  getCompactionTriggerPercent(): number { return this.getCompactionTriggerPercentOverride() ?? 85; }
  setCompactionTriggerPercent(value: number): void { this.#setNested("compaction", "triggerPercent", Math.max(50, Math.min(95, Math.round(value)))); }
  getCompactionReserveTokens(): number | undefined { return this.#effective().compaction?.reserveTokens ?? undefined; }
  getCompactionRecentTokens(): number | undefined { return this.#effective().compaction?.recentTokens ?? undefined; }
  getCompactionSettings(): CompactionSummary {
    return { enabled: this.getCompactionEnabled(), triggerPercent: this.getCompactionTriggerPercent() };
  }
  getBranchSummarySettings(): BranchSummary {
    const value = this.#effective().branchSummary;
    return { reserveTokens: value?.reserveTokens ?? 18_000, skipPrompt: value?.skipPrompt ?? false };
  }
  getBranchSummarySkipPrompt(): boolean { return this.getBranchSummarySettings().skipPrompt; }

  getRetryEnabled(): boolean { return this.#effective().retry?.enabled ?? true; }
  setRetryEnabled(value: boolean): void { this.#setNested("retry", "enabled", value); }
  getRetrySettings(): RetrySettings {
    const value = this.#effective().retry;
    return {
      enabled: value?.enabled ?? true,
      maxRetries: value?.maxRetries ?? 3,
      baseDelayMs: value?.baseDelayMs ?? 2_000,
    };
  }
  getProviderRetrySettings(): ProviderRetrySettings {
    const provider = this.#effective().retry?.provider;
    return {
      ...optionalProperties(provider?.timeoutMs == null ? undefined : { timeoutMs: provider.timeoutMs }),
      maxRetries: provider?.maxRetries ?? 0,
      maxRetryDelayMs: provider?.maxRetryDelayMs ?? 60_000,
    };
  }
  getObservabilityLevel(): ObservabilityLevel { return this.#effective().observability?.level ?? "debug"; }

  getShowCacheMissNotices(): boolean { return this.#effective().showCacheMissNotices ?? false; }
  setShowCacheMissNotices(value: boolean): void { this.#set("showCacheMissNotices", value); }
  getExternalEditorCommand(): string | undefined {
    return this.#effective().externalEditor ?? process.env.VISUAL ?? process.env.EDITOR;
  }
  getShellPath(): string | undefined { return expandHome(this.#effective().shellPath ?? undefined); }
  getQuietStartup(): boolean { return this.#effective().quietStartup ?? false; }
  setQuietStartup(value: boolean): void { this.#set("quietStartup", value); }
  getDefaultProjectTrust(): DefaultProjectTrust { return this.#effective().defaultProjectTrust ?? "ask"; }
  setDefaultProjectTrust(value: DefaultProjectTrust): void { this.#set("defaultProjectTrust", value); }
  getShellCommandPrefix(): string | undefined { return this.#effective().shellCommandPrefix ?? undefined; }
  getNpmCommand(): string[] | undefined { return clone(this.#effective().npmCommand ?? undefined); }
  setNpmCommand(value: string[]): void { this.#set("npmCommand", value); }
  getCollapseChangelog(): boolean { return this.#effective().collapseChangelog ?? false; }
  setCollapseChangelog(value: boolean): void { this.#set("collapseChangelog", value); }

  getPackages(): PackageSource[] { return clone(this.#effective().packages ?? []); }
  setPackages(value: PackageSource[]): void { this.#set("packages", value); }
  setProjectPackages(value: PackageSource[]): void { this.#update("project", { packages: value }); }
  getExtensionPaths(): string[] { return clone(this.#effective().extensions ?? []); }
  setExtensionPaths(value: string[]): void { this.#set("extensions", value); }
  setProjectExtensionPaths(value: string[]): void { this.#update("project", { extensions: value }); }
  getSkillPaths(): string[] { return clone(this.#effective().skills ?? []); }
  setSkillPaths(value: string[]): void { this.#set("skills", value); }
  setProjectSkillPaths(value: string[]): void { this.#update("project", { skills: value }); }
  getPromptPaths(): string[] { return clone(this.#effective().prompts ?? []); }
  setPromptPaths(value: string[]): void { this.#set("prompts", value); }
  setProjectPromptPaths(value: string[]): void { this.#update("project", { prompts: value }); }
  getThemePaths(): string[] { return clone(this.#effective().themes ?? []); }
  setThemePaths(value: string[]): void { this.#set("themes", value); }
  setProjectThemePaths(value: string[]): void { this.#update("project", { themes: value }); }
  getEnableSkillCommands(): boolean { return this.#effective().enableSkillCommands ?? true; }
  setEnableSkillCommands(value: boolean): void { this.#set("enableSkillCommands", value); }
  getToolSettings(): ToolSettings {
    const value = this.#effective().tools;
    return {
      ...optionalProperties(value?.enabled == null ? undefined : { enabled: clone(value.enabled) }),
      excluded: clone(value?.excluded ?? []),
    };
  }

  getShowImages(): boolean { return this.#effective().terminal?.showImages ?? true; }
  setShowImages(value: boolean): void { this.#setNested("terminal", "showImages", value); }
  getImageWidthCells(): number { return this.#effective().terminal?.imageWidthCells ?? 60; }
  setImageWidthCells(value: number): void { this.#setNested("terminal", "imageWidthCells", Math.max(1, Math.round(value))); }
  getClearOnShrink(): boolean {
    const configured = this.#effective().terminal?.clearOnShrink;
    return configured ?? process.env.OHM_CLEAR_ON_SHRINK === "1";
  }
  setClearOnShrink(value: boolean): void { this.#setNested("terminal", "clearOnShrink", value); }
  getShowTerminalProgress(): boolean { return this.#effective().terminal?.showTerminalProgress ?? false; }
  setShowTerminalProgress(value: boolean): void { this.#setNested("terminal", "showTerminalProgress", value); }
  getFullscreenScrollbar(): FullscreenScrollbar {
    return this.#effective().fullscreenScrollbar ?? "auto";
  }
  setFullscreenScrollbar(value: FullscreenScrollbar): void {
    this.#set("fullscreenScrollbar", value);
  }
  getFullscreenCopyOnSelect(): boolean {
    return this.#effective().fullscreenCopyOnSelect ?? true;
  }
  setFullscreenCopyOnSelect(value: boolean): void {
    this.#set("fullscreenCopyOnSelect", value);
  }
  getImageAutoResize(): boolean { return this.#effective().images?.autoResize ?? true; }
  setImageAutoResize(value: boolean): void { this.#setNested("images", "autoResize", value); }
  getBlockImages(): boolean { return this.#effective().images?.blockImages ?? false; }
  setBlockImages(value: boolean): void { this.#setNested("images", "blockImages", value); }
  getDoubleEscapeAction(): "atlas" | "none" {
    return this.#effective().doubleEscapeAction === "none" ? "none" : "atlas";
  }
  setDoubleEscapeAction(value: "atlas" | "none"): void { this.#set("doubleEscapeAction", value); }
  getTreeFilterMode(): "default" | "no-tools" | "user-only" | "labeled-only" | "all" {
    return this.#effective().treeFilterMode ?? "default";
  }
  setTreeFilterMode(value: "default" | "no-tools" | "user-only" | "labeled-only" | "all"): void { this.#set("treeFilterMode", value); }
  getThinkingBudgets(): ThinkingBudgets | undefined {
    const value = this.#effective().thinkingBudgets;
    if (value == null) return undefined;
    return clone({
      ...optionalProperties(value.minimal == null ? undefined : { minimal: value.minimal }),
      ...optionalProperties(value.low == null ? undefined : { low: value.low }),
      ...optionalProperties(value.medium == null ? undefined : { medium: value.medium }),
      ...optionalProperties(value.high == null ? undefined : { high: value.high }),
      ...optionalProperties(value.xhigh == null ? undefined : { xhigh: value.xhigh }),
      ...optionalProperties(value.max == null ? undefined : { max: value.max }),
    });
  }
  getEditorPaddingX(): number { return this.#effective().editorPaddingX ?? 0; }
  setEditorPaddingX(value: number): void { this.#set("editorPaddingX", Math.max(0, Math.min(3, Math.round(value)))); }
  getOutputPad(): 0 | 1 { return this.#effective().outputPad ?? 1; }
  setOutputPad(value: 0 | 1): void { this.#set("outputPad", value); }
  getAutocompleteMaxVisible(): number { return this.#effective().autocompleteMaxVisible ?? 5; }
  setAutocompleteMaxVisible(value: number): void { this.#set("autocompleteMaxVisible", Math.max(3, Math.min(20, Math.round(value)))); }
  getShowHardwareCursor(): boolean {
    const configured = this.#effective().showHardwareCursor;
    if (configured != null) return configured;
    return process.env.OHM_HARDWARE_CURSOR !== "0";
  }
  setShowHardwareCursor(value: boolean): void { this.#set("showHardwareCursor", value); }
  getCodeBlockIndent(): string { return this.#effective().markdown?.codeBlockIndent ?? "  "; }
  getWarnings(): WarningSettings {
    const value = this.#effective().warnings?.anthropicExtraUsage;
    return clone({ ...optionalProperties(value == null ? undefined : { anthropicExtraUsage: value }) });
  }
  setWarnings(value: WarningSettings): void { this.#set("warnings", value); }
  getSessionDir(): string | undefined { return expandHome(this.#effective().sessionDir ?? undefined); }
  getHttpProxy(): string | undefined { return this.#effective().httpProxy ?? undefined; }
  getHttpIdleTimeoutMs(): number { return timeoutSetting(this.#effective().httpIdleTimeoutMs, 300_000, "httpIdleTimeoutMs"); }
  setHttpIdleTimeoutMs(value: number): void { this.#set("httpIdleTimeoutMs", value); }
  getWebSocketConnectTimeoutMs(): number { return timeoutSetting(this.#effective().websocketConnectTimeoutMs, 30_000, "websocketConnectTimeoutMs"); }
  getKeybindings(): Record<string, string | string[] | null> { return clone(this.#effective().keybindings ?? {}); }
}
