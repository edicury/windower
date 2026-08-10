import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CaptureTarget,
  DaemonError,
  LOOP_PROTOCOL_VERSION,
  type OperatorDeps,
  type OperatorPlan,
  type OperatorStep,
  WINDOWER_HOME_ENV,
} from "@windower/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type OperatorEvent,
  OperatorLoopHost,
  type OperatorLoopOutcome,
} from "./operator-loop-host.js";
import { resetCaptureHoldsForTesting } from "./screen-capture-lock.js";
import { type FakeLoopChild, createFakeLoopChildFactory } from "./test-helpers/fake-loop-child.js";

/**
 * The daemon-side half of `contracts/operator-loop-protocol.md`.
 *
 * These tests drive a scripted fake child through sequences a well-behaved
 * loop would never produce — forged step indices, nested `beginStep`, actions
 * outside a step, a batch that runs past its ceiling, a `{{secret}}` nobody
 * declared — because the contract's claim is not "the child behaves" but "the
 * child *cannot* misbehave": *the thing being bounded is not trusted to bound
 * itself.*
 *
 * Note what cannot be scripted here: there is no recording-shaped method,
 * param, identifier, or error code on this wire to reach for.
 */

const TARGET: CaptureTarget = {
  kind: "display",
  id: "display-1",
  name: "Built-in",
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  isPrimary: true,
  scaleFactor: 2,
};

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** Lets a pushed notification cross the in-memory stream pair. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

const STEP = (index: number): OperatorStep => ({
  index,
  observations: [{ kind: "elements", ref: `memory:${index + 1}:deadbeef` }],
  toolCalls: [],
  tMs: index * 10,
});

interface HarnessOptions {
  maxSteps?: number;
  maxBatchActions?: number;
  maxReplans?: number;
  timeoutMs?: number;
  unbounded?: boolean;
  bounds?: { x: number; y: number; width: number; height: number };
  secrets?: Array<{ name: string; value: string }>;
  deps?: Partial<OperatorDeps>;
  loopProtocolVersion?: number;
  answerPings?: boolean;
  timings?: Record<string, number>;
  now?: () => number;
}

interface Harness {
  host: OperatorLoopHost;
  child: FakeLoopChild;
  outcome: Promise<OperatorLoopOutcome>;
  plans: OperatorPlan[];
  steps: OperatorStep[];
  events: OperatorEvent[];
  calls: string[];
  performed: unknown[][];
  framesDir: string;
  observationsDir: string;
}

describe("OperatorLoopHost", () => {
  let home: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "windower-loop-host-"));
    originalHome = process.env[WINDOWER_HOME_ENV];
    process.env[WINDOWER_HOME_ENV] = home;
  });

  afterEach(async () => {
    resetCaptureHoldsForTesting();
    if (originalHome === undefined) delete process.env[WINDOWER_HOME_ENV];
    else process.env[WINDOWER_HOME_ENV] = originalHome;
    await rm(home, { recursive: true, force: true });
  });

  function harness(options: HarnessOptions = {}): Harness {
    const { spawn, child } = createFakeLoopChildFactory({
      loopProtocolVersion: options.loopProtocolVersion,
      ...(options.answerPings === undefined ? {} : { answerPings: options.answerPings }),
    });
    const plans: OperatorPlan[] = [];
    const steps: OperatorStep[] = [];
    const events: OperatorEvent[] = [];
    const calls: string[] = [];
    const performed: unknown[][] = [];
    const framesDir = join(home, "operator-runs", "run-1", "frames");
    const observationsDir = join(home, "operator-runs", "run-1", "observations");

    const deps: OperatorDeps = {
      captureFrame: async () => {
        calls.push("captureFrame");
        return { imageBase64: TINY_PNG_BASE64, width: 1920, height: 1080, scale: 2 };
      },
      performInput: async (actions) => {
        calls.push("performInput");
        performed.push(actions as unknown[]);
        return { performed: actions.length };
      },
      listTargets: async () => {
        calls.push("listTargets");
        return [TARGET];
      },
      resizeWindow: async (_targetId, bounds) => {
        calls.push("resizeWindow");
        return { actualBounds: bounds, result: "success" as const };
      },
      enumerateElements: async () => {
        calls.push("enumerateElements");
        return { elements: [], generation: "gen-1", truncated: false };
      },
      ...options.deps,
    };

    const host = new OperatorLoopHost({
      config: {
        runId: "run-1",
        task: "do the thing",
        target: TARGET,
        models: { planner: { provider: "anthropic", model: "claude-sonnet-5" } },
        maxSteps: options.maxSteps ?? 10,
        maxBatchActions: options.maxBatchActions ?? 8,
        maxReplans: options.maxReplans ?? 3,
        timeoutMs: options.timeoutMs ?? 60_000,
        unbounded: options.unbounded ?? false,
        bounds: options.bounds ?? TARGET.bounds,
        env: { ANTHROPIC_API_KEY: "caller-key" },
        // One origin for the child's `tMs` and the daemon's `timeoutMs`.
        startedAtMs: options.now?.() ?? Date.now(),
      },
      secrets: options.secrets ?? [],
      deps,
      spawn,
      framesDir,
      observationsDir,
      persistPlan: async (plan) => {
        plans.push(plan);
      },
      persistStep: async (step) => {
        steps.push(step);
      },
      onEvent: (event) => events.push(event),
      onLog: () => {},
      ...(options.now === undefined ? {} : { now: options.now }),
      timings: {
        exitGraceMs: 20,
        abortGraceMs: 1_000,
        sigkillGraceMs: 20,
        pingIntervalMs: 0,
        pingTimeoutMs: 50,
        ...options.timings,
      },
    });

    return {
      host,
      child,
      outcome: host.run(),
      plans,
      steps,
      events,
      calls,
      performed,
      framesDir,
      observationsDir,
    };
  }

  /** The shortest well-formed run after the handshake: one step, a result. */
  async function nominal(h: Harness): Promise<void> {
    await h.child.request("beginStep", { index: 0 });
    await h.child.request("reportStep", { step: STEP(0) });
    await h.child.request("reportResult", { state: "succeeded", summary: "done" });
    h.child.exit(0);
  }

  // ---- Handshake -------------------------------------------------------

  it("answers `ready` with the run configuration, and never with a resolved secret", async () => {
    const h = harness({ secrets: [{ name: "password", value: "sup3r-s3cret" }] });
    const config = await h.child.handshake();

    expect(config.runId).toBe("run-1");
    expect(config.task).toBe("do the thing");
    // The daemon resolved the selector before the spawn, so the child never
    // enumerates to find out what it is driving.
    expect(config.target).toEqual(TARGET);
    expect(config.maxBatchActions).toBe(8);
    expect(config.env).toEqual({ ANTHROPIC_API_KEY: "caller-key" });
    // Names only — the process running provider SDK code holds no secret material.
    expect(config.secretNames).toEqual(["password"]);
    expect(JSON.stringify(config)).not.toContain("sup3r-s3cret");

    await nominal(h);
    await h.outcome;
  });

  it("fails the run loudly on a protocol-version mismatch instead of degrading", async () => {
    const h = harness({ loopProtocolVersion: LOOP_PROTOCOL_VERSION + 1 });
    await expect(h.child.handshake()).rejects.toMatchObject({
      code: "LOOP_PROTOCOL_VERSION_MISMATCH",
    });
    // No capability negotiation: a mismatch is a broken install, never a
    // supported configuration, so nothing degrades to a smaller method set.
    h.child.exit(1);
    const outcome = await h.outcome;
    expect(outcome.state).toBe("failed");
    expect(outcome.error?.code).toBe("OPERATOR_LOOP_CRASHED");
  });

  it("rejects anything before `ready` with LOOP_NOT_STARTED and a second `ready` as a violation", async () => {
    const h = harness();
    await expect(h.child.request("beginStep", { index: 0 })).rejects.toMatchObject({
      code: "LOOP_NOT_STARTED",
    });
    await h.child.handshake();
    await expect(h.child.handshake()).rejects.toMatchObject({ code: "LOOP_PROTOCOL_VIOLATION" });
    await h.child.request("reportResult", { state: "succeeded" });
    h.child.exit(0);
    await h.outcome;
  });

  it("rejects every request after `reportResult` with LOOP_ALREADY_ENDED", async () => {
    const h = harness();
    await h.child.handshake();
    await h.child.request("reportResult", { state: "succeeded" });
    await expect(h.child.request("beginStep", { index: 0 })).rejects.toMatchObject({
      code: "LOOP_ALREADY_ENDED",
    });
    h.child.exit(0);
    await h.outcome;
  });

  // ---- Step framing ----------------------------------------------------

  it("serves screen-facing methods only inside an open step", async () => {
    const h = harness();
    await h.child.handshake();

    for (const call of [
      () => h.child.request("captureFrame", { format: "png" }),
      () => h.child.request("enumerateTargets", {}),
      () => h.child.request("enumerateElements", {}),
      () => h.child.request("performInput", { actions: [{ kind: "mouse_move", x: 5, y: 5 }] }),
      () => h.child.request("resizeWindow", { targetId: "w", bounds: TARGET.bounds }),
      () => h.child.request("reportPlan", { steps: ["a"] }),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: "NO_OPEN_STEP" });
    }
    // Skipping `beginStep` and acting directly reaches nothing at all.
    expect(h.calls).toEqual([]);

    await h.child.request("reportResult", { state: "failed" });
    h.child.exit(0);
    await h.outcome;
  });

  it("refuses a forged step index and a nested beginStep", async () => {
    const h = harness();
    await h.child.handshake();
    await expect(h.child.request("beginStep", { index: 3 })).rejects.toMatchObject({
      code: "STEP_INDEX_MISMATCH",
    });
    await h.child.request("beginStep", { index: 0 });
    await expect(h.child.request("beginStep", { index: 1 })).rejects.toMatchObject({
      code: "LOOP_PROTOCOL_VIOLATION",
    });
    // Re-using an index after the step closed is equally impossible.
    await h.child.request("reportStep", { step: STEP(0) });
    await expect(h.child.request("beginStep", { index: 0 })).rejects.toMatchObject({
      code: "STEP_INDEX_MISMATCH",
    });
    await expect(h.child.request("reportStep", { step: STEP(1) })).rejects.toMatchObject({
      code: "LOOP_PROTOCOL_VIOLATION",
    });
    await h.child.request("reportResult", { state: "failed" });
    h.child.exit(0);
    await h.outcome;
  });

  it("counts steps on beginStep alone — a batch costs one step no matter how many actions", async () => {
    const h = harness({ maxBatchActions: 8 });
    await h.child.handshake();
    const opened = await h.child.request("beginStep", { index: 0 });
    expect(opened.guardrail.stepsUsed).toBe(1);

    for (let i = 0; i < 4; i++) {
      await h.child.request("performInput", { actions: [{ kind: "mouse_move", x: 5, y: 5 }] });
    }
    // Observations are not actions and never count toward the batch ceiling.
    await h.child.request("captureFrame", { format: "png" });
    await h.child.request("enumerateTargets", {});
    await h.child.request("enumerateElements", {});

    const state = await h.child.request("guardrailState", {});
    expect(state.stepsUsed).toBe(1);
    expect(state.actionsInStep).toBe(4);

    const closed = await h.child.request("reportStep", { step: STEP(0) });
    expect(closed.guardrail.stepsUsed).toBe(1);
    expect(closed.guardrail.actionsInStep).toBe(0);

    await h.child.request("reportResult", { state: "succeeded" });
    h.child.exit(0);
    await h.outcome;
  });

  // ---- The guardrail bypass table --------------------------------------

  it("stops a child that loops past maxSteps", async () => {
    const h = harness({ maxSteps: 1 });
    await h.child.handshake();
    await h.child.request("beginStep", { index: 0 });
    await h.child.request("reportStep", { step: STEP(0) });
    await expect(h.child.request("beginStep", { index: 1 })).rejects.toMatchObject({
      code: "OPERATOR_MAX_STEPS_EXCEEDED",
    });
    // The daemon begins finalization on its own — it does not wait to be told.
    await tick();
    expect(h.child.aborts.map((a) => a.reason)).toEqual(["max-steps"]);

    await h.child.request("reportResult", {
      state: "failed",
      error: { code: "OPERATOR_MAX_STEPS_EXCEEDED", message: "budget" },
    });
    h.child.exit(0);
    const outcome = await h.outcome;
    expect(outcome.state).toBe("failed");
    expect(outcome.error?.code).toBe("OPERATOR_MAX_STEPS_EXCEEDED");
    expect(outcome.crashed).toBe(false);
  });

  it("stops a child that runs past its wall-clock budget", async () => {
    let clock = 1_000;
    const h = harness({ timeoutMs: 500, now: () => clock, timings: { abortGraceMs: 5_000 } });
    await h.child.handshake();
    await h.child.request("beginStep", { index: 0 });
    clock += 10_000;
    await expect(h.child.request("captureFrame", { format: "png" })).rejects.toMatchObject({
      code: "OPERATOR_TIMEOUT",
    });
    await expect(h.child.request("beginStep", { index: 1 })).rejects.toMatchObject({
      code: "LOOP_PROTOCOL_VIOLATION",
    });
    h.child.exit(0);
    const outcome = await h.outcome;
    // The state the daemon signalled, not the state the child claimed.
    expect(outcome.state).toBe("timed_out");
    expect(outcome.crashed).toBe(false);
  });

  it("refuses every request after an abort was signalled", async () => {
    const h = harness({ timings: { abortGraceMs: 5_000 } });
    await h.child.handshake();
    await h.child.request("beginStep", { index: 0 });
    h.host.abort("user");
    await expect(h.child.request("captureFrame", { format: "png" })).rejects.toMatchObject({
      code: "OPERATOR_ABORTED",
    });
    await tick();
    expect(h.child.aborts.map((a) => a.reason)).toEqual(["user"]);
    // The abort is recorded when SIGNALLED, not when the child acknowledges —
    // a child that reports `succeeded` anyway does not get to overrule it.
    await h.child.request("reportResult", { state: "succeeded" });
    h.child.exit(0);
    expect((await h.outcome).state).toBe("aborted");
  });

  it("clamps every action request on arrival, never once per batch", async () => {
    const h = harness({ timings: { abortGraceMs: 5_000 } });
    await h.child.handshake();
    await h.child.request("beginStep", { index: 0 });
    // First action is inside the target and is served for real...
    await h.child.request("performInput", { actions: [{ kind: "mouse_move", x: 5, y: 5 }] });
    // ...and the *next* one in the same batch is still checked.
    await expect(
      h.child.request("performInput", {
        actions: [{ kind: "mouse_click", x: 99_999, y: 99_999, button: "left" }],
      }),
    ).rejects.toMatchObject({ code: "INPUT_OUT_OF_BOUNDS" });
    // A batch is not a transaction: the first action already happened.
    expect(h.calls).toEqual(["performInput"]);

    await h.child.request("reportResult", { state: "failed" });
    h.child.exit(0);
    expect((await h.outcome).state).toBe("failed");
  });

  it("honours --unbounded by skipping the clamp entirely", async () => {
    const h = harness({ unbounded: true });
    await h.child.handshake();
    await h.child.request("beginStep", { index: 0 });
    await h.child.request("performInput", {
      actions: [{ kind: "mouse_click", x: 99_999, y: 99_999, button: "left" }],
    });
    expect(h.calls).toEqual(["performInput"]);
    await h.child.request("reportResult", { state: "succeeded" });
    h.child.exit(0);
    await h.outcome;
  });

  it("caps a batch without ending the run, and leaves the step open", async () => {
    const h = harness({ maxBatchActions: 2 });
    await h.child.handshake();
    await h.child.request("beginStep", { index: 0 });
    await h.child.request("performInput", { actions: [{ kind: "mouse_move", x: 1, y: 1 }] });
    await h.child.request("resizeWindow", { targetId: "w", bounds: TARGET.bounds });
    await expect(
      h.child.request("performInput", { actions: [{ kind: "mouse_move", x: 2, y: 2 }] }),
    ).rejects.toMatchObject({ code: "OPERATOR_BATCH_LIMIT_EXCEEDED" });

    // NOT run-terminating: no abort was pushed, the step is still open, and the
    // child closes it normally and carries on.
    expect(h.child.aborts).toEqual([]);
    await h.child.request("reportStep", { step: STEP(0) });
    await h.child.request("beginStep", { index: 1 });
    await h.child.request("reportStep", { step: STEP(1) });
    await h.child.request("reportResult", { state: "succeeded" });
    h.child.exit(0);
    expect((await h.outcome).state).toBe("succeeded");
    expect(h.steps.map((s) => s.index)).toEqual([0, 1]);
  });

  it("ends the run on a terminal guardrail mid-batch, but not on a proxied surface error", async () => {
    const h = harness({
      timings: { abortGraceMs: 5_000 },
      deps: {
        resizeWindow: async () => {
          throw new DaemonError("RESIZE_UNSUPPORTED", "not resizable");
        },
      },
    });
    await h.child.handshake();
    await h.child.request("beginStep", { index: 0 });
    // A proxied surface error is returned as that action's result, verbatim,
    // and the run continues.
    await expect(
      h.child.request("resizeWindow", { targetId: "w", bounds: TARGET.bounds }),
    ).rejects.toMatchObject({ code: "RESIZE_UNSUPPORTED" });
    expect(h.child.aborts).toEqual([]);
    await h.child.request("performInput", { actions: [{ kind: "mouse_move", x: 1, y: 1 }] });

    // A terminal guardrail code is a different class entirely.
    await expect(
      h.child.request("performInput", { actions: [{ kind: "mouse_move", x: -50, y: -50 }] }),
    ).rejects.toMatchObject({ code: "INPUT_OUT_OF_BOUNDS" });

    await h.child.request("reportStep", { step: STEP(0) });
    await h.child.request("reportResult", {
      state: "failed",
      error: { code: "INPUT_OUT_OF_BOUNDS", message: "outside" },
    });
    h.child.exit(0);
    expect((await h.outcome).state).toBe("failed");
  });

  // ---- Secrets ---------------------------------------------------------

  it("substitutes {{name}} daemon-side and never lets the value reach the child", async () => {
    const h = harness({ secrets: [{ name: "password", value: "sup3r-s3cret" }] });
    const config = await h.child.handshake();
    expect(config.secretNames).toEqual(["password"]);
    await h.child.request("beginStep", { index: 0 });
    await h.child.request("performInput", {
      actions: [{ kind: "type_text", text: "hunter{{password}}" }],
    });
    // Substituted immediately before the control-surface RPC...
    expect(h.performed[0]).toEqual([{ kind: "type_text", text: "huntersup3r-s3cret" }]);
    await h.child.request("reportStep", {
      step: {
        ...STEP(0),
        toolCalls: [{ name: "type_text", args: { text: "sup3r-s3cret" }, result: { ok: true } }],
      },
    });
    // ...and redacted back out of anything that gets persisted.
    expect(JSON.stringify(h.steps)).not.toContain("sup3r-s3cret");
    expect(JSON.stringify(h.steps)).toContain("{{password}}");
    await h.child.request("reportResult", { state: "succeeded" });
    h.child.exit(0);
    await h.outcome;
  });

  it("rejects an unknown {{name}} rather than typing it literally", async () => {
    const h = harness({ secrets: [{ name: "password", value: "x" }] });
    await h.child.handshake();
    await h.child.request("beginStep", { index: 0 });
    await expect(
      h.child.request("performInput", { actions: [{ kind: "type_text", text: "{{apikey}}" }] }),
    ).rejects.toMatchObject({ code: "UNKNOWN_SECRET_REF" });
    // Never passed through: a literal `{{apikey}}` in a login form is a silent
    // failure that looks like a model mistake.
    expect(h.calls).toEqual([]);
    await h.child.request("reportResult", { state: "failed" });
    h.child.exit(0);
    await h.outcome;
  });

  // ---- Plans, events, persistence --------------------------------------

  it("assigns plan revisions itself and refuses a second plan in one step", async () => {
    const h = harness();
    await h.child.handshake();
    await h.child.request("beginStep", { index: 0 });
    const first = await h.child.request("reportPlan", { steps: ["a", "b"], rationale: "why" });
    expect(first).toEqual({ accepted: true, revision: 0 });
    await expect(h.child.request("reportPlan", { steps: ["c"] })).rejects.toMatchObject({
      code: "LOOP_PROTOCOL_VIOLATION",
    });
    await h.child.request("reportStep", { step: STEP(0) });
    await h.child.request("beginStep", { index: 1 });
    const second = await h.child.request("reportPlan", { steps: ["c"] });
    expect(second.revision).toBe(1);
    await h.child.request("reportStep", { step: STEP(1) });
    await h.child.request("reportResult", { state: "succeeded" });
    h.child.exit(0);
    await h.outcome;

    // Identity is the daemon's: revision, atStepIndex and tMs are stamped here.
    expect(h.plans.map((p) => [p.revision, p.atStepIndex])).toEqual([
      [0, 0],
      [1, 1],
    ]);
    // ...and the revision lands on the step whose turn produced it.
    expect(h.steps[0]?.plan?.revision).toBe(0);
    expect(h.steps[1]?.plan?.revision).toBe(1);
    // Planning consumes no budget.
    expect(h.steps).toHaveLength(2);
  });

  // Phase 22 — guardrails are daemon-authoritative; the loop-side replan
  // count in packages/operator is deliberate duplication, not the source of
  // truth (contracts/operator-loop-protocol.md).
  it("enforces maxReplans daemon-side, refusing a reportPlan past the ceiling", async () => {
    const h = harness({ maxReplans: 1 });
    await h.child.handshake();

    await h.child.request("beginStep", { index: 0 });
    const initial = await h.child.request("reportPlan", { steps: ["a"] });
    expect(initial.revision).toBe(0); // Revision 0 is free — not a replan.
    await h.child.request("reportStep", { step: STEP(0) });

    await h.child.request("beginStep", { index: 1 });
    const replan = await h.child.request("reportPlan", { steps: ["b"] });
    expect(replan.revision).toBe(1); // The one replan the budget allows.
    const guardrail = await h.child.request("guardrailState", {});
    expect(guardrail.replansUsed).toBe(1);
    expect(guardrail.maxReplans).toBe(1);
    await h.child.request("reportStep", { step: STEP(1) });

    await h.child.request("beginStep", { index: 2 });
    await expect(h.child.request("reportPlan", { steps: ["c"] })).rejects.toMatchObject({
      code: "OPERATOR_MAX_REPLANS_EXCEEDED",
    });

    await h.child.request("reportResult", {
      state: "failed",
      error: { code: "OPERATOR_MAX_REPLANS_EXCEEDED", message: "budget" },
    });
    h.child.exit(0);
    const outcome = await h.outcome;
    expect(outcome.state).toBe("failed");
    expect(outcome.error?.code).toBe("OPERATOR_MAX_REPLANS_EXCEEDED");
  });

  it("exposes replansUsed/maxReplans in guardrailState even before any plan", async () => {
    const h = harness({ maxReplans: 3 });
    await h.child.handshake();
    const guardrail = await h.child.request("guardrailState", {});
    expect(guardrail.replansUsed).toBe(0);
    expect(guardrail.maxReplans).toBe(3);
    await h.child.request("reportResult", { state: "succeeded" });
    h.child.exit(0);
    await h.outcome;
  });

  it("derives the five event kinds from reported facts, with daemon-assigned seq", async () => {
    const h = harness();
    await h.child.handshake();
    await h.child.request("beginStep", { index: 0 });
    await h.child.request("reportPlan", { steps: ["open it"] });
    await h.child.request("reportStep", {
      step: {
        ...STEP(0),
        reasoning: "clicking the button",
        toolCalls: [{ name: "click", args: { x: 1, y: 2 }, result: { performed: 1 } }],
        checkpoint: { expectation: "dialog opens", outcome: "held" },
      },
    });
    await h.child.request("reportResult", { state: "succeeded", summary: "done" });
    h.child.exit(0);
    await h.outcome;

    expect(h.events.map((e) => e.kind)).toEqual([
      "plan",
      "narration",
      "action",
      "checkpoint",
      "result",
    ]);
    expect(h.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(h.events.filter((e) => e.kind === "result")).toHaveLength(1);
    // No event carries any identifier other than `runId`.
    for (const event of h.events) expect(event.runId).toBe("run-1");
  });

  it("writes observation frames itself and resolves the child's ref to the file it wrote", async () => {
    const h = harness();
    await h.child.handshake();
    await h.child.request("beginStep", { index: 0 });
    const frame = await h.child.request("captureFrame", { format: "png" });
    expect(frame.imageBase64).toBe(TINY_PNG_BASE64);

    // The child names the frame by content hash; the daemon already holds the
    // bytes, because the frame came from its own proxy. Refs flow up, image
    // data never does.
    const files = await readdir(h.framesDir);
    expect(files).toHaveLength(1);
    const hash = (files[0] as string).replace(/\.png$/, "");
    await h.child.request("reportStep", {
      step: { ...STEP(0), observations: [{ kind: "frame", ref: `memory:1:${hash}` }] },
    });
    expect(h.steps[0]?.observations).toEqual([{ kind: "frame", ref: `frames/${hash}.png` }]);

    await h.child.request("reportResult", { state: "succeeded" });
    h.child.exit(0);
    await h.outcome;
  });

  // Phase 22 — same convention, for `enumerateElements` snapshots
  // (contracts/operator-loop-protocol.md: "The daemon persists the element
  // snapshot under the run's `observations/` and returns it; the child
  // writes nothing to disk.").
  it("does not count enumerateElements toward maxBatchActions, and persists the snapshot under observations/", async () => {
    const h = harness({
      maxBatchActions: 1,
      deps: {
        enumerateElements: async () => ({
          elements: [
            {
              ref: "gen-1:0",
              role: "button",
              label: "Create Incident",
              bounds: { x: 10, y: 10, width: 100, height: 20 },
              enabled: true,
            },
          ],
          generation: "gen-1",
          truncated: false,
        }),
      },
    });
    await h.child.handshake();
    await h.child.request("beginStep", { index: 0 });
    // One action already spends the whole (tiny) batch budget...
    await h.child.request("performInput", { actions: [{ kind: "mouse_move", x: 5, y: 5 }] });
    // ...yet enumerateElements is still servable: it is an observation.
    const result = await h.child.request("enumerateElements", { filter: "interactable" });
    expect(result.elements).toHaveLength(1);

    const files = await readdir(h.observationsDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.json$/);

    const hash = (files[0] as string).replace(/\.json$/, "");
    await h.child.request("reportStep", {
      step: { ...STEP(0), observations: [{ kind: "elements", ref: `memory:1:${hash}` }] },
    });
    expect(h.steps[0]?.observations).toEqual([
      { kind: "elements", ref: `observations/${hash}.json` },
    ]);

    await h.child.request("reportResult", { state: "succeeded" });
    h.child.exit(0);
    await h.outcome;
  });

  // ---- Shutdown and crash ----------------------------------------------

  it("SIGKILLs a child that lingers past the exit grace after reportResult", async () => {
    const h = harness({ timings: { exitGraceMs: 10 } });
    await h.child.handshake();
    await h.child.request("reportResult", { state: "succeeded", summary: "ok" });
    // The child never exits on its own.
    const outcome = await h.outcome;
    expect(outcome.state).toBe("succeeded");
    expect(outcome.crashed).toBe(false);
    expect(h.child.signals).toContain("SIGKILL");
  });

  it("escalates abort → SIGTERM → SIGKILL and still records the state it signalled", async () => {
    const h = harness({ timings: { abortGraceMs: 10, sigkillGraceMs: 10 } });
    await h.child.handshake();
    h.host.abort("user");
    const outcome = await h.outcome;
    expect(h.child.aborts.map((a) => a.reason)).toEqual(["user"]);
    expect(h.child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    // "A run that reaches SIGKILL is still recorded with the state the daemon
    // signalled, not as OPERATOR_LOOP_CRASHED — the daemon asked for this exit."
    expect(outcome.state).toBe("aborted");
    expect(outcome.crashed).toBe(false);
    expect(outcome.error?.code).toBeUndefined();
  });

  it("maps every abort reason to the state the daemon applies regardless of the child", async () => {
    const cases = [
      ["user", "aborted"],
      ["timeout", "timed_out"],
      ["max-steps", "failed"],
      ["daemon-shutdown", "aborted"],
    ] as const;
    for (const [reason, expected] of cases) {
      const h = harness({ timings: { abortGraceMs: 10, sigkillGraceMs: 10 } });
      await h.child.handshake();
      h.host.abort(reason);
      const outcome = await h.outcome;
      expect(outcome.state, reason).toBe(expected);
      expect(outcome.crashed).toBe(false);
    }
  });

  it("reports OPERATOR_LOOP_CRASHED with a partial transcript when the child is killed mid-run", async () => {
    const h = harness();
    await h.child.handshake();
    await h.child.request("beginStep", { index: 0 });
    await h.child.request("reportPlan", { steps: ["step one"] });
    await h.child.request("reportStep", { step: STEP(0) });
    await h.child.request("beginStep", { index: 1 });
    // kill -9, mid-step, no `reportResult`.
    h.child.exit(null, "SIGKILL");

    const outcome = await h.outcome;
    expect(outcome).toMatchObject({ state: "failed", crashed: true });
    expect(outcome.error?.code).toBe("OPERATOR_LOOP_CRASHED");
    expect(outcome.error?.message).toContain("SIGKILL");
    // A crashed run keeps everything reported so far.
    expect(h.plans.map((p) => p.revision)).toEqual([0]);
    expect(h.steps.map((s) => s.index)).toEqual([0]);
    // The stream still ends with exactly one `result` — synthesized here.
    const results = h.events.filter((e) => e.kind === "result");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ kind: "result", state: "failed" });
  });

  it("treats a non-zero exit without reportResult as a crash", async () => {
    const h = harness();
    await h.child.handshake();
    h.child.exit(7);
    const outcome = await h.outcome;
    expect(outcome.crashed).toBe(true);
    expect(outcome.error?.code).toBe("OPERATOR_LOOP_CRASHED");
    expect(outcome.error?.message).toContain("7");
  });

  it("treats an unanswered liveness ping as a crash — pid liveness is not health", async () => {
    const h = harness({
      answerPings: false,
      timings: { pingIntervalMs: 5, pingTimeoutMs: 10 },
    });
    await h.child.handshake();
    const outcome = await h.outcome;
    expect(h.child.pings).toBeGreaterThan(0);
    expect(outcome.error?.code).toBe("OPERATOR_LOOP_CRASHED");
    expect(h.child.signals).toContain("SIGKILL");
  });

  it("survives an unparseable stdout line and crashes only at EOF", async () => {
    const h = harness();
    await h.child.handshake();
    // stderr is free-form; stdout is protocol. A garbage line is logged, not
    // fatal on its own.
    (h.child.stdout as unknown as { write: (s: string) => void }).write("not json at all\n");
    h.child.writeStderr("some human-readable log line");
    await h.child.request("beginStep", { index: 0 });
    h.child.exit(null, "SIGKILL");
    expect((await h.outcome).error?.code).toBe("OPERATOR_LOOP_CRASHED");
  });
});
