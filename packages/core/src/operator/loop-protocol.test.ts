import { describe, expect, it } from "vitest";
import {
  GuardrailStateSchema,
  LOOP_ABORT_REASON_TO_STATE,
  LOOP_PROTOCOL_VERSION,
  OPERATOR_LOOP_CHILD_METHODS,
  OPERATOR_LOOP_CHILD_METHOD_SCHEMAS,
  OPERATOR_LOOP_DAEMON_METHOD_SCHEMAS,
  OPERATOR_LOOP_DAEMON_NOTIFICATION_SCHEMAS,
  OPERATOR_LOOP_PROXIED_METHODS,
  OperatorLoopErrorCodeSchema,
} from "./loop-protocol.js";

/**
 * contracts/operator-loop-protocol.md — every shape below is quoted from that
 * doc; if a test here needs changing, change the doc first (CLAUDE.md
 * §protocol before platform).
 */

describe("operator loop protocol — method tables", () => {
  it("serves exactly the child→daemon method table", () => {
    expect([...OPERATOR_LOOP_CHILD_METHODS]).toEqual([
      "ready",
      "beginStep",
      "captureFrame",
      "performInput",
      "enumerateTargets",
      "resizeWindow",
      "reportPlan",
      "reportStep",
      "reportResult",
      "guardrailState",
    ]);
    expect(Object.keys(OPERATOR_LOOP_CHILD_METHOD_SCHEMAS).sort()).toEqual(
      [...OPERATOR_LOOP_CHILD_METHODS].sort(),
    );
  });

  it("proxies exactly OperatorDeps' four screen-facing members", () => {
    expect([...OPERATOR_LOOP_PROXIED_METHODS]).toEqual([
      "captureFrame",
      "performInput",
      "enumerateTargets",
      "resizeWindow",
    ]);
  });

  it("exposes no filesystem/spawn/network method to the child", () => {
    // The child writes nothing to disk, spawns nothing, and makes no HTTP
    // request on the daemon's behalf — the method table is the whole surface.
    for (const method of OPERATOR_LOOP_CHILD_METHODS) {
      expect(method).not.toMatch(/spawn|exec|writeFile|readFile|fetch|unlink|http/i);
    }
  });

  it("pins the protocol version as an assertion, not a negotiation", () => {
    expect(LOOP_PROTOCOL_VERSION).toBe(1);
    const ready = OPERATOR_LOOP_CHILD_METHOD_SCHEMAS.ready.params.parse({
      loopProtocolVersion: LOOP_PROTOCOL_VERSION,
      pid: 4890,
    });
    expect(ready.loopProtocolVersion).toBe(1);
  });
});

describe("operator loop protocol — ready", () => {
  it("carries secret NAMES and never secret values", () => {
    const result = OPERATOR_LOOP_CHILD_METHOD_SCHEMAS.ready.result.parse({
      runId: "018f2c00-0000-7000-8000-000000000000",
      task: "open waroom.co in Safari",
      target: {
        kind: "window",
        id: "window:4821",
        title: "Safari",
        appName: "Safari",
        appBundleId: "com.apple.Safari",
        bounds: { x: 0, y: 0, width: 3024, height: 1964 },
        isFocused: true,
        resizable: true,
      },
      model: { provider: "anthropic", model: "claude-sonnet-5" },
      secretNames: ["password"],
      maxSteps: 40,
      maxBatchActions: 8,
      timeoutMs: 300_000,
      unbounded: false,
      bounds: { x: 0, y: 0, width: 3024, height: 1964 },
      env: { ANTHROPIC_API_KEY: "sk-test" },
      startedAtMs: 1786000931000,
    });
    expect(result.secretNames).toEqual(["password"]);
    expect(result).not.toHaveProperty("secrets");
    expect(result).not.toHaveProperty("transcriptPath");
  });

  it("carries the resolved target and no recording identifier", () => {
    const result = OPERATOR_LOOP_CHILD_METHOD_SCHEMAS.ready.result.parse({
      runId: "018f2c00-0000-7000-8000-000000000000",
      task: "open waroom.co in Safari",
      target: {
        kind: "window",
        id: "window:4821",
        title: "Safari",
        appName: "Safari",
        appBundleId: "com.apple.Safari",
        bounds: { x: 0, y: 0, width: 3024, height: 1964 },
        isFocused: true,
        resizable: true,
      },
      model: { provider: "anthropic", model: "claude-sonnet-5" },
      secretNames: [],
      maxSteps: 40,
      maxBatchActions: 8,
      timeoutMs: 300_000,
      unbounded: false,
      startedAtMs: 1786000931000,
      // A stale caller still sending a session id must not get one through.
      sessionId: "sess-7",
    });
    // The child is handed a resolved target, so it never enumerates to find
    // out what it drives — contracts/operator-loop-protocol.md §Handshake.
    // `CaptureTarget` is a discriminated union; a region target carries no
    // `id`, so narrow before reaching for one.
    expect(result.target.kind).toBe("window");
    if (result.target.kind !== "region") {
      expect(result.target.id).toBe("window:4821");
    }
    // Recording independence: nothing on this wire names a recording.
    expect(result).not.toHaveProperty("sessionId");
  });
});

describe("operator loop protocol — GuardrailState", () => {
  it("parses the daemon's authoritative budget view", () => {
    const state = {
      stepsUsed: 3,
      maxSteps: 40,
      actionsInStep: 2,
      maxBatchActions: 8,
      remainingMs: 250_000,
      aborted: false,
      unbounded: false,
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      planRevision: 1,
    };
    expect(GuardrailStateSchema.parse(state)).toEqual(state);
  });

  it("allows an unbounded run with no bounds", () => {
    expect(
      GuardrailStateSchema.parse({
        stepsUsed: 0,
        maxSteps: 40,
        actionsInStep: 0,
        maxBatchActions: 8,
        remainingMs: 300_000,
        aborted: false,
        unbounded: true,
      }).bounds,
    ).toBeUndefined();
  });

  it("leaves planRevision absent before the first reportPlan", () => {
    expect(
      GuardrailStateSchema.parse({
        stepsUsed: 0,
        maxSteps: 40,
        actionsInStep: 0,
        maxBatchActions: 8,
        remainingMs: 300_000,
        aborted: false,
        unbounded: false,
      }).planRevision,
    ).toBeUndefined();
  });

  it("requires the batching counters — a state without them is not servable", () => {
    expect(
      GuardrailStateSchema.safeParse({
        stepsUsed: 0,
        maxSteps: 40,
        remainingMs: 300_000,
        aborted: false,
        unbounded: false,
      }).success,
    ).toBe(false);
  });
});

describe("operator loop protocol — reportPlan", () => {
  it("carries plan CONTENT only — the child never sends revision/atStepIndex/tMs", () => {
    const params = OPERATOR_LOOP_CHILD_METHOD_SCHEMAS.reportPlan.params.parse({
      steps: ["activate Safari", "Cmd+L, type waroom.co, Enter", "verify the page loaded"],
      rationale: "the address bar is more reliable than hunting for a link",
    });
    expect(params.steps).toHaveLength(3);
    expect(params).not.toHaveProperty("revision");
    expect(params).not.toHaveProperty("atStepIndex");
    expect(params).not.toHaveProperty("tMs");
  });

  it("accepts a plan with no rationale", () => {
    expect(
      OPERATOR_LOOP_CHILD_METHOD_SCHEMAS.reportPlan.params.parse({ steps: ["do the thing"] })
        .rationale,
    ).toBeUndefined();
  });

  it("returns the daemon-assigned revision", () => {
    expect(
      OPERATOR_LOOP_CHILD_METHOD_SCHEMAS.reportPlan.result.parse({ accepted: true, revision: 0 }),
    ).toEqual({ accepted: true, revision: 0 });
    expect(
      OPERATOR_LOOP_CHILD_METHOD_SCHEMAS.reportPlan.result.safeParse({
        accepted: false,
        revision: 0,
      }).success,
    ).toBe(false);
  });
});

describe("operator loop protocol — abort", () => {
  it("maps every abort reason to a terminal run state", () => {
    expect(LOOP_ABORT_REASON_TO_STATE).toEqual({
      user: "aborted",
      timeout: "timed_out",
      "max-steps": "failed",
      "daemon-shutdown": "aborted",
    });
  });

  it("closes the reason set over non-recording reasons only", () => {
    // contracts/operator-loop-protocol.md §"Methods: daemon → child": a
    // recording starting, stopping, failing, or never having existed MUST NOT
    // abort an operator run — the earlier draft's `"session-ended"` is gone.
    expect(Object.keys(LOOP_ABORT_REASON_TO_STATE)).toEqual([
      "user",
      "timeout",
      "max-steps",
      "daemon-shutdown",
    ]);
    expect(
      OPERATOR_LOOP_DAEMON_NOTIFICATION_SCHEMAS.abort.safeParse({ reason: "session-ended" })
        .success,
    ).toBe(false);
  });

  it("parses the abort notification's params", () => {
    expect(
      OPERATOR_LOOP_DAEMON_NOTIFICATION_SCHEMAS.abort.parse({ reason: "daemon-shutdown" }),
    ).toEqual({ reason: "daemon-shutdown" });
    expect(
      OPERATOR_LOOP_DAEMON_NOTIFICATION_SCHEMAS.abort.safeParse({ reason: "bogus" }).success,
    ).toBe(false);
  });

  it("parses a ping response", () => {
    expect(
      OPERATOR_LOOP_DAEMON_METHOD_SCHEMAS.ping.result.parse({
        pong: true,
        stepIndex: 2,
        uptimeMs: 1234,
      }).pong,
    ).toBe(true);
  });
});

describe("operator loop protocol — error taxonomy", () => {
  it("declares every code new to this channel", () => {
    expect([...OperatorLoopErrorCodeSchema.options].sort()).toEqual(
      [
        "CONTROL_SURFACE_UNAVAILABLE",
        "INVALID_ARGS",
        "LOOP_ALREADY_ENDED",
        "LOOP_NOT_STARTED",
        "LOOP_PROTOCOL_VERSION_MISMATCH",
        "LOOP_PROTOCOL_VIOLATION",
        "NO_OPEN_STEP",
        "OPERATOR_ABORTED",
        "OPERATOR_BATCH_LIMIT_EXCEEDED",
        "OPERATOR_MAX_STEPS_EXCEEDED",
        "OPERATOR_TIMEOUT",
        "STEP_INDEX_MISMATCH",
        "UNKNOWN_SECRET_REF",
      ].sort(),
    );
  });

  it("does not restate OPERATOR_LOOP_CRASHED — it is daemon-internal, never on the wire", () => {
    expect(OperatorLoopErrorCodeSchema.options).not.toContain("OPERATOR_LOOP_CRASHED");
  });
});
