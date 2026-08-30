import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { resolveExecutable } from "../process/runner.js";
import { STRING_VALUE } from "../core/value-schemas.js";
import { Check } from "typebox/value";

interface RipgrepModule {
  rgPath?: unknown;
}

type RipgrepModuleLoader = () => Promise<RipgrepModule>;

const loadBundledRipgrep: RipgrepModuleLoader = async () => await import("@vscode/ripgrep");

async function bundledPath(loader: RipgrepModuleLoader): Promise<string | undefined> {
  try {
    const candidate = (await loader()).rgPath;
    if (!Check(STRING_VALUE, candidate) || !isAbsolute(candidate)) return undefined;
    await access(candidate, constants.X_OK);
    const resolved = await realpath(candidate);
    if (!(await stat(resolved)).isFile()) return undefined;
    return resolved;
  } catch {
    return undefined;
  }
}

export async function resolveRipgrep(
  options: { excludedRoot?: string; environment?: NodeJS.ProcessEnv } = {},
  loader: RipgrepModuleLoader = loadBundledRipgrep,
): Promise<string | undefined> {
  return await bundledPath(loader) ?? await resolveExecutable(
    process.platform === "win32" ? "rg.exe" : "rg",
    options,
  );
}
