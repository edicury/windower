import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OperatorRunOptions, OperatorStep, ResolvedSecret } from "@windower/core";
import { OperatorRunSchema, parseModelConfig } from "@windower/core";
import { describe, expect, it } from "vitest";
import { OPERATOR_ERROR_CODES } from "./errors.js";
import { type OperatorRunInternals, runOperator } from "./run.js";
import { createFakeDeps, createScriptedModel } from "./test-helpers/fakes.js";
import { framesDirFor } from "./transcript.js";

const BOUNDS = { x: 0, y: 0, width: 1920, height: 1080 };

async function tempTranscriptPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "windower-operator-"));
  return join(dir, "demo.mp4.operator.json");
}

function makeOptions(
  overrides: Partial<OperatorRunOptions & OperatorRunInternals> = {},
): OperatorRunOptions & OperatorRunInternals {
  return {
    runId: "run-1",
    task: "Do the thing",
    model: parseModelConfig("anthropic:claude-sonnet-5"),
    secrets: [],
    maxSteps: 10,
    timeoutMs: 60_000,
    unbounded: false,
    bounds: BOUNDS,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("runOperator — termination", () => {
  it("runs observe → decide → act and succeeds on `done`", async () => {
    const deps = createFakeDeps();
    const steps: OperatorStep[] = [];
    const model = createScriptedModel([
      { text: "I can see the button.", toolCalls: [{ name: "click", args: { x: 10, y: 20 } }] },
      { toolCalls: [{ name: "type_text", args: { text: "hello" } }] },
      { toolCalls: [{ name: "done", args: { summary: "Clicked and typed." } }] },
    ]);

    const result = await runOperator(
      makeOptions({ languageModel: model, onStep: (s) => void steps.push(s) }),
      deps,
    );

    expect(result.state).toBe("succeeded");
    expect(result.summary).toBe("Clicked and typed.");
    expect(result.steps).toHaveLength(3);
    expect(steps).toHaveLength(3);
    // One observation per step.
    expect(deps.calls.captureFrame).toHaveLength(3);
    expect(deps.calls.performInput).toEqual([
      [{ kind: "mouse_click", x: 10, y: 20, button: "left", clickCount: 1 }],
      [{ kind: "type_text", text: "hello" }],
    ]);
    expect(result.steps[0]?.reasoning).toBe("I can see the button.");
    expect(result.steps[0]?.toolCalls[0]?.name).toBe("click");
    expect(result.steps.map((s) => s.index)).toEqual([0, 1, 2]);
  });

  it("fails on `fail`, recording the model's reason", async () => {
    const model = createScriptedModel([
      { toolCalls: [{ name: "fail", args: { reason: "Login form never appeared." } }] },
    ]);
    const result = await runOperator(makeOptions({ languageModel: model }), createFakeDeps());
    expect(result.state).toBe("failed");
    expect(result.error?.code).toBe(OPERATOR_ERROR_CODES.MODEL_FAILED);
    expect(result.error?.message).toContain("Login form never appeared.");
  });

  it("fails when maxSteps is exhausted without `done`", async () => {
    const model = createScriptedModel([
      { toolCalls: [{ name: "wait", args: { ms: 0 } }] }, // repeats forever
    ]);
    const result = await runOperator(
      makeOptions({ languageModel: model, maxSteps: 3 }),
      createFakeDeps(),
    );
    expect(result.state).toBe("failed");
    expect(result.error?.code).toBe(OPERATOR_ERROR_CODES.MAX_STEPS_EXCEEDED);
    expect(result.steps).toHaveLength(3);
  });

  it("times out on the wall clock, independent of the step budget", async () => {
    let clock = 1_000_000;
    const model = createScriptedModel([{ toolCalls: [{ name: "wait", args: { ms: 0 } }] }], {
      onCall: () => {
        clock += 4_000;
      },
    });
    const result = await runOperator(
      makeOptions({
        languageModel: model,
        maxSteps: 100,
        timeoutMs: 10_000,
        now: () => clock,
      }),
      createFakeDeps(),
    );
    expect(result.state).toBe("timed_out");
    expect(result.error?.code).toBe(OPERATOR_ERROR_CODES.TIMEOUT);
    expect(result.steps.length).toBeLessThan(100);
  });

  it("aborts promptly when the kill switch fires mid-run", async () => {
    const controller = new AbortController();
    const deps = createFakeDeps({
      onPerformInput: () => {
        controller.abort();
      },
    });
    const model = createScriptedModel([{ toolCalls: [{ name: "click", args: { x: 1, y: 1 } }] }]);
    const result = await runOperator(
      makeOptions({ languageModel: model, signal: controller.signal, maxSteps: 50 }),
      deps,
    );
    expect(result.state).toBe("aborted");
    expect(result.error?.code).toBe(OPERATOR_ERROR_CODES.ABORTED);
    // The abort landed on the very next loop iteration — no second input RPC.
    expect(deps.calls.performInput).toHaveLength(1);
  });

  it("checks abort before the first RPC when the signal is already aborted", async () => {
    const deps = createFakeDeps();
    const model = createScriptedModel([{ toolCalls: [{ name: "click", args: { x: 1, y: 1 } }] }]);
    const result = await runOperator(
      makeOptions({ languageModel: model, signal: AbortSignal.abort() }),
      deps,
    );
    expect(result.state).toBe("aborted");
    expect(deps.calls.captureFrame).toHaveLength(0);
  });
});

describe("runOperator — guardrails", () => {
  it("ends the run failed with INPUT_OUT_OF_BOUNDS on an out-of-bounds coordinate", async () => {
    const deps = createFakeDeps();
    const model = createScriptedModel([
      { toolCalls: [{ name: "click", args: { x: 99_999, y: 5 } }] },
    ]);
    const result = await runOperator(makeOptions({ languageModel: model }), deps);
    expect(result.state).toBe("failed");
    expect(result.error?.code).toBe(OPERATOR_ERROR_CODES.INPUT_OUT_OF_BOUNDS);
    // Rejected *before* the RPC — nothing reached the sidecar.
    expect(deps.calls.performInput).toHaveLength(0);
    // The rejected call is still recorded, for the transcript.
    expect(result.steps.at(-1)?.toolCalls.at(-1)?.name).toBe("click");
  });

  it("allows out-of-bounds coordinates under --unbounded", async () => {
    const deps = createFakeDeps();
    const model = createScriptedModel([
      { toolCalls: [{ name: "click", args: { x: 99_999, y: 5 } }] },
      { toolCalls: [{ name: "done", args: { summary: "ok" } }] },
    ]);
    const result = await runOperator(makeOptions({ languageModel: model, unbounded: true }), deps);
    expect(result.state).toBe("succeeded");
    expect(deps.calls.performInput).toHaveLength(1);
  });

  it("checks every coordinate of a drag, not just the origin", async () => {
    const deps = createFakeDeps();
    const model = createScriptedModel([
      { toolCalls: [{ name: "drag", args: { fromX: 5, fromY: 5, toX: 5, toY: 99_999 } }] },
    ]);
    const result = await runOperator(makeOptions({ languageModel: model }), deps);
    expect(result.error?.code).toBe(OPERATOR_ERROR_CODES.INPUT_OUT_OF_BOUNDS);
    expect(deps.calls.performInput).toHaveLength(0);
  });
});

describe("runOperator — tool → deps mapping", () => {
  it("maps each tool onto the deps method contracts/operator.md specifies", async () => {
    const deps = createFakeDeps();
    const model = createScriptedModel([
      {
        toolCalls: [
          { name: "move_mouse", args: { x: 1, y: 2 } },
          { name: "double_click", args: { x: 3, y: 4 } },
          { name: "scroll", args: { x: 5, y: 6, deltaX: 0, deltaY: -10 } },
          { name: "press_key", args: { key: "Return", modifiers: ["cmd"] } },
          { name: "list_targets", args: { kinds: ["window"] } },
          {
            name: "resize_window",
            args: { targetId: "window:1", bounds: { x: 0, y: 0, width: 100, height: 100 } },
          },
          { name: "screenshot", args: { maxWidth: 640 } },
        ],
      },
      { toolCalls: [{ name: "done", args: { summary: "ok" } }] },
    ]);

    const result = await runOperator(makeOptions({ languageModel: model }), deps);

    expect(result.state).toBe("succeeded");
    expect(deps.calls.performInput).toEqual([
      [{ kind: "mouse_move", x: 1, y: 2 }],
      [
        { kind: "mouse_click", x: 3, y: 4, button: "left", clickCount: 1 },
        { kind: "mouse_click", x: 3, y: 4, button: "left", clickCount: 2 },
      ],
      [{ kind: "scroll", x: 5, y: 6, deltaX: 0, deltaY: -10 }],
      [{ kind: "key_press", key: "Return", modifiers: ["cmd"] }],
    ]);
    expect(deps.calls.listTargets).toEqual([["window"]]);
    expect(deps.calls.resizeWindow).toEqual([
      { targetId: "window:1", bounds: { x: 0, y: 0, width: 100, height: 100 } },
    ]);
    // `screenshot` makes no extra captureFrame call of its own; it steers the
    // next observation's maxWidth.
    expect(deps.calls.captureFrame.at(-1)?.maxWidth).toBe(640);
  });

  it("`wait` performs a local sleep with no RPC", async () => {
    const deps = createFakeDeps();
    const model = createScriptedModel([
      { toolCalls: [{ name: "wait", args: { ms: 1 } }] },
      { toolCalls: [{ name: "done", args: { summary: "ok" } }] },
    ]);
    await runOperator(makeOptions({ languageModel: model }), deps);
    expect(deps.calls.performInput).toHaveLength(0);
  });

  it("fails the run when a deps call rejects", async () => {
    const deps = createFakeDeps({
      performInput: async () => {
        throw new Error("sidecar died");
      },
    });
    const model = createScriptedModel([{ toolCalls: [{ name: "click", args: { x: 1, y: 1 } }] }]);
    const result = await runOperator(makeOptions({ languageModel: model }), deps);
    expect(result.state).toBe("failed");
    expect(result.error?.code).toBe(OPERATOR_ERROR_CODES.DEPENDENCY_ERROR);
  });
});

describe("runOperator — secrets and redaction", () => {
  const SECRET = "hunter2-Sup3rSecret-Value";
  const secrets: ResolvedSecret[] = [{ name: "password", value: SECRET }];

  it("substitutes the secret only at the performInput boundary", async () => {
    const typed: string[] = [];
    const deps = createFakeDeps({
      onPerformInput: (actions) => {
        for (const action of actions) {
          if (action.kind === "type_text") typed.push(action.text);
        }
      },
    });
    const model = createScriptedModel([
      { toolCalls: [{ name: "type_text", args: { text: "{{password}}" } }] },
      { toolCalls: [{ name: "done", args: { summary: "logged in" } }] },
    ]);

    const result = await runOperator(
      makeOptions({ languageModel: model, secrets, task: "Log in with {{password}}" }),
      deps,
    );

    // The real value reached the sidecar exactly once...
    expect(typed).toEqual([SECRET]);
    // ...and the recorded args kept the placeholder form.
    expect(result.steps[0]?.toolCalls[0]?.args).toEqual({ text: "{{password}}" });
  });

  it("never lets the secret reach the model's prompt or context", async () => {
    const seen: string[] = [];
    const deps = createFakeDeps();
    const model = createScriptedModel(
      [
        { toolCalls: [{ name: "type_text", args: { text: "{{password}}" } }] },
        { toolCalls: [{ name: "done", args: { summary: "ok" } }] },
      ],
      { onCall: () => {} },
    );
    const original = model.doGenerate;
    model.doGenerate = async (options) => {
      seen.push(JSON.stringify(options.prompt));
      return original(options);
    };

    await runOperator(
      makeOptions({ languageModel: model, secrets, task: "Log in with {{password}}" }),
      deps,
    );

    expect(seen.join("\n")).not.toContain(SECRET);
    expect(seen.join("\n")).toContain("{{password}}");
  });

  it("keeps the secret out of the transcript, the step records, and the logs", async () => {
    const transcriptPath = await tempTranscriptPath();
    const logLines: string[] = [];
    const persistedSteps: OperatorStep[] = [];
    const deps = createFakeDeps();
    // A misbehaving model that echoes the resolved secret back at us in its
    // reasoning and in a tool argument — the redaction filter is the barrier.
    const model = createScriptedModel([
      {
        text: `The password is ${SECRET}`,
        toolCalls: [{ name: "type_text", args: { text: SECRET } }],
      },
      { toolCalls: [{ name: "done", args: { summary: `used ${SECRET}` } }] },
    ]);

    const result = await runOperator(
      makeOptions({
        languageModel: model,
        secrets,
        transcriptPath,
        logSink: (line) => logLines.push(line),
        onStep: (step) => void persistedSteps.push(step),
      }),
      deps,
    );

    const transcript = await readFile(transcriptPath, "utf8");
    expect(transcript).not.toContain(SECRET);
    expect(transcript).toContain("{{password}}");
    expect(JSON.stringify(result.steps)).not.toContain(SECRET);
    expect(JSON.stringify(persistedSteps)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(logLines.join("\n")).not.toContain(SECRET);
    expect(logLines.length).toBeGreaterThan(0);
  });
});

describe("runOperator — transcript", () => {
  it("writes <recording>.operator.json in the OperatorRun shape, incrementally", async () => {
    const transcriptPath = await tempTranscriptPath();
    const snapshots: number[] = [];
    const model = createScriptedModel([
      { toolCalls: [{ name: "wait", args: { ms: 0 } }] },
      { toolCalls: [{ name: "wait", args: { ms: 0 } }] },
      { toolCalls: [{ name: "done", args: { summary: "done" } }] },
    ]);

    const result = await runOperator(
      makeOptions({
        languageModel: model,
        transcriptPath,
        onStep: async () => {
          // Partial transcript is on disk before the run ends.
          const partial = OperatorRunSchema.parse(
            JSON.parse(await readFile(transcriptPath, "utf8")),
          );
          snapshots.push(partial.steps.length);
        },
      }),
      createFakeDeps(),
    );

    expect(result.state).toBe("succeeded");
    expect(snapshots).toEqual([1, 2, 3]);

    const run = OperatorRunSchema.parse(JSON.parse(await readFile(transcriptPath, "utf8")));
    expect(run.id).toBe("run-1");
    expect(run.state).toBe("succeeded");
    expect(run.model).toEqual(parseModelConfig("anthropic:claude-sonnet-5"));
    expect(run.endedAt).toBeDefined();
    expect(run.steps).toHaveLength(3);
  });

  it("stores frames as sibling files referenced by hash, never inlined base64", async () => {
    const transcriptPath = await tempTranscriptPath();
    const model = createScriptedModel([{ toolCalls: [{ name: "done", args: { summary: "ok" } }] }]);
    const result = await runOperator(
      makeOptions({ languageModel: model, transcriptPath }),
      createFakeDeps(),
    );

    const raw = await readFile(transcriptPath, "utf8");
    expect(raw).not.toContain("iVBORw0KGgo"); // no inlined PNG base64
    const frames = await readdir(framesDirFor(transcriptPath));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatch(/^[0-9a-f]{16}\.png$/);
    expect(result.steps[0]?.observationRef).toBe(`demo.mp4.operator.frames/${frames[0]}`);
  });

  it("leaves a usable partial transcript when a run dies mid-flight", async () => {
    const transcriptPath = await tempTranscriptPath();
    const controller = new AbortController();
    const model = createScriptedModel([{ toolCalls: [{ name: "wait", args: { ms: 0 } }] }], {
      onCall: () => {
        if (controller.signal.aborted) return;
      },
    });
    const deps = createFakeDeps({
      captureFrame: async () => {
        if (deps.calls.captureFrame.length > 2) controller.abort();
        return { imageBase64: "AAAA", width: 100, height: 100, scale: 1 };
      },
    });

    const result = await runOperator(
      makeOptions({
        languageModel: model,
        transcriptPath,
        signal: controller.signal,
        maxSteps: 50,
      }),
      deps,
    );

    expect(result.state).toBe("aborted");
    const run = OperatorRunSchema.parse(JSON.parse(await readFile(transcriptPath, "utf8")));
    expect(run.state).toBe("aborted");
    expect(run.steps.length).toBeGreaterThan(0);
  });
});

describe("runOperator — model swap", () => {
  it("runs the identical loop against two different provider configs, unchanged", async () => {
    const script = [
      { toolCalls: [{ name: "click", args: { x: 10, y: 10 } }] },
      { toolCalls: [{ name: "done", args: { summary: "clicked" } }] },
    ];

    const anthropicDeps = createFakeDeps();
    const anthropicResult = await runOperator(
      makeOptions({
        model: parseModelConfig("anthropic:claude-sonnet-5"),
        languageModel: createScriptedModel(script, {
          provider: "anthropic",
          modelId: "claude-sonnet-5",
        }),
      }),
      anthropicDeps,
    );

    const localDeps = createFakeDeps();
    const localResult = await runOperator(
      makeOptions({
        model: parseModelConfig("openai-compatible:llama-3.3", {
          baseUrl: "http://localhost:1234/v1",
        }),
        languageModel: createScriptedModel(script, {
          provider: "openai-compatible",
          modelId: "llama-3.3",
        }),
      }),
      localDeps,
    );

    expect(anthropicResult.state).toBe("succeeded");
    expect(localResult.state).toBe("succeeded");
    expect(localResult.summary).toBe(anthropicResult.summary);
    expect(localDeps.calls.performInput).toEqual(anthropicDeps.calls.performInput);
    expect(localResult.steps.map((s) => s.toolCalls.map((c) => c.name))).toEqual(
      anthropicResult.steps.map((s) => s.toolCalls.map((c) => c.name)),
    );
  });

  it("fails cleanly when the configured provider cannot be resolved", async () => {
    const result = await runOperator(
      makeOptions({ model: parseModelConfig("nope:x"), env: {} }),
      createFakeDeps(),
    );
    expect(result.state).toBe("failed");
    expect(result.error?.code).toBe(OPERATOR_ERROR_CODES.UNKNOWN_PROVIDER);
  });
});

describe("runOperator — model misbehavior", () => {
  it("nudges the model when it produces no tool call, and still counts the step", async () => {
    const model = createScriptedModel([{ text: "Thinking out loud." }]);
    const result = await runOperator(
      makeOptions({ languageModel: model, maxSteps: 2 }),
      createFakeDeps(),
    );
    expect(result.state).toBe("failed");
    expect(result.error?.code).toBe(OPERATOR_ERROR_CODES.MAX_STEPS_EXCEEDED);
    expect(result.steps).toHaveLength(2);
  });

  it("rejects malformed tool arguments without crashing the process", async () => {
    const model = createScriptedModel([
      { toolCalls: [{ name: "click", args: { x: "left-ish" } }] },
    ]);
    const result = await runOperator(makeOptions({ languageModel: model }), createFakeDeps());
    expect(result.state).toBe("failed");
    expect(result.error?.code).toBe(OPERATOR_ERROR_CODES.INVALID_TOOL_INPUT);
  });

  it("dedupes a duplicate toolCallId within one turn instead of emitting two tool-results", async () => {
    const deps = createFakeDeps();
    const model = createScriptedModel([
      {
        toolCalls: [
          { name: "press_key", args: { key: "Escape" }, toolCallId: "dup-1" },
          { name: "click", args: { x: 1, y: 1 }, toolCallId: "dup-1" },
        ],
      },
      { toolCalls: [{ name: "done", args: { summary: "ok" } }] },
    ]);

    const result = await runOperator(makeOptions({ languageModel: model }), deps);

    // Only the first tool call sharing the id was executed — the duplicate was skipped.
    expect(deps.calls.performInput).toEqual([[{ kind: "key_press", key: "Escape" }]]);
    expect(result.state).toBe("succeeded");
    expect(result.steps[0]?.toolCalls).toHaveLength(1);
  });
});
