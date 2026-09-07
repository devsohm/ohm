import { optionalProperties } from "../core/optional-properties.js";
import {
  existsSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import { CONFIG_DIR_NAME, getAgentDir } from "../config/paths.js";
import type { EventBus } from "../core/event-bus.js";
import { errorMessage } from "../core/errors.js";
import { resolvePackagePluginEntries } from "../core/package-manager.js";
import { isPluginSourcePath, PLUGIN_ENTRY_NAMES } from "../core/plugin-source.js";
import { createSyntheticSourceInfo } from "../core/source-info.js";
import type { SourceInfo } from "../core/source-info.js";
import { normalizePath, resolvePath } from "../utils/paths.js";
import type { Plugin, LoadPluginsResult } from "./direct.js";
import {
  attachPluginProjection,
  attachPluginRuntimeHost,
  createPluginRuntime,
} from "./compat-runtime.js";
import {
  appendDirectPlugins,
  loadDirectPlugins,
  RuntimePluginHost,
  type RuntimeDirectPathMetadata,
} from "./runtime.js";

export {
  attachPluginProjection,
  attachPluginRuntimeHost,
  createPluginRuntime,
  ensurePluginRuntimeHost,
  PluginRunner,
  getPluginRuntimeHost,
  type PluginErrorListener,
} from "./compat-runtime.js";

interface DiscoveredPlugin {
  path: string;
  metadata: RuntimeDirectPathMetadata;
}

export interface LoadedPluginProjectionMetadata {
  /** Original path presented by the loader; defaults to the canonical source path. */
  path?: string;
  /** Original provenance when a resource loader already resolved it. */
  sourceInfo?: SourceInfo;
}

function resolvePluginEntries(directory: string, errors: LoadPluginsResult["errors"]): string[] | null {
  if (["package.json", "plugin.json", "extension.json"].some((name) => existsSync(join(directory, name)))) {
    try {
      const entries = resolvePackagePluginEntries(directory);
      if (entries !== undefined) return entries;
    } catch (cause) {
      errors.push({ path: directory, error: loadError(cause) });
      return [];
    }
  }

  for (const name of PLUGIN_ENTRY_NAMES) {
    const path = join(directory, name);
    if (existsSync(path) && statSync(path).isFile()) return [path];
  }
  return null;
}

function discoverPluginsInDirectory(directory: string, errors: LoadPluginsResult["errors"]): string[] {
  if (!existsSync(directory)) return [];
  const discovered: string[] = [];
  try {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const entryPath = join(directory, entry.name);
      const sourceFile = entry.isFile() || entry.isSymbolicLink();
      if (sourceFile && isPluginSourcePath(entry.name)) {
        discovered.push(entryPath);
      } else if (entry.isDirectory() || entry.isSymbolicLink()) {
        const entries = resolvePluginEntries(entryPath, errors);
        if (entries !== null) discovered.push(...entries);
      }
    }
  } catch {
    return [];
  }
  return discovered;
}

function loadError(cause: unknown): string {
  return `Failed to load plugin: ${errorMessage(cause)}`;
}

function projectPlugin(
  captured: Plugin,
  selected: DiscoveredPlugin,
  resolvedPath: string,
): Plugin {
  const sourceInfo = createSyntheticSourceInfo(selected.path, {
    source: "local",
    scope: selected.metadata.scope,
    origin: "top-level",
    baseDir: dirname(resolvedPath),
  });
  for (const tool of captured.tools.values()) tool.sourceInfo = sourceInfo;
  for (const command of captured.commands.values()) command.sourceInfo = sourceInfo;
  return {
    ...captured,
    path: selected.path,
    resolvedPath,
    sourceInfo,
    tools: captured.tools,
    commands: captured.commands,
  };
}

/** Projects an already-active native host without evaluating any factory again. */
export function projectLoadedPluginHost(
  host: RuntimePluginHost,
  metadata: ReadonlyMap<string, LoadedPluginProjectionMetadata> = new Map(),
): LoadPluginsResult {
  const runtime = createPluginRuntime();
  attachPluginRuntimeHost(runtime, host);
  const plugins = host.plugins().map((entry) => {
    const captured = host.compatibilityProjection(entry.sourcePath);
    if (captured === undefined) {
      throw new Error(`Loaded plugin has no public projection: ${entry.sourcePath}`);
    }
    const selected = metadata.get(entry.sourcePath);
    const path = selected?.path ?? entry.sourcePath;
    const sourceInfo = selected?.sourceInfo ?? createSyntheticSourceInfo(path, {
      source: "local",
      scope: entry.scope === "user" ? "user" : entry.scope === "project" ? "project" : "temporary",
      origin: "top-level",
      baseDir: entry.resourceRoot ?? dirname(entry.sourcePath),
    });
    for (const tool of captured.tools.values()) tool.sourceInfo = sourceInfo;
    for (const command of captured.commands.values()) command.sourceInfo = sourceInfo;
    const projection: Plugin = {
      ...captured,
      path,
      resolvedPath: entry.sourcePath,
      sourceInfo,
      tools: captured.tools,
      commands: captured.commands,
    };
    attachPluginProjection(projection, runtime);
    return projection;
  });
  runtime.flagValues = host.flagValues();
  return { plugins, errors: [], runtime };
}

/**
 * Low-level pre-approved compatibility loader for direct plugin factories.
 *
 * Discovers project, user, then explicitly configured factories and loads them
 * sequentially. The caller must already have approved project-local executable
 * code. This function does not prompt for or establish trust. Application entry
 * points must use the trust-aware resource loader instead of calling it before
 * a trust decision.
 */
export async function discoverAndLoadPlugins(
  requestedPaths: string[],
  workspace: string,
  userDataDir: string = getAgentDir(),
  events?: EventBus,
): Promise<LoadPluginsResult> {
  const roots = Object.freeze({
    workspace: resolvePath(workspace),
    agent: resolvePath(userDataDir),
  });
  const discovered: DiscoveredPlugin[] = [];
  const errors: LoadPluginsResult["errors"] = [];
  const seen = new Set<string>();

  const addPaths = (
    paths: readonly string[],
    metadata: RuntimeDirectPathMetadata,
  ): void => {
    for (const path of paths) {
      const canonical = resolve(path);
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      discovered.push({
        path,
        metadata: {
          ...metadata,
          resourceRoot: metadata.resourceRoot ?? dirname(canonical),
        },
      });
    }
  };

  for (const [root, scope] of [[join(roots.workspace, CONFIG_DIR_NAME), "project"], [roots.agent, "user"]] as const) {
    for (const directory of ["plugins", "extensions"]) {
      addPaths(discoverPluginsInDirectory(join(root, directory), errors), { scope, trusted: true });
    }
  }

  for (const configuredPath of requestedPaths) {
    const selected = resolvePath(normalizePath(configuredPath, { normalizeUnicodeSpaces: true }), roots.workspace);
    if (existsSync(selected) && statSync(selected).isDirectory()) {
      const entries = resolvePluginEntries(selected, errors);
      if (entries !== null) {
        addPaths(entries, { scope: "temporary", trusted: true, resourceRoot: selected });
        continue;
      }
      addPaths(discoverPluginsInDirectory(selected, errors), {
        scope: "temporary",
        trusted: true,
        resourceRoot: selected,
      });
      continue;
    }
    addPaths([selected], { scope: "temporary", trusted: true });
  }

  const host = await loadDirectPlugins([], {
    workspace: roots.workspace,
    activationFailure: "throw",
    ...optionalProperties(events === undefined ? undefined : { eventBus: events }),
  });
  const runtime = createPluginRuntime();
  attachPluginRuntimeHost(runtime, host);
  const plugins: Plugin[] = [];

  for (const selected of discovered) {
    try {
      const sourcePath = realpathSync(selected.path);
      if (host.plugins().some((entry) => entry.sourcePath === sourcePath)) continue;
      const metadata = new Map<string, RuntimeDirectPathMetadata>([[selected.path, selected.metadata]]);
      const before = host.plugins().length;
      await appendDirectPlugins(host, [selected.path], {
        workspace: roots.workspace,
        activationFailure: "throw",
        directPathMetadata: metadata,
        ...optionalProperties(events === undefined ? undefined : { eventBus: events }),
      });
      const entry = host.plugins()[before];
      if (entry === undefined) throw new Error("Plugin activation produced no runtime generation");
      const captured = host.compatibilityProjection(entry.sourcePath);
      if (captured === undefined) throw new Error("Plugin activation produced no public projection");
      const projection = projectPlugin(captured, selected, entry.sourcePath);
      attachPluginProjection(projection, runtime);
      plugins.push(projection);
    } catch (cause) {
      errors.push({ path: selected.path, error: loadError(cause) });
    }
  }

  runtime.flagValues = host.flagValues();
  return { plugins, errors, runtime };
}
