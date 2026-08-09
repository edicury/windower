import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { ModelConfig } from "@windower/core";
import type { LanguageModel } from "ai";
import { OPERATOR_ERROR_CODES, OperatorError } from "./errors.js";

/**
 * Provider registry (contracts/operator.md §Model configuration).
 *
 * `--model <provider>:<model>` is parsed by `parseModelConfig` in
 * `@windower/core`; this file is the only place that knows what a provider id
 * means. Adding a provider is one registry entry — the observe → decide → act
 * loop never learns a provider's name, so a model swap is genuinely zero code
 * change in the loop.
 *
 * API keys come from the process environment only. They are never accepted as
 * a CLI flag (shell history / process listing exposure), never persisted, and
 * never logged.
 */

export interface ProviderEntry {
  /** Default env var holding the API key; `undefined` when none is required. */
  defaultApiKeyEnvVar?: string;
  /** True when a run with no API key present is still valid (local servers). */
  apiKeyOptional?: boolean;
  /** Some providers (openai-compatible) cannot work without an explicit base URL. */
  baseUrlRequired?: boolean;
  create(params: { modelId: string; apiKey?: string; baseUrl?: string }): LanguageModel;
}

export const PROVIDER_REGISTRY: Record<string, ProviderEntry> = {
  anthropic: {
    defaultApiKeyEnvVar: "ANTHROPIC_API_KEY",
    create: ({ modelId, apiKey, baseUrl }) =>
      createAnthropic({ apiKey, baseURL: baseUrl })(modelId),
  },
  openai: {
    defaultApiKeyEnvVar: "OPENAI_API_KEY",
    create: ({ modelId, apiKey, baseUrl }) => createOpenAI({ apiKey, baseURL: baseUrl })(modelId),
  },
  "openai-compatible": {
    defaultApiKeyEnvVar: "OPENAI_COMPATIBLE_API_KEY",
    apiKeyOptional: true,
    baseUrlRequired: true,
    create: ({ modelId, apiKey, baseUrl }) =>
      createOpenAICompatible({
        name: "openai-compatible",
        baseURL: baseUrl ?? "",
        apiKey,
      })(modelId),
  },
};

export function knownProviders(): string[] {
  return Object.keys(PROVIDER_REGISTRY).sort();
}

/**
 * Resolves a `ModelConfig` into an AI SDK `LanguageModel`.
 *
 * `env` is injectable so tests never touch `process.env`; production callers
 * pass nothing and get the daemon's environment.
 */
export function resolveModel(
  config: ModelConfig,
  env: NodeJS.ProcessEnv = process.env,
): LanguageModel {
  const entry = PROVIDER_REGISTRY[config.provider];
  if (entry === undefined) {
    throw new OperatorError(
      OPERATOR_ERROR_CODES.UNKNOWN_PROVIDER,
      `Unknown model provider "${config.provider}". Known providers: ${knownProviders().join(", ")}.`,
    );
  }

  const envVar = config.apiKeyEnvVar ?? entry.defaultApiKeyEnvVar;
  const apiKey = envVar === undefined ? undefined : env[envVar];
  if (apiKey === undefined && entry.apiKeyOptional !== true) {
    throw new OperatorError(
      OPERATOR_ERROR_CODES.MISSING_API_KEY,
      `Missing API key for provider "${config.provider}": set ${envVar} in the daemon's environment. API keys are never accepted as a command-line flag.`,
    );
  }

  if (entry.baseUrlRequired === true && (config.baseUrl === undefined || config.baseUrl === "")) {
    throw new OperatorError(
      OPERATOR_ERROR_CODES.UNKNOWN_PROVIDER,
      `Provider "${config.provider}" requires --base-url pointing at the model server.`,
    );
  }

  return entry.create({ modelId: config.model, apiKey, baseUrl: config.baseUrl });
}
