import type { OperatorRunOptions, OperatorStep } from "@windower/core";
import {
  DEFAULT_OPERATOR_MAX_BATCH_ACTIONS,
  OperatorCheckpointSchema,
  OperatorStepSchema,
  parseModelConfig,
} from "@windower/core";
import { describe, expect, it } from "vitest";
import { runLoopChild } from "./loop/child.js";
import { buildSystemPrompt } from "./prompt.js";
import { type OperatorRunInternals, runOperator } from "./run.js";
import { FakeLoopDaemon } from "./test-helpers/fake-loop-daemon.js";
import { FAKE_TARGET, createFakeDeps, createScriptedModel } from "./test-helpers/fakes.js";
import { ToolInputSchemas } from "./tools.js";

/**
 * contracts/operator.md §"Execution model" — the verification checkpoint as a
 * first-class stage of the loop: plan → execute → observe → checkpoint →
 * continue / replan.
 *
 * The load-bearing property throughout is that **the runtime never infers an
 * outcome**. A checkpoint exists exactly when the model called `checkpoint`,
 * and says exactly what the model said. Replanning is not a proxy for
 * `failed-plan-invalid`, and its absence is not a proxy for `held`.
 */

const BOUNDS = { x: 0, y: 0, width: 1920, height: 1080 };

function makeOptions(
  overrides: Partial<OperatorRunOptions & OperatorRunInternals> = {},
): OperatorRunOptions & OperatorRunInternals {
  return {
    runId: "run-1",
    task: "Open Safari and create an incident",
    models: { planner: parseModelConfig("anthropic:claude-sonnet-5") },
    secrets: [],
    maxSteps: 10,
    timeoutMs: 60_000,
    maxBatchActions: DEFAULT_OPERATOR_MAX_BATCH_ACTIONS,
    maxReplans: 3,
    observe: "vision",
    unbounded: false,
    bounds: BOUNDS,
    target: FAKE_TARGET,
    signal: new AbortController().signal,
    ...overrides,
  };
}

const PLAN_TURN = {
  toolCalls: [{ name: "plan", args: { steps: ["Focus the window", "Type the URL"] } }],
};
const DONE_TURN = { toolCalls: [{ name: "done", args: { summary: "ok" } }] };

describe("checkpoint tool surface", () => {
  it("takes `OperatorCheckpoint` itself as its params — no parallel shape", () => {
    // The single-representation rule (contracts/operator.md §Execution model):
    // the tool's params ARE the data-model schema, imported, not re-declared.
    expect(ToolInputSchemas.checkpoint).toBe(OperatorCheckpointSchema);
  });

  it("accepts the three outcomes and nothing else, with `detail` optional", () => {
    for (const outcome of ["held", "failed-plan-sound", "failed-plan-invalid"]) {
      expect(
        ToolInputSchemas.checkpoint.safeParse({ expectation: "The page loaded", outcome }).success,
      ).toBe(true);
    }
    expect(
      ToolInputSchemas.checkpoint.safeParse({ expectation: "x", outcome: "maybe" }).success,
    ).toBe(false);
    const withDetail = ToolInputSchemas.checkpoint.parse({
      expectation: "The page loaded",
      outcome: "failed-plan-sound",
      detail: "A cookie banner covered it.",
    });
    expect(withDetail.detail).toBe("A cookie banner covered it.");
  });
});

describe("checkpoints are recorded, never derived", () => {
  it.each([
    ["held", undefined],
    ["failed-plan-sound", "The button was there but disabled."],
    ["failed-plan-invalid", "This is a login wall, not the incidents list."],
  ] as const)("records outcome %s faithfully, with detail %s", async (outcome, detail) => {
    const model = createScriptedModel([
      PLAN_TURN,
      {
        toolCalls: [
          { name: "click", args: { x: 10, y: 10 } },
          {
            name: "checkpoint",
            args: {
              expectation: "The incidents list is visible",
              outcome,
              ...(detail === undefined ? {} : { detail }),
            },
          },
        ],
      },
      DONE_TURN,
    ]);

    const result = await runOperator(makeOptions({ languageModel: model }), createFakeDeps());

    expect(result.state).toBe("succeeded");
    expect(result.steps[1]?.checkpoint).toEqual({
      expectation: "The incidents list is visible",
      outcome,
      ...(detail === undefined ? {} : { detail }),
    });
    // Recording a checkpoint is bookkeeping: it never ends or fails the run.
    expect(result.error).toBeUndefined();
  });

  it("leaves a step with no checkpoint well-formed — no default, no inference", async () => {
    const model = createScriptedModel([
      PLAN_TURN,
      { toolCalls: [{ name: "click", args: { x: 10, y: 10 } }] },
      DONE_TURN,
    ]);

    const result = await runOperator(makeOptions({ languageModel: model }), createFakeDeps());

    for (const step of result.steps) {
      expect(step.checkpoint).toBeUndefined();
      // Optional on the wire and in the data model: the step still validates.
      expect(OperatorStepSchema.safeParse(step).success).toBe(true);
    }
  });

  it("does not fabricate `failed-plan-invalid` for the checkpoint that triggered a replan", async () => {
    // "The turn replanned" is NOT a usable proxy for a failed checkpoint —
    // and, Phase 22, a replan is now a SEPARATE later step (only the planner
    // may call `plan`, contracts/operator.md §Model tiers), so the checkpoint
    // that triggers escalation and the `plan` call that answers it are two
    // different steps' records, neither fabricated from the other.
    const model = createScriptedModel([
      PLAN_TURN,
      { toolCalls: [{ name: "click", args: { x: 10, y: 10 } }] },
      {
        toolCalls: [
          {
            name: "checkpoint",
            args: { expectation: "Warroom loaded", outcome: "failed-plan-invalid" },
          },
        ],
      },
      { toolCalls: [{ name: "plan", args: { steps: ["Dismiss the login wall"] } }] },
      DONE_TURN,
    ]);

    const result = await runOperator(makeOptions({ languageModel: model }), createFakeDeps());

    const checkpointStep = result.steps[2];
    expect(checkpointStep?.checkpoint?.outcome).toBe("failed-plan-invalid");
    expect(checkpointStep?.plan).toBeUndefined();

    const replanStep = result.steps[3];
    expect(replanStep?.plan?.revision).toBe(1);
    expect(replanStep?.checkpoint).toBeUndefined();
  });

  it("records a `held` checkpoint on a turn that also replanned, as stated", async () => {
    // The mirror image of the test above: the runtime does not overwrite,
    // second-guess, or downgrade a stated outcome because the same turn
    // happened to call `plan`. Only the escalated planner turn has both tools
    // available at once (contracts/operator.md §Model tiers), so that's the
    // turn exercised here.
    const model = createScriptedModel([
      PLAN_TURN,
      { toolCalls: [{ name: "click", args: { x: 10, y: 10 } }] },
      {
        toolCalls: [
          {
            name: "checkpoint",
            args: { expectation: "Login wall appeared", outcome: "failed-plan-invalid" },
          },
        ],
      },
      {
        toolCalls: [
          {
            name: "checkpoint",
            args: { expectation: "Safari is frontmost", outcome: "held" },
          },
          { name: "plan", args: { steps: ["Now use the address bar"] } },
        ],
      },
      DONE_TURN,
    ]);

    const result = await runOperator(makeOptions({ languageModel: model }), createFakeDeps());

    const step = result.steps[3];
    expect(step?.checkpoint).toEqual({ expectation: "Safari is frontmost", outcome: "held" });
    expect(step?.plan?.revision).toBe(1);
  });

  it("has no checkpoint on the opening observe-and-plan turn, which executed no batch", async () => {
    const model = createScriptedModel([
      PLAN_TURN,
      {
        toolCalls: [
          { name: "click", args: { x: 10, y: 10 } },
          { name: "checkpoint", args: { expectation: "Clicked through", outcome: "held" } },
        ],
      },
      DONE_TURN,
    ]);

    const result = await runOperator(makeOptions({ languageModel: model }), createFakeDeps());

    expect(result.steps[0]?.plan).toBeDefined();
    expect(result.steps[0]?.checkpoint).toBeUndefined();
    expect(result.steps[1]?.checkpoint?.outcome).toBe("held");
  });

  it("accepts at most one checkpoint per turn", async () => {
    const model = createScriptedModel([
      PLAN_TURN,
      {
        toolCalls: [
          { name: "checkpoint", args: { expectation: "First", outcome: "held" } },
          { name: "checkpoint", args: { expectation: "Second", outcome: "failed-plan-sound" } },
        ],
      },
      DONE_TURN,
    ]);

    const result = await runOperator(makeOptions({ languageModel: model }), createFakeDeps());

    expect(result.steps[1]?.checkpoint).toEqual({ expectation: "First", outcome: "held" });
    const second = result.steps[1]?.toolCalls[1];
    expect(second?.name).toBe("checkpoint");
    expect(second?.result).toMatchObject({ ok: false });
  });

  it("costs no action budget, exactly like `plan`", async () => {
    const model = createScriptedModel([
      PLAN_TURN,
      {
        toolCalls: [
          { name: "checkpoint", args: { expectation: "Window focused", outcome: "held" } },
          { name: "click", args: { x: 10, y: 10 } },
        ],
      },
      DONE_TURN,
    ]);

    const deps = createFakeDeps();
    // Budget of one action: the click still runs, so the checkpoint consumed none.
    const result = await runOperator(
      makeOptions({ languageModel: model, maxBatchActions: 1 }),
      deps,
    );

    expect(result.state).toBe("succeeded");
    expect(deps.calls.performInput).toHaveLength(1);
    expect(result.steps[1]?.checkpoint?.outcome).toBe("held");
  });

  it("produces identical checkpoint records for a provider that exposes no rationale", async () => {
    // contracts/operator.md §"Provider independence": verification rides an
    // ordinary tool call, so a provider that narrates nothing records the same
    // checkpoints as one that narrates everything.
    const turns = [
      PLAN_TURN,
      {
        toolCalls: [
          { name: "click", args: { x: 10, y: 10 } },
          {
            name: "checkpoint",
            args: {
              expectation: "The dialog opened",
              outcome: "failed-plan-invalid",
              detail: "An update prompt took focus.",
            },
          },
        ],
      },
      DONE_TURN,
    ];
    const chattyTurns = turns.map((turn, i) => ({ ...turn, text: `Thinking about turn ${i}.` }));

    const silent = await runOperator(
      makeOptions({ languageModel: createScriptedModel(turns) }),
      createFakeDeps(),
    );
    const chatty = await runOperator(
      makeOptions({ languageModel: createScriptedModel(chattyTurns) }),
      createFakeDeps(),
    );

    const checkpoints = (steps: readonly OperatorStep[]) =>
      steps.flatMap((s) => (s.checkpoint === undefined ? [] : [s.checkpoint]));

    expect(chatty.steps[0]?.reasoning).toBeDefined();
    expect(silent.steps[0]?.reasoning).toBeUndefined();
    expect(checkpoints(silent.steps)).toEqual(checkpoints(chatty.steps));
    expect(checkpoints(silent.steps)).toEqual([
      {
        expectation: "The dialog opened",
        outcome: "failed-plan-invalid",
        detail: "An update prompt took focus.",
      },
    ]);
  });
});

describe("checkpoints on the loop wire", () => {
  it("reaches the daemon as reportStep.step.checkpoint, with no event method", async () => {
    const daemon = new FakeLoopDaemon();
    const model = createScriptedModel([
      PLAN_TURN,
      {
        toolCalls: [
          { name: "click", args: { x: 10, y: 10 } },
          {
            name: "checkpoint",
            args: { expectation: "The list is visible", outcome: "held", detail: "12 rows." },
          },
        ],
      },
      DONE_TURN,
    ]);

    const result = await runLoopChild(daemon.streams, { languageModel: model });

    expect(result.state).toBe("succeeded");
    expect(daemon.calls.reportStep[0]?.checkpoint).toBeUndefined();
    expect(daemon.calls.reportStep[1]?.checkpoint).toEqual({
      expectation: "The list is visible",
      outcome: "held",
      detail: "12 rows.",
    });
    // The child reports facts; the daemon derives events. No checkpoint method
    // exists on this wire (contracts/operator-loop-protocol.md §Operator events).
    expect(Object.keys(daemon.calls)).not.toContain("reportCheckpoint");
    expect(daemon.calls.order).not.toContain("reportCheckpoint");
  });
});

describe("checkpoint prompt guidance", () => {
  it("teaches explicit outcomes, per-batch (not per-action), vendor-neutrally", () => {
    const prompt = buildSystemPrompt({
      task: "Do a thing",
      secretNames: [],
      maxSteps: 10,
      timeoutMs: 60_000,
      maxBatchActions: DEFAULT_OPERATOR_MAX_BATCH_ACTIONS,
      unbounded: false,
      bounds: BOUNDS,
    });

    expect(prompt).toContain("`checkpoint`");
    expect(prompt).toContain('`outcome: "held"`');
    expect(prompt).toContain('`outcome: "failed-plan-sound"`');
    expect(prompt).toContain('`outcome: "failed-plan-invalid"`');
    expect(prompt).toContain("Only `failed-plan-invalid` warrants calling `plan` again");
    expect(prompt).toContain("NOT required after every individual action");
    expect(prompt).toContain("Nothing infers them for you");
    expect(prompt).toContain("checkpoint");
    // Vendor-neutral: no dependence on thinking blocks or structured output.
    expect(prompt).not.toMatch(/extended thinking|structured output|json mode/i);
  });
});
