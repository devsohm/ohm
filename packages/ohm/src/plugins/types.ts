import type { SkillRoot } from "../context/skills.js";
import type { ThemeDefinition } from "../tui/theme.js";

export type PluginScope = "builtin" | "user" | "project" | "invocation";
export type PluginStatus = "active" | "blocked" | "disabled" | "invalid" | "shadowed";
export type PluginDiagnosticSeverity = "error" | "warning" | "info";

export interface PluginContributionCounts {
  skillRoots: number;
  prompts: number;
  commands: number;
  themes: number;
  runtime: number;
}

export interface PluginMetadata {
  id: string;
  name: string;
  version?: string;
  description?: string;
  hostVersionRange?: string;
  scope: PluginScope;
  trusted: boolean;
  status: PluginStatus;
  sourceRoot: string;
  extensionRoot: string;
  manifestPath: string;
  manifestSha256?: string;
  precedence: number;
  contributions: PluginContributionCounts;
}

export interface PluginDiagnostic {
  severity: PluginDiagnosticSeverity;
  code: string;
  message: string;
  path: string;
  extensionId?: string;
}

export interface PluginPromptTemplate {
  id: string;
  extensionId: string;
  description?: string;
  argumentHint?: string;
  sourcePath: string;
  sha256: string;
  template: string;
}

export interface PluginSlashCommand {
  name: string;
  extensionId: string;
  description?: string;
  argumentHint?: string;
  sourcePath: string;
  sha256: string;
  template: string;
}

export interface PluginTheme {
  name: string;
  extensionId: string;
  description?: string;
  sourcePath: string;
  sha256: string;
  definition: ThemeDefinition;
}

export interface PluginRuntimeEntry {
  extensionId: string;
  sourcePath: string;
  /** SHA-256 of the exact runtime source bytes evaluated for this generation. */
  sha256: string;
  /** Package metadata is present only when supplied by an integrity-checked resolver. */
  packageVersion?: string;
  packageContentSha256?: string;
  manifestSha256?: string;
  /** Directory that owns relative resources contributed by this runtime entry. */
  resourceRoot?: string;
  scope?: PluginScope;
  trusted?: boolean;
}

export interface PluginBundle {
  skillRoots: SkillRoot[];
  prompts: PluginPromptTemplate[];
  commands: PluginSlashCommand[];
  themes: PluginTheme[];
  runtime: PluginRuntimeEntry[];
}

export interface PluginDoctorReport {
  healthy: boolean;
  active: number;
  blocked: number;
  disabled: number;
  invalid: number;
  shadowed: number;
  diagnostics: PluginDiagnostic[];
}
