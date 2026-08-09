import { DEFAULT_OPERATOR_MAX_STEPS, DaemonError, RunOperatorParamsSchema } from "@windower/core";
import { describe, expect, it } from "vitest";
import {
  type OperateOpts,
  buildRunOperatorParams,
  parseSecretRefs,
  secretWarnings,
} from "./operate-params.js";

const MODEL = "anthropic:claude-sonnet-5";

function opts(overrides: Partial<OperateOpts> = {}): OperateOpts {
  return { model: MODEL, ...overrides };
}

describe("buildRunOperatorParams — model", () => {
  it("parses --model into a ModelConfig", () => {
    const params = buildRunOperatorParams("do a thing", opts());
    expect(params.model).toEqual({ provider: "anthropic", model: "claude-sonnet-5" });
  });

  it("splits --model on the first colon only, so model ids may contain colons", () => {
    const params = buildRunOperatorParams("t", opts({ model: "openai-compatible:llama3:8b" }));
    expect(params.model).toEqual({ provider: "openai-compatible", model: "llama3:8b" });
  });

  it("attaches --base-url to the model config", () => {
    const params = buildRunOperatorParams(
      "t",
      opts({ model: "openai-compatible:llama3", baseUrl: "http://localhost:11434/v1" }),
    );
    expect(params.model.baseUrl).toBe("http://localhost:11434/v1");
  });

  it("falls back to the config operator block when --model is omitted", () => {
    const params = buildRunOperatorParams("t", opts({ model: undefined }), {
      defaultModel: { provider: "openai", model: "gpt-5" },
      baseUrl: "http://localhost:1234/v1",
      apiKeyEnvVar: "MY_KEY",
    });
    expect(params.model).toEqual({
      provider: "openai",
      model: "gpt-5",
      baseUrl: "http://localhost:1234/v1",
      apiKeyEnvVar: "MY_KEY",
    });
  });

  it("fails with INVALID_ARGS when no model is available at all", () => {
    expect(() => buildRunOperatorParams("t", opts({ model: undefined }))).toThrow(DaemonError);
    try {
      buildRunOperatorParams("t", opts({ model: undefined }));
    } catch (err) {
      expect((err as DaemonError).code).toBe("INVALID_ARGS");
    }
  });

  it("rejects a --model without a provider prefix", () => {
    expect(() => buildRunOperatorParams("t", opts({ model: "gpt-5" }))).toThrow(
      /INVALID_ARGS|--model/,
    );
  });

  it("never accepts an API key as a flag — only an env var name via config", () => {
    // The flag surface has no `--api-key`; the only way a key reference gets
    // in is `apiKeyEnvVar` from config (a *name*, not a value).
    const params = buildRunOperatorParams("t", opts(), { apiKeyEnvVar: "ANTHROPIC_API_KEY" });
    expect(params.model.apiKeyEnvVar).toBe("ANTHROPIC_API_KEY");
    expect(JSON.stringify(params)).not.toContain("sk-");
  });
});

describe("buildRunOperatorParams — secrets", () => {
  it("parses repeated --secret flags in order", () => {
    const params = buildRunOperatorParams(
      "log in as {{user}}/{{password}}",
      opts({ secret: ["user=env:DEMO_USER", "password=keychain:waroom"] }),
    );
    expect(params.secrets).toEqual([
      { name: "user", source: "env", ref: "DEMO_USER" },
      { name: "password", source: "keychain", ref: "waroom" },
    ]);
  });

  it("splits the source on the first colon only, so refs may contain colons", () => {
    const [secret] = parseSecretRefs(["tok=literal:a:b:c"]);
    expect(secret).toEqual({ name: "tok", source: "literal", ref: "a:b:c" });
  });

  it("omits `secrets` entirely when no --secret was passed", () => {
    expect(buildRunOperatorParams("t", opts()).secrets).toBeUndefined();
  });

  it("rejects a malformed --secret with INVALID_ARGS", () => {
    try {
      parseSecretRefs(["nope"]);
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(DaemonError);
      expect((err as DaemonError).code).toBe("INVALID_ARGS");
    }
  });

  it("rejects an unknown secret source", () => {
    expect(() => parseSecretRefs(["p=vault:thing"])).toThrow(DaemonError);
  });
});

describe("secretWarnings", () => {
  it("warns about a literal: secret (shell-history exposure) but does not block it", () => {
    const secrets = parseSecretRefs(["password=literal:hunter2", "user=env:DEMO_USER"]);
    const warnings = secretWarnings(secrets);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/literal/);
    expect(warnings[0]).toMatch(/shell/i);
    // Not blocked: the ref still makes it into the params.
    const params = buildRunOperatorParams(
      "t",
      opts({ secret: ["password=literal:hunter2", "user=env:DEMO_USER"] }),
    );
    expect(params.secrets).toHaveLength(2);
  });

  it("says nothing about env/keychain secrets", () => {
    expect(secretWarnings(parseSecretRefs(["a=env:A", "b=keychain:B"]))).toEqual([]);
  });
});

describe("buildRunOperatorParams — guardrails", () => {
  it("passes --max-steps and --timeout through, with --timeout staying in seconds", () => {
    const params = buildRunOperatorParams("t", opts({ maxSteps: "12", timeout: "90" }));
    // The RPC boundary is `timeoutSeconds` (contracts/mcp-tools.md); the
    // daemon multiplies by 1000 into the runtime's `timeoutMs`.
    expect(params.guardrails).toEqual({ maxSteps: 12, timeoutSeconds: 90 });
  });

  it("sets unbounded only when --unbounded is passed", () => {
    expect(buildRunOperatorParams("t", opts()).guardrails).toBeUndefined();
    expect(buildRunOperatorParams("t", opts({ unbounded: true })).guardrails).toEqual({
      unbounded: true,
    });
  });

  it("layers config guardrail defaults under the flags", () => {
    const params = buildRunOperatorParams("t", opts({ timeout: "10" }), {
      guardrailDefaults: { maxSteps: DEFAULT_OPERATOR_MAX_STEPS, timeoutSeconds: 600 },
    });
    expect(params.guardrails).toEqual({
      maxSteps: DEFAULT_OPERATOR_MAX_STEPS,
      timeoutSeconds: 10,
    });
  });

  it("rejects a non-positive --max-steps and --timeout", () => {
    expect(() => buildRunOperatorParams("t", opts({ maxSteps: "0" }))).toThrow(DaemonError);
    expect(() => buildRunOperatorParams("t", opts({ maxSteps: "1.5" }))).toThrow(DaemonError);
    expect(() => buildRunOperatorParams("t", opts({ timeout: "-1" }))).toThrow(DaemonError);
    expect(() => buildRunOperatorParams("t", opts({ timeout: "abc" }))).toThrow(DaemonError);
  });
});

describe("buildRunOperatorParams — recording flags", () => {
  it("reuses the shared video/audio flag parsing", () => {
    const params = buildRunOperatorParams(
      "t",
      opts({
        fps: "60",
        codec: "hevc",
        container: "mov",
        resolution: "1920x1080",
        quality: "lossless_ish",
        cursor: false,
        audioMic: true,
        micDevice: "mic-1",
        audioSystem: true,
        out: "/tmp/out",
      }),
    );
    expect(params.recording).toEqual({
      video: {
        fps: 60,
        codec: "hevc",
        container: "mov",
        resolution: { width: 1920, height: 1080 },
        quality: "lossless_ish",
        showCursor: false,
      },
      audio: {
        tracks: [
          { source: "system", enabled: true },
          { source: "microphone", enabled: true, deviceId: "mic-1" },
        ],
        separateTracks: true,
      },
      outputDir: "/tmp/out",
    });
  });

  it("maps --no-record to recording.disabled", () => {
    // commander sets `record: false` for `--no-record`.
    expect(buildRunOperatorParams("t", opts({ record: false })).recording).toEqual({
      disabled: true,
    });
    expect(buildRunOperatorParams("t", opts()).recording).toBeUndefined();
  });

  it("rejects target-selection flags — run_operator takes no target", () => {
    for (const overrides of [{ target: "42" }, { kind: "window" }, { region: "0,0,10,10" }]) {
      expect(() => buildRunOperatorParams("t", opts(overrides))).toThrow(DaemonError);
    }
  });

  it("rejects an empty task", () => {
    expect(() => buildRunOperatorParams("   ", opts())).toThrow(DaemonError);
  });
});

describe("buildRunOperatorParams — schema parity", () => {
  it("produces params that validate against the core RunOperatorParams schema", () => {
    const params = buildRunOperatorParams(
      "Open waroom.co, log in as {{user}}/{{password}}, create an incident",
      opts({
        secret: ["user=env:DEMO_USER", "password=keychain:waroom"],
        resolution: "1920x1080",
        out: "~/Desktop",
        maxSteps: "20",
        timeout: "120",
      }),
    );
    expect(RunOperatorParamsSchema.parse(params)).toEqual(params);
  });
});
