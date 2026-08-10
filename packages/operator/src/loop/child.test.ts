import { describe, expect, it } from "vitest";
import { FakeLoopDaemon } from "../test-helpers/fake-loop-daemon.js";
import { createScriptedModel } from "../test-helpers/fakes.js";
import { runLoopChild } from "./child.js";

/**
 * The loop child driven end to end over contracts/operator-loop-protocol.md,
 * against a fake daemon. No daemon, no sidecar, no native binary — the same
 * offline-and-deterministic property `packages/core`'s fake-sidecar tests have.
 */

const PLAN_TURN = {
  toolCalls: [{ name: "plan", args: { steps: ["Focus the window", "Type the URL"] } }],
};

describe("operator loop child — handshake and framing", () => {
  it("sends `ready` first and takes its whole configuration from the result", async () => {
    const daemon = new FakeLoopDaemon({
      config: { runId: "run-42", task: "Open the app", maxSteps: 4 },
    });
    const model = createScriptedModel([
      PLAN_TURN,
      { toolCalls: [{ name: "done", args: { summary: "ok" } }] },
    ]);

    const result = await runLoopChild(daemon.streams, { languageModel: model });

    expect(daemon.calls.order[0]).toBe("ready");
    expect(daemon.calls.ready).toBe(1);
    expect(result.state).toBe("succeeded");
    expect(daemon.calls.reportResult).toEqual([
      { state: "succeeded", summary: "ok", error: undefined },
    ]);
    expect(result.exitCode).toBe(0);
  });

  it("brackets every step with beginStep → … → reportStep", async () => {
    const daemon = new FakeLoopDaemon();
    const model = createScriptedModel([
      PLAN_TURN,
      { toolCalls: [{ name: "click", args: { x: 10, y: 20 } }] },
      { toolCalls: [{ name: "done", args: { summary: "ok" } }] },
    ]);

    await runLoopChild(daemon.streams, { languageModel: model });

    expect(daemon.calls.beginStep).toEqual([0, 1, 2]);
    expect(daemon.calls.reportStep.map((s) => s.index)).toEqual([0, 1, 2]);
    // Proxied calls only ever land inside an open bracket — the fake daemon
    // rejects them with NO_OPEN_STEP otherwise, so a clean run proves it.
    const bracketed = daemon.calls.order.filter((m) =>
      ["beginStep", "captureFrame", "performInput", "reportStep"].includes(m),
    );
    expect(bracketed.slice(0, 4)).toEqual(["beginStep", "captureFrame", "reportStep", "beginStep"]);
  });

  it("proxies every screen-facing action instead of touching a sidecar", async () => {
    const daemon = new FakeLoopDaemon();
    const model = createScriptedModel([
      PLAN_TURN,
      {
        toolCalls: [
          { name: "click", args: { x: 5, y: 5 } },
          { name: "list_targets", args: {} },
          {
            name: "resize_window",
            args: { targetId: "window:1", bounds: { x: 0, y: 0, width: 10, height: 10 } },
          },
        ],
      },
      { toolCalls: [{ name: "done", args: { summary: "ok" } }] },
    ]);

    await runLoopChild(daemon.streams, { languageModel: model });

    expect(daemon.calls.performInput).toEqual([
      [{ kind: "mouse_click", x: 5, y: 5, button: "left", clickCount: 1 }],
    ]);
    expect(daemon.calls.enumerateTargets).toBe(1);
    expect(daemon.calls.resizeWindow).toEqual([
      { targetId: "window:1", bounds: { x: 0, y: 0, width: 10, height: 10 } },
    ]);
    expect(daemon.calls.captureFrame).toBe(3);
  });

  it("answers `ping`, because pid liveness is not health", async () => {
    const daemon = new FakeLoopDaemon();
    const model = createScriptedModel([
      PLAN_TURN,
      { toolCalls: [{ name: "done", args: { summary: "ok" } }] },
    ]);
    const run = runLoopChild(daemon.streams, { languageModel: model });
    const pong: unknown = await daemon.ping();
    await run;
    expect(pong).toMatchObject({ pong: true });
  });
});

describe("operator loop child — plans on the wire", () => {
  it("reports plan content and takes the daemon's revision as identity", async () => {
    const daemon = new FakeLoopDaemon();
    const model = createScriptedModel([
      {
        toolCalls: [
          {
            name: "plan",
            args: { steps: ["Open Safari", "Go to the URL"], rationale: "Direct route." },
          },
        ],
      },
      // Phase 22: only the planner may call `plan` — a replan is reached via
      // a `checkpoint` with outcome `failed-plan-invalid` (the escalation
      // edge), not a bare second `plan` call from the executor's turn.
      {
        toolCalls: [
          {
            name: "checkpoint",
            args: { expectation: "Safari opened the URL", outcome: "failed-plan-invalid" },
          },
        ],
      },
      {
        toolCalls: [{ name: "plan", args: { steps: ["Log in first"], rationale: "Login wall." } }],
      },
      { toolCalls: [{ name: "done", args: { summary: "ok" } }] },
    ]);

    await runLoopChild(daemon.streams, { languageModel: model });

    expect(daemon.calls.reportPlan).toEqual([
      { steps: ["Open Safari", "Go to the URL"], rationale: "Direct route.", revision: 0 },
      { steps: ["Log in first"], rationale: "Login wall.", revision: 1 },
    ]);
    // The child never chooses a revision — it wears the daemon's.
    expect(daemon.calls.reportStep[0]?.plan?.revision).toBe(0);
    expect(daemon.calls.reportStep[2]?.plan?.revision).toBe(1);
    expect(daemon.plan?.revision).toBe(1);
    // Planning costs no step budget beyond the step it rode in on.
    expect(daemon.calls.beginStep).toEqual([0, 1, 2, 3]);
  });
});

describe("operator loop child — guardrails are the daemon's", () => {
  it("ends the run when the daemon refuses beginStep past maxSteps", async () => {
    const daemon = new FakeLoopDaemon({ config: { maxSteps: 2 } });
    // A child that never calls `done`: the daemon's ceiling is what stops it.
    const model = createScriptedModel([{ toolCalls: [{ name: "wait", args: { ms: 0 } }] }]);

    const result = await runLoopChild(daemon.streams, { languageModel: model });

    expect(daemon.calls.beginStep).toEqual([0, 1]);
    expect(result.state).toBe("failed");
    expect(daemon.calls.reportResult[0]?.error?.code).toBe("OPERATOR_MAX_STEPS_EXCEEDED");
  });

  it("abandons the rest of a batch when the daemon returns OPERATOR_BATCH_LIMIT_EXCEEDED", async () => {
    // The daemon's ceiling is 2; the child believes it is 8 (it asked, but a
    // hostile/stale child is exactly the case this covers).
    const daemon = new FakeLoopDaemon({ maxBatchActions: 2 });
    const model = createScriptedModel([
      PLAN_TURN,
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

    const result = await runLoopChild(daemon.streams, { languageModel: model });

    // Two actions served, the third refused, the fourth never sent.
    expect(daemon.calls.performInput).toHaveLength(2);
    const step = daemon.calls.reportStep[1];
    expect(step?.toolCalls.map((c) => c.result)).toEqual([
      { performed: 1 },
      { performed: 1 },
      { error: { code: "OPERATOR_BATCH_LIMIT_EXCEEDED", message: expect.any(String) } },
      { skipped: "BATCH_ABORTED" },
    ]);
    // Non-terminal: the step closed and the run carried on to `done`.
    expect(result.state).toBe("succeeded");
    expect(daemon.calls.beginStep).toEqual([0, 1, 2]);
  });

  it("never receives a secret value — only placeholder names cross the wire", async () => {
    const daemon = new FakeLoopDaemon({
      config: { secretNames: ["password"], task: "Log in with {{password}}" },
    });
    const model = createScriptedModel([
      PLAN_TURN,
      { toolCalls: [{ name: "type_text", args: { text: "{{password}}" } }] },
      { toolCalls: [{ name: "done", args: { summary: "ok" } }] },
    ]);

    await runLoopChild(daemon.streams, { languageModel: model });

    // The placeholder reached the daemon verbatim; substitution is its job.
    expect(daemon.calls.performInput).toEqual([[{ kind: "type_text", text: "{{password}}" }]]);
    // And nothing resembling a resolved value was ever configured or sent.
    expect(JSON.stringify(daemon.rawFromChild)).not.toContain("secrets");
  });
});

describe("operator loop child — shutdown", () => {
  it("winds down on a pushed `abort` and reports the mapped terminal state", async () => {
    const daemon = new FakeLoopDaemon();
    const model = createScriptedModel([{ toolCalls: [{ name: "wait", args: { ms: 0 } }] }], {
      onCall: () => daemon.abort("user"),
    });

    const result = await runLoopChild(daemon.streams, { languageModel: model });

    expect(result.state).toBe("aborted");
    expect(daemon.calls.reportResult[0]?.state).toBe("aborted");
  });

  it("maps abort reason `timeout` to `timed_out`, which the daemon already decided", async () => {
    const daemon = new FakeLoopDaemon();
    const model = createScriptedModel([{ toolCalls: [{ name: "wait", args: { ms: 0 } }] }], {
      onCall: () => daemon.abort("timeout"),
    });

    const result = await runLoopChild(daemon.streams, { languageModel: model });

    expect(result.state).toBe("timed_out");
  });

  it("exits quietly on stdin EOF without attempting reportResult", async () => {
    const daemon = new FakeLoopDaemon();
    const model = createScriptedModel([{ toolCalls: [{ name: "wait", args: { ms: 0 } }] }], {
      onCall: () => daemon.killDaemon(),
    });

    const result = await runLoopChild(daemon.streams, { languageModel: model });

    // Nobody left to report to; a child that outlives its daemon is an orphan.
    expect(daemon.calls.reportResult).toEqual([]);
    expect(result.exitCode).toBe(0);
  });
});
