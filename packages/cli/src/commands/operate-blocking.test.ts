import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RunOperatorParams, WINDOWER_HOME_ENV } from "@windower/core";
import type { RecordingEngine, SidecarHandle } from "@windower/engine";
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

const baseParams: RunOperatorParams = {
  task: "Open the app and create an incident",
  model: { provider: "anthropic", model: "claude-sonnet-5" },
};

function fakeClient() {
  return {
    describe: vi.fn().mockResolvedValue({ capabilities: ["screenshot", "input"] }),
    enumerateTargets: vi.fn().mockResolvedValue({
      targets: [
        {
          kind: "display",
          id: "d1",
          name: "Built-in",
          isPrimary: true,
          bounds: { x: 0, y: 0, width: 1920, height: 1080 },
          scaleFactor: 2,
        },
      ],
    }),
    captureFrame: vi.fn(),
    performInput: vi.fn(),
    resizeWindow: vi.fn(),
  };
}

function fakeSidecarHandle(): SidecarHandle {
  return {
    client: fakeClient() as unknown as SidecarHandle["client"],
    terminate: vi.fn().mockResolvedValue(undefined),
    pid: 4242,
  };
}

function fakeRecordingEngine(
  overrides: Partial<Record<keyof RecordingEngine, unknown>> = {},
): RecordingEngine {
  const sidecar = fakeSidecarHandle();
  return {
    startRecording: vi.fn().mockResolvedValue({ sessionId: "sess-1" }),
    getSidecarClient: vi.fn().mockReturnValue(sidecar.client),
    getPlannedOutputPath: vi.fn().mockReturnValue("/tmp/out/rec.mp4"),
    setOperatorRunPath: vi.fn(),
    getSession: vi.fn().mockReturnValue({ state: "recording" }),
    stopRecording: vi.fn().mockResolvedValue({}),
    ...overrides,
  } as unknown as RecordingEngine;
}

describe("runOperatorBlocking (operate's local/blocking path)", () => {
  let home: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "windower-operate-blocking-test-"));
    originalHome = process.env[WINDOWER_HOME_ENV];
    process.env[WINDOWER_HOME_ENV] = home;
    mockedRunOperator.mockReset();
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env[WINDOWER_HOME_ENV];
    else process.env[WINDOWER_HOME_ENV] = originalHome;
    await rm(home, { recursive: true, force: true });
  });

  it("runs the loop in-process, persists the terminal run, and finalizes the recording on success", async () => {
    mockedRunOperator.mockResolvedValue({
      state: "succeeded",
      steps: [{ index: 0, observationRef: "frame-0.png", toolCalls: [], tMs: 100 }],
      summary: "done",
    });
    const recordingEngine = fakeRecordingEngine();

    const run = await runOperatorBlocking(baseParams, {
      signal: new AbortController().signal,
      recordingEngine,
      spawnSidecar: () => fakeSidecarHandle(),
    });

    expect(run.state).toBe("succeeded");
    expect(run.steps).toHaveLength(1);
    expect(recordingEngine.startRecording).toHaveBeenCalled();
    expect(recordingEngine.stopRecording).toHaveBeenCalledWith({ sessionId: "sess-1" });
  });

  it("still finalizes the recording when the loop ends in a non-succeeded terminal state", async () => {
    mockedRunOperator.mockResolvedValue({
      state: "failed",
      steps: [],
      error: { code: "MODEL_ERROR", message: "boom" },
    });
    const recordingEngine = fakeRecordingEngine();

    const run = await runOperatorBlocking(baseParams, {
      signal: new AbortController().signal,
      recordingEngine,
      spawnSidecar: () => fakeSidecarHandle(),
    });

    expect(run.state).toBe("failed");
    expect(run.error).toEqual({ code: "MODEL_ERROR", message: "boom" });
    expect(recordingEngine.stopRecording).toHaveBeenCalledWith({ sessionId: "sess-1" });
  });

  it("calls onStep as steps land and persists them", async () => {
    mockedRunOperator.mockImplementation(async (options: { onStep?: (step: unknown) => void }) => {
      await options.onStep?.({ index: 0, observationRef: "frame-0.png", toolCalls: [], tMs: 5 });
      return { state: "succeeded", steps: [], summary: "done" };
    });
    const onStep = vi.fn();

    await runOperatorBlocking(baseParams, {
      signal: new AbortController().signal,
      recordingEngine: fakeRecordingEngine(),
      spawnSidecar: () => fakeSidecarHandle(),
      onStep,
    });

    expect(onStep).toHaveBeenCalledWith(
      expect.objectContaining({ index: 0, observationRef: "frame-0.png" }),
    );
  });

  it("SIGINT-driven abort still finalizes (stops) the recording, and reports state 'aborted'", async () => {
    const recordingEngine = fakeRecordingEngine();
    const controller = new AbortController();
    // Checks `signal.aborted` up front (the same pattern `packages/operator`'s
    // own loop uses, `combineSignals` in `run.ts`) so this test isn't racing
    // the `abort()` call below against the several awaits `runOperatorBlocking`
    // does (target resolution, `startRecording`, `describe()`) before it ever
    // reaches the mocked loop — `controller.abort()` fires synchronously,
    // long before this implementation is even invoked.
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
      recordingEngine,
      spawnSidecar: () => fakeSidecarHandle(),
    });

    controller.abort();
    const run = await runPromise;

    expect(run.state).toBe("aborted");
    expect(recordingEngine.stopRecording).toHaveBeenCalledWith({ sessionId: "sess-1" });
  });

  it("--no-record runs against a transient sidecar and never starts a session", async () => {
    mockedRunOperator.mockResolvedValue({ state: "succeeded", steps: [], summary: "done" });
    const recordingEngine = fakeRecordingEngine();
    const transientHandle = fakeSidecarHandle();

    const run = await runOperatorBlocking(
      { ...baseParams, recording: { disabled: true } },
      {
        signal: new AbortController().signal,
        recordingEngine,
        spawnSidecar: () => transientHandle,
      },
    );

    expect(run.state).toBe("succeeded");
    expect(run.sessionId).toBeUndefined();
    expect(recordingEngine.startRecording).not.toHaveBeenCalled();
    expect(transientHandle.terminate).toHaveBeenCalled();
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
