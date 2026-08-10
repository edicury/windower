import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { OperatorRunOptions, UIElement } from "@windower/core";
import { DEFAULT_OPERATOR_MAX_BATCH_ACTIONS, parseModelConfig } from "@windower/core";
import { describe, expect, it } from "vitest";
import { OPERATOR_ERROR_CODES } from "./errors.js";
import { type OperatorRunInternals, runOperator } from "./run.js";
import { FAKE_TARGET, createFakeDeps, createScriptedModel } from "./test-helpers/fakes.js";

/**
 * Phase 22 — observation policy, element tools, model tiers/escalation, and
 * the parity/degradation properties the phase's exit criteria call out
 * (tasks/phase-22-operator-ax-first.md "Exit criteria").
 */

const BOUNDS = { x: 0, y: 0, width: 1920, height: 1080 };

function makeOptions(
  overrides: Partial<OperatorRunOptions & OperatorRunInternals> = {},
): OperatorRunOptions & OperatorRunInternals {
  return {
    runId: "run-1",
    task: "Create an incident",
    models: { planner: parseModelConfig("anthropic:claude-sonnet-5") },
    secrets: [],
    maxSteps: 12,
    timeoutMs: 60_000,
    maxBatchActions: DEFAULT_OPERATOR_MAX_BATCH_ACTIONS,
    maxReplans: 3,
    observe: "auto",
    unbounded: false,
    bounds: BOUNDS,
    target: FAKE_TARGET,
    signal: new AbortController().signal,
    ...overrides,
  };
}

const BUTTON: UIElement = {
  ref: "e1",
  role: "button",
  label: "Create Incident",
  bounds: { x: 100, y: 200, width: 80, height: 24 },
  enabled: true,
};

const FIELD: UIElement = {
  ref: "e2",
  role: "textfield",
  label: "Title",
  bounds: { x: 100, y: 240, width: 200, height: 24 },
  enabled: true,
};

describe("observation policy", () => {
  it("defaults to elements, capturing only the planner's one grounding frame", async () => {
    const deps = createFakeDeps({ elements: [BUTTON, FIELD] });
    const model = createScriptedModel([
      { toolCalls: [{ name: "plan", args: { steps: ["Click Create Incident"] } }] },
      { toolCalls: [{ name: "click_element", args: { ref: "e1" } }] },
      { toolCalls: [{ name: "done", args: { summary: "ok" } }] },
    ]);

    const result = await runOperator(makeOptions({ languageModel: model }), deps);

    expect(result.state).toBe("succeeded");
    // Plan stage is worth one grounding frame (contracts/operator.md §Model
    // tiers) even under "auto" — everything after it is elements-only here.
    expect(deps.calls.captureFrame).toHaveLength(1);
    expect(deps.calls.enumerateElements.length).toBeGreaterThan(0);
    expect(result.steps[0]?.observations.some((o) => o.kind === "frame")).toBe(true);
    for (const step of result.steps.slice(1)) {
      expect(step.observations.every((o) => o.kind === "elements")).toBe(true);
    }
  });

  it("falls back to a frame when the element list is empty", async () => {
    const deps = createFakeDeps({ elements: [] });
    const model = createScriptedModel([
      { toolCalls: [{ name: "plan", args: { steps: ["Do it"] } }] },
      { toolCalls: [{ name: "done", args: { summary: "ok" } }] },
    ]);

    const result = await runOperator(makeOptions({ languageModel: model }), deps);

    expect(result.state).toBe("succeeded");
    expect(deps.calls.captureFrame.length).toBeGreaterThan(0);
    expect(result.steps.some((s) => s.observations.some((o) => o.kind === "frame"))).toBe(true);
  });

  it("falls back to a frame when enumerateElements is UNSUPPORTED_CAPABILITY, with no error and no platform branch", async () => {
    const deps = createFakeDeps({
      enumerateElements: async () => {
        throw Object.assign(new Error("no ui.elements"), { code: "UNSUPPORTED_CAPABILITY" });
      },
    });
    const model = createScriptedModel([
      { toolCalls: [{ name: "plan", args: { steps: ["Do it"] } }] },
      { toolCalls: [{ name: "click", args: { x: 50, y: 50 } }] },
      { toolCalls: [{ name: "done", args: { summary: "ok" } }] },
    ]);

    const result = await runOperator(makeOptions({ languageModel: model }), deps);

    expect(result.state).toBe("succeeded");
    expect(result.error).toBeUndefined();
    expect(deps.calls.captureFrame.length).toBeGreaterThan(0);
    expect(result.steps.every((s) => s.observations.every((o) => o.kind !== "elements"))).toBe(
      true,
    );
  });

  it('"ax" never captures a frame, even across a full run', async () => {
    const deps = createFakeDeps({ elements: [BUTTON, FIELD] });
    const model = createScriptedModel([
      { toolCalls: [{ name: "plan", args: { steps: ["Click Create Incident"] } }] },
      { toolCalls: [{ name: "click_element", args: { ref: "e1" } }] },
      { toolCalls: [{ name: "done", args: { summary: "ok" } }] },
    ]);

    const result = await runOperator(makeOptions({ languageModel: model, observe: "ax" }), deps);

    expect(result.state).toBe("succeeded");
    expect(deps.calls.captureFrame).toHaveLength(0);
    expect(result.steps.every((s) => s.observations.every((o) => o.kind === "elements"))).toBe(
      true,
    );
  });

  it('"vision" never reads elements — exact pre-Phase-22 behavior', async () => {
    const deps = createFakeDeps({ elements: [BUTTON, FIELD] });
    const model = createScriptedModel([
      { toolCalls: [{ name: "plan", args: { steps: ["Click Create Incident"] } }] },
      { toolCalls: [{ name: "done", args: { summary: "ok" } }] },
    ]);

    const result = await runOperator(
      makeOptions({ languageModel: model, observe: "vision" }),
      deps,
    );

    expect(result.state).toBe("succeeded");
    expect(deps.calls.enumerateElements).toHaveLength(0);
    expect(deps.calls.captureFrame.length).toBe(result.steps.length);
    expect(result.steps.every((s) => s.observations.every((o) => o.kind === "frame"))).toBe(true);
  });

  it("a checkpoint declared visual:true forces a frame on the NEXT step", async () => {
    const deps = createFakeDeps({ elements: [BUTTON, FIELD] });
    const model = createScriptedModel([
      { toolCalls: [{ name: "plan", args: { steps: ["Click, then verify visually"] } }] },
      { toolCalls: [{ name: "click_element", args: { ref: "e1" } }] },
      {
        toolCalls: [
          {
            name: "checkpoint",
            args: { expectation: "The badge turned green", outcome: "held", visual: true },
          },
        ],
      },
      { toolCalls: [{ name: "done", args: { summary: "ok" } }] },
    ]);

    const result = await runOperator(makeOptions({ languageModel: model }), deps);

    expect(result.state).toBe("succeeded");
    // Steps: 0 plan(elements), 1 click_element(elements), 2 checkpoint(elements,
    // visual:true recorded), 3 done — frame forced onto step 3's observation.
    const visualCheckpointStepIndex = result.steps.findIndex((s) => s.checkpoint?.visual === true);
    expect(visualCheckpointStepIndex).toBeGreaterThanOrEqual(0);
    const nextStep = result.steps[visualCheckpointStepIndex + 1];
    expect(nextStep?.observations.some((o) => o.kind === "frame")).toBe(true);
  });

  it("the `screenshot` tool forces a frame on the next observation, same mechanism as before", async () => {
    const deps = createFakeDeps({ elements: [BUTTON] });
    const model = createScriptedModel([
      { toolCalls: [{ name: "plan", args: { steps: ["Look, then decide"] } }] },
      { toolCalls: [{ name: "screenshot", args: {} }] },
      { toolCalls: [{ name: "done", args: { summary: "ok" } }] },
    ]);

    const result = await runOperator(makeOptions({ languageModel: model }), deps);

    expect(result.state).toBe("succeeded");
    expect(deps.calls.captureFrame.length).toBeGreaterThan(0);
    expect(result.steps[2]?.observations.some((o) => o.kind === "frame")).toBe(true);
  });
});

describe("element tools — resolve, clamp, act", () => {
  it("click_element re-resolves the ref, clicks its rect center, and consumes the batch budget", async () => {
    const deps = createFakeDeps({ elements: [BUTTON] });
    const model = createScriptedModel([
      { toolCalls: [{ name: "plan", args: { steps: ["Click Create Incident"] } }] },
      { toolCalls: [{ name: "click_element", args: { ref: "e1" } }] },
      { toolCalls: [{ name: "done", args: { summary: "ok" } }] },
    ]);

    const result = await runOperator(makeOptions({ languageModel: model }), deps);

    expect(result.state).toBe("succeeded");
    // Re-resolve via refs, then the center of {x:100,y:200,w:80,h:24} = (140, 212).
    expect(deps.calls.enumerateElements.some((c) => c.refs?.includes("e1"))).toBe(true);
    expect(deps.calls.performInput).toContainEqual([
      { kind: "mouse_click", x: 140, y: 212, button: "left", clickCount: 1 },
    ]);
  });

  it("double_click_element issues two discrete clicks at the resolved center", async () => {
    const deps = createFakeDeps({ elements: [BUTTON] });
    const model = createScriptedModel([
      { toolCalls: [{ name: "plan", args: { steps: ["Double-click"] } }] },
      { toolCalls: [{ name: "double_click_element", args: { ref: "e1" } }] },
      { toolCalls: [{ name: "done", args: { summary: "ok" } }] },
    ]);

    const result = await runOperator(makeOptions({ languageModel: model }), deps);

    expect(result.state).toBe("succeeded");
    expect(deps.calls.performInput).toContainEqual([
      { kind: "mouse_click", x: 140, y: 212, button: "left", clickCount: 1 },
      { kind: "mouse_click", x: 140, y: 212, button: "left", clickCount: 2 },
    ]);
  });

  it("type_into_element clicks then types, substituting secrets after the model's placeholder", async () => {
    const deps = createFakeDeps({ elements: [FIELD] });
    const model = createScriptedModel([
      { toolCalls: [{ name: "plan", args: { steps: ["Type the title"] } }] },
      { toolCalls: [{ name: "type_into_element", args: { ref: "e2", text: "{{title}}" } }] },
      { toolCalls: [{ name: "done", args: { summary: "ok" } }] },
    ]);

    const result = await runOperator(
      makeOptions({
        languageModel: model,
        secrets: [{ name: "title", value: "Sev1 outage" }],
      }),
      deps,
    );

    expect(result.state).toBe("succeeded");
    expect(deps.calls.performInput).toContainEqual([
      { kind: "mouse_click", x: 200, y: 252, button: "left", clickCount: 1 },
      { kind: "type_text", text: "Sev1 outage" },
    ]);
    // The recorded tool call keeps the placeholder, never the resolved value.
    const typeCall = result.steps
      .flatMap((s) => s.toolCalls)
      .find((c) => c.name === "type_into_element");
    expect(typeCall?.args).toEqual({ ref: "e2", text: "{{title}}" });
  });

  it("scroll_element resolves the ref and scrolls at its center", async () => {
    const deps = createFakeDeps({ elements: [FIELD] });
    const model = createScriptedModel([
      { toolCalls: [{ name: "plan", args: { steps: ["Scroll"] } }] },
      { toolCalls: [{ name: "scroll_element", args: { ref: "e2", deltaX: 0, deltaY: -50 } }] },
      { toolCalls: [{ name: "done", args: { summary: "ok" } }] },
    ]);

    const result = await runOperator(makeOptions({ languageModel: model }), deps);

    expect(result.state).toBe("succeeded");
    expect(deps.calls.performInput).toContainEqual([
      { kind: "scroll", x: 200, y: 252, deltaX: 0, deltaY: -50 },
    ]);
  });

  it("clamps a resolved element center against the target bounds, same as any pixel tool", async () => {
    const offscreen: UIElement = {
      ref: "e9",
      role: "button",
      label: "Off-screen",
      bounds: { x: 5000, y: 5000, width: 20, height: 20 },
      enabled: true,
    };
    const deps = createFakeDeps({ elements: [offscreen] });
    const model = createScriptedModel([
      { toolCalls: [{ name: "plan", args: { steps: ["Click it"] } }] },
      { toolCalls: [{ name: "click_element", args: { ref: "e9" } }] },
    ]);

    const result = await runOperator(makeOptions({ languageModel: model }), deps);

    expect(result.state).toBe("failed");
    expect(result.error?.code).toBe(OPERATOR_ERROR_CODES.INPUT_OUT_OF_BOUNDS);
    // The clamp rejects before any RPC — no element-based exemption.
    expect(deps.calls.performInput).toHaveLength(0);
  });

  it("the re-resolve call itself does not consume maxBatchActions", async () => {
    const deps = createFakeDeps({ elements: [BUTTON, FIELD] });
    const model = createScriptedModel([
      { toolCalls: [{ name: "plan", args: { steps: ["Click both"] } }] },
      {
        toolCalls: [
          { name: "click_element", args: { ref: "e1" } },
          { name: "click_element", args: { ref: "e2" } },
        ],
      },
      { toolCalls: [{ name: "done", args: { summary: "ok" } }] },
    ]);

    const result = await runOperator(
      makeOptions({ languageModel: model, maxBatchActions: 2 }),
      deps,
    );

    expect(result.state).toBe("succeeded");
    // Two element-tool actions, each preceded by an un-budgeted re-resolve —
    // both actions must have executed (not the second one skipped).
    expect(deps.calls.performInput).toHaveLength(2);
  });
});

describe("stale-ref recovery", () => {
  it("AX_ELEMENT_STALE from an element tool is non-terminal — the run recovers on the next observation", async () => {
    const deps = createFakeDeps({ elements: [BUTTON] });
    const model = createScriptedModel([
      { toolCalls: [{ name: "plan", args: { steps: ["Click Create Incident"] } }] },
      // Stale ref: not present in the current fixture.
      { toolCalls: [{ name: "click_element", args: { ref: "stale-ref" } }] },
      { toolCalls: [{ name: "done", args: { summary: "recovered" } }] },
    ]);

    const result = await runOperator(makeOptions({ languageModel: model }), deps);

    expect(result.state).toBe("succeeded");
    const failedCall = result.steps
      .flatMap((s) => s.toolCalls)
      .find((c) => c.name === "click_element");
    expect(failedCall?.result).toMatchObject({
      error: { code: "AX_ELEMENT_STALE" },
    });
    expect(deps.calls.performInput).toHaveLength(0);
  });

  it("a malformed (fabricated) ref gets the clearer 'not a valid element ref' message", async () => {
    const deps = createFakeDeps({ elements: [BUTTON] });
    const model = createScriptedModel([
      { toolCalls: [{ name: "plan", args: { steps: ["Click Log In"] } }] },
      // Not `<generation>:<index>` shaped — the exact class of fabricated ref
      // a real model produced in the live run that motivated this fix.
      { toolCalls: [{ name: "click_element", args: { ref: "Login_btn_ref" } }] },
      { toolCalls: [{ name: "done", args: { summary: "recovered" } }] },
    ]);

    const result = await runOperator(makeOptions({ languageModel: model }), deps);

    expect(result.state).toBe("succeeded");
    const failedCall = result.steps
      .flatMap((s) => s.toolCalls)
      .find((c) => c.name === "click_element");
    expect(failedCall?.result).toMatchObject({ error: { code: "AX_ELEMENT_STALE" } });
    const message = (failedCall?.result as { error: { message: string } }).error.message;
    expect(message).toContain("is not a valid element ref");
    expect(message).toContain("do not invent refs");
  });

  it("a well-formed but expired ref keeps the existing AX_ELEMENT_STALE staleness wording", async () => {
    const deps = createFakeDeps({ elements: [BUTTON] });
    const model = createScriptedModel([
      { toolCalls: [{ name: "plan", args: { steps: ["Click it"] } }] },
      // Correctly `<generation>:<index>` shaped, just not one that resolves.
      { toolCalls: [{ name: "click_element", args: { ref: "gen-9:99" } }] },
      { toolCalls: [{ name: "done", args: { summary: "recovered" } }] },
    ]);

    const result = await runOperator(makeOptions({ languageModel: model }), deps);

    expect(result.state).toBe("succeeded");
    const failedCall = result.steps
      .flatMap((s) => s.toolCalls)
      .find((c) => c.name === "click_element");
    expect(failedCall?.result).toMatchObject({ error: { code: "AX_ELEMENT_STALE" } });
    const message = (failedCall?.result as { error: { message: string } }).error.message;
    expect(message).not.toContain("is not a valid element ref");
    expect(message).not.toContain("do not invent refs");
  });
});

describe("model tiers — escalation and maxReplans", () => {
  it("a second consecutive failed-plan-sound checkpoint escalates to the planner", async () => {
    const deps = createFakeDeps({ elements: [BUTTON] });
    const model = createScriptedModel([
      { toolCalls: [{ name: "plan", args: { steps: ["Click it"] } }] },
      { toolCalls: [{ name: "click_element", args: { ref: "e1" } }] },
      {
        toolCalls: [
          { name: "checkpoint", args: { expectation: "It clicked", outcome: "failed-plan-sound" } },
        ],
      },
      { toolCalls: [{ name: "click_element", args: { ref: "e1" } }] },
      {
        toolCalls: [
          { name: "checkpoint", args: { expectation: "It clicked", outcome: "failed-plan-sound" } },
        ],
      },
      // The escalation turn: only reachable if the planner regained `plan`.
      { toolCalls: [{ name: "plan", args: { steps: ["Try a different element"] } }] },
      { toolCalls: [{ name: "done", args: { summary: "ok" } }] },
    ]);

    const result = await runOperator(makeOptions({ languageModel: model }), deps);

    expect(result.state).toBe("succeeded");
    const revisions = result.steps.flatMap((s) => (s.plan ? [s.plan.revision] : []));
    expect(revisions).toEqual([0, 1]);
  });

  it("maxReplans exceeded ends the run with OPERATOR_MAX_REPLANS_EXCEEDED rather than exhausting maxSteps", async () => {
    // A model that never converges: every checkpoint is failed-plan-invalid.
    const turns = [{ toolCalls: [{ name: "plan", args: { steps: ["Try"] } }] }];
    for (let i = 0; i < 6; i++) {
      turns.push({ toolCalls: [{ name: "click_element", args: { ref: "e1" } }] } as never);
      turns.push({
        toolCalls: [
          {
            name: "checkpoint",
            args: { expectation: "It worked", outcome: "failed-plan-invalid" },
          },
        ],
      } as never);
      turns.push({ toolCalls: [{ name: "plan", args: { steps: [`Retry ${i}`] } }] } as never);
    }
    const deps = createFakeDeps({ elements: [BUTTON] });
    const model = createScriptedModel(turns);

    const result = await runOperator(
      makeOptions({ languageModel: model, maxReplans: 2, maxSteps: 40 }),
      deps,
    );

    expect(result.state).toBe("failed");
    expect(result.error?.code).toBe(OPERATOR_ERROR_CODES.MAX_REPLANS_EXCEEDED);
    // Ended well short of the step ceiling — the point of the guardrail.
    expect(result.steps.length).toBeLessThan(40);
  });
});

describe("model tiers — single-model parity", () => {
  it("a run with only `models.planner` set resolves both tiers to the same model and produces the same call sequence as an explicit two-tier config pointing at identical models", async () => {
    const script = [
      { toolCalls: [{ name: "plan", args: { steps: ["Click it"] } }] },
      { toolCalls: [{ name: "click_element", args: { ref: "e1" } }] },
      { toolCalls: [{ name: "done", args: { summary: "ok" } }] },
    ];

    const singleDeps = createFakeDeps({ elements: [BUTTON] });
    const singleResult = await runOperator(
      makeOptions({ languageModel: createScriptedModel(script) }),
      singleDeps,
    );

    const explicitDeps = createFakeDeps({ elements: [BUTTON] });
    const explicitResult = await runOperator(
      makeOptions({
        models: {
          planner: parseModelConfig("anthropic:claude-sonnet-5"),
          executor: parseModelConfig("anthropic:claude-sonnet-5"),
        },
        languageModel: createScriptedModel(script),
      }),
      explicitDeps,
    );

    expect(singleResult.state).toBe(explicitResult.state);
    expect(singleDeps.calls.performInput).toEqual(explicitDeps.calls.performInput);
    expect(singleResult.steps.map((s) => s.toolCalls.map((c) => c.name))).toEqual(
      explicitResult.steps.map((s) => s.toolCalls.map((c) => c.name)),
    );
  });
});

describe("prompt caching — pure optimization, never load-bearing", () => {
  it("produces an identical transcript whether the planner's provider supports prompt caching or not", async () => {
    const script = [
      { toolCalls: [{ name: "plan", args: { steps: ["Click it"] } }] },
      { toolCalls: [{ name: "click_element", args: { ref: "e1" } }] },
      { toolCalls: [{ name: "done", args: { summary: "ok" } }] },
    ];
    const withoutTiming = (steps: unknown[]) =>
      (steps as Array<{ tMs: number; plan?: { tMs: number } }>).map(
        ({ tMs: _tMs, plan, ...rest }) => ({
          ...rest,
          plan: plan === undefined ? undefined : { ...plan, tMs: 0 },
        }),
      );

    // "anthropic" is the one provider `promptCacheProviderOptions` recognizes;
    // "openai-compatible" is deliberately not, and is a real registry entry
    // (providers.ts) rather than a made-up id.
    const cachingDeps = createFakeDeps({ elements: [BUTTON] });
    const cachingResult = await runOperator(
      makeOptions({
        models: { planner: parseModelConfig("anthropic:claude-sonnet-5") },
        languageModel: createScriptedModel(script),
      }),
      cachingDeps,
    );

    const nonCachingDeps = createFakeDeps({ elements: [BUTTON] });
    const nonCachingResult = await runOperator(
      makeOptions({
        models: {
          planner: parseModelConfig("openai-compatible:llama-3.3", {
            baseUrl: "http://localhost:1234/v1",
          }),
        },
        languageModel: createScriptedModel(script),
      }),
      nonCachingDeps,
    );

    expect(cachingResult.state).toBe(nonCachingResult.state);
    expect(cachingDeps.calls.performInput).toEqual(nonCachingDeps.calls.performInput);
    expect(withoutTiming(cachingResult.steps)).toEqual(withoutTiming(nonCachingResult.steps));
  });
});

describe("bug fix — element tools stay usable with no signal when AX is unavailable for the whole run", () => {
  const ELEMENT_TOOL_NAMES = [
    "observe_elements",
    "click_element",
    "double_click_element",
    "type_into_element",
    "scroll_element",
  ];

  it("never offers the 5 element tools, in either tier, once elementsUnsupported is true (capability-absent)", async () => {
    const deps = createFakeDeps({
      enumerateElements: async () => {
        throw Object.assign(new Error("no ui.elements"), { code: "UNSUPPORTED_CAPABILITY" });
      },
    });
    // Escalate once so both the planner (initial + escalation) and the
    // executor tier actually get a turn, and inspect every recorded call.
    const model = createScriptedModel([
      { toolCalls: [{ name: "plan", args: { steps: ["Do it"] } }] },
      { toolCalls: [{ name: "click", args: { x: 50, y: 50 } }] },
      {
        toolCalls: [
          { name: "checkpoint", args: { expectation: "It worked", outcome: "failed-plan-invalid" } },
        ],
      },
      { toolCalls: [{ name: "plan", args: { steps: ["Retry"] } }] },
      { toolCalls: [{ name: "done", args: { summary: "ok" } }] },
    ]);

    const result = await runOperator(makeOptions({ languageModel: model }), deps);

    expect(result.state).toBe("succeeded");
    expect(model.doGenerateCalls.length).toBeGreaterThan(0);
    for (const call of model.doGenerateCalls) {
      const offered = (call.tools ?? []).map((t) => t.name);
      for (const name of ELEMENT_TOOL_NAMES) {
        expect(offered, `turn offered ${name}`).not.toContain(name);
      }
    }
  });

  it("never offers the 5 element tools when the target is not a window (non-window is run-invariant too)", async () => {
    const deps = createFakeDeps({ elements: [BUTTON, FIELD] });
    const model = createScriptedModel([
      { toolCalls: [{ name: "plan", args: { steps: ["Click at a coordinate"] } }] },
      { toolCalls: [{ name: "click", args: { x: 50, y: 50 } }] },
      { toolCalls: [{ name: "done", args: { summary: "ok" } }] },
    ]);

    const result = await runOperator(
      makeOptions({
        languageModel: model,
        target: {
          kind: "display",
          id: "display:1",
          name: "Display 1",
          bounds: BOUNDS,
          isPrimary: true,
          scaleFactor: 2,
        },
      }),
      deps,
    );

    expect(result.state).toBe("succeeded");
    for (const call of model.doGenerateCalls) {
      const offered = (call.tools ?? []).map((t) => t.name);
      for (const name of ELEMENT_TOOL_NAMES) {
        expect(offered, `turn offered ${name}`).not.toContain(name);
      }
    }
  });

  it("keeps element tools available across a step-local elementsInsufficient dip (transient, not sticky)", async () => {
    // Elements start empty (forces a frame this step, `elementsInsufficient`)
    // then appear on a later step — the tool surface must never have been
    // narrowed for this, since it's not `elementsUnsupported`.
    const deps = createFakeDeps({ elements: [] });
    const model = createScriptedModel([
      { toolCalls: [{ name: "plan", args: { steps: ["Click Create Incident"] } }] },
      { toolCalls: [{ name: "click", args: { x: 50, y: 50 } }] },
      { toolCalls: [{ name: "done", args: { summary: "ok" } }] },
    ]);

    await runOperator(makeOptions({ languageModel: model }), deps);

    for (const call of model.doGenerateCalls) {
      const offered = (call.tools ?? []).map((t) => t.name);
      expect(offered).toContain("click_element");
    }
  });

  it("states elements are unavailable in the frame observation message once elementsUnsupported is true", async () => {
    const deps = createFakeDeps({
      enumerateElements: async () => {
        throw Object.assign(new Error("no ui.elements"), { code: "UNSUPPORTED_CAPABILITY" });
      },
    });
    const model = createScriptedModel([
      { toolCalls: [{ name: "plan", args: { steps: ["Do it"] } }] },
      { toolCalls: [{ name: "click", args: { x: 50, y: 50 } }] },
      { toolCalls: [{ name: "done", args: { summary: "ok" } }] },
    ]);

    await runOperator(makeOptions({ languageModel: model }), deps);

    const sawUnavailableNote = model.doGenerateCalls.some((call) =>
      call.prompt.some(
        (message) =>
          message.role === "user" &&
          Array.isArray(message.content) &&
          message.content.some(
            (part) =>
              part.type === "text" && part.text.includes("Accessibility elements are unavailable"),
          ),
      ),
    );
    expect(sawUnavailableNote).toBe(true);
  });
});

describe("ui.elements-absent — vision-only degradation, zero platform branches", () => {
  it("completes a scripted run with no error when the backend never advertises ui.elements", async () => {
    const deps = createFakeDeps({
      enumerateElements: async () => {
        throw Object.assign(new Error("Backend does not support ui.elements"), {
          code: "UNSUPPORTED_CAPABILITY",
        });
      },
    });
    const model = createScriptedModel([
      { toolCalls: [{ name: "plan", args: { steps: ["Click at a coordinate"] } }] },
      { toolCalls: [{ name: "click", args: { x: 50, y: 50 } }] },
      { toolCalls: [{ name: "done", args: { summary: "ok" } }] },
    ]);

    const result = await runOperator(makeOptions({ languageModel: model }), deps);

    expect(result.state).toBe("succeeded");
    expect(result.error).toBeUndefined();
  });

  it('has no `platform === "macos"` branch anywhere in packages/ or apps/', () => {
    const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
    let output = "";
    try {
      output = execFileSync(
        "grep",
        ["-r", "-n", "--include=*.ts", 'platform === "macos"', "packages", "apps"],
        { cwd: repoRoot, encoding: "utf8" },
      );
    } catch (err) {
      // grep exits 1 when it finds nothing — that's the passing case.
      const e = err as { status?: number };
      if (e.status === 1) {
        output = "";
      } else {
        throw err;
      }
    }
    // Drop matches inside a comment (e.g. `secret-resolver.ts`'s comment
    // describing the rule it follows) and this file's own literal search
    // string above — the check is for an actual branch, not a mention of the
    // phrase in prose or in the grep invocation itself.
    const codeLines = output
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .filter((line) => !line.includes("phase22.test.ts"))
      .filter((line) => {
        const afterColon = line.split(":").slice(2).join(":").trim();
        return !afterColon.startsWith("*") && !afterColon.startsWith("//");
      });
    expect(codeLines).toEqual([]);
  });
});
