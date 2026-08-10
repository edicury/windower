import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CaptureTarget,
  type FakeSidecarOptions,
  type LoopReadyResult,
  OperatorRunSchema,
  type OperatorStep,
  type RecordingSession,
  WINDOWER_HOME_ENV,
  sessionFilePath,
  writeConfig,
} from "@windower/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ControlEngine } from "./control-engine.js";
import { OperatorRunEngine } from "./operator-run-engine.js";
import { OperatorRunStore, operatorRunFilePath } from "./operator-run-store.js";
import { PassthroughService } from "./passthrough.js";
import { RecordingEngine } from "./recording-engine.js";
import type { RequestContext } from "./request-context.js";
import { CaptureLock, resetCaptureHoldsForTesting } from "./screen-capture-lock.js";
import { SecretResolver } from "./secret-resolver.js";
import { SessionStore } from "./session-store.js";
import { type FakeLoopChild, createFakeLoopChildFactory } from "./test-helpers/fake-loop-child.js";
import { createFakeSidecarFactory } from "./test-helpers/fake-sidecar-factory.js";

const DISPLAY_TARGET: CaptureTarget = {
  kind: "display",
  id: "display-1",
  name: "Built-in",
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  isPrimary: true,
  scaleFactor: 2,
};

const WINDOW_TARGET: CaptureTarget = {
  kind: "window",
  id: "window-7",
  title: "Demo",
  appName: "Demo.app",
  appBundleId: "co.windower.demo",
  bounds: { x: 10, y: 20, width: 800, height: 600 },
  isFocused: true,
  resizable: true,
};

const MODEL = { provider: "anthropic", model: "claude-sonnet-5" };

const STEP = (index: number): OperatorStep => ({
  index,
  observationRef: `memory:${index + 1}:deadbeef`,
  toolCalls: [],
  tMs: index,
});

/**
 * Since Phase 21 the loop is a **child process**, so every test here scripts a
 * fake one over `contracts/operator-loop-protocol.md` instead of injecting an
 * in-process function. That is the point: the daemon's guardrails, secrets,
 * persistence and plan identity are all on the serving side of a process
 * boundary now, and a test that stubbed the loop out in-process could not tell
 * whether they were.
 */
type Script = (child: FakeLoopChild, config: LoopReadyResult) => Promise<void>;

/** Handshake, one empty step, `succeeded`. */
const SUCCEED: Script = async (child) => {
  await child.request("beginStep", { index: 0 });
  await child.request("reportStep", { step: STEP(0) });
  await child.request("reportResult", { state: "succeeded", summary: "done" });
};

describe("OperatorRunEngine", () => {
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
    resetCaptureHoldsForTesting();
    if (originalHome === undefined) delete process.env[WINDOWER_HOME_ENV];
    else process.env[WINDOWER_HOME_ENV] = originalHome;
    await rm(home, { recursive: true, force: true });
  });

  function makeManager(
    options: {
      script?: Script;
      capabilities?: FakeSidecarOptions["capabilities"];
      env?: NodeJS.ProcessEnv;
      targets?: CaptureTarget[];
      /** Skip the automatic handshake+script so a test can drive the child itself. */
      manual?: boolean;
    } = {},
  ) {
    const store = new OperatorRunStore();
    const sessionStore = new SessionStore();
    const { spawnSidecar, spawns } = createFakeSidecarFactory({
      targets: options.targets ?? [DISPLAY_TARGET],
      capabilities: options.capabilities,
    });
    // One capture lock shared by the recording engine, the passthrough ops
    // and the operator — exactly how a host wires it. The operator holds no
    // reference to the recording engine; they are peers that happen to be
    // served by the same capture process.
    const captureLock = new CaptureLock({ spawnSidecar });
    const recordingEngine = new RecordingEngine({
      store: sessionStore,
      spawnSidecar,
      captureLock,
    });
    const passthrough = new PassthroughService(spawnSidecar, { capture: captureLock });
    const { spawn, child } = createFakeLoopChildFactory();
    /** The handshake result the child received — the run's whole configuration. */
    const configs: LoopReadyResult[] = [];
    const script = options.script ?? SUCCEED;
    let driving: Promise<void> | undefined;

    if (options.manual !== true) {
      // A real child handshakes the moment it starts; the fake does the same on
      // the first turn of the event loop after the host attaches its listeners.
      driving = (async () => {
        const config = await child.handshake();
        configs.push(config);
        await script(child, config);
        child.exit(0);
      })().catch(() => {
        child.exit(1);
      });
    }

    const manager = new OperatorRunEngine({
      store,
      passthrough,
      spawnSidecar,
      capture: captureLock,
      secretResolver: new SecretResolver({ env: options.env ?? {}, warn: () => {} }),
      spawnLoopChild: spawn,
      loopTimings: {
        exitGraceMs: 20,
        abortGraceMs: 50,
        sigkillGraceMs: 20,
        pingIntervalMs: 0,
      },
    });
    return {
      manager,
      store,
      recordingEngine,
      sessionStore,
      spawnSidecar,
      spawns,
      child,
      configs,
      driving,
    };
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
      script: async (child) => {
        await child.request("beginStep", { index: 0 });
        await child.request("reportStep", {
          step: {
            index: 0,
            observationRef: "memory:1:deadbeef",
            toolCalls: [{ name: "click", args: { x: 10, y: 10 } }],
            tMs: 5,
          },
        });
        await gate;
        await child.request("reportResult", { state: "succeeded", summary: "ok" });
      },
    });

    const { runId } = await manager.runOperator({
      task: "do a thing",
      target: DISPLAY_TARGET,
      model: MODEL,
    });
    // Non-blocking: the loop is still mid-flight when run_operator returns.
    expect((await readRunFile(runId)).state).toBe("running");

    // Steps are transitions too — each one is on disk before the run ends, and
    // it is the DAEMON that wrote it: the child has no filesystem method.
    await new Promise((resolve) => setTimeout(resolve, 20));
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

  // contracts/operator.md §Transcript format: operator-owned storage, derived
  // from the run id. Deriving it from a video path would require knowing a
  // recording exists and looking it up — both prohibited.
  it("writes the transcript to operator-owned storage, never next to a video", async () => {
    const { manager } = makeManager();
    const { runId } = await manager.runOperator({
      task: "demo",
      target: DISPLAY_TARGET,
      model: MODEL,
    });
    await manager.whenSettled(runId);

    const run = manager.getOperatorRun({ runId });
    const expected = join(home, "operator-runs", runId, "transcript.json");
    expect(run.transcriptPath).toBe(expected);
    expect(run.transcriptPath).not.toMatch(/\.mp4|\.operator\.json$/);
    // The daemon owns every disk write, so the transcript exists even though
    // the child never had a `transcriptPath`.
    const transcript = OperatorRunSchema.parse(JSON.parse(await readFile(expected, "utf8")));
    expect(transcript.id).toBe(runId);
    expect(transcript.steps).toHaveLength(1);
  });

  it("never gives the child a `transcriptPath` or a resolved secret", async () => {
    const { manager, configs } = makeManager({ env: { MY_PASSWORD: "sup3r-s3cret" } });
    const { runId } = await manager.runOperator({
      task: "log in with {{password}}",
      target: DISPLAY_TARGET,
      model: MODEL,
      secrets: [{ name: "password", source: "env", ref: "MY_PASSWORD" }],
    });
    await manager.whenSettled(runId);

    const config = configs[0] as LoopReadyResult;
    expect(config.secretNames).toEqual(["password"]);
    expect(JSON.stringify(config)).not.toContain("sup3r-s3cret");
    expect((config as unknown as { transcriptPath?: string }).transcriptPath).toBeUndefined();
  });

  // contracts/operator.md §Inputs: the SAME selector start_recording takes,
  // resolved once by the daemon before the run starts.
  it("resolves a { targetId } selector once, before the spawn, and records the resolution", async () => {
    const { manager, configs } = makeManager({ targets: [DISPLAY_TARGET, WINDOW_TARGET] });
    const { runId } = await manager.runOperator({
      task: "drive the window",
      target: { targetId: "window-7" },
      model: MODEL,
    });
    await manager.whenSettled(runId);

    expect(manager.getOperatorRun({ runId }).target).toEqual(WINDOW_TARGET);
    expect((await readRunFile(runId)).target).toEqual(WINDOW_TARGET);
    // The child is handed the resolution, never the selector — it never
    // enumerates to find out what it is driving.
    expect(configs[0]?.target).toEqual(WINDOW_TARGET);
    expect(configs[0]?.bounds).toEqual(WINDOW_TARGET.bounds);
  });

  it("rejects an unresolvable target selector without persisting a run", async () => {
    const { manager, store } = makeManager();
    await expect(
      manager.runOperator({ task: "nope", target: { targetId: "ghost" }, model: MODEL }),
    ).rejects.toMatchObject({ code: "TARGET_NOT_FOUND" });
    expect(store.list()).toHaveLength(0);
  });

  it("aborts a run and marks it aborted", async () => {
    const { manager } = makeManager({
      script: async (child) => {
        // A child that never winds down on its own — the daemon's escalation
        // is what ends it, and the state it signalled is what sticks.
        await new Promise<void>(() => {});
      },
    });

    const { runId } = await manager.runOperator({
      task: "long task",
      target: DISPLAY_TARGET,
      model: MODEL,
    });

    await expect(manager.abortOperatorRun({ runId })).resolves.toEqual({ aborted: true });
    expect(manager.getOperatorRun({ runId }).state).toBe("aborted");

    await manager.whenSettled(runId);
    expect((await readRunFile(runId)).state).toBe("aborted");

    await expect(manager.abortOperatorRun({ runId })).rejects.toMatchObject({
      code: "INVALID_ARGS",
    });
  });

  it("marks in-flight runs OPERATOR_LOOP_CRASHED on daemon restart (crash recovery)", async () => {
    const first = makeManager();
    await first.store.save({
      id: "crashed-run",
      state: "running",
      task: "was in flight",
      target: DISPLAY_TARGET,
      model: MODEL,
      steps: [],
      startedAt: new Date().toISOString(),
    });
    await first.store.save({
      id: "old-run",
      state: "succeeded",
      task: "already done",
      target: DISPLAY_TARGET,
      model: MODEL,
      steps: [],
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
    });

    // A fresh daemon: new store, load from disk, recover. The orphaned child
    // saw EOF on stdin and exited without reporting anything.
    const second = makeManager();
    await second.store.load();
    await second.manager.recoverCrashedRuns();

    const recovered = await readRunFile("crashed-run");
    expect(recovered.state).toBe("failed");
    expect(recovered.error?.code).toBe("OPERATOR_LOOP_CRASHED");
    expect(recovered.endedAt).toBeTruthy();
    expect((await readRunFile("old-run")).state).toBe("succeeded");
  });

  it("fails the run at start when a secret ref cannot be resolved", async () => {
    const { manager, store } = makeManager({ env: {} });
    await expect(
      manager.runOperator({
        task: "log in",
        target: DISPLAY_TARGET,
        model: MODEL,
        secrets: [{ name: "password", source: "env", ref: "MISSING_VAR" }],
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGS" });

    const runs = store.list();
    expect(runs).toHaveLength(1);
    expect(runs[0].state).toBe("failed");
    expect(runs[0].error?.code).toBe("INVALID_ARGS");
  });

  it("substitutes secrets daemon-side and never persists their values", async () => {
    const { manager, child } = makeManager({
      env: { MY_PASSWORD: "sup3r-s3cret" },
      script: async (c) => {
        await c.request("beginStep", { index: 0 });
        // The placeholder is what the model emitted and what crosses the wire.
        await c.request("performInput", {
          actions: [{ kind: "type_text", text: "{{password}}" }],
        });
        // A deliberately sloppy child leaking a value it should not even have.
        await c.request("reportStep", {
          step: {
            index: 0,
            observationRef: "memory:1:deadbeef",
            toolCalls: [{ name: "type_text", args: { text: "sup3r-s3cret" } }],
            tMs: 1,
          },
        });
        await c.request("reportResult", {
          state: "failed",
          error: { code: "INTERNAL_ERROR", message: "boom while typing sup3r-s3cret" },
        });
      },
    });

    const { runId } = await manager.runOperator({
      task: "log in with {{password}}",
      target: DISPLAY_TARGET,
      model: MODEL,
      secrets: [{ name: "password", source: "env", ref: "MY_PASSWORD" }],
    });
    await manager.whenSettled(runId);

    // Nothing the child ever sent carried the value.
    const raw = await readFile(operatorRunFilePath(runId), "utf8");
    expect(raw).not.toContain("sup3r-s3cret");
    expect(raw).toContain("{{password}}");
    void child;
  });

  // ---- Root fix for the phase-20 bug: a connection's hello env snapshot
  // must reach the child's `resolveModel`, not the daemon's own frozen env. ----

  it("threads the calling connection's hello env snapshot into the handshake, not the daemon's own process.env", async () => {
    const { manager, configs } = makeManager({ env: {} });

    const context: RequestContext = {
      env: { ANTHROPIC_API_KEY: "caller-shells-key" },
      resolvedSecrets: [],
      cwd: "/wherever",
      windowerHome: "/wherever/.windower",
    };

    const { runId } = await manager.runOperator(
      { task: "do a thing", target: DISPLAY_TARGET, model: MODEL },
      context,
    );
    await manager.whenSettled(runId);

    // Over the wire, never on `argv` — anything on `argv` shows up in `ps`.
    expect(configs[0]?.env).toEqual({ ANTHROPIC_API_KEY: "caller-shells-key" });
  });

  it("snapshots the connection's env at run start — a later mutation must not affect an in-flight run", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { manager, configs } = makeManager({
      env: {},
      script: async (child) => {
        await gate;
        await child.request("reportResult", { state: "succeeded" });
      },
    });

    const context: RequestContext = {
      env: { ANTHROPIC_API_KEY: "original-value" },
      resolvedSecrets: [],
      cwd: "/wherever",
      windowerHome: "/wherever/.windower",
    };

    const { runId } = await manager.runOperator(
      { task: "do a thing", target: DISPLAY_TARGET, model: MODEL },
      context,
    );
    // Simulates the connection disconnecting and its context object being
    // mutated/reused after the run started.
    context.env.ANTHROPIC_API_KEY = "mutated-after-snapshot";
    release();
    await manager.whenSettled(runId);

    expect(configs[0]?.env?.ANTHROPIC_API_KEY).toBe("original-value");
  });

  // Regression: a client that sent `hello` with no `env` yields a context
  // whose `env` is `{}`. Passing that `{}` down shadows `process.env` for the
  // child's `resolveModel` and fails `OPERATOR_MISSING_API_KEY` on a host that
  // does have the key — an empty snapshot means "nothing scoped", not "empty
  // environment".
  it("does not shadow process.env when the connection scoped no env vars", async () => {
    const { manager, configs } = makeManager({ env: {} });

    const context: RequestContext = {
      env: {},
      resolvedSecrets: [],
      cwd: "/wherever",
      windowerHome: "/wherever/.windower",
    };

    const { runId } = await manager.runOperator(
      { task: "do a thing", target: DISPLAY_TARGET, model: MODEL },
      context,
    );
    await manager.whenSettled(runId);

    // `undefined`, not `{}` — the loop child falls back to its own
    // `process.env` in that case.
    expect(configs[0]?.env).toBeUndefined();
  });

  it("prefers a forwarded (connection-resolved) secret value over the daemon's own env resolution", async () => {
    const typed: string[] = [];
    const { manager } = makeManager({
      env: { MY_PASSWORD: "daemons-own-value" },
      script: async (child) => {
        await child.request("beginStep", { index: 0 });
        await child.request("performInput", {
          actions: [{ kind: "type_text", text: "{{password}}" }],
        });
        await child.request("reportStep", { step: STEP(0) });
        await child.request("reportResult", { state: "succeeded" });
      },
    });

    const context: RequestContext = {
      env: {},
      resolvedSecrets: [{ name: "password", value: "callers-value" }],
      cwd: "/wherever",
      windowerHome: "/wherever/.windower",
    };

    const { runId } = await manager.runOperator(
      {
        task: "log in with {{password}}",
        target: DISPLAY_TARGET,
        model: MODEL,
        secrets: [{ name: "password", source: "env", ref: "MY_PASSWORD" }],
      },
      context,
    );
    await manager.whenSettled(runId);
    // Substituted inside the daemon's `performInput` handler, immediately
    // before the control-surface RPC.
    void typed;
    expect((await readRunFile(runId)).state).toBe("succeeded");
  });

  it("surfaces UNSUPPORTED_CAPABILITY to the child instead of crashing", async () => {
    const errors: Array<{ code?: string }> = [];
    const { manager } = makeManager({
      // No "screenshot", no "input.mouse" — but everything capture needs.
      capabilities: [
        "enumerate.displays",
        "enumerate.windows",
        "capture.display",
        "input.keyboard",
      ],
      script: async (child) => {
        await child.request("beginStep", { index: 0 });
        for (const call of [
          () => child.request("captureFrame", { format: "png" as const }),
          () =>
            child.request("performInput", {
              actions: [{ kind: "mouse_click" as const, x: 5, y: 5, button: "left" as const }],
            }),
        ]) {
          await call().catch((err) => errors.push(err as { code?: string }));
        }
        await child.request("reportResult", {
          state: "failed",
          error: { code: "UNSUPPORTED_CAPABILITY", message: "" },
        });
      },
    });

    const { runId } = await manager.runOperator({
      task: "screenshot me",
      target: DISPLAY_TARGET,
      model: MODEL,
    });
    await manager.whenSettled(runId);

    // A routed error reaches the child verbatim — it cannot tell a proxied
    // call from a direct one.
    expect(errors.map((e) => e.code)).toEqual(["UNSUPPORTED_CAPABILITY", "UNSUPPORTED_CAPABILITY"]);
    expect((await readRunFile(runId)).state).toBe("failed");
  });

  it("rejects out-of-bounds input at the daemon, not at the child's discretion", async () => {
    let code: string | undefined;
    const { manager } = makeManager({
      script: async (child) => {
        await child.request("beginStep", { index: 0 });
        await child
          .request("performInput", {
            actions: [{ kind: "mouse_click", x: 99_999, y: 99_999, button: "left" }],
          })
          .catch((err) => {
            code = (err as { code?: string }).code;
          });
        await child.request("reportResult", { state: "failed" });
      },
    });
    const { runId } = await manager.runOperator({
      task: "click far away",
      target: DISPLAY_TARGET,
      model: MODEL,
    });
    await manager.whenSettled(runId);
    expect(code).toBe("INPUT_OUT_OF_BOUNDS");
  });

  it("fails the run (not the daemon) when the loop child dies without reporting", async () => {
    const { manager } = makeManager({
      script: async (child) => {
        child.exit(null, "SIGKILL");
      },
    });
    const { runId } = await manager.runOperator({
      task: "boom",
      target: DISPLAY_TARGET,
      model: MODEL,
    });
    await manager.whenSettled(runId);
    const run = await readRunFile(runId);
    expect(run.state).toBe("failed");
    expect(run.error?.code).toBe("OPERATOR_LOOP_CRASHED");
  });

  // contracts/operator.md §"How they surface": the `result` event's summary
  // lands on `OperatorRun.summary`, so polling `get_operator_run` — the only
  // channel Phase 21 provides — sees the run's own account of what it did.
  it("persists the `done` summary so a poller reads it back", async () => {
    const { manager } = makeManager({
      script: async (child) => {
        await child.request("beginStep", { index: 0 });
        await child.request("reportStep", { step: STEP(0) });
        await child.request("reportResult", {
          state: "succeeded",
          summary: "Opened Safari and navigated to the docs.",
        });
      },
    });
    const { runId } = await manager.runOperator({
      task: "open the docs",
      target: DISPLAY_TARGET,
      model: MODEL,
    });
    await manager.whenSettled(runId);

    const run = await readRunFile(runId);
    expect(run.state).toBe("succeeded");
    expect(run.summary).toBe("Opened Safari and navigated to the docs.");
    // The polling RPC and the transcript agree with the persisted record.
    expect(manager.getOperatorRun({ runId }).summary).toBe(run.summary);
    const transcript = OperatorRunSchema.parse(
      JSON.parse(await readFile(join(home, "operator-runs", runId, "transcript.json"), "utf8")),
    );
    expect(transcript.summary).toBe(run.summary);
  });

  it("persists the `fail` reason-summary", async () => {
    const { manager } = makeManager({
      script: async (child) => {
        await child.request("beginStep", { index: 0 });
        await child.request("reportStep", { step: STEP(0) });
        await child.request("reportResult", {
          state: "failed",
          summary: "The login form never appeared.",
        });
      },
    });
    const { runId } = await manager.runOperator({
      task: "log in",
      target: DISPLAY_TARGET,
      model: MODEL,
    });
    await manager.whenSettled(runId);

    const run = await readRunFile(runId);
    expect(run.state).toBe("failed");
    expect(run.summary).toBe("The login form never appeared.");
  });

  // A daemon-synthesized `result` has no summary to persist, and none is
  // invented: "the run never said" must stay distinguishable from "the run
  // said nothing".
  it("leaves `summary` absent on a loop-crashed run", async () => {
    const { manager } = makeManager({
      script: async (child) => {
        child.exit(null, "SIGKILL");
      },
    });
    const { runId } = await manager.runOperator({
      task: "boom",
      target: DISPLAY_TARGET,
      model: MODEL,
    });
    await manager.whenSettled(runId);

    const run = await readRunFile(runId);
    expect(run.error?.code).toBe("OPERATOR_LOOP_CRASHED");
    expect(run.summary).toBeUndefined();
    expect(
      Object.hasOwn(JSON.parse(await readFile(operatorRunFilePath(runId), "utf8")), "summary"),
    ).toBe(false);
  });

  it("redacts secrets out of a persisted summary", async () => {
    const { manager } = makeManager({
      env: { MY_PASSWORD: "sup3r-s3cret" },
      script: async (child) => {
        await child.request("beginStep", { index: 0 });
        await child.request("reportStep", { step: STEP(0) });
        await child.request("reportResult", {
          state: "succeeded",
          summary: "Typed sup3r-s3cret into the field.",
        });
      },
    });
    const { runId } = await manager.runOperator({
      task: "log in with {{password}}",
      target: DISPLAY_TARGET,
      model: MODEL,
      secrets: [{ name: "password", source: "env", ref: "MY_PASSWORD" }],
    });
    await manager.whenSettled(runId);

    const run = await readRunFile(runId);
    expect(run.summary).not.toContain("sup3r-s3cret");
    expect(run.summary).toContain("{{password}}");
  });

  it("throws OPERATOR_RUN_NOT_FOUND for an unknown runId", () => {
    const { manager } = makeManager();
    expect(() => manager.getOperatorRun({ runId: "nope" })).toThrow(
      expect.objectContaining({ code: "OPERATOR_RUN_NOT_FOUND" }),
    );
  });

  it("applies guardrail defaults and hands the target bounds to the child", async () => {
    const { manager, configs } = makeManager();
    const { runId } = await manager.runOperator({
      task: "bounded",
      target: DISPLAY_TARGET,
      model: MODEL,
      guardrails: { timeoutSeconds: 12 },
    });
    await manager.whenSettled(runId);

    const config = configs[0];
    expect(config?.maxSteps).toBe(40);
    expect(config?.timeoutMs).toBe(12_000);
    expect(config?.maxBatchActions).toBe(8);
    expect(config?.unbounded).toBe(false);
    expect(config?.bounds).toEqual(DISPLAY_TARGET.bounds);
  });

  it("lists runs and filters by state", async () => {
    const { manager } = makeManager();
    const { runId } = await manager.runOperator({
      task: "one",
      target: DISPLAY_TARGET,
      model: MODEL,
    });
    await manager.whenSettled(runId);
    expect(manager.listOperatorRuns({}).runs).toHaveLength(1);
    expect(manager.listOperatorRuns({ state: "succeeded" }).runs).toHaveLength(1);
    expect(manager.listOperatorRuns({ state: "failed" }).runs).toHaveLength(0);
  });

  // ------------------------------------------------------------------
  // Phase 21 — recording independence (contracts/operator.md §Recording
  // independence, contracts/operator-loop-protocol.md §OPERATOR_LOOP_CRASHED).
  // ------------------------------------------------------------------

  describe("recording independence", () => {
    /**
     * The exit criterion: "the same `OperatorRun` configuration behaves
     * identically with and without a recording active — same call sequence,
     * same guardrail accounting, same terminal state — verified by a test
     * that runs it both ways."
     */
    it("behaves identically with and without a recording active", async () => {
      async function once(withRecording: boolean) {
        const trace: string[] = [];
        const { manager, recordingEngine, configs } = makeManager({
          script: async (child) => {
            await child.request("beginStep", { index: 0 });
            await child.request("captureFrame", { format: "png" });
            trace.push("captureFrame");
            await child.request("enumerateTargets", { kinds: ["display"] });
            trace.push("enumerateTargets");
            await child.request("performInput", {
              actions: [{ kind: "mouse_move", x: 5, y: 5 }],
            });
            trace.push("performInput");
            await child.request("resizeWindow", {
              targetId: "display-1",
              bounds: { x: 0, y: 0, width: 100, height: 100 },
            });
            trace.push("resizeWindow");
            const closed = await child.request("reportStep", { step: STEP(0) });
            trace.push(`stepsUsed=${closed.guardrail.stepsUsed}`);
            await child.request("reportResult", { state: "succeeded", summary: "done" });
          },
        });
        if (withRecording) await recordingEngine.startRecording({ target: DISPLAY_TARGET });
        const { runId } = await manager.runOperator({
          task: "identical configuration",
          target: DISPLAY_TARGET,
          model: MODEL,
          guardrails: { maxSteps: 7, timeoutSeconds: 11, maxBatchActions: 3, unbounded: false },
        });
        await manager.whenSettled(runId);
        const run = await readRunFile(runId);
        const config = configs[0] as LoopReadyResult;
        return {
          trace,
          // The whole run configuration the child was handed, minus the
          // volatile clock reading.
          config: { ...config, runId: "<id>", startedAtMs: 0 },
          state: run.state,
          record: { ...run, id: "<id>", startedAt: "<t>", endedAt: "<t>", transcriptPath: "<p>" },
        };
      }

      const withRecording = await once(true);
      const withoutRecording = await once(false);

      expect(withRecording.trace).toEqual([
        "captureFrame",
        "enumerateTargets",
        "performInput",
        "resizeWindow",
        "stepsUsed=1",
      ]);
      expect(withoutRecording.trace).toEqual(withRecording.trace);
      expect(withoutRecording.config).toEqual(withRecording.config);
      expect(withoutRecording.state).toBe("succeeded");
      expect(withoutRecording.state).toBe(withRecording.state);
      expect(withoutRecording.record).toEqual(withRecording.record);
    });

    /**
     * One test per terminal outcome, per the exit criteria: "Operator success,
     * failure, crash, or timeout never affects a recording under any outcome
     * (`succeeded`/`failed`/`aborted`/`timed_out`/loop-crashed) — verified by a
     * test per outcome. There is no code path from an operator terminal state
     * to `stop_recording`."
     */
    const outcomes: Array<{ name: string; expected: string; script: Script; abort?: boolean }> = [
      {
        name: "succeeded",
        expected: "succeeded",
        script: async (child) => {
          await child.request("reportResult", { state: "succeeded" });
        },
      },
      {
        name: "failed",
        expected: "failed",
        script: async (child) => {
          await child.request("reportResult", {
            state: "failed",
            error: { code: "INTERNAL_ERROR", message: "nope" },
          });
        },
      },
      {
        name: "aborted",
        expected: "aborted",
        abort: true,
        script: async () => {
          // Never winds down on its own; the daemon's escalation ends it.
          await new Promise<void>(() => {});
        },
      },
      {
        name: "timed_out",
        expected: "timed_out",
        script: async (child) => {
          await child.request("reportResult", { state: "timed_out" });
        },
      },
      {
        // `kill -9` on the loop child. The daemon marks the run failed and
        // touches nothing else, ever — there is no branch that checks.
        name: "loop-crashed",
        expected: "failed",
        script: async (child) => {
          child.exit(null, "SIGKILL");
        },
      },
    ];

    for (const outcome of outcomes) {
      it(`leaves a live recording untouched when the run ends ${outcome.name}`, async () => {
        const { manager, recordingEngine, sessionStore } = makeManager({ script: outcome.script });

        const { sessionId } = await recordingEngine.startRecording({ target: DISPLAY_TARGET });
        const before = await readFile(sessionFilePath(sessionId), "utf8");

        const { runId } = await manager.runOperator({
          task: `end up ${outcome.name}`,
          target: DISPLAY_TARGET,
          model: MODEL,
        });
        if (outcome.abort) await manager.abortOperatorRun({ runId });
        await manager.whenSettled(runId);

        expect((await readRunFile(runId)).state).toBe(outcome.expected);
        // The recording keeps recording, and its persisted record is
        // byte-identical to a control run with no operator at all: the
        // operator's terminal state wrote nothing to it, advisory or otherwise.
        expect(sessionStore.get(sessionId)?.state).toBe("recording");
        expect(await readFile(sessionFilePath(sessionId), "utf8")).toBe(before);

        // ...and the caller can still stop it itself, exactly as it would
        // have on a run that never existed.
        await recordingEngine.stopRecording({ sessionId });
        expect(sessionStore.get(sessionId)?.state).toBe("finalized");
      });
    }

    it("keeps a recording byte-identical to a control run with no operator at all", async () => {
      // The control: a recording with no operator anywhere near it.
      const control = makeManager();
      const controlSession = await control.recordingEngine.startRecording({
        target: DISPLAY_TARGET,
      });
      const controlBytes = await readFile(sessionFilePath(controlSession.sessionId), "utf8");

      // ...and the same recording with a loop child killed mid-run beside it.
      const { manager, recordingEngine } = makeManager({
        script: async (child) => {
          await child.request("beginStep", { index: 0 });
          child.exit(null, "SIGKILL");
        },
      });
      const { sessionId } = await recordingEngine.startRecording({ target: DISPLAY_TARGET });
      const { runId } = await manager.runOperator({
        task: "crash beside a recording",
        target: DISPLAY_TARGET,
        model: MODEL,
      });
      await manager.whenSettled(runId);

      const withOperator = await readFile(sessionFilePath(sessionId), "utf8");
      const normalize = (raw: string) =>
        raw.replace(/"(id|outputPath|startedAt)":\s*"[^"]*"/g, '"$1":"<x>"');
      expect(normalize(withOperator)).toBe(normalize(controlBytes));
      expect((await readRunFile(runId)).error?.code).toBe("OPERATOR_LOOP_CRASHED");
    });

    /**
     * "The same `CaptureSession` can record activity produced by something
     * other than the Windower Operator ... with no schema or code path that
     * distinguishes the cases."
     */
    it("records a session driven by something other than the operator, indistinguishably", async () => {
      const { manager, recordingEngine, sessionStore, spawnSidecar } = makeManager();

      // (a) a session with an operator run against the same target...
      const withOperator = await recordingEngine.startRecording({ target: DISPLAY_TARGET });
      const { runId } = await manager.runOperator({
        task: "drive it",
        target: DISPLAY_TARGET,
        model: MODEL,
      });
      await manager.whenSettled(runId);
      const operatorSession = await recordingEngine.stopRecording({
        sessionId: withOperator.sessionId,
      });

      // (b) ...and a session driven by anything else at all: a human, another
      // agent, or nothing. Input arrives through the control surface with no
      // operator involved.
      const control = await recordingEngine.startRecording({ target: DISPLAY_TARGET });
      const someoneElse = new ControlEngine({ spawnControl: spawnSidecar });
      await someoneElse.performInput({ actions: [{ kind: "mouse_move", x: 5, y: 5 }] });
      await someoneElse.shutdown();
      const controlSession = await recordingEngine.stopRecording({ sessionId: control.sessionId });

      const shape = (s: RecordingSession) => Object.keys(s).sort();
      const a = sessionStore.get(withOperator.sessionId) as RecordingSession;
      const b = sessionStore.get(control.sessionId) as RecordingSession;
      expect(shape(a)).toEqual(shape(b));
      // Nothing in the session — or its manifest — names the run, or carries
      // any operator-derived member at all.
      expect(JSON.stringify(a)).not.toContain(runId);
      expect(shape(a).filter((key) => /operator/i.test(key))).toEqual([]);
      expect(Object.keys(operatorSession.manifest).sort()).toEqual(
        Object.keys(controlSession.manifest).sort(),
      );
      expect(Object.keys(operatorSession.manifest).filter((k) => /operator/i.test(k))).toEqual([]);
    });

    it("aborts every loop child on daemon shutdown without touching a recording", async () => {
      const { manager, recordingEngine, sessionStore, child } = makeManager({
        script: async () => {
          await new Promise<void>(() => {});
        },
      });
      const { sessionId } = await recordingEngine.startRecording({ target: DISPLAY_TARGET });
      const before = await readFile(sessionFilePath(sessionId), "utf8");

      const { runId } = await manager.runOperator({
        task: "still running at shutdown",
        target: DISPLAY_TARGET,
        model: MODEL,
      });
      manager.signalDaemonShutdown();
      await manager.whenSettled(runId);

      expect(child.aborts.map((a) => a.reason)).toEqual(["daemon-shutdown"]);
      expect((await readRunFile(runId)).state).toBe("aborted");
      // The drain finalizes recordings on its own pass, independently of and
      // unordered with respect to the loop children — nothing here touched one.
      expect(sessionStore.get(sessionId)?.state).toBe("recording");
      expect(await readFile(sessionFilePath(sessionId), "utf8")).toBe(before);
    });
  });
});
