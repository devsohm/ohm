import { parse as parseYaml } from "yaml";

import { isJsonObject, type JsonObject } from "./json.js";

export interface ParsedFrontmatter {
  frontmatter: JsonObject;
  body: string;
}

export function parseFrontmatter(input: string): ParsedFrontmatter {
  const normalized = input.replace(/\r\n?|\u2028|\u2029/gu, "\n");
  if (!normalized.startsWith("---\n")) return { frontmatter: {}, body: normalized };
  const end = normalized.indexOf("\n---", 4);
  if (end < 0 || (normalized[end + 4] !== undefined && normalized[end + 4] !== "\n")) {
    return { frontmatter: {}, body: normalized };
  }
  const decoded = parseYaml(normalized.slice(4, end));
  const frontmatter = decoded ?? {};
  if (!isJsonObject(frontmatter)) {
    throw new TypeError("Frontmatter must be a YAML mapping");
  }
  return {
    frontmatter,
    body: normalized.slice(end + 4).trim(),
  };
}

export function stripFrontmatter(input: string): string {
  return parseFrontmatter(input).body;
}
