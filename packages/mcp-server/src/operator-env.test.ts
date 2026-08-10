import { afterEach, describe, expect, it } from "vitest";
import { buildOperatorHelloEnv } from "./operator-env.js";

const ENV_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "MY_CUSTOM_KEY", "DEMO_USER"] as const;

function clearEnv(): void {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

describe("buildOperatorHelloEnv", () => {
  afterEach(() => {
    clearEnv();
  });

  it("returns undefined when nothing relevant is present in process.env", () => {
    clearEnv();
    const env = buildOperatorHelloEnv({
      models: { provider: "anthropic", model: "claude-sonnet-5" },
    });
    expect(env).toBeUndefined();
  });

  it("resolves the provider's default API key env var when present", () => {
    process.env.ANTHROPIC_API_KEY = "sk-abc";
    const env = buildOperatorHelloEnv({
      models: { provider: "anthropic", model: "claude-sonnet-5" },
    });
    expect(env).toEqual({
      apiKeyEnvVar: "ANTHROPIC_API_KEY",
      apiKeyValue: "sk-abc",
      secretRefs: undefined,
    });
  });

  it("prefers an explicit model.apiKeyEnvVar over the provider default", () => {
    process.env.MY_CUSTOM_KEY = "sk-custom";
    const env = buildOperatorHelloEnv({
      models: { provider: "anthropic", model: "claude-sonnet-5", apiKeyEnvVar: "MY_CUSTOM_KEY" },
    });
    expect(env?.apiKeyEnvVar).toBe("MY_CUSTOM_KEY");
    expect(env?.apiKeyValue).toBe("sk-custom");
  });

  it("leaves apiKeyEnvVar/apiKeyValue unset when the configured var isn't present in process.env", () => {
    const env = buildOperatorHelloEnv({
      models: { provider: "anthropic", model: "claude-sonnet-5" },
      secrets: [{ name: "user", source: "env", ref: "DEMO_USER" }],
    });
    process.env.DEMO_USER = "alice";
    // Re-derive after setting DEMO_USER so this call only carries the secret ref.
    const envWithSecretOnly = buildOperatorHelloEnv({
      models: { provider: "anthropic", model: "claude-sonnet-5" },
      secrets: [{ name: "user", source: "env", ref: "DEMO_USER" }],
    });
    expect(env).toBeUndefined(); // ANTHROPIC_API_KEY unset, DEMO_USER unset at first call
    expect(envWithSecretOnly).toEqual({
      apiKeyEnvVar: undefined,
      apiKeyValue: undefined,
      secretRefs: [{ name: "user", value: "alice" }],
    });
  });

  it("forwards only source:'env' secrets, resolved by value, never keychain/literal refs", () => {
    process.env.DEMO_USER = "alice";
    const env = buildOperatorHelloEnv({
      models: { provider: "openai-compatible", model: "llama3:8b" },
      secrets: [
        { name: "user", source: "env", ref: "DEMO_USER" },
        { name: "password", source: "keychain", ref: "waroom" },
        { name: "token", source: "literal", ref: "shhh" },
      ],
    });
    expect(env?.secretRefs).toEqual([{ name: "user", value: "alice" }]);
  });

  it("skips an env-sourced secret whose ref isn't present in process.env (daemon falls back to its own)", () => {
    const env = buildOperatorHelloEnv({
      models: { provider: "anthropic", model: "claude-sonnet-5" },
      secrets: [{ name: "missing", source: "env", ref: "NOT_SET_ANYWHERE" }],
    });
    expect(env).toBeUndefined();
  });

  it("never touches unrelated env vars (only the resolved API-key var and named secret refs)", () => {
    process.env.OPENAI_API_KEY = "unrelated-should-not-appear";
    const env = buildOperatorHelloEnv({
      models: { provider: "anthropic", model: "claude-sonnet-5" },
    });
    expect(env).toBeUndefined();
  });

  it("forwards only the planner's key when planner and executor share a provider (tiered, same env var)", () => {
    process.env.ANTHROPIC_API_KEY = "sk-shared";
    const env = buildOperatorHelloEnv({
      models: {
        planner: { provider: "anthropic", model: "claude-sonnet-5" },
        executor: { provider: "anthropic", model: "claude-haiku" },
      },
    });
    expect(env).toEqual({
      apiKeyEnvVar: "ANTHROPIC_API_KEY",
      apiKeyValue: "sk-shared",
      secretRefs: undefined,
    });
  });

  it("also forwards the executor's key when the two tiers use different providers", () => {
    process.env.ANTHROPIC_API_KEY = "sk-planner";
    process.env.OPENAI_API_KEY = "sk-executor";
    const env = buildOperatorHelloEnv({
      models: {
        planner: { provider: "anthropic", model: "claude-sonnet-5" },
        executor: { provider: "openai", model: "gpt-5-mini" },
      },
    });
    expect(env).toEqual({
      apiKeyEnvVar: "ANTHROPIC_API_KEY",
      apiKeyValue: "sk-planner",
      executorApiKeyEnvVar: "OPENAI_API_KEY",
      executorApiKeyValue: "sk-executor",
      secretRefs: undefined,
    });
  });
});
