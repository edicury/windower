import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CaptureTarget, type RunOperatorParams, WINDOWER_HOME_ENV } from "@windower/core";
import {
  OperatorRunStore,
  type SidecarHandle,
  resetCaptureHoldsForTesting,
} from "@windower/engine";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderOperatorStepLine, runOperatorBlocking } from "./operate-blocking.js";

/**
 * `@windower/operator` is loaded lazily by `operate-blocking.ts` through a
 * non-literal `import(specifier)` (mirrors `operator-run-engine.ts`'s
 * `defaultLoadRunOperator`) — `vi.mock` intercepts it the same as a static
 * import, since module resolution happens by specifier regardless of call
 * shape.
 */
const mockedRunOperator = vi.fn();
vi.mock("@windower/operator", () => ({
  runOperator: (...args: unknown[]) => mockedRunOperator(...args),
}));

const DISPLAY_TARGET: CaptureTarget = {
  kind: "display",
  id: "d1",
  name: "Built-in",
  isPrimary: true,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  scaleFactor: 2,
};

const baseParams: RunOperatorParams = {
  task: "Open the app and create an incident",
  target: DISPLAY_TARGET,
  model: { provider: "anthropic", model: "claude-sonnet-5" },
};

function fakeClient() {
  return {
    describe: vi.fn().mockResolvedValue({ capabilities: ["screenshot", "input"] }),
    enumerateTargets: vi.fn().mockResolvedValue({ targets: [DISPLAY_TARGET] }),
    captureFrame: vi.fn(),
    performInput: vi.fn().mockResolvedValue({ performed: 1 }),
    resizeWindow: vi
      .fn()
      .mockResolvedValue({ actualBounds: DISPLAY_TARGET.bounds, result: "success" }),
  };
}

function fakeSidecarHandle(): SidecarHandle {
  return {
    client: fakeClient() as unknown as SidecarHandle["client"],
    terminate: vi.fn().mockResolvedValue(undefined),
    pid: 4242,
  };
}

describe("runOperatorBlocking (operate's local/blocking path)", () => {
  let home: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    // `CaptureLock`'s hold registry is module-global — a leaked hold would make
    // the next test reuse this one's capture process (row 1) instead of taking
    // the lock.
    resetCaptureHoldsForTesting();
    home = await mkdtemp(join(tmpdir(), "windower-operate-blocking-test-"));
    originalHome = process.env[WINDOWER_HOME_ENV];
    process.env[WINDOWER_HOME_ENV] = home;
    mockedRunOperator.mockReset();
  });

  afterEach(async () => {
    resetCaptureHoldsForTesting();
    if (originalHome === undefined) delete process.env[WINDOWER_HOME_ENV];
    else process.env[WINDOWER_HOME_ENV] = originalHome;
    await rm(home, { recursive: true, force: true });
  });

  it("runs the loop in-process and persists the terminal run", async () => {
    mockedRunOperator.mockResolvedValue({
      state: "succeeded",
      steps: [{ index: 0, observationRef: "frame-0.png", toolCalls: [], tMs: 100 }],
      summary: "done",
    });

    const run = await runOperatorBlocking(baseParams, {
      signal: new AbortController().signal,
      spawnSidecar: () => fakeSidecarHandle(),
    });

    expect(run.state).toBe("succeeded");
    expect(run.steps).toHaveLength(1);
    expect(run.target).toEqual(DISPLAY_TARGET);
  });

  it("persists a non-succeeded terminal state", async () => {
    mockedRunOperator.mockResolvedValue({
      state: "failed",
      steps: [],
      error: { code: "MODEL_ERROR", message: "boom" },
    });

    const run = await runOperatorBlocking(baseParams, {
      signal: new AbortController().signal,
      spawnSidecar: () => fakeSidecarHandle(),
    });

    expect(run.state).toBe("failed");
    expect(run.error).toEqual({ code: "MODEL_ERROR", message: "boom" });
  });

  // contracts/operator.md §"How they surface" — the summary is persisted, not
  // merely returned, so `windower operate status` and `get_operator_run` show
  // the same outcome the blocking invocation printed.
  it("persists the run's summary so a later poll reads it back", async () => {
    mockedRunOperator.mockResolvedValue({
      state: "succeeded",
      steps: [],
      summary: "Created the incident and confirmed it in the list.",
    });

    const run = await runOperatorBlocking(baseParams, {
      signal: new AbortController().signal,
      spawnSidecar: () => fakeSidecarHandle(),
    });

    expect(run.summary).toBe("Created the incident and confirmed it in the list.");
    const store = new OperatorRunStore();
    await store.load();
    expect(store.get(run.id)?.summary).toBe(run.summary);
  });

  it("leaves `summary` absent when the loop reported none", async () => {
    mockedRunOperator.mockResolvedValue({
      state: "failed",
      steps: [],
      error: { code: "OPERATOR_LOOP_CRASHED", message: "Operator loop crashed." },
    });

    const run = await runOperatorBlocking(baseParams, {
      signal: new AbortController().signal,
      spawnSidecar: () => fakeSidecarHandle(),
    });

    expect(run.summary).toBeUndefined();
    expect(Object.hasOwn(run, "summary")).toBe(false);
  });

  it("calls onStep as steps land and persists them", async () => {
    mockedRunOperator.mockImplementation(async (options: { onStep?: (step: unknown) => void }) => {
      await options.onStep?.({ index: 0, observationRef: "frame-0.png", toolCalls: [], tMs: 5 });
      return { state: "succeeded", steps: [], summary: "done" };
    });
    const onStep = vi.fn();

    await runOperatorBlocking(baseParams, {
      signal: new AbortController().signal,
      spawnSidecar: () => fakeSidecarHandle(),
      onStep,
    });

    expect(onStep).toHaveBeenCalledWith(
      expect.objectContaining({ index: 0, observationRef: "frame-0.png" }),
    );
  });

  it("SIGINT-driven abort reports state 'aborted'", async () => {
    const controller = new AbortController();
    // Checks `signal.aborted` up front (the same pattern `packages/operator`'s
    // own loop uses, `combineSignals` in `run.ts`) so this test isn't racing
    // the `abort()` call below against the several awaits `runOperatorBlocking`
    // does before it ever reaches the mocked loop.
    mockedRunOperator.mockImplementation(
      (options: { signal: AbortSignal }) =>
        new Promise((resolve) => {
          const settle = () =>
            resolve({ state: "failed", steps: [], error: { code: "ABORTED", message: "aborted" } });
          if (options.signal.aborted) settle();
          else options.signal.addEventListener("abort", settle);
        }),
    );

    const runPromise = runOperatorBlocking(baseParams, {
      signal: controller.signal,
      spawnSidecar: () => fakeSidecarHandle(),
    });

    controller.abort();
    expect((await runPromise).state).toBe("aborted");
  });

  /**
   * Phase 21 (contracts/operator.md §Recording independence): this path has no
   * `RecordingEngine`, starts nothing, stops nothing, and leaves no session
   * behind under ANY terminal state. The `bugs.spec.md` #6 concern it used to
   * guard against — a second ScreenCaptureKit process spawned mid-recording —
   * is now handled for every caller alike by the capture lock
   * (`contracts/screen-capture-exclusivity.md`), not by this file remembering
   * to reuse a recording's sidecar.
   */
  for (const state of ["succeeded", "failed", "aborted", "timed_out"] as const) {
    it(`starts and finalizes no recording when the run ends ${state}`, async () => {
      mockedRunOperator.mockResolvedValue({ state, steps: [] });

      const run = await runOperatorBlocking(baseParams, {
        signal: new AbortController().signal,
        spawnSidecar: () => fakeSidecarHandle(),
      });

      expect(run.state).toBe(state);
      // No `RecordingSession` was created — `~/.windower/sessions` is either
      // absent or empty.
      const sessions = await readdir(join(home, "sessions")).catch(() => [] as string[]);
      expect(sessions).toEqual([]);
    });
  }

  it("resolves a { targetId } selector before the run and records the resolution", async () => {
    mockedRunOperator.mockResolvedValue({ state: "succeeded", steps: [] });

    const run = await runOperatorBlocking(
      { ...baseParams, target: { targetId: "d1" } },
      { signal: new AbortController().signal, spawnSidecar: () => fakeSidecarHandle() },
    );

    expect(run.target).toEqual(DISPLAY_TARGET);
    expect(mockedRunOperator.mock.calls[0]?.[0]).toMatchObject({
      target: DISPLAY_TARGET,
      bounds: DISPLAY_TARGET.bounds,
    });
  });

  /**
   * Phase 21 (`contracts/screen-capture-exclusivity.md` §What never takes this
   * lock): `performInput`/`resizeWindow` are CONTROL-surface calls.
   * `SpawnSidecarOptions.surface` defaults to `"capture"`, so a `ControlEngine`
   * built without `spawnOptions: { surface: "control" }` would spawn the
   * ScreenCaptureKit-linked binary for every action.
   */
  it('spawns the control surface with surface: "control", and takes no capture lock for it', async () => {
    const spawnedSurfaces: Array<string | undefined> = [];
    let lockExistedAtControlSpawn: boolean | undefined;
    mockedRunOperator.mockImplementation(
      async (
        _options: unknown,
        deps: { resizeWindow: (targetId: string, bounds: unknown) => Promise<unknown> },
      ) => {
        await deps.resizeWindow("d1", DISPLAY_TARGET.bounds);
        return { state: "succeeded", steps: [] };
      },
    );

    await runOperatorBlocking(baseParams, {
      signal: new AbortController().signal,
      spawnSidecar: (options) => {
        spawnedSurfaces.push(options.surface);
        if (options.surface === "control") {
          lockExistedAtControlSpawn = existsSync(join(home, "capture.lock"));
        }
        return fakeSidecarHandle();
      },
    });

    expect(spawnedSurfaces).toContain("control");
    // The control spawn did not go through the capture lock, and nothing was
    // left behind by the run.
    expect(lockExistedAtControlSpawn).toBe(false);
    expect(existsSync(join(home, "capture.lock"))).toBe(false);
  });

  it("writes the transcript to operator-owned storage, never next to a video", async () => {
    mockedRunOperator.mockResolvedValue({ state: "succeeded", steps: [] });

    const run = await runOperatorBlocking(baseParams, {
      signal: new AbortController().signal,
      spawnSidecar: () => fakeSidecarHandle(),
    });

    expect(run.transcriptPath).toBe(join(home, "operator-runs", run.id, "transcript.json"));
  });
});

describe("renderOperatorStepLine", () => {
  it("summarizes the step index, elapsed time, and tool calls", () => {
    const line = renderOperatorStepLine({
      index: 2,
      observationRef: "frame-2.png",
      toolCalls: [{ name: "click", args: { x: 10, y: 20 }, result: { performed: 1 } }],
      tMs: 4200,
    });
    expect(line).toContain("step 3");
    expect(line).toContain("4.2s");
    expect(line).toContain("click(");
  });

  it("handles a step with no tool calls", () => {
    const line = renderOperatorStepLine({
      index: 0,
      observationRef: "frame-0.png",
      toolCalls: [],
      tMs: 0,
    });
    expect(line).toContain("no tool call");
  });
});
