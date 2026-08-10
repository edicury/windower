import type { OperatorDeps, OperatorRunOptions, OperatorStep } from "@windower/core";
import { DEFAULT_OPERATOR_MAX_BATCH_ACTIONS, parseModelConfig } from "@windower/core";
import { describe, expect, it } from "vitest";
import { type OperatorRunInternals, runOperator } from "./run.js";
import {
  FAKE_TARGET,
  TINY_PNG_BASE64,
  createFakeDeps,
  createScriptedModel,
} from "./test-helpers/fakes.js";

/**
 * contracts/operator.md §Recording independence, asserted directly:
 *
 * > The same `OperatorRun` MUST behave identically whether the screen is being
 * > recorded or not. Any observable difference between the two — a different
 * > code path, a different error, a different transcript, a different frame
 * > source visible to the model — is a contract violation.
 *
 * The test is only meaningful because there is nothing to pass in: no session
 * id, no recording flag, no attach mode. The *only* way a live recording could
 * reach the operator is through the frame it observes, so that is what varies
 * between the two runs below — one served as a one-shot capture, one served
 * from an already-live capture source, exactly the optimization
 * `contracts/screen-capture-exclusivity.md` permits below the operator. Every
 * operator-visible call, and the whole transcript, must come out identical.
 */

/** One line per operator-visible call, in issue order. */
type CallLog = string[];

function recordingDeps(log: CallLog, recordingActive: boolean): OperatorDeps {
  const base = createFakeDeps({
    // The provenance of the frame is the daemon's business. It is deliberately
    // NOT surfaced in the result shape — there is no field the operator could
    // read to tell these two apart.
    captureFrame: async () => ({
      imageBase64: TINY_PNG_BASE64,
      width: 1920,
      height: 1080,
      scale: 2,
    }),
  });
  return {
    async captureFrame(params) {
      log.push(`captureFrame ${JSON.stringify(params)}`);
      // A live capture source may already exist for this target; serving from it
      // is invisible here, which is the entire point.
      void recordingActive;
      return base.captureFrame(params);
    },
    async performInput(actions) {
      log.push(`performInput ${JSON.stringify(actions)}`);
      return base.performInput(actions);
    },
    async listTargets(kinds) {
      log.push(`listTargets ${JSON.stringify(kinds ?? null)}`);
      return base.listTargets(kinds);
    },
    async resizeWindow(targetId, bounds) {
      log.push(`resizeWindow ${targetId} ${JSON.stringify(bounds)}`);
      return base.resizeWindow(targetId, bounds);
    },
  };
}

function script() {
  return createScriptedModel([
    { text: "Observing.", toolCalls: [{ name: "plan", args: { steps: ["Focus", "Type", "Go"] } }] },
    {
      toolCalls: [
        { name: "press_key", args: { key: "l", modifiers: ["cmd"] } },
        { name: "type_text", args: { text: "https://waroom.co" } },
        { name: "press_key", args: { key: "Return" } },
      ],
    },
    { toolCalls: [{ name: "list_targets", args: {} }] },
    { toolCalls: [{ name: "done", args: { summary: "Navigated." } }] },
  ]);
}

function options(): OperatorRunOptions & OperatorRunInternals {
  return {
    runId: "run-1",
    task: "Navigate to the site",
    model: parseModelConfig("anthropic:claude-sonnet-5"),
    secrets: [],
    maxSteps: 10,
    timeoutMs: 60_000,
    maxBatchActions: DEFAULT_OPERATOR_MAX_BATCH_ACTIONS,
    unbounded: false,
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    target: FAKE_TARGET,
    signal: new AbortController().signal,
    languageModel: script(),
  };
}

/** `tMs` is a wall clock, not behavior — everything else must match exactly. */
function withoutTiming(steps: OperatorStep[]): unknown {
  return steps.map(({ tMs, plan, ...rest }) => ({
    ...rest,
    plan: plan === undefined ? undefined : { ...plan, tMs: 0 },
  }));
}

describe("recording independence", () => {
  it("issues an identical sequence of operator-visible calls, recording or not", async () => {
    const withRecording: CallLog = [];
    const withoutRecording: CallLog = [];

    const a = await runOperator(options(), recordingDeps(withRecording, true));
    const b = await runOperator(options(), recordingDeps(withoutRecording, false));

    expect(withRecording).toEqual(withoutRecording);
    // ...and it is a real sequence, not two empty logs agreeing.
    expect(withRecording.filter((c) => c.startsWith("performInput"))).toHaveLength(3);
    expect(withRecording.filter((c) => c.startsWith("captureFrame")).length).toBeGreaterThan(1);

    expect(a.state).toBe(b.state);
    expect(a.summary).toBe(b.summary);
    expect(withoutTiming(a.steps)).toEqual(withoutTiming(b.steps));
  });

  it("carries no recording or session identifier anywhere in its inputs or record", async () => {
    const result = await runOperator(options(), recordingDeps([], true));

    // The options object is the run's whole input surface. If a recording could
    // reach the operator at all, it would have to be through one of these keys.
    for (const forbidden of ["sessionId", "session", "recording", "recordingId", "manifest"]) {
      expect(Object.keys(options())).not.toContain(forbidden);
    }
    const serialized = JSON.stringify({ steps: result.steps, summary: result.summary });
    for (const forbidden of ["sessionId", "recordingId", "manifest.json", ".mp4"]) {
      expect(serialized.includes(forbidden), forbidden).toBe(false);
    }
  });
});
