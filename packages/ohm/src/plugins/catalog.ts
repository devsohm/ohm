import { optionalProperties } from "../core/optional-properties.js";
import type {
  PluginBundle,
  PluginDiagnostic,
  PluginDoctorReport,
  PluginMetadata,
  PluginPromptTemplate,
  PluginSlashCommand,
  PluginTheme,
} from "./types.js";

function cloneMetadata(value: PluginMetadata): PluginMetadata {
  return { ...value, contributions: { ...value.contributions } };
}

function cloneTheme(value: PluginTheme): PluginTheme {
  return {
    ...value,
    definition: {
      ...value.definition,
      styles: Object.fromEntries(
        Object.entries(value.definition.styles).map(([role, declaration]) => [role, { ...declaration }]),
      ),
      ...optionalProperties(value.definition.tokens === undefined ? undefined : { tokens: { ...value.definition.tokens } }),
      ...optionalProperties(value.definition.export === undefined ? undefined : { export: { ...value.definition.export } }),
    },
  };
}

function cloneBundle(value: PluginBundle): PluginBundle {
  return {
    skillRoots: value.skillRoots.map((root) => ({ ...root })),
    prompts: value.prompts.map((prompt) => ({ ...prompt })),
    commands: value.commands.map((command) => ({ ...command })),
    themes: value.themes.map(cloneTheme),
    runtime: value.runtime.map((entry) => ({ ...entry })),
  };
}

/** Read-only catalog projection assembled from active direct factories and resolved resources. */
export class PluginCatalog {
  readonly #extensions: PluginMetadata[];
  readonly #diagnostics: PluginDiagnostic[];
  readonly #bundle: PluginBundle;

  constructor(extensions: PluginMetadata[], diagnostics: PluginDiagnostic[], bundle: PluginBundle) {
    this.#extensions = extensions.map(cloneMetadata);
    this.#diagnostics = diagnostics.map((diagnostic) => ({ ...diagnostic }));
    this.#bundle = cloneBundle(bundle);
  }

  list(): PluginMetadata[] {
    return this.#extensions.map(cloneMetadata);
  }

  bundle(): PluginBundle {
    return cloneBundle(this.#bundle);
  }

  doctor(): PluginDoctorReport {
    const count = (status: PluginMetadata["status"]): number =>
      this.#extensions.filter((entry) => entry.status === status).length;
    return {
      healthy: !this.#diagnostics.some((entry) => entry.severity === "error"),
      active: count("active"),
      blocked: count("blocked"),
      disabled: count("disabled"),
      invalid: count("invalid"),
      shadowed: count("shadowed"),
      diagnostics: this.#diagnostics.map((diagnostic) => ({ ...diagnostic })),
    };
  }

  prompt(id: string): PluginPromptTemplate | undefined {
    const value = this.#bundle.prompts.find((entry) => entry.id === id);
    return value === undefined ? undefined : { ...value };
  }

  command(name: string): PluginSlashCommand | undefined {
    const value = this.#bundle.commands.find((entry) => entry.name === name);
    return value === undefined ? undefined : { ...value };
  }

  theme(name: string): PluginTheme | undefined {
    const value = this.#bundle.themes.find((entry) => entry.name === name);
    return value === undefined ? undefined : cloneTheme(value);
  }
}
