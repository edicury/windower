import { parseModelConfig } from "@windower/core";
import { describe, expect, it } from "vitest";
import { OPERATOR_ERROR_CODES, OperatorError } from "./errors.js";
import {
  PROVIDER_REGISTRY,
  type ProviderEntry,
  knownProviders,
  resolveModel,
} from "./providers.js";

/** `LanguageModel` is `string | LanguageModelV4`; the registry always returns the latter. */
function modelIdOf(model: ReturnType<typeof resolveModel>): string {
  return (model as { modelId: string }).modelId;
}

describe("provider registry", () => {
  it("registers the providers named in contracts/operator.md", () => {
    expect(knownProviders()).toEqual(["anthropic", "openai", "openai-compatible"]);
  });

  it("resolves anthropic and openai from a provider:model string", () => {
    const env = { ANTHROPIC_API_KEY: "test-anthropic", OPENAI_API_KEY: "test-openai" };
    const anthropic = resolveModel(parseModelConfig("anthropic:claude-sonnet-5"), env);
    const openai = resolveModel(parseModelConfig("openai:gpt-5"), env);
    expect(modelIdOf(anthropic)).toBe("claude-sonnet-5");
    expect(modelIdOf(openai)).toBe("gpt-5");
  });

  it("keeps model ids containing colons intact (ollama-style tags)", () => {
    const config = parseModelConfig("openai-compatible:llama3:8b", {
      baseUrl: "http://localhost:11434/v1",
    });
    expect(modelIdOf(resolveModel(config, {}))).toBe("llama3:8b");
  });

  it("honors baseUrl for openai-compatible and allows a keyless local server", () => {
    const model = resolveModel(
      parseModelConfig("openai-compatible:llama-3.3", { baseUrl: "http://localhost:1234/v1" }),
      {},
    );
    expect(modelIdOf(model)).toBe("llama-3.3");
  });

  it("requires a base URL for openai-compatible", () => {
    expect(() => resolveModel(parseModelConfig("openai-compatible:llama-3.3"), {})).toThrow(
      OperatorError,
    );
  });

  it("reads the API key from the environment only, and fails loudly when unset", () => {
    try {
      resolveModel(parseModelConfig("anthropic:claude-sonnet-5"), {});
      expect.unreachable("expected a missing-api-key error");
    } catch (err) {
      expect((err as OperatorError).code).toBe(OPERATOR_ERROR_CODES.MISSING_API_KEY);
      expect((err as Error).message).toContain("ANTHROPIC_API_KEY");
    }
  });

  it("honors a per-config apiKeyEnvVar override", () => {
    const config = parseModelConfig("anthropic:claude-sonnet-5", {
      apiKeyEnvVar: "MY_CUSTOM_KEY",
    });
    expect(() => resolveModel(config, { MY_CUSTOM_KEY: "abc" })).not.toThrow();
    expect(() => resolveModel(config, { ANTHROPIC_API_KEY: "abc" })).toThrow();
  });

  it("rejects an unknown provider with a listing of the known ones", () => {
    try {
      resolveModel(parseModelConfig("nope:some-model"), {});
      expect.unreachable("expected an unknown-provider error");
    } catch (err) {
      expect((err as OperatorError).code).toBe(OPERATOR_ERROR_CODES.UNKNOWN_PROVIDER);
      expect((err as Error).message).toContain("anthropic");
    }
  });

  it("adding a provider is a registry entry, not a loop change", () => {
    // The loop never names a provider; it only calls resolveModel(). Proven by
    // registering an entry at runtime and resolving through the same path.
    const openai = PROVIDER_REGISTRY.openai as ProviderEntry;
    PROVIDER_REGISTRY["fake-provider"] = {
      apiKeyOptional: true,
      create: ({ modelId }) => openai.create({ modelId, apiKey: "x" }),
    };
    try {
      expect(modelIdOf(resolveModel(parseModelConfig("fake-provider:whatever"), {}))).toBe(
        "whatever",
      );
    } finally {
      Reflect.deleteProperty(PROVIDER_REGISTRY, "fake-provider");
    }
  });
});
