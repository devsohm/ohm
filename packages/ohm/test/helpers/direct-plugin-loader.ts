import {
  appendDirectPlugins,
  loadDirectPlugins,
  type RuntimeDirectPathMetadata,
  type RuntimePluginHost,
  type RuntimePluginLoadOptions,
} from "../../src/plugins/runtime.js";
import type { PluginRuntimeEntry } from "../../src/plugins/types.js";

function metadata(entries: readonly PluginRuntimeEntry[]): ReadonlyMap<string, RuntimeDirectPathMetadata> {
  return new Map(entries.map((entry) => {
    const value: RuntimeDirectPathMetadata = {
      scope: entry.scope === "invocation" || entry.scope === "builtin" || entry.scope === undefined
        ? "temporary"
        : entry.scope,
      trusted: entry.trusted ?? true,
      extensionId: entry.extensionId,
      expectedSha256: entry.sha256,
    };
    if (entry.resourceRoot !== undefined) value.resourceRoot = entry.resourceRoot;
    if (entry.packageVersion !== undefined) value.packageVersion = entry.packageVersion;
    if (entry.packageContentSha256 !== undefined) value.packageContentSha256 = entry.packageContentSha256;
    if (entry.manifestSha256 !== undefined) value.manifestSha256 = entry.manifestSha256;
    return [entry.sourcePath, value] as const;
  }));
}

/** Exercises the path-first direct loader while retaining explicit fixture provenance. */
export async function loadTestDirectExtensions(
  entries: readonly PluginRuntimeEntry[],
  options: RuntimePluginLoadOptions,
): Promise<RuntimePluginHost> {
  const { directPathMetadata: _directPathMetadata, ...loadOptions } = options;
  return await loadDirectPlugins(entries.map((entry) => entry.sourcePath), {
    ...loadOptions,
    directPathMetadata: metadata(entries),
  });
}

/** Appends fixtures through the same path-first direct loader used by refresh. */
export async function appendTestDirectExtensions(
  host: RuntimePluginHost,
  entries: readonly PluginRuntimeEntry[],
  options: RuntimePluginLoadOptions,
): Promise<void> {
  const { directPathMetadata: _directPathMetadata, ...loadOptions } = options;
  await appendDirectPlugins(host, entries.map((entry) => entry.sourcePath), {
    ...loadOptions,
    directPathMetadata: metadata(entries),
  });
}
