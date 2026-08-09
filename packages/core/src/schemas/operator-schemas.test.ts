import { describe, expect, it } from "vitest";
import { WindowerConfigSchema } from "./config.js";
import { EventTimelineSchema, TimelineEventSchema } from "./event-timeline.js";
import { INPUT_ACTION_KINDS, InputActionSchema, inputActionCoordinates } from "./input-action.js";
import { OutputManifestSchema } from "./manifest.js";
import {
  DEFAULT_OPERATOR_MAX_STEPS,
  DEFAULT_OPERATOR_TIMEOUT_MS,
  ModelConfigSchema,
  OperatorRunSchema,
  OperatorRunStateSchema,
  OperatorStepSchema,
  SecretRefSchema,
  formatModelConfig,
  isTerminalOperatorRunState,
  parseModelConfig,
  parseSecretRef,
} from "./operator.js";

/**
 * Phase 19 schema round-trips. Every shape below is quoted from
 * data-model.md — if a test here needs changing, change the doc first
 * (CLAUDE.md §protocol before platform).
 */

const validRect = { x: 0, y: 0, width: 1920, height: 1080 };

describe("InputAction", () => {
  const samples: Record<string, unknown> = {
    mouse_move: { kind: "mouse_move", x: 10, y: 20 },
    mouse_down: { kind: "mouse_down", x: 10, y: 20, button: "left" },
    mouse_up: { kind: "mouse_up", x: 10, y: 20, button: "right" },
    mouse_click: { kind: "mouse_click", x: 10, y: 20, button: "left", clickCount: 2 },
    mouse_drag: {
      kind: "mouse_drag",
      fromX: 1,
      fromY: 2,
      toX: 3,
      toY: 4,
      button: "left",
      durationMs: 250,
    },
    scroll: { kind: "scroll", x: 10, y: 20, deltaX: 0, deltaY: -3 },
    type_text: { kind: "type_text", text: "hello {{password}}" },
    key_press: { kind: "key_press", key: "Return", modifiers: ["cmd", "shift"] },
    wait: { kind: "wait", durationMs: 500 },
  };

  it("covers exactly the kinds listed in data-model.md", () => {
    expect(Object.keys(samples).sort()).toEqual([...INPUT_ACTION_KINDS].sort());
  });

  for (const kind of INPUT_ACTION_KINDS) {
    it(`round-trips ${kind}`, () => {
      const parsed = InputActionSchema.parse(samples[kind]);
      expect(parsed).toEqual(samples[kind]);
      expect(InputActionSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
    });
  }

  it("accepts the optional fields being omitted", () => {
    expect(InputActionSchema.parse({ kind: "mouse_click", x: 1, y: 2, button: "other" })).toEqual({
      kind: "mouse_click",
      x: 1,
      y: 2,
      button: "other",
    });
    expect(InputActionSchema.parse({ kind: "key_press", key: "a" })).toEqual({
      kind: "key_press",
      key: "a",
    });
  });

  it("rejects an unknown kind and a bad button", () => {
    expect(InputActionSchema.safeParse({ kind: "teleport", x: 1, y: 2 }).success).toBe(false);
    expect(
      InputActionSchema.safeParse({ kind: "mouse_down", x: 1, y: 2, button: "middle" }).success,
    ).toBe(false);
  });

  it("exposes every coordinate an action touches", () => {
    expect(inputActionCoordinates(InputActionSchema.parse(samples.mouse_drag))).toEqual([
      { x: 1, y: 2 },
      { x: 3, y: 4 },
    ]);
    expect(inputActionCoordinates(InputActionSchema.parse(samples.scroll))).toEqual([
      { x: 10, y: 20 },
    ]);
    expect(inputActionCoordinates(InputActionSchema.parse(samples.type_text))).toEqual([]);
    expect(inputActionCoordinates(InputActionSchema.parse(samples.wait))).toEqual([]);
  });
});

describe("SecretRef", () => {
  it("round-trips each source", () => {
    for (const source of ["env", "keychain", "literal"] as const) {
      const ref = { name: "password", source, ref: "WAROOM_PASSWORD" };
      expect(SecretRefSchema.parse(ref)).toEqual(ref);
    }
  });

  it("rejects an unknown source and an empty name", () => {
    expect(SecretRefSchema.safeParse({ name: "p", source: "vault", ref: "x" }).success).toBe(false);
    expect(SecretRefSchema.safeParse({ name: "", source: "env", ref: "x" }).success).toBe(false);
  });

  it("parses the CLI --secret <name>=<source>:<ref> form", () => {
    expect(parseSecretRef("password=keychain:waroom")).toEqual({
      name: "password",
      source: "keychain",
      ref: "waroom",
    });
    // A ref may itself contain colons.
    expect(parseSecretRef("token=literal:abc:def")).toEqual({
      name: "token",
      source: "literal",
      ref: "abc:def",
    });
    expect(() => parseSecretRef("password")).toThrow();
    expect(() => parseSecretRef("password=keychain")).toThrow();
  });
});

describe("ModelConfig", () => {
  it("round-trips full and minimal shapes", () => {
    const full = {
      provider: "openai-compatible",
      model: "llama-3.3",
      baseUrl: "http://localhost:11434/v1",
      apiKeyEnvVar: "LOCAL_API_KEY",
    };
    expect(ModelConfigSchema.parse(full)).toEqual(full);
    expect(ModelConfigSchema.parse({ provider: "anthropic", model: "claude-sonnet-5" })).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-5",
    });
  });

  it("parses provider:model strings", () => {
    expect(parseModelConfig("anthropic:claude-sonnet-5")).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-5",
    });
    expect(parseModelConfig("openai:gpt-5")).toEqual({ provider: "openai", model: "gpt-5" });
    // Only the FIRST colon separates — model ids routinely contain colons.
    expect(parseModelConfig("openai-compatible:llama3:8b")).toEqual({
      provider: "openai-compatible",
      model: "llama3:8b",
    });
  });

  it("merges baseUrl/apiKeyEnvVar overrides while parsing", () => {
    expect(
      parseModelConfig("openai-compatible:llama-3.3", { baseUrl: "http://localhost:1234/v1" }),
    ).toEqual({
      provider: "openai-compatible",
      model: "llama-3.3",
      baseUrl: "http://localhost:1234/v1",
    });
  });

  it("rejects malformed provider:model strings", () => {
    for (const bad of ["", "anthropic", ":claude", "anthropic:", "  "]) {
      expect(() => parseModelConfig(bad)).toThrow();
    }
  });

  it("formats back to the provider:model form", () => {
    const config = parseModelConfig("openai-compatible:llama3:8b");
    expect(formatModelConfig(config)).toBe("openai-compatible:llama3:8b");
  });
});

describe("OperatorStep / OperatorRun", () => {
  const validStep = {
    index: 0,
    observationRef: "/tmp/run-1/frame-0.png",
    toolCalls: [
      { name: "click", args: { x: 10, y: 20 } },
      { name: "type_text", args: { text: "{{password}}" }, result: { performed: 1 } },
    ],
    reasoning: "The login field is focused, so type the password.",
    tMs: 1234,
  };

  it("round-trips a full step", () => {
    expect(OperatorStepSchema.parse(validStep)).toEqual(validStep);
  });

  it("round-trips a step with no reasoning and no tool results", () => {
    const minimal = { index: 1, observationRef: "handle:2", toolCalls: [], tMs: 0 };
    expect(OperatorStepSchema.parse(minimal)).toEqual(minimal);
  });

  it("rejects a negative index", () => {
    expect(OperatorStepSchema.safeParse({ ...validStep, index: -1 }).success).toBe(false);
  });

  it("round-trips a full run through JSON (as persisted to disk)", () => {
    const run = {
      id: "11111111-1111-1111-1111-111111111111",
      state: "running",
      task: "Open waroom.co and create an incident",
      model: { provider: "anthropic", model: "claude-sonnet-5" },
      sessionId: "22222222-2222-2222-2222-222222222222",
      steps: [validStep],
      startedAt: "2026-08-09T12:00:00.000Z",
      transcriptPath: "/tmp/demo.operator.json",
    };
    const parsed = OperatorRunSchema.parse(run);
    expect(parsed).toEqual(run);
    expect(OperatorRunSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  it("round-trips a terminal run with an error", () => {
    const run = {
      id: "run-2",
      state: "failed",
      task: "do the thing",
      model: { provider: "openai", model: "gpt-5" },
      steps: [],
      startedAt: "2026-08-09T12:00:00.000Z",
      endedAt: "2026-08-09T12:01:00.000Z",
      error: { code: "INPUT_OUT_OF_BOUNDS", message: "coordinate outside target bounds" },
    };
    expect(OperatorRunSchema.parse(run)).toEqual(run);
  });

  it("enumerates exactly the states in data-model.md", () => {
    expect(OperatorRunStateSchema.options).toEqual([
      "pending",
      "running",
      "succeeded",
      "failed",
      "aborted",
      "timed_out",
    ]);
    expect(isTerminalOperatorRunState("running")).toBe(false);
    expect(isTerminalOperatorRunState("pending")).toBe(false);
    for (const state of ["succeeded", "failed", "aborted", "timed_out"] as const) {
      expect(isTerminalOperatorRunState(state)).toBe(true);
    }
  });

  it("rejects an unknown state", () => {
    expect(OperatorRunStateSchema.safeParse("cancelled").success).toBe(false);
  });

  it("pins the contract's guardrail defaults", () => {
    expect(DEFAULT_OPERATOR_MAX_STEPS).toBe(40);
    expect(DEFAULT_OPERATOR_TIMEOUT_MS).toBe(300_000);
  });
});

describe("TimelineEvent.source", () => {
  it('defaults to "user" for a pre-Phase-19 event with no source', () => {
    expect(TimelineEventSchema.parse({ t: 5, type: "cursor_move", x: 1, y: 2 })).toEqual({
      t: 5,
      type: "cursor_move",
      x: 1,
      y: 2,
      source: "user",
    });
    expect(
      TimelineEventSchema.parse({ t: 5, type: "mouse_down", x: 1, y: 2, button: "left" }),
    ).toMatchObject({ source: "user" });
    expect(TimelineEventSchema.parse({ t: 5, type: "key_up", key: "a" })).toMatchObject({
      source: "user",
    });
  });

  it("preserves an explicit operator source on every event type", () => {
    expect(
      TimelineEventSchema.parse({ t: 1, type: "cursor_move", x: 0, y: 0, source: "operator" }),
    ).toMatchObject({ source: "operator" });
    expect(
      TimelineEventSchema.parse({
        t: 1,
        type: "mouse_up",
        x: 0,
        y: 0,
        button: "right",
        source: "operator",
      }),
    ).toMatchObject({ source: "operator" });
    expect(
      TimelineEventSchema.parse({ t: 1, type: "key_down", key: "b", source: "operator" }),
    ).toMatchObject({ source: "operator" });
  });

  it("rejects an unknown source", () => {
    expect(
      TimelineEventSchema.safeParse({ t: 1, type: "cursor_move", x: 0, y: 0, source: "human" })
        .success,
    ).toBe(false);
  });

  it("parses a whole pre-Phase-19 .events.json file unchanged", () => {
    const legacy = {
      sessionId: "s1",
      events: [
        { t: 0, type: "cursor_move", x: 1, y: 1 },
        { t: 10, type: "mouse_down", x: 1, y: 1, button: "left" },
      ],
      capabilities: { keystrokes: true },
    };
    const parsed = EventTimelineSchema.parse(legacy);
    expect(parsed.events.map((e) => e.source)).toEqual(["user", "user"]);
  });
});

describe("OutputManifest.operatorRunPath", () => {
  const baseManifest = {
    windowerVersion: "0.1.1",
    sessionId: "s1",
    target: { kind: "region", displayId: "1", bounds: validRect },
    video: {
      fps: 30,
      codec: "h264",
      container: "mp4",
      quality: "high",
      showCursor: true,
      actualResolution: { width: 1920, height: 1080 },
      durationMs: 1000,
    },
    audio: { tracks: [] },
    createdAt: "2026-08-09T12:00:00.000Z",
    file: { path: "/tmp/x.mp4", sizeBytes: 10, codec: "h264", container: "mp4" },
  };

  it("is optional (a non-operator recording still parses)", () => {
    const parsed = OutputManifestSchema.parse(baseManifest);
    expect(parsed.operatorRunPath).toBeUndefined();
  });

  it("round-trips when present", () => {
    const parsed = OutputManifestSchema.parse({
      ...baseManifest,
      operatorRunPath: "x.operator.json",
    });
    expect(parsed.operatorRunPath).toBe("x.operator.json");
  });
});

describe("WindowerConfig.operator", () => {
  it("round-trips the Phase 19 operator block", () => {
    const config = {
      operator: {
        defaultModel: { provider: "anthropic", model: "claude-sonnet-5" },
        apiKeyEnvVar: "ANTHROPIC_API_KEY",
        baseUrl: "http://localhost:11434/v1",
        guardrailDefaults: { maxSteps: 20, timeoutSeconds: 120, unbounded: false },
      },
    };
    expect(WindowerConfigSchema.parse(config)).toEqual(config);
  });

  it("stays optional for a pre-Phase-19 config.json", () => {
    expect(WindowerConfigSchema.parse({ outputDir: "/tmp" })).toEqual({ outputDir: "/tmp" });
  });
});
