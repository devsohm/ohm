import anthropicData from "./providers/data/anthropic.json" with { type: "json" };
import deepseekData from "./providers/data/deepseek.json" with { type: "json" };
import githubCopilotData from "./providers/data/github-copilot.json" with { type: "json" };
import googleData from "./providers/data/google.json" with { type: "json" };
import kimiCodeData from "./providers/data/kimi-code.json" with { type: "json" };
import ollamaData from "./providers/data/ollama.json" with { type: "json" };
import openaiCodexData from "./providers/data/openai-codex.json" with { type: "json" };
import openaiData from "./providers/data/openai.json" with { type: "json" };
import opencodeData from "./providers/data/opencode.json" with { type: "json" };
import opencodeGoData from "./providers/data/opencode-go.json" with { type: "json" };
import openrouterData from "./providers/data/openrouter.json" with { type: "json" };
import xaiData from "./providers/data/xai.json" with { type: "json" };
import type { Model } from "./contracts.js";

type CatalogSourceModel = Omit<Model, "input"> & { input: string[] };

interface CatalogSource {
  [id: string]: CatalogSourceModel;
}

function catalogInput(value: string): "text" | "image" {
  if (value === "text" || value === "image") return value;
  throw new TypeError(`Unsupported catalog input: ${value}`);
}

function rows(value: CatalogSource): readonly Model[] {
  return Object.freeze(Object.values(value).map((source) => {
    const model: Model = {
      ...structuredClone(source),
      input: source.input.map(catalogInput),
    };
    return Object.freeze(model);
  }));
}

export const anthropicModels = rows(anthropicData);
export const deepseekModels = rows(deepseekData);
export const githubCopilotModels = rows(githubCopilotData);
export const googleModels = rows(googleData);
export const kimiCodeModels = rows(kimiCodeData);
export const ollamaModels = rows(ollamaData);
export const openaiModels = rows(openaiData);
export const opencodeModels = rows(opencodeData);
export const openrouterModels = rows(openrouterData);
export const xaiModels = rows(xaiData);

export const openaiCodexModels: readonly Model[] = rows(openaiCodexData);
export const opencodeGoModels: readonly Model[] = rows(opencodeGoData);

export const models: readonly Model[] = Object.freeze([
  ...anthropicModels,
  ...deepseekModels,
  ...githubCopilotModels,
  ...googleModels,
  ...kimiCodeModels,
  ...ollamaModels,
  ...openaiCodexModels,
  ...openaiModels,
  ...opencodeModels,
  ...opencodeGoModels,
  ...openrouterModels,
  ...xaiModels,
]);

export function getModel(provider: string, id: string): Model | undefined {
  return models.find((model) => model.provider === provider && model.id === id);
}

export function getModels(provider?: string): readonly Model[] {
  return provider === undefined ? models : models.filter((model) => model.provider === provider);
}

export const modelProviders = Object.freeze([...new Set(models.map((model) => model.provider))]);
