import type {
  GeneratedImage,
  ImageModel,
  ImageProvider,
  ImageRequest,
  ImageResult,
  JsonObject,
  JsonValue,
  StreamOptions,
} from "./contracts.js";
import { fetchJson, type HttpStreamRequest } from "./http-engine.js";
import { createImageModels } from "./image-models.js";

const providers = createImageModels();

export function registerImageProvider(provider: ImageProvider): void {
  providers.setProvider(provider);
}

export function unregisterImageProvider(providerId: string): boolean {
  return providers.deleteProvider(providerId);
}

export function getImageProviders(): readonly ImageProvider[] {
  return providers.getProviders();
}

export function getImageModels(providerId?: string): readonly ImageModel[] {
  return providers.getModels(providerId);
}

export async function generateImage(model: ImageModel, request: ImageRequest): Promise<ImageResult> {
  return providers.generateImage(model, request);
}

export const openrouterImageModels: readonly ImageModel[] = Object.freeze([
  {
    id: "google/gemini-2.5-flash-image",
    name: "Gemini 2.5 Flash Image",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
  },
  {
    id: "openai/gpt-image-1",
    name: "GPT Image 1",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
  },
]);

export interface OpenRouterImageProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  models?: readonly ImageModel[];
  headers?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
}

export function openrouterImagesProvider(options: OpenRouterImageProviderOptions = {}): ImageProvider {
  const models = (options.models ?? openrouterImageModels).map((model) => ({
    ...model,
    provider: "openrouter",
    baseUrl: options.baseUrl ?? model.baseUrl,
  }));
  return {
    id: "openrouter",
    name: "OpenRouter",
    models,
    auth: { apiKey: {
      name: "OpenRouter API key",
      async resolve({ ctx, credential }) {
        const apiKey = credential?.key ?? options.apiKey ?? await ctx.env("OPENROUTER_API_KEY");
        return apiKey === undefined ? undefined : { auth: { apiKey } };
      },
    } },
    async generate(model, request, invocation) {
      const key = invocation?.apiKey ?? options.apiKey
        ?? (invocation === undefined ? globalThis.process?.env.OPENROUTER_API_KEY : undefined);
      if (!key) throw new Error("OpenRouter image generation requires an API key");
      if (!request.prompt.trim()) throw new TypeError("Image prompt must not be empty");
      const count = request.count ?? 1;
      if (!Number.isSafeInteger(count) || count < 1 || count > 10) throw new RangeError("Image count must be between 1 and 10");
      const body: JsonObject = {
        model: model.id,
        messages: [{ role: "user", content: request.prompt }],
        modalities: ["image", "text"],
      };
      if (request.size !== undefined) body.image_config = { aspect_ratio: aspectRatio(request.size) };
      const streamOptions: StreamOptions = {};
      if (request.signal !== undefined) streamOptions.signal = request.signal;
      const fetch = invocation?.fetch ?? options.fetch;
      if (fetch !== undefined) streamOptions.fetch = fetch;
      const httpRequest: HttpStreamRequest = {
        url: `${(invocation?.baseUrl ?? model.baseUrl).replace(/\/+$/u, "")}/chat/completions`,
        body,
        authorization: { value: key },
        options: streamOptions,
      };
      if (options.headers !== undefined) httpRequest.defaultHeaders = options.headers;
      if (invocation?.headers !== undefined) httpRequest.headers = invocation.headers;
      const value = await fetchJson(httpRequest);
      const images = parseOpenRouterImages(value).slice(0, count);
      if (images.length === 0) throw new Error("OpenRouter response did not contain an image");
      return { images, model: model.id, provider: "openrouter" };
    },
  };
}

function aspectRatio(size: string): string {
  const match = /^(\d+)x(\d+)$/u.exec(size);
  if (!match) return size;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new TypeError("Invalid image size");
  const divisor = gcd(width, height);
  return `${width / divisor}:${height / divisor}`;
}

function gcd(left: number, right: number): number {
  while (right) [left, right] = [right, left % right];
  return left;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && value !== undefined && value.constructor === Object;
}

function jsonString(value: JsonValue | undefined): string | undefined {
  return value !== undefined && value !== null && value.constructor === String ? String(value) : undefined;
}

function parseOpenRouterImages(value: JsonValue): GeneratedImage[] {
  if (!isJsonObject(value)) return [];
  const choices = value.choices;
  if (!Array.isArray(choices)) return [];
  const output: GeneratedImage[] = [];
  for (const choice of choices) {
    if (!isJsonObject(choice)) continue;
    const message = choice.message;
    if (!isJsonObject(message)) continue;
    const images = message.images;
    if (!Array.isArray(images)) continue;
    for (const image of images) {
      if (!isJsonObject(image)) continue;
      const imageUrl = image.image_url;
      const stringUrl = jsonString(imageUrl) ?? (isJsonObject(imageUrl) ? jsonString(imageUrl.url) : undefined);
      if (stringUrl === undefined) continue;
      const data = /^data:([^;]+);base64,(.*)$/su.exec(stringUrl);
      output.push(data ? { mimeType: data[1]!, data: data[2]! } : { url: stringUrl });
    }
  }
  return output;
}

export function registerBuiltinImageProviders(options: OpenRouterImageProviderOptions = {}): void {
  registerImageProvider(openrouterImagesProvider(options));
}
