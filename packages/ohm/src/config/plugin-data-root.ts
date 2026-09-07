import { lstatSync } from "node:fs";
import { resolve } from "node:path";

import { errorCode } from "../core/errors.js";
import { assertCanonicalDirectoryCreationPathSync } from "./canonical-path.js";

/** Selects existing product plugin state without moving or merging user files. */
export function resolvePluginDataRoot(agentDirectory: string): string {
  const preferred = resolve(agentDirectory, "extension-data");
  const roots = [preferred, resolve(agentDirectory, "state", "extension-data")];
  const existing = roots.filter((path) => {
    assertCanonicalDirectoryCreationPathSync(path);
    try {
      lstatSync(path);
      return true;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return false;
      throw error;
    }
  });
  if (existing.length > 1) {
    throw new Error(
      `Plugin data exists in both ${roots[0]} and ${roots[1]}. `
      + "Close Ohm and back up both directories, then explicitly reconcile them into one location before restarting. "
      + "No plugin data was moved or merged.",
    );
  }
  return existing[0] ?? preferred;
}
