import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CaptureTarget,
  type FakeSidecarOptions,
  type OperatorDeps,
  type OperatorRunOptions,
  type OperatorRunResult,
  OperatorRunSchema,
  OutputManifestSchema,
  type RunOperator,
  WINDOWER_HOME_ENV,
  writeConfig,
} from "@windower/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OperatorRunManager } from "./operator-run-manager.js";
import { OperatorRunStore, operatorRunFilePath } from "./operator-run-store.js";
import { PassthroughService } from "./passthrough.js";
import { SecretResolver } from "./secret-resolver.js";
import { SessionManager } from "./session-manager.js";
import { SessionStore } from "./session-store.js";
import { createFakeSidecarFactory } from "./test-helpers/fake-sidecar-factory.js";

const DISPLAY_TARGET: CaptureTarget = {
  kind: "display",
  id: "display-1",
  name: "Built-in",
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  isPrimary: true,
  scaleFactor: 2,
};

const MODEL = { provider: "anthropic", model: "claude-sonnet-5" };

/** The loop lives in packages/operator; every test here injects its own stub. */
type RunnerImpl = (options: OperatorRunOptions, deps: OperatorDeps) => Promise<OperatorRunResult>;

const SUCCEED: RunnerImpl = async () => ({ state: "succeeded", steps: [], summary: "done" });

describe("OperatorRunManager", () => {
  let home: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "windower-operator-run-"));
    originalHome = process.env[WINDOWER_HOME_ENV];
    process.env[WINDOWER_HOME_ENV] = home;
    // Keep every recording this suite starts inside the temp home — the real
    // `defaultOutputDir()` resolves under the user's actual homedir.
    await writeConfig({ outputDir: join(home, "output") });
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env[WINDOWER_HOME_ENV];
    else process.env[WINDOWER_HOME_ENV] = originalHome;
    await rm(home, { recursive: true, force: true });
  });

  function makeManager(
    options: {
      impl?: RunnerImpl;
      capabilities?: FakeSidecarOptions["capabilities"];
      env?: NodeJS.ProcessEnv;
    } = {},
  ) {
    const store = new OperatorRunStore();
    const sessionStore = new SessionStore();
    const { spawnSidecar, spawns } = createFakeSidecarFactory({
      targets: [DISPLAY_TARGET],
      capabilities: options.capabilities,
    });
    const sessionManager = new SessionManager({ store: sessionStore, spawnSidecar });
    const passthrough = new PassthroughService(spawnSidecar);
    const seen: Array<{ options: OperatorRunOptions; deps: OperatorDeps }> = [];
    const impl = options.impl ?? SUCCEED;
    const runner: RunOperator = async (runOptions, deps) => {
      seen.push({ options: runOptions, deps });
      return impl(runOptions, deps);
    };
    const manager = new OperatorRunManager({
      store,
      sessionManager,
      passthrough,
      spawnSidecar,
      secretResolver: new SecretResolver({ env: options.env ?? {}, warn: () => {} }),
      loadRunOperator: async () => runner,
    });
    return { manager, store, sessionManager, sessionStore, spawns, seen };
  }

  async function readRunFile(runId: string) {
    return OperatorRunSchema.parse(JSON.parse(await readFile(operatorRunFilePath(runId), "utf8")));
  }

  it("returns a runId promptly and persists every state transition to disk", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { manager } = makeManager({
      impl: async (options) => {
        await options.onStep?.({
          index: 0,
          observationRef: "frame-0.png",
          toolCalls: [{ name: "click", args: { x: 10, y: 10 } }],
          tMs: 5,
        });
        await gate;
        return { state: "succeeded", steps: [], summary: "ok" };
      },
    });

    const { runId } = await manager.runOperator({ task: "do a thing", model: MODEL });
    // Non-blocking: the loop is still mid-flight when run_operator returns.
    expect((await readRunFile(runId)).state).toBe("running");
    expect(manager.getOperatorRun({ runId }).sessionId).toBeTruthy();

    // Steps are transitions too — each one is on disk before the run ends.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const midRun = await readRunFile(runId);
    expect(midRun.steps).toHaveLength(1);
    expect(midRun.endedAt).toBeUndefined();

    release();
    await manager.whenSettled(runId);

    const final = await readRunFile(runId);
    expect(final.state).toBe("succeeded");
    expect(final.endedAt).toBeTruthy();
    expect(manager.activeRunCount).toBe(0);
  });

  it("writes operatorRunPath into the recording's manifest", async () => {
    const { manager, sessionManager } = makeManager();
    const { runId } = await manager.runOperator({ task: "demo", model: MODEL });
    await manager.whenSettled(runId);

    const run = manager.getOperatorRun({ runId });
    expect(run.transcriptPath).toMatch(/\.operator\.json$/);

    const session = sessionManager.getSession({ sessionId: run.sessionId as string });
    expect(session.state).toBe("finalized");
    const manifest = OutputManifestSchema.parse(
      JSON.parse(await readFile(session.manifestPath as string, "utf8")),
    );
    expect(manifest.operatorRunPath).toBe(run.transcriptPath);
  });

  it("runs without a recording when recording.disabled is set", async () => {
    let performed = 0;
    const { manager, sessionStore } = makeManager({
      impl: async (_options, deps) => {
        const result = await deps.performInput([{ kind: "mouse_move", x: 10, y: 10 }]);
        performed = result.performed;
        return { state: "succeeded", steps: [] };
      },
    });

    const { runId } = await manager.runOperator({
      task: "no-record",
      model: MODEL,
      recording: { disabled: true },
    });
    await manager.whenSettled(runId);

    expect(performed).toBe(1);
    expect(manager.getOperatorRun({ runId }).sessionId).toBeUndefined();
    expect(sessionStore.list()).toHaveLength(0);
    expect((await readRunFile(runId)).state).toBe("succeeded");
  });

  it("aborts a run, marks it aborted, and finalizes the recording", async () => {
    const { manager, sessionManager } = makeManager({
      impl: (options) =>
        new Promise<OperatorRunResult>((resolve) => {
          options.signal.addEventListener("abort", () => resolve({ state: "aborted", steps: [] }));
        }),
    });

    const { runId } = await manager.runOperator({ task: "long task", model: MODEL });
    const sessionId = manager.getOperatorRun({ runId }).sessionId as string;

    await expect(manager.abortOperatorRun({ runId })).resolves.toEqual({ aborted: true });
    expect(manager.getOperatorRun({ runId }).state).toBe("aborted");

    await manager.whenSettled(runId);
    expect((await readRunFile(runId)).state).toBe("aborted");
    expect(sessionManager.getSession({ sessionId }).state).toBe("finalized");

    await expect(manager.abortOperatorRun({ runId })).rejects.toMatchObject({
      code: "INVALID_ARGS",
    });
  });

  it("marks in-flight runs failed on daemon restart (crash recovery)", async () => {
    const first = makeManager();
    await first.store.save({
      id: "crashed-run",
      state: "running",
      task: "was in flight",
      model: MODEL,
      steps: [],
      startedAt: new Date().toISOString(),
    });
    await first.store.save({
      id: "old-run",
      state: "succeeded",
      task: "already done",
      model: MODEL,
      steps: [],
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
    });

    // A fresh daemon: new store, load from disk, recover.
    const second = makeManager();
    await second.store.load();
    await second.manager.recoverCrashedRuns();

    const recovered = await readRunFile("crashed-run");
    expect(recovered.state).toBe("failed");
    expect(recovered.error?.code).toBe("INTERNAL_ERROR");
    expect(recovered.endedAt).toBeTruthy();
    expect((await readRunFile("old-run")).state).toBe("succeeded");
  });

  it("fails the run at start when a secret ref cannot be resolved", async () => {
    const { manager, store } = makeManager({ env: {} });
    await expect(
      manager.runOperator({
        task: "log in",
        model: MODEL,
        secrets: [{ name: "password", source: "env", ref: "MISSING_VAR" }],
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGS" });

    const runs = store.list();
    expect(runs).toHaveLength(1);
    expect(runs[0].state).toBe("failed");
    expect(runs[0].error?.code).toBe("INVALID_ARGS");
    // No recording was started for a run that never began.
    expect(runs[0].sessionId).toBeUndefined();
  });

  it("hands resolved secrets to the loop but never persists their values", async () => {
    let handed: string | undefined;
    const { manager } = makeManager({
      env: { MY_PASSWORD: "sup3r-s3cret" },
      impl: async (options) => {
        handed = options.secrets[0]?.value;
        // A deliberately sloppy loop leaking the raw value into a step record.
        await options.onStep?.({
          index: 0,
          observationRef: "frame-0.png",
          toolCalls: [{ name: "type_text", args: { text: "sup3r-s3cret" } }],
          tMs: 1,
        });
        return {
          state: "failed",
          steps: [],
          error: { code: "INTERNAL_ERROR", message: "boom while typing sup3r-s3cret" },
        };
      },
    });

    const { runId } = await manager.runOperator({
      task: "log in with {{password}}",
      model: MODEL,
      recording: { disabled: true },
      secrets: [{ name: "password", source: "env", ref: "MY_PASSWORD" }],
    });
    await manager.whenSettled(runId);

    expect(handed).toBe("sup3r-s3cret");
    const raw = await readFile(operatorRunFilePath(runId), "utf8");
    expect(raw).not.toContain("sup3r-s3cret");
    expect(raw).toContain("{{password}}");
  });

  it("surfaces UNSUPPORTED_CAPABILITY instead of crashing when the sidecar lacks a capability", async () => {
    const errors: Array<{ code?: string }> = [];
    const { manager } = makeManager({
      // No "screenshot", no "input.mouse" — but everything capture needs.
      capabilities: [
        "enumerate.displays",
        "enumerate.windows",
        "capture.display",
        "input.keyboard",
      ],
      impl: async (_options, deps) => {
        for (const call of [
          () => deps.captureFrame({ format: "png" }),
          () => deps.performInput([{ kind: "mouse_click", x: 5, y: 5, button: "left" }]),
        ]) {
          await call().catch((err) => errors.push(err as { code?: string }));
        }
        return {
          state: "failed",
          steps: [],
          error: { code: "UNSUPPORTED_CAPABILITY", message: "" },
        };
      },
    });

    const { runId } = await manager.runOperator({
      task: "screenshot me",
      model: MODEL,
      recording: { disabled: true },
    });
    await manager.whenSettled(runId);

    expect(errors.map((e) => e.code)).toEqual(["UNSUPPORTED_CAPABILITY", "UNSUPPORTED_CAPABILITY"]);
    expect((await readRunFile(runId)).state).toBe("failed");
  });

  it("keeps the sidecar error taxonomy when input is rejected by the backend", async () => {
    let code: string | undefined;
    const { manager } = makeManager({
      impl: async (_options, deps) => {
        await deps
          .performInput([{ kind: "mouse_click", x: 99_999, y: 99_999, button: "left" }])
          .catch((err) => {
            code = (err as { code?: string }).code;
          });
        return { state: "succeeded", steps: [] };
      },
    });
    const { runId } = await manager.runOperator({
      task: "click far away",
      model: MODEL,
      recording: { disabled: true },
    });
    await manager.whenSettled(runId);
    expect(code).toBe("INPUT_OUT_OF_BOUNDS");
  });

  it("fails the run (not the daemon) when the operator loop throws", async () => {
    const { manager } = makeManager({
      impl: async () => {
        throw new Error("model exploded");
      },
    });
    const { runId } = await manager.runOperator({
      task: "boom",
      model: MODEL,
      recording: { disabled: true },
    });
    await manager.whenSettled(runId);
    const run = await readRunFile(runId);
    expect(run.state).toBe("failed");
    expect(run.error).toEqual({ code: "INTERNAL_ERROR", message: "model exploded" });
  });

  it("throws OPERATOR_RUN_NOT_FOUND for an unknown runId", () => {
    const { manager } = makeManager();
    expect(() => manager.getOperatorRun({ runId: "nope" })).toThrow(
      expect.objectContaining({ code: "OPERATOR_RUN_NOT_FOUND" }),
    );
  });

  it("applies guardrail defaults and passes the target bounds to the loop", async () => {
    const { manager, seen } = makeManager();
    const { runId } = await manager.runOperator({
      task: "bounded",
      model: MODEL,
      recording: { disabled: true },
      guardrails: { timeoutSeconds: 12 },
    });
    await manager.whenSettled(runId);

    const options = seen[0]?.options;
    expect(options?.maxSteps).toBe(40);
    expect(options?.timeoutMs).toBe(12_000);
    expect(options?.unbounded).toBe(false);
    expect(options?.bounds).toEqual(DISPLAY_TARGET.bounds);
  });

  it("lists runs and filters by state", async () => {
    const { manager } = makeManager();
    const { runId } = await manager.runOperator({
      task: "one",
      model: MODEL,
      recording: { disabled: true },
    });
    await manager.whenSettled(runId);
    expect(manager.listOperatorRuns({}).runs).toHaveLength(1);
    expect(manager.listOperatorRuns({ state: "succeeded" }).runs).toHaveLength(1);
    expect(manager.listOperatorRuns({ state: "failed" }).runs).toHaveLength(0);
  });
});
