import { describe, expect, it } from "vitest";
import {
  DaemonErrorCodeSchema,
  RunOperatorParamsSchema,
  StartRecordingParamsSchema,
} from "./methods.js";

describe("DaemonErrorCodeSchema", () => {
  it("includes the Phase 20 hello-handshake error codes", () => {
    expect(DaemonErrorCodeSchema.options).toContain("DAEMON_VERSION_MISMATCH");
    expect(DaemonErrorCodeSchema.options).toContain("DAEMON_BUSY");
  });

  it("still accepts pre-existing daemon-only codes", () => {
    expect(DaemonErrorCodeSchema.options).toContain("OUTPUT_DIR_NOT_WRITABLE");
    expect(DaemonErrorCodeSchema.options).toContain("OPERATOR_RUN_NOT_FOUND");
  });

  it("includes the Phase 21 capture-exclusivity/operator-loop error codes", () => {
    // contracts/operator-loop-protocol.md §OPERATOR_LOOP_CRASHED and
    // contracts/screen-capture-exclusivity.md §Error codes.
    expect(DaemonErrorCodeSchema.options).toContain("OPERATOR_LOOP_CRASHED");
    expect(DaemonErrorCodeSchema.options).toContain("SCREEN_CAPTURE_BUSY");
    expect(DaemonErrorCodeSchema.parse("OPERATOR_LOOP_CRASHED")).toBe("OPERATOR_LOOP_CRASHED");
    expect(DaemonErrorCodeSchema.parse("SCREEN_CAPTURE_BUSY")).toBe("SCREEN_CAPTURE_BUSY");
  });
});

describe("RunOperatorParamsSchema — recording-unaware inputs (Phase 21)", () => {
  const base = {
    task: "open waroom.co in Safari",
    target: { targetId: "window:42" },
    models: { planner: { provider: "anthropic", model: "claude-sonnet-5" } },
  };

  it("accepts exactly { task, target, models?, secrets?, guardrails?, observe? }", () => {
    // contracts/operator.md §Inputs — a run is fully specified by these and
    // nothing else.
    const params = {
      ...base,
      secrets: [{ name: "password", source: "env", ref: "WAROOM_PASSWORD" }],
      guardrails: { maxSteps: 12, timeoutSeconds: 90, maxBatchActions: 4, unbounded: false },
    };
    expect(RunOperatorParamsSchema.parse(params)).toEqual(params);
    expect(Object.keys(RunOperatorParamsSchema.shape).sort()).toEqual([
      "guardrails",
      "models",
      "observe",
      "secrets",
      "target",
      "task",
    ]);
  });

  it("accepts a bare ModelConfig for `models`, one --model setting both tiers", () => {
    const params = { ...base, models: { provider: "anthropic", model: "claude-sonnet-5" } };
    expect(RunOperatorParamsSchema.parse(params)).toEqual(params);
  });

  it("accepts an omitted `models`, relying on daemon-side config-file resolution", () => {
    const { models, ...noModels } = base;
    expect(RunOperatorParamsSchema.parse(noModels)).toEqual(noModels);
    void models;
  });

  it("takes the same target selector `start_recording` takes", () => {
    const resolved = {
      ...base,
      target: {
        kind: "window",
        id: "window:42",
        title: "Waroom",
        appName: "Safari",
        appBundleId: "com.apple.Safari",
        bounds: { x: 0, y: 0, width: 1440, height: 900 },
        isFocused: true,
        resizable: true,
      },
    };
    expect(RunOperatorParamsSchema.parse(resolved)).toEqual(resolved);
    expect(StartRecordingParamsSchema.parse({ target: resolved.target })).toEqual({
      target: resolved.target,
    });
  });

  it("requires a target", () => {
    const { target, ...noTarget } = base;
    expect(RunOperatorParamsSchema.safeParse(noTarget).success).toBe(false);
  });

  it("rejects `sessionId` — by strictness, not by refinement", () => {
    // The operator is recording-unaware: there is no attach mode to name a
    // session for. The daemon maps this to INVALID_ARGS.
    const result = RunOperatorParamsSchema.safeParse({
      ...base,
      sessionId: "018f2c00-0000-7000-8000-000000000000",
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((i) => i.code === "unrecognized_keys")).toBe(true);
  });

  it("rejects `recording` — the standalone convenience mode is gone", () => {
    expect(
      RunOperatorParamsSchema.safeParse({ ...base, recording: { outputDir: "/tmp/out" } }).success,
    ).toBe(false);
    // Including the `--no-record`-backing `disabled` flag: a run with no
    // recording is now the only shape there is.
    expect(
      RunOperatorParamsSchema.safeParse({ ...base, recording: { disabled: true } }).success,
    ).toBe(false);
  });

  it("declares no recording-derived member", () => {
    for (const key of Object.keys(RunOperatorParamsSchema.shape)) {
      expect(key.toLowerCase()).not.toContain("session");
      expect(key.toLowerCase()).not.toContain("record");
    }
  });
});
