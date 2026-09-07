import { optionalProperties } from "../core/optional-properties.js";
import { flagBoolean, flagString, flagStrings, type ManagementArguments as ParsedArguments } from "./management-args.js";
import { activatePackageCandidate, loadRuntime } from "./runtime.js";
import type { RuntimeInlinePlugin } from "../plugins/runtime.js";
import { ProjectPackageManager } from "../plugins/project-packages.js";
import { TrustStore } from "../config/index.js";
import type { ProjectTrustResolver } from "./project-trust.js";
import { relative, resolve, sep } from "node:path";
import { realpath } from "node:fs/promises";
import { agentPaths } from "./paths.js";
import { pluginResourceOptions } from "./plugin-flags.js";
import { writeMachineOutput } from "../interfaces/output-guard.js";
import type { TuiSettingItem } from "../tui/index.js";
import { createRichTuiController } from "../tui/rich-frame-projector.js";
import { isStringValue } from "../tui/value-guards.js";
import { DefaultPackageManager } from "../core/package-manager.js";
import { SettingsManager, type PackageSource } from "../core/settings-manager.js";
import {
  inspectPluginPackage,
  initPluginPackage,
  loadPluginGalleryIndex,
  packPluginPackage,
  preparePluginPreview,
  refreshPluginPackage,
  reportPluginPackage,
  smokePluginPackage,
  testPluginPackage,
  validatePluginPackage,
  verifyPluginPackage,
} from "./plugin-author.js";

function output<Output>(value: Output, json: boolean): void {
  writeMachineOutput(json ? `${JSON.stringify(value)}\n` : `${JSON.stringify(value, null, 2)}\n`);
}

function line(value: string): void {
  writeMachineOutput(`${value}\n`);
}

function packageScope(argumentsValue: ParsedArguments): "user" | "project" {
  const value = flagString(argumentsValue, "scope") ?? (flagBoolean(argumentsValue, "local") ? "project" : "user");
  if (value !== "user" && value !== "project") throw new Error("--scope must be user or project");
  return value;
}

export interface PackageCommandOptions {
  projectTrustResolver?: ProjectTrustResolver;
  signal?: AbortSignal;
}

async function packageContext(argumentsValue: ParsedArguments, options: PackageCommandOptions = {}) {
  const paths = agentPaths();
  const workspace = await realpath(resolve(flagString(argumentsValue, "workspace") ?? process.cwd()));
  const approve = flagBoolean(argumentsValue, "approve");
  const deny = flagBoolean(argumentsValue, "no-approve");
  if (approve && deny) throw new Error("--approve and --no-approve are mutually exclusive");
  const requestedTrust = options.projectTrustResolver === undefined
    ? approve || (!deny && await new TrustStore(paths.trustStore).isTrusted(workspace))
    : await options.projectTrustResolver.isTrusted(workspace);
  const settings = SettingsManager.create(workspace, paths.agentDirectory, { projectTrusted: requestedTrust });
  const trusted = settings.isProjectTrusted();
  await settings.refresh();
  const manager = new DefaultPackageManager({
    cwd: workspace,
    agentDir: paths.agentDirectory,
    settingsManager: settings,
    activateCandidate: activatePackageCandidate,
    ...optionalProperties(flagBoolean(argumentsValue, "offline") ? { offline: true } : undefined),
  });
  return { paths, workspace, trusted, settings, manager };
}

export async function runPackageConfigCommand(
  argumentsValue: ParsedArguments,
  options: PackageCommandOptions = {},
): Promise<void> {
  const scope = packageScope(argumentsValue);
  const { workspace, trusted, settings: settingsManager, manager } = await packageContext(argumentsValue, options);
  if (scope === "project" && !trusted) {
    throw new Error("Project packages contain trusted code. Review the source, then rerun with --approve or save project trust.");
  }
  const resolved = await manager.resolve();
  const resources = (["extensions", "skills", "prompts", "themes"] as const).flatMap((kind) =>
    resolved[kind]
      .filter((resource) => resource.metadata.origin === "package" && resource.metadata.scope === scope)
      .map((resource) => {
        const base = resolve(resource.metadata.baseDir ?? workspace);
        const label = relative(base, resource.path).split(sep).join("/") || ".";
        return {
          kind: kind === "extensions" ? "entrypoints" as const : kind,
          source: resource.metadata.source,
          sourcePath: resource.path,
          label,
          enabled: resource.enabled,
        };
      }));
  if (resources.length === 0) {
    writeMachineOutput(`No ${scope} package resources are installed.\n`);
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    if (flagBoolean(argumentsValue, "json")) output(resources, true);
    else for (const resource of resources) {
      line(`${resource.enabled ? "[x]" : "[ ]"} ${resource.source} · ${resource.kind} · ${resource.label}`);
    }
    return;
  }
  const settings: TuiSettingItem[] = resources.map((resource, index) => ({
    id: `resource-${index}`,
    label: `${resource.source} · ${resource.kind} · ${resource.label}`,
    description: resource.sourcePath,
    value: String(resource.enabled),
    values: ["true", "false"],
  }));
  const terminal = createRichTuiController();
  terminal.start();
  terminal.setContext({ workspace });
  try {
    await terminal.chooseSettings(settings, async (setting, value) => {
      const index = Number(setting.id.slice("resource-".length));
      const resource = resources[index];
      if (resource === undefined) throw new Error("Package resource selection is stale");
      const configured = scope === "project"
        ? settingsManager.getProjectSettings().plugins ?? []
        : settingsManager.getGlobalSettings().plugins ?? [];
      const sourceOf = (entry: PackageSource): string => isStringValue(entry) ? entry : entry.source;
      const packageIndex = configured.findIndex((entry) => sourceOf(entry) === resource.source);
      if (packageIndex < 0) throw new Error(`Configured package is no longer available: ${resource.source}`);
      const current = configured[packageIndex]!;
      const selected = isStringValue(current) ? { source: current } : { ...current };
      const key = resource.kind;
      const prior = selected[key] ?? [];
      selected[key] = [
        ...prior.filter((pattern) => pattern.replace(/^[!+-]/u, "") !== resource.label),
        `${value === "true" ? "+" : "-"}${resource.label}`,
      ];
      const next = configured.with(packageIndex, selected);
      if (scope === "project") settingsManager.setProjectPackages(next);
      else settingsManager.setPackages(next);
      await settingsManager.flush();
    });
  } finally {
    terminal.close();
  }
}

export async function runPackageCommand(
  argumentsValue: ParsedArguments,
  options: PackageCommandOptions = {},
): Promise<void> {
  const action = argumentsValue.command === "plugins" ? argumentsValue.positionals[0] : argumentsValue.command;
  const offset = argumentsValue.command === "plugins" ? 1 : 0;
  const scope = packageScope(argumentsValue);
  const { trusted, settings, manager } = await packageContext(argumentsValue, options);
  if (scope === "project" && !trusted && action !== "list") {
    throw new Error("Project packages contain trusted code. Review the source, then rerun with --approve or save trust interactively with /trust");
  }
  const json = flagBoolean(argumentsValue, "json");
  const allowScripts = flagBoolean(argumentsValue, "allow-scripts");
  if (action === "list") {
    const scopeSelected = flagString(argumentsValue, "scope") !== undefined || flagBoolean(argumentsValue, "local");
    const installed = manager.listConfiguredPackages().filter((entry) => !scopeSelected || entry.scope === scope);
    if (json) output(installed, true);
    else if (installed.length === 0) line("No plugins installed.");
    else {
      for (const selectedScope of ["user", "project"] as const) {
        const entries = installed.filter((entry) => entry.scope === selectedScope);
        if (entries.length === 0) continue;
        line(`${selectedScope === "user" ? "User" : "Project"} plugins:`);
        for (const entry of entries) {
          line(`  ${entry.source}${entry.filtered ? " (filtered)" : ""}`);
          if (entry.installedPath !== undefined) line(`    ${entry.installedPath}`);
        }
      }
    }
    return;
  }
  if (action === "install") {
    const source = argumentsValue.positionals[offset];
    if (source === undefined) throw new Error("install requires a package source: directory, npm:SPEC, git:SOURCE, or HTTPS URL");
    await manager.installAndPersist(source, {
      local: scope === "project",
      allowScripts,
      ...optionalProperties(options.signal === undefined ? undefined : { signal: options.signal }),
    });
    await settings.flush();
    const installed = manager.listConfiguredPackages().find((entry) => entry.scope === scope && entry.source === source)
      ?? { source, scope, filtered: false };
    if (json) output(installed, true);
    else line(`Installed ${source} (${scope})`);
    return;
  }
  if (action === "update") {
    const source = argumentsValue.positionals[offset];
    if (flagBoolean(argumentsValue, "all")) {
      if (source !== undefined) throw new Error("update accepts either a package source or --all, not both");
      await manager.update(undefined, {
        allowScripts,
        ...optionalProperties(options.signal === undefined ? undefined : { signal: options.signal }),
      });
      const updated = manager.listConfiguredPackages();
      if (json) output({ updated }, true);
      else line(`Updated ${updated.length} configured package${updated.length === 1 ? "" : "s"}.`);
      return;
    }
    if (source === undefined) throw new Error("update requires a package source or --all");
    await manager.update(source, {
      allowScripts,
      ...optionalProperties(options.signal === undefined ? undefined : { signal: options.signal }),
    });
    if (json) output({ source, updated: true }, true);
    else line(`Updated ${source}`);
    return;
  }
  if (action === "remove" || action === "uninstall") {
    const source = argumentsValue.positionals[offset];
    if (source === undefined) throw new Error("remove requires a package source");
    const removed = await manager.removeAndPersist(source, { local: scope === "project" });
    await settings.flush();
    if (json) output({ source, scope, removed }, true);
    else line(removed ? `Removed ${source} (${scope})` : `Package was not configured: ${source}`);
    return;
  }
  throw new Error(`Unknown package action: ${action}`);
}

export async function runProjectPackageCommand(
  argumentsValue: ParsedArguments,
  options: PackageCommandOptions = {},
): Promise<void> {
  const { paths, workspace, trusted, settings } = await packageContext(argumentsValue, options);
  const npmCommand = settings.getNpmCommand();
  const manager = new ProjectPackageManager({
    workspace,
    projectTrusted: trusted,
    ...optionalProperties(flagBoolean(argumentsValue, "offline") ? { offline: true } : undefined),
    operationLeaseRoot: resolve(paths.agentDirectory, "state", "leases"),
    ...optionalProperties(npmCommand === undefined || npmCommand.length === 0 ? undefined : {
      commands: { npm: { command: npmCommand[0]!, prefix: npmCommand.slice(1) } },
    }),
  });
  const action = argumentsValue.positionals[0] ?? "check";
  const json = flagBoolean(argumentsValue, "json");
  if (action === "check") {
    const result = await manager.check(options.signal);
    if (json) output(result, true);
    else line(result.message);
    return;
  }
  if (action === "reconcile") {
    const result = await manager.reconcile(options.signal);
    if (json) output(result, true);
    else if (result.status === "ignored") line("Project package declarations are ignored until the workspace is trusted.");
    else line(`${result.changed ? "Reconciled" : "Verified"} ${result.packages.length} locked project package${result.packages.length === 1 ? "" : "s"}.`);
    return;
  }
  if (action === "update") {
    if (flagBoolean(argumentsValue, "allow-scripts")) {
      throw new Error("Declarative project packages never enable lifecycle scripts");
    }
    const ids = argumentsValue.positionals.slice(1);
    const result = await manager.update({
      all: flagBoolean(argumentsValue, "all"),
      ids,
      ...optionalProperties(options.signal === undefined ? undefined : { signal: options.signal }),
    });
    if (json) output(result, true);
    else line(`Updated and reconciled ${result.packages.length} locked project package${result.packages.length === 1 ? "" : "s"}.`);
    return;
  }
  throw new Error(`Unknown project package action: ${action}`);
}

export interface PluginsCommandOptions {
  pluginFactories?: readonly RuntimeInlinePlugin[];
  projectTrustResolver?: ProjectTrustResolver;
  signal?: AbortSignal;
}

export async function runPluginsCommand(
  argumentsValue: ParsedArguments,
  options: PluginsCommandOptions = {},
): Promise<void | { previewArgv: string[] }> {
  if (["install", "remove", "uninstall", "update", "packages"].includes(argumentsValue.positionals[0] ?? "")) {
    const action = argumentsValue.positionals[0] === "packages" ? "list" : argumentsValue.positionals[0]!;
    await runPackageCommand(
      { ...argumentsValue, positionals: [action, ...argumentsValue.positionals.slice(1)] },
      options,
    );
    return;
  }
  if (argumentsValue.positionals[0] === "author") {
    const action = argumentsValue.positionals[1];
    const source = argumentsValue.positionals[2];
    if (action === undefined) throw new Error("plugins requires init, test, preview, verify, validate, inspect, pack, smoke, refresh, report, or index");
    if (source === undefined) throw new Error(`plugins ${action} requires a local package or index path`);
    let result: unknown;
    if (action === "init") result = await initPluginPackage(source, options.signal);
    else if (action === "test") {
      const tested = await testPluginPackage(source, options.signal);
      if (tested.status === "error") process.exitCode = 1;
      result = tested;
    }
    else if (action === "preview") {
      const preview = await preparePluginPreview(source, flagString(argumentsValue, "workspace"), options.signal);
      if (flagBoolean(argumentsValue, "approve")) preview.argv.push("--approve");
      if (flagBoolean(argumentsValue, "no-approve")) preview.argv.push("--no-approve");
      if (flagBoolean(argumentsValue, "json")) result = preview;
      else {
        if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Live plugin preview requires a terminal. Use --json to inspect the invocation without activating code.");
        line(`Previewing ${preview.directory}. Use /refresh after edits and /exit to close. No saved session or package installation.`);
        return { previewArgv: preview.argv };
      }
    }
    else if (action === "validate") result = await validatePluginPackage(source);
    else if (action === "inspect") result = await inspectPluginPackage(source, options.signal);
    else if (action === "pack") {
      const destination = argumentsValue.positionals[3];
      if (destination === undefined) throw new Error("plugins pack requires a destination directory");
      result = await packPluginPackage(source, destination, options.signal);
    }
    else if (action === "smoke") result = await smokePluginPackage(source, options.signal);
    else if (action === "refresh") result = await refreshPluginPackage(source, options.signal);
    else if (action === "report" || action === "verify") {
      const report = action === "verify"
        ? await verifyPluginPackage(source, options.signal)
        : await reportPluginPackage(source, options.signal);
      result = report;
      if (report.status === "error") process.exitCode = 1;
    }
    else if (action === "index") result = await loadPluginGalleryIndex(source);
    else throw new Error(`Unknown plugin authoring action: ${action}`);
    output(result, flagBoolean(argumentsValue, "json"));
    return;
  }
  const workspace = flagString(argumentsValue, "workspace");
  const action = argumentsValue.positionals[0] ?? "list";
  const inspectRuntime = action === "doctor" || action === "show" || action === "commands";
  const runtime = await loadRuntime({
    ...optionalProperties(workspace === undefined ? undefined : { workspace }),
    ephemeral: true,
    ...optionalProperties(flagBoolean(argumentsValue, "offline") ? { offline: true } : undefined),
    ...pluginResourceOptions({
      noPlugins: flagBoolean(argumentsValue, "no-plugins"),
      noPluginCode: flagBoolean(argumentsValue, "no-plugin-code"),
    }),
    pluginPaths: flagStrings(argumentsValue, "plugin"),
    ...optionalProperties(options.pluginFactories === undefined ? undefined : { pluginFactories: options.pluginFactories }),
    ...optionalProperties(options.projectTrustResolver === undefined ? undefined : { projectTrustResolver: options.projectTrustResolver }),
    ...optionalProperties(inspectRuntime ? { pluginRuntime: true } : undefined),
  });
  try {
    const json = flagBoolean(argumentsValue, "json");
    if (action === "list") output(runtime.plugins.list(), json);
    else if (action === "doctor") {
      const report = runtime.plugins.doctor();
      const runtimeDiagnostics = runtime.runtimePlugins.diagnostics();
      output({
        ...report,
        healthy: report.healthy && runtimeDiagnostics.length === 0,
        runtimeDiagnostics,
      }, json);
    }
    else if (action === "commands") output({
      runtime: runtime.runtimePlugins.commands(),
      templates: runtime.plugins.bundle().commands.map(({ template: _template, ...metadata }) => metadata),
    }, json);
    else if (action === "prompts") output(runtime.plugins.bundle().prompts.map(({ template: _template, ...metadata }) => metadata), json);
    else if (action === "show") {
      const id = argumentsValue.positionals[1];
      if (id === undefined) throw new Error("plugins show requires ID");
      const extension = runtime.plugins.list().find((entry) => entry.id === id);
      if (extension === undefined) throw new Error(`Unknown plugin: ${id}`);
      output({
        extension,
        diagnostics: runtime.plugins.doctor().diagnostics.filter((entry) => entry.extensionId === id),
        runtimeDiagnostics: runtime.runtimePlugins.diagnostics().filter((entry) => entry.extensionId === id),
      }, json);
    } else throw new Error(`Unknown plugins action: ${action}`);
  } finally {
    await runtime.close();
  }
}
