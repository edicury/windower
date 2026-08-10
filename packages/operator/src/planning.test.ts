import type { OperatorRunOptions, OperatorStep } from "@windower/core";
import {
  BATCH_ABORTED_RESULT,
  DEFAULT_OPERATOR_MAX_BATCH_ACTIONS,
  parseModelConfig,
} from "@windower/core";
import { describe, expect, it } from "vitest";
import { OPERATOR_ERROR_CODES } from "./errors.js";
import { buildSystemPrompt } from "./prompt.js";
import { type OperatorRunInternals, runOperator } from "./run.js";
import { FAKE_TARGET, createFakeDeps, createScriptedModel } from "./test-helpers/fakes.js";

/**
 * contracts/operator.md §"Execution model — plan → execute → verify" and
 * §"Action batching", exercised against the in-process loop.
 */

const BOUNDS = { x: 0, y: 0, width: 1920, height: 1080 };

function makeOptions(
  overrides: Partial<OperatorRunOptions & OperatorRunInternals> = {},
): OperatorRunOptions & OperatorRunInternals {
  return {
    runId: "run-1",
    task: "Open Safari and create an incident",
    model: parseModelConfig("anthropic:claude-sonnet-5"),
    secrets: [],
    maxSteps: 10,
    timeoutMs: 60_000,
    maxBatchActions: DEFAULT_OPERATOR_MAX_BATCH_ACTIONS,
    unbounded: false,
    bounds: BOUNDS,
    target: FAKE_TARGET,
    signal: new AbortController().signal,
    ...overrides,
  };
}

/** The input tools §Execution model forbids before the run's first `plan` call. */
const INPUT_TOOL_NAMES: string[] = [
  "move_mouse",
  "click",
  "double_click",
  "drag",
  "scroll",
  "type_text",
  "press_key",
  "resize_window",
];

/** An error shaped like a proxied surface error: it carries its own code. */
function surfaceError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

describe("plan → execute → verify", () => {
  it("records a revision-0 plan on the step whose turn produced it", async () => {
    const steps: OperatorStep[] = [];
    const model = createScriptedModel([
      {
        text: "Planning first.",
        toolCalls: [
          {
            name: "plan",
            args: {
              steps: ["Activate Safari", "Cmd+L and type the URL", "Verify the page loaded"],
              rationale: "Address bar beats hunting for a link.",
            },
          },
        ],
      },
      { toolCalls: [{ name: "click", args: { x: 10, y: 10 } }] },
      { toolCalls: [{ name: "done", args: { summary: "ok" } }] },
    ]);

    const result = await runOperator(
      makeOptions({ languageModel: model, onStep: (s) => void steps.push(s) }),
      createFakeDeps(),
    );

    expect(result.state).toBe("succeeded");
    const plan = result.steps[0]?.plan;
    expect(plan?.revision).toBe(0);
    expect(plan?.atStepIndex).toBe(0);
    expect(plan?.steps).toEqual([
      "Activate Safari",
      "Cmd+L and type the URL",
      "Verify the page loaded",
    ]);
    expect(plan?.rationale).toBe("Address bar beats hunting for a link.");
    // The plan rides on the step it was produced in — and only that step.
    expect(result.steps[1]?.plan).toBeUndefined();
    expect(steps[0]?.plan?.revision).toBe(0);

    // "MUST NOT emit any input tool in a turn preceding the run's first `plan`
    // call" — a prompt-quality property the runtime never rejects, and therefore
    // one this suite is what asserts (contracts/operator.md §Execution model).
    const firstPlanStep = result.steps.findIndex((s) => s.plan !== undefined);
    expect(firstPlanStep).toBe(0);
    const before = result.steps
      .slice(0, firstPlanStep)
      .flatMap((s) => s.toolCalls.map((c) => c.name));
    expect(before.filter((n) => INPUT_TOOL_NAMES.includes(n))).toEqual([]);
  });

  it("does not spend a step or an action on planning", async () => {
    const deps = createFakeDeps();
    const model = createScriptedModel([
      {
        toolCalls: [
          { name: "plan", args: { steps: ["Focus", "Type"] } },
          { name: "press_key", args: { key: "l", modifiers: ["cmd"] } },
        ],
      },
      { toolCalls: [{ name: "done", args: { summary: "ok" } }] },
    ]);

    const result = await runOperator(
      makeOptions({ languageModel: model, maxBatchActions: 1 }),
      deps,
    );

    // maxBatchActions is 1 and the turn contained a plan + one action: the
    // action ran, so planning consumed nothing.
    expect(result.state).toBe("succeeded");
    expect(deps.calls.performInput).toHaveLength(1);
    expect(result.steps).toHaveLength(2);
  });

  it("replans in place, keeping every revision in the transcript", async () => {
    const model = createScriptedModel([
      { toolCalls: [{ name: "plan", args: { steps: ["Open the app"] } }] },
      { toolCalls: [{ name: "click", args: { x: 1, y: 1 } }] },
      {
        toolCalls: [
          {
            name: "plan",
            args: {
              steps: ["Dismiss the login wall", "Retry"],
              rationale: "A login wall appeared.",
            },
          },
        ],
      },
      { toolCalls: [{ name: "done", args: { summary: "ok" } }] },
    ]);

    const result = await runOperator(makeOptions({ languageModel: model }), createFakeDeps());

    // The ordered step.plan values ARE the history — no second array.
    const history = result.steps.flatMap((s) => (s.plan === undefined ? [] : [s.plan]));
    expect(history.map((p) => p.revision)).toEqual([0, 1]);
    expect(history[1]?.atStepIndex).toBe(2);
    expect(history[1]?.rationale).toBe("A login wall appeared.");
  });

  it("delegates revision identity when an authority owns it (the daemon)", async () => {
    const assigned: Array<{ steps: string[]; atStepIndex: number }> = [];
    const model = createScriptedModel([
      { toolCalls: [{ name: "plan", args: { steps: ["A"] } }] },
      { toolCalls: [{ name: "plan", args: { steps: ["B"] } }] },
      { toolCalls: [{ name: "done", args: { summary: "ok" } }] },
    ]);

    const result = await runOperator(
      makeOptions({
        languageModel: model,
        onPlan: (content, atStepIndex) => {
          assigned.push({ steps: content.steps, atStepIndex });
          return 100 + assigned.length;
        },
      }),
      createFakeDeps(),
    );

    expect(assigned).toEqual([
      { steps: ["A"], atStepIndex: 0 },
      { steps: ["B"], atStepIndex: 1 },
    ]);
    // The loop wears the assigned numbers rather than its own counter.
    expect(result.steps.flatMap((s) => (s.plan ? [s.plan.revision] : []))).toEqual([101, 102]);
  });

  it("accepts at most one plan revision per turn", async () => {
    const model = createScriptedModel([
      {
        toolCalls: [
          { name: "plan", args: { steps: ["First"] } },
          { name: "plan", args: { steps: ["Second"] } },
        ],
      },
      { toolCalls: [{ name: "done", args: { summary: "ok" } }] },
    ]);

    const result = await runOperator(makeOptions({ languageModel: model }), createFakeDeps());

    expect(result.steps[0]?.plan?.steps).toEqual(["First"]);
    expect(result.steps[0]?.toolCalls[1]?.result).toMatchObject({ ok: false });
  });

  it("produces identical plan records for a provider that exposes no rationale", async () => {
    // contracts/operator.md §"Provider independence": planning rides the
    // ordinary `plan` tool call because tool calling is the one capability every
    // supported provider exposes identically. `OperatorStep.reasoning` stays a
    // best-effort capture and MUST NOT be load-bearing — a provider that surfaces
    // no rationale at all must still produce the same plan records.
    const turns = [
      { name: "plan", args: { steps: ["Open the app", "Verify it opened"] } },
      { name: "click", args: { x: 5, y: 5 } },
      { name: "plan", args: { steps: ["Dismiss the wall"], rationale: "A login wall appeared." } },
      { name: "done", args: { summary: "ok" } },
    ];

    const chatty = await runOperator(
      makeOptions({
        languageModel: createScriptedModel(
          turns.map((call, i) => ({ text: `Thinking about step ${i}.`, toolCalls: [call] })),
        ),
      }),
      createFakeDeps(),
    );
    const silent = await runOperator(
      makeOptions({
        languageModel: createScriptedModel(turns.map((call) => ({ toolCalls: [call] }))),
      }),
      createFakeDeps(),
    );

    const plans = (r: typeof chatty) =>
      r.steps.flatMap((s) => (s.plan === undefined ? [] : [{ ...s.plan, tMs: 0 }]));

    expect(plans(silent)).toEqual(plans(chatty));
    expect(plans(silent).map((p) => p.revision)).toEqual([0, 1]);
    // The only difference is the optional narration, exactly as specified.
    expect(chatty.steps.every((s) => s.reasoning !== undefined)).toBe(true);
    expect(silent.steps.every((s) => s.reasoning === undefined)).toBe(true);
    expect(silent.state).toBe(chatty.state);
  });

  it("teaches plan-first, batching, and the batch ceiling in the prompt, vendor-neutrally", () => {
    const prompt = buildSystemPrompt({
      task: "Do the thing",
      secretNames: [],
      maxSteps: 40,
      timeoutMs: 300_000,
      maxBatchActions: 8,
      unbounded: false,
      bounds: BOUNDS,
    });

    expect(prompt).toContain("plan -> execute one or more actions -> verify checkpoint");
    expect(prompt).toContain("Do not emit any input tool before the run's first `plan` call");
    expect(prompt).toContain("At most 8 action tool calls per turn");
    expect(prompt).toContain("Only `failed-plan-invalid` warrants calling `plan` again");
    // Nothing here may lean on one vendor's features.
    for (const vendorism of ["thinking", "anthropic", "openai", "structured output"]) {
      expect(prompt.toLowerCase()).not.toContain(vendorism);
    }
  });
});

describe("action batching", () => {
  it("executes a whole batch in emission order for the cost of one step", async () => {
    const deps = createFakeDeps();
    const model = createScriptedModel([
      { toolCalls: [{ name: "plan", args: { steps: ["Navigate"] } }] },
      {
        toolCalls: [
          { name: "press_key", args: { key: "l", modifiers: ["cmd"] } },
          { name: "type_text", args: { text: "https://waroom.co" } },
          { name: "press_key", args: { key: "Return" } },
        ],
      },
      { toolCalls: [{ name: "done", args: { summary: "ok" } }] },
    ]);

    const result = await runOperator(makeOptions({ languageModel: model }), deps);

    expect(deps.calls.performInput).toEqual([
      [{ kind: "key_press", key: "l", modifiers: ["cmd"] }],
      [{ kind: "type_text", text: "https://waroom.co" }],
      [{ kind: "key_press", key: "Return", modifiers: undefined }],
    ]);
    // Three actions, ONE step — the whole economic point of batching.
    expect(result.steps).toHaveLength(3);
    expect(result.steps[1]?.toolCalls).toHaveLength(3);
    // And exactly one fresh observation follows the batch, for verification.
    expect(deps.calls.captureFrame).toHaveLength(3);
  });

  it("stops at action k, skips k+1..n, and keeps the run alive on a non-terminal failure", async () => {
    let performCount = 0;
    const deps = createFakeDeps({
      performInput: async () => {
        performCount += 1;
        if (performCount === 2) throw surfaceError("INPUT_UNSUPPORTED", "No such key.");
        return { performed: 1 };
      },
    });
    const model = createScriptedModel([
      { toolCalls: [{ name: "plan", args: { steps: ["Type"] } }] },
      {
        toolCalls: [
          { name: "click", args: { x: 1, y: 1 } },
          { name: "press_key", args: { key: "Nope" } },
          { name: "type_text", args: { text: "never typed" } },
          { name: "click", args: { x: 2, y: 2 } },
        ],
      },
      { toolCalls: [{ name: "done", args: { summary: "recovered" } }] },
    ]);

    const result = await runOperator(makeOptions({ languageModel: model }), deps);

    const batchStep = result.steps[1];
    expect(batchStep?.toolCalls.map((c) => c.name)).toEqual([
      "click",
      "press_key",
      "type_text",
      "click",
    ]);
    expect(batchStep?.toolCalls[0]?.result).toEqual({ performed: 1 });
    expect(batchStep?.toolCalls[1]?.result).toMatchObject({
      error: { code: "INPUT_UNSUPPORTED" },
    });
    // Skipped actions stay rows — never missing ones.
    expect(batchStep?.toolCalls[2]?.result).toEqual(BATCH_ABORTED_RESULT);
    expect(batchStep?.toolCalls[3]?.result).toEqual(BATCH_ABORTED_RESULT);
    // No rollback and no retroactive execution: exactly two RPCs were attempted.
    expect(performCount).toBe(2);
    expect(result.state).toBe("succeeded");
    // Still one step for the whole partial batch.
    expect(result.steps).toHaveLength(3);
  });

  it("lets a terminal guardrail failure end the run mid-batch, with the partial step intact", async () => {
    const deps = createFakeDeps();
    const model = createScriptedModel([
      { toolCalls: [{ name: "plan", args: { steps: ["Click"] } }] },
      {
        toolCalls: [
          { name: "click", args: { x: 1, y: 1 } },
          { name: "click", args: { x: 99_999, y: 1 } },
          { name: "click", args: { x: 2, y: 2 } },
        ],
      },
    ]);

    const result = await runOperator(makeOptions({ languageModel: model }), deps);

    // Batching MUST NOT downgrade a terminal guardrail failure.
    expect(result.state).toBe("failed");
    expect(result.error?.code).toBe(OPERATOR_ERROR_CODES.INPUT_OUT_OF_BOUNDS);
    const partial = result.steps.at(-1);
    expect(partial?.toolCalls.map((c) => c.result)).toEqual([
      { performed: 1 },
      { error: { code: "INPUT_OUT_OF_BOUNDS", message: expect.any(String) } },
      BATCH_ABORTED_RESULT,
    ]);
    // The out-of-bounds click never reached the sidecar; nor did the one after it.
    expect(deps.calls.performInput).toHaveLength(1);
  });

  it("caps a batch at maxBatchActions without ending the run", async () => {
    const deps = createFakeDeps();
    const model = createScriptedModel([
      { toolCalls: [{ name: "plan", args: { steps: ["Click a lot"] } }] },
      {
        toolCalls: [
          { name: "click", args: { x: 1, y: 1 } },
          { name: "click", args: { x: 2, y: 2 } },
          { name: "click", args: { x: 3, y: 3 } },
          { name: "click", args: { x: 4, y: 4 } },
        ],
      },
      { toolCalls: [{ name: "done", args: { summary: "ok" } }] },
    ]);

    const result = await runOperator(
      makeOptions({ languageModel: model, maxBatchActions: 2 }),
      deps,
    );

    expect(deps.calls.performInput).toHaveLength(2);
    const capped = result.steps[1];
    expect(capped?.toolCalls[2]?.result).toMatchObject({
      error: { code: OPERATOR_ERROR_CODES.BATCH_LIMIT_EXCEEDED },
    });
    expect(capped?.toolCalls[3]?.result).toEqual(BATCH_ABORTED_RESULT);
    // Non-terminal: the step closed and the run continued to `done`.
    expect(result.state).toBe("succeeded");
    expect(result.steps).toHaveLength(3);
  });

  it("does not charge observations or waits against the batch ceiling", async () => {
    const deps = createFakeDeps();
    const model = createScriptedModel([
      {
        toolCalls: [
          { name: "screenshot", args: {} },
          { name: "list_targets", args: {} },
          { name: "wait", args: { ms: 0 } },
          { name: "click", args: { x: 1, y: 1 } },
        ],
      },
      { toolCalls: [{ name: "done", args: { summary: "ok" } }] },
    ]);

    const result = await runOperator(
      makeOptions({ languageModel: model, maxBatchActions: 1 }),
      deps,
    );

    expect(result.state).toBe("succeeded");
    expect(deps.calls.performInput).toHaveLength(1);
    expect(result.steps[0]?.toolCalls.every((c) => c.result !== BATCH_ABORTED_RESULT)).toBe(true);
  });
});
