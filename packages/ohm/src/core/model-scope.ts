import { optionalProperties } from "./optional-properties.js";
import { hasControlCharacters } from "./value-schemas.js";

import type { ThinkingLevel } from "./settings-manager.js";

export const MAX_MODEL_SCOPE_SELECTORS = 1_024;
export const MAX_MODEL_SCOPE_PROVIDER_BYTES = 128;
export const MAX_MODEL_SCOPE_MODEL_BYTES = 512;

export interface ModelIdentity {
  readonly provider: string;
  readonly id: string;
}

export interface ScopedModel<Model extends ModelIdentity> {
  readonly model: Model;
  readonly thinkingLevel?: ThinkingLevel;
}

export function exactModelSelector(provider: string, modelId: string): string {
  return `${provider}/${modelId}`;
}

/** Exact selectors are `provider/model`; model IDs may contain further slashes. */
export function isExactModelSelector(value: string): boolean {
  if (
    value === ""
    || value !== value.trim()
    || hasControlCharacters(value)
    || /\s|[*?[\]{}]/u.test(value)
  ) return false;
  const separator = value.indexOf("/");
  if (separator <= 0 || separator >= value.length - 1) return false;
  return Buffer.byteLength(value.slice(0, separator), "utf8") <= MAX_MODEL_SCOPE_PROVIDER_BYTES
    && Buffer.byteLength(value.slice(separator + 1), "utf8") <= MAX_MODEL_SCOPE_MODEL_BYTES;
}

export function normalizeModelScopeSelectors(selectors: readonly string[]): string[] {
  if (selectors.length > MAX_MODEL_SCOPE_SELECTORS) {
    throw new RangeError(`Model scope cannot contain more than ${MAX_MODEL_SCOPE_SELECTORS} selectors`);
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const selector of selectors) {
    if (!isExactModelSelector(selector)) {
      throw new TypeError(`Model scope selector "${selector}" must be an exact provider/model reference`);
    }
    if (seen.has(selector)) continue;
    seen.add(selector);
    normalized.push(selector);
  }
  return normalized;
}

export function modelIsInScope(
  selectors: readonly string[],
  provider: string,
  modelId: string,
): boolean {
  return selectors.length === 0 || selectors.includes(exactModelSelector(provider, modelId));
}

export function resolveScopedModels<Model extends ModelIdentity>(
  selectors: readonly string[],
  models: readonly Model[],
  thinkingLevels: Readonly<Record<string, ThinkingLevel>>,
): Array<ScopedModel<Model>> {
  let selectedModels: readonly Model[] = models;
  if (selectors.length > 0) {
    const modelsBySelector = new Map(
      models.map((model) => [exactModelSelector(model.provider, model.id), model]),
    );
    selectedModels = selectors.flatMap((selector) => {
      const model = modelsBySelector.get(selector);
      return model === undefined ? [] : [model];
    });
  }
  return selectedModels
    .map((model) => {
      const thinkingLevel = thinkingLevels[exactModelSelector(model.provider, model.id)];
      return {
        model,
        ...optionalProperties(thinkingLevel === undefined ? undefined : { thinkingLevel }),
      };
    });
}
