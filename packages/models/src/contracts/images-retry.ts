export interface RetryPolicy {
  enabled: boolean;
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs?: number;
}

export interface RetryCallbacks {
  onRetryScheduled?(
    attempt: number,
    maxAttempts: number,
    delayMs: number,
    errorMessage: string,
  ): void | Promise<void>;
  onRetryAttemptStart?(attempt: number): void | Promise<void>;
  onRetryFinished?(success: boolean, attempt: number): void | Promise<void>;
}

export interface ImageModel {
  id: string;
  name: string;
  provider: string;
  baseUrl: string;
  sizes?: readonly string[];
  qualities?: readonly string[];
  formats?: readonly string[];
}

export interface ImageRequest {
  prompt: string;
  count?: number;
  size?: string;
  quality?: string;
  format?: string;
  background?: "transparent" | "opaque" | "auto";
  signal?: AbortSignal;
}

export interface GeneratedImage {
  data?: string;
  url?: string;
  mimeType?: string;
  revisedPrompt?: string;
}

export interface ImageResult {
  images: GeneratedImage[];
  model: string;
  provider: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}

export interface ImageProvider {
  id: string;
  name: string;
  models: readonly ImageModel[];
  auth?: ProviderAuth;
  refreshModels?(context: ImageModelsRefreshContext): Promise<readonly ImageModel[]>;
  generate(model: ImageModel, request: ImageRequest, options?: ImageGenerationOptions): Promise<ImageResult>;
}

export interface ImageGenerationOptions {
  apiKey?: string;
  headers?: ProviderHeaders;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

export interface ImageModelsRefreshContext {
  auth?: AuthResult;
  ctx: AuthContext;
  allowNetwork: boolean;
  force?: boolean;
  signal?: AbortSignal;
}
import type { AuthContext, AuthResult, ProviderAuth } from "./credentials-auth-providers-catalog.js";
import type { ProviderHeaders } from "./models-sampling-streaming.js";
