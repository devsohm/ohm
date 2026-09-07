import type { RuntimePluginHost, RuntimeFlagDescription } from "../plugins/runtime.js";
import { isStringValue } from "../tui/value-guards.js";
import type { Args, CliDiagnostic } from "./args.js";

/** Disable automatic discovery without discarding deliberately selected plugin resources. */
export function pluginResourceOptions(selection: Pick<Args, "noPlugins" | "noPluginCode" | "noSkills" | "noPromptTemplates" | "noThemes">) {
  return {
    pluginCode: selection.noPlugins !== true && selection.noPluginCode !== true,
    skills: selection.noPlugins !== true && selection.noSkills !== true,
    promptTemplates: selection.noPlugins !== true && selection.noPromptTemplates !== true,
    themes: selection.noPlugins !== true && selection.noThemes !== true,
    explicitPluginResources: {
      skills: selection.noSkills !== true,
      prompts: selection.noPromptTemplates !== true,
      themes: selection.noThemes !== true,
    },
  };
}

export interface ResolvedRuntimePluginFlags {
  values: Map<string, boolean | string>;
  diagnostics: CliDiagnostic[];
}

export function resolveRuntimePluginFlags(
  requested: ReadonlyMap<string, boolean | string>,
  flags: readonly RuntimeFlagDescription[],
): ResolvedRuntimePluginFlags {
  const registered = new Map(flags.map((flag) => [flag.name, flag]));
  const values = new Map<string, boolean | string>();
  const diagnostics: CliDiagnostic[] = [];
  const unknown: string[] = [];

  for (const [name, value] of requested) {
    const flag = registered.get(name);
    if (flag === undefined) {
      unknown.push(name);
      continue;
    }
    if (flag.type === "boolean") values.set(name, true);
    else if (isStringValue(value)) values.set(name, value);
    else diagnostics.push({ type: "error", message: `Plugin flag "--${name}" requires a value` });
  }
  if (unknown.length > 0) {
    diagnostics.push({
      type: "error",
      message: `Unknown option${unknown.length === 1 ? "" : "s"}: ${unknown.map((name) => `--${name}`).join(", ")}`,
    });
  }
  return { values, diagnostics };
}

export function applyRuntimePluginFlags(args: Args, host: RuntimePluginHost): Args {
  const resolved = resolveRuntimePluginFlags(args.unknownFlags, host.flags());
  host.setFlagValues(resolved.values);
  args.diagnostics.push(...resolved.diagnostics);
  return args;
}
