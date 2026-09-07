import { extname } from "node:path";

const PLUGIN_SOURCE_SUFFIXES = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".mts", ".cts"]);

export const PLUGIN_ENTRY_NAMES = ["index.ts", "index.tsx", "index.js", "index.mjs", "index.cjs", "index.mts", "index.cts"] as const;

export function isPluginSourcePath(path: string): boolean {
  return PLUGIN_SOURCE_SUFFIXES.has(extname(path).toLowerCase());
}
