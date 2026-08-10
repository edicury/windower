import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { JSONValue } from "@ai-sdk/provider";
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

/**
 * Prompt caching (Phase 22, contracts/operator.md §"Prompt caching is a pure
 * optimization"). The run-stable prefix — the system prompt built once in
 * `prompt.ts` and byte-identical every turn — is the one thing worth marking
 * cacheable: it is genuinely stable for the whole run, unlike `messages`,
 * which grows every step.
 *
 * Returns `undefined` for a provider with no known cache-control mechanism —
 * `run.ts` must skip attaching `providerOptions` entirely in that case, so a
 * provider that ignores an unrecognized option isn't relied upon; the
 * feature is opt-in per provider, not opt-out per provider.
 *
 * Scope, deliberately narrower than "system prompt AND tool-schema prefix":
 * this package builds `ToolSet` entries as plain `{ description, inputSchema
 * }` records (`tools.ts`) with no per-tool `providerOptions` hook in the
 * installed AI SDK version (7.0.58) short of restructuring `buildToolSet`
 * around `tool()` wrappers. The system prompt is the larger and more clearly
 * stable of the two (~1.5 KB vs ~2.6 KB of schemas that Anthropic's API
 * already caches as a unit once *any* prior block in the request carries a
 * cache breakpoint), so it is what's wired up now; extending the same
 * mechanism to tool schemas is a follow-up, not a correctness gap — caching
 * is additive and non-load-bearing either way (settled decision 4).
 */
/**
 * Structurally identical to the AI SDK's own `ProviderOptions` (a per-provider
 * bag of provider-specific settings), typed locally rather than imported: the
 * `ai` package re-exports the *name* `ProviderOptions` from
 * `@ai-sdk/provider-utils` in its public API surface, but that package isn't
 * a direct dependency here, and `generateText`'s `providerOptions`/`instructions`
 * params accept this shape structurally regardless of which module declared it.
 */
export type OperatorProviderOptions = Record<string, Record<string, JSONValue>>;

export function promptCacheProviderOptions(provider: string): OperatorProviderOptions | undefined {
  if (provider === "anthropic") {
    return { anthropic: { cacheControl: { type: "ephemeral" } } };
  }
  return undefined;
}
