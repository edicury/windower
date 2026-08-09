/**
 * Builds `run_operator`'s scoped `hello` env snapshot (Phase 20,
 * `phase-20-daemon-optional.md` "Scoped env snapshot over the socket") from
 * this MCP server process's own `process.env` — never `process.env`
 * wholesale, and never the daemon's own environment.
 *
 * `DEFAULT_API_KEY_ENV_VARS` mirrors `packages/operator/src/providers.ts`'s
 * `PROVIDER_REGISTRY` (`defaultApiKeyEnvVar` per provider). Duplicated here
 * rather than imported from `@windower/operator` on purpose:
 * `OperatorRunEngine` (`@windower/engine`) already dynamic-imports
 * `@windower/operator` through a non-literal specifier specifically so
 * hosts that never run an operator don't eagerly load its AI SDK provider
 * packages; a static top-level `import` here would defeat that for every
 * MCP server process regardless of whether `run_operator` is ever called.
 * Keep this map in sync with `providers.ts`'s registry if a provider is
 * added there.
 */
import type { DaemonHelloEnv, ModelConfig, ResolvedSecret, SecretRef } from "@windower/core";

const DEFAULT_API_KEY_ENV_VARS: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  "openai-compatible": "OPENAI_COMPATIBLE_API_KEY",
};

/**
 * Resolves which env var this call's model reads its API key from —
 * `model.apiKeyEnvVar` if the caller set one, else the provider's default.
 * `undefined` for an unknown provider (the daemon's own `resolveModel` call
 * is the source of truth for provider validation; this just has nothing to
 * look up).
 */
function apiKeyEnvVarFor(model: ModelConfig): string | undefined {
  return model.apiKeyEnvVar ?? DEFAULT_API_KEY_ENV_VARS[model.provider];
}

/**
 * `env:`-sourced `secrets` entries this call named, resolved against this
 * MCP server process's own environment and forwarded by value — mirrors
 * `SecretResolver.resolveAll`'s `forwarded` matching in `@windower/engine`.
 * `keychain`/`literal` secrets are left for the daemon to resolve itself
 * (keychain access is inherently local to the daemon's host; `literal`
 * needs no env lookup at all).
 */
function resolvedEnvSecretRefs(secrets: readonly SecretRef[] | undefined): ResolvedSecret[] {
  if (!secrets || secrets.length === 0) return [];
  const resolved: ResolvedSecret[] = [];
  for (const secret of secrets) {
    if (secret.source !== "env") continue;
    const value = process.env[secret.ref];
    if (value === undefined) continue; // Not present here — the daemon falls back to its own env, same as before this fix.
    resolved.push({ name: secret.name, value });
  }
  return resolved;
}

/**
 * Builds the `DaemonHelloEnv` for one `run_operator` call. Returns
 * `undefined` (not sent at all) when neither an API key nor any `env:`
 * secret is present in this process's environment — `hello`'s `env` is
 * optional, and there's nothing to scope.
 */
export function buildOperatorHelloEnv(params: {
  model: ModelConfig;
  secrets?: SecretRef[];
}): DaemonHelloEnv | undefined {
  const apiKeyEnvVar = apiKeyEnvVarFor(params.model);
  const apiKeyValue = apiKeyEnvVar ? process.env[apiKeyEnvVar] : undefined;
  const secretRefs = resolvedEnvSecretRefs(params.secrets);

  if (apiKeyValue === undefined && secretRefs.length === 0) {
    return undefined;
  }

  return {
    apiKeyEnvVar: apiKeyValue !== undefined ? apiKeyEnvVar : undefined,
    apiKeyValue,
    secretRefs: secretRefs.length > 0 ? secretRefs : undefined,
  };
}
