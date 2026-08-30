import { optionalProperties } from "./optional-properties.js";
export type SourceScope = "user" | "project" | "temporary";
export type SourceOrigin = "top-level" | "package";

export interface SourceInfo {
  path: string;
  source: string;
  scope: SourceScope;
  origin: SourceOrigin;
  baseDir?: string;
}

export function createSyntheticSourceInfo(
  path: string,
  values: Partial<Omit<SourceInfo, "path">> = {},
): SourceInfo {
  return {
    path,
    source: values.source ?? path,
    scope: values.scope ?? "temporary",
    origin: values.origin ?? "top-level",
    ...optionalProperties(values.baseDir === undefined ? undefined : { baseDir: values.baseDir }),
  };
}
