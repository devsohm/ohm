import { constants as fsConstants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { basename, extname, resolve, sep } from "node:path";

import { Type } from "typebox";
import { Check } from "typebox/value";

export const MAX_PROFILE_BYTES = 32 * 1024;
export const MAX_PROFILE_ENTRIES = 128;

const NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;
const MODEL_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:@/+-]{0,255}$/u;
const TOOL_PATTERN = /^[a-zA-Z][a-zA-Z0-9_.:-]{0,127}$/u;
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const FRONTMATTER_KEYS = new Set(["name", "description", "model", "thinking", "tools"]);
const STRING_VALUE = Type.String();

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

function pathInside(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function plainScalar(value, label) {
  const selected = value.trim();
  if (selected === "") return "";
  if (selected.startsWith('"') || selected.startsWith("'")) {
    if (selected[0] !== '"' || selected.at(-1) !== '"') {
      throw new Error(`${label} must use JSON double quotes when quoted`);
    }
    let decoded;
    try {
      decoded = JSON.parse(selected);
    } catch {
      throw new Error(`${label} contains invalid quoted text`);
    }
    if (!Check(STRING_VALUE, decoded)) throw new Error(`${label} must be text`);
    return decoded;
  }
  return selected;
}

function boundedText(value, label, maximum, { required = true } = {}) {
  const selected = value.trim();
  if ((required && selected === "") || selected.includes("\0") || byteLength(selected) > maximum) {
    throw new Error(`${label} must be ${required ? "non-empty and " : ""}at most ${maximum} UTF-8 bytes without NUL`);
  }
  return selected;
}

function parseTools(value, label) {
  if (value.trim() === "") return [];
  const tools = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (tools.length > 32) throw new Error(`${label} may contain at most 32 tools`);
  const unique = new Set();
  for (const tool of tools) {
    if (!TOOL_PATTERN.test(tool)) throw new Error(`${label} contains invalid tool name ${JSON.stringify(tool)}`);
    if (unique.has(tool)) throw new Error(`${label} contains duplicate tool ${JSON.stringify(tool)}`);
    unique.add(tool);
  }
  return tools;
}

export function parseProfile(source, fileName, scope = "user") {
  if (!Check(STRING_VALUE, source) || source.includes("\0") || byteLength(source) > MAX_PROFILE_BYTES) {
    throw new Error(`${fileName} exceeds the ${MAX_PROFILE_BYTES}-byte profile limit or contains NUL`);
  }
  const normalized = source.replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) throw new Error(`${fileName} must begin with a frontmatter block`);
  const closing = normalized.indexOf("\n---\n", 4);
  if (closing < 0) throw new Error(`${fileName} has no closing frontmatter delimiter`);

  const metadata = new Map();
  for (const [index, line] of normalized.slice(4, closing).split("\n").entries()) {
    if (line.trim() === "") continue;
    const colon = line.indexOf(":");
    if (colon <= 0) throw new Error(`${fileName} frontmatter line ${index + 1} must be key: value`);
    const key = line.slice(0, colon).trim();
    if (!FRONTMATTER_KEYS.has(key)) throw new Error(`${fileName} contains unsupported frontmatter key ${JSON.stringify(key)}`);
    if (metadata.has(key)) throw new Error(`${fileName} repeats frontmatter key ${JSON.stringify(key)}`);
    metadata.set(key, plainScalar(line.slice(colon + 1), `${fileName} ${key}`));
  }

  const inferredName = basename(fileName, extname(fileName));
  const name = metadata.get("name") || inferredName;
  if (!NAME_PATTERN.test(name)) throw new Error(`${fileName} has an invalid profile name`);
  if (name !== inferredName) throw new Error(`${fileName} profile name must match its filename`);
  const description = boundedText(metadata.get("description") ?? "", `${fileName} description`, 512);
  const instructions = boundedText(normalized.slice(closing + 5), `${fileName} instructions`, 24 * 1024);
  const model = metadata.get("model");
  if (model !== undefined && model !== "" && !MODEL_PATTERN.test(model)) throw new Error(`${fileName} has an invalid model selector`);
  const thinking = metadata.get("thinking");
  if (thinking !== undefined && thinking !== "" && !THINKING_LEVELS.has(thinking)) {
    throw new Error(`${fileName} has an invalid thinking level`);
  }
  const tools = parseTools(metadata.get("tools") ?? "", `${fileName} tools`);

  const profile = {
    name,
    description,
    instructions,
    tools: Object.freeze(tools),
    scope,
  };
  if (model !== undefined && model !== "") profile.model = model;
  if (thinking !== undefined && thinking !== "") profile.thinking = thinking;
  return Object.freeze(profile);
}

async function readBoundedFile(path, root, label) {
  const file = await lstat(path);
  if (!file.isFile() || file.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  const canonical = await realpath(path);
  if (!pathInside(root, canonical)) throw new Error(`${label} escapes its profile directory`);

  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await open(canonical, flags);
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.size > MAX_PROFILE_BYTES) {
      throw new Error(`${label} exceeds the ${MAX_PROFILE_BYTES}-byte profile limit`);
    }
    const output = Buffer.allocUnsafe(MAX_PROFILE_BYTES + 1);
    let total = 0;
    while (total <= MAX_PROFILE_BYTES) {
      const { bytesRead } = await handle.read(output, total, output.byteLength - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > MAX_PROFILE_BYTES) throw new Error(`${label} grew beyond the ${MAX_PROFILE_BYTES}-byte profile limit`);
    return new TextDecoder("utf-8", { fatal: true }).decode(output.subarray(0, total));
  } finally {
    await handle.close();
  }
}

async function profilesFromRoot(rootValue, scope) {
  if (rootValue === undefined) return [];
  const root = resolve(rootValue);
  let rootStat;
  try {
    rootStat = await lstat(root);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`${scope} profile root must be a regular directory`);
  }
  const canonicalRoot = await realpath(root);
  if (canonicalRoot !== root) throw new Error(`${scope} profile root must be canonical`);

  const candidates = [];
  const directory = await opendir(canonicalRoot);
  let entries = 0;
  try {
    for await (const entry of directory) {
      entries += 1;
      if (entries > MAX_PROFILE_ENTRIES) throw new Error(`${scope} profile root has more than ${MAX_PROFILE_ENTRIES} entries`);
      if (!entry.name.endsWith(".md")) continue;
      if (!NAME_PATTERN.test(basename(entry.name, ".md"))) throw new Error(`${scope} profile filename ${JSON.stringify(entry.name)} is invalid`);
      candidates.push(entry.name);
    }
  } finally {
    await directory.close().catch(() => undefined);
  }

  candidates.sort((left, right) => left.localeCompare(right));
  const profiles = [];
  const names = new Set();
  for (const fileName of candidates) {
    const source = await readBoundedFile(resolve(canonicalRoot, fileName), canonicalRoot, `${scope} profile ${fileName}`);
    const profile = parseProfile(source, fileName, scope);
    if (names.has(profile.name)) throw new Error(`${scope} profile name ${profile.name} is duplicated`);
    names.add(profile.name);
    profiles.push(profile);
  }
  return profiles;
}

export async function discoverProfiles({ builtinRoot, userRoot, workspaceRoot, projectTrusted }) {
  const selected = new Map();
  for (const profile of await profilesFromRoot(builtinRoot, "builtin")) selected.set(profile.name, profile);
  for (const profile of await profilesFromRoot(userRoot, "user")) selected.set(profile.name, profile);
  if (projectTrusted === true) {
    for (const profile of await profilesFromRoot(workspaceRoot, "workspace")) selected.set(profile.name, profile);
  }
  return [...selected.values()].sort((left, right) => left.name.localeCompare(right.name));
}
