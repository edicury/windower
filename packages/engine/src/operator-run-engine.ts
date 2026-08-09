import { randomUUID } from "node:crypto";
import { basename, dirname, extname, join } from "node:path";
import {
  type CaptureTarget,
  DEFAULT_OPERATOR_MAX_STEPS,
  DEFAULT_OPERATOR_TIMEOUT_MS,
  DaemonError,
  type DaemonMethodMap,
  type InputAction,
  type OperatorDeps,
  type OperatorRun,
  type OperatorRunResult,
  type OperatorStep,
  type Rect,
  type ResolvedSecret,
  type RunOperator,
  type SidecarClient,
  SidecarError,
  isTerminalOperatorRunState,
  requiredCapabilityForInputAction,
} from "@windower/core";
import type { OperatorRunStore } from "./operator-run-store.js";
import type { PassthroughService } from "./passthrough.js";
import type { RecordingEngine, SidecarFactory, SidecarHandle } from "./recording-engine.js";
import type { RequestContext } from "./request-context.js";
import { SecretResolver, redactSecrets } from "./secret-resolver.js";

/**
 * The daemon half of Phase 19. `OperatorRunEngine` owns the `OperatorRun`
 * state machine (`pending -> running -> succeeded|failed|aborted|timed_out`,
 * data-model.md §OperatorRun), persists every transition through
 * `OperatorRunStore` exactly as `RecordingEngine` does for `RecordingSession`,
 * and wires the loop in `packages/operator` to a real sidecar.
 *
 * It deliberately owns *no* agent logic: the observe → decide → act loop is
 * `runOperator` from `packages/operator`, reached through the `RunOperator`
 * type in `@windower/core`'s operator seam. That package is loaded lazily
 * (see `defaultLoadRunOperator`) and is injectable, so the daemon builds,
 * typechecks, and tests without it.
 *
 * Nothing here branches on the host OS — capabilities are read from
 * `describe().capabilities` and the one platform-shaped concern (keychain
 * lookup) lives behind `SecretResolver`'s swappable resolver function
 * (CLAUDE.md §protocol before platform).
 */

/** Injection seam for the operator loop — tests stub this, production loads `@windower/operator`. */
export type OperatorRunnerLoader = () => Promise<RunOperator>;

/**
 * Resolved through a non-literal specifier so TypeScript does not try to
 * resolve `@windower/operator` at compile time: the daemon must build and test
 * on its own, and the operator package is only needed when a run actually
 * starts.
 */
const OPERATOR_PACKAGE_SPECIFIER = "@windower/operator";

const defaultLoadRunOperator: OperatorRunnerLoader = async () => {
  const specifier: string = OPERATOR_PACKAGE_SPECIFIER;
  const mod = (await import(specifier)) as { runOperator?: RunOperator };
  if (typeof mod.runOperator !== "function") {
    throw new DaemonError(
      "INTERNAL_ERROR",
      `"${OPERATOR_PACKAGE_SPECIFIER}" does not export runOperator`,
    );
  }
  return mod.runOperator;
};

export interface OperatorRunEngineOptions {
  store: OperatorRunStore;
  sessionManager: RecordingEngine;
  passthrough: PassthroughService;
  /** Used for `--no-record` runs, which still need a sidecar for input/screenshots. */
  spawnSidecar: SidecarFactory;
  secretResolver?: SecretResolver;
  loadRunOperator?: OperatorRunnerLoader;
}

interface ActiveRun {
  controller: AbortController;
  aborted: boolean;
  sessionId?: string;
  /** Only set for `--no-record` runs; recording runs borrow the session's sidecar. */
  transientSidecar?: SidecarHandle;
}

function nowIso(): string {
  return new Date().toISOString();
}

function transcriptPathFor(outputPath: string): string {
  const ext = extname(outputPath);
  return join(dirname(outputPath), `${basename(outputPath, ext)}.operator.json`);
}

function toDaemonError(err: unknown): DaemonError {
  if (err instanceof DaemonError) return err;
  // Mirrors server.ts's mapping: a `SidecarError` reaching here (e.g.
  // UNSUPPORTED_CAPABILITY, INPUT_UNSUPPORTED, INPUT_OUT_OF_BOUNDS) must keep
  // its taxonomy code rather than degrade to INTERNAL_ERROR.
  if (err instanceof SidecarError) return new DaemonError(err.code, err.message);
  return new DaemonError("INTERNAL_ERROR", err instanceof Error ? err.message : String(err));
}

function targetBounds(target: CaptureTarget): Rect {
  return target.bounds;
}

export class OperatorRunEngine {
  private readonly store: OperatorRunStore;
  private readonly sessionManager: RecordingEngine;
  private readonly passthrough: PassthroughService;
  private readonly spawnSidecar: SidecarFactory;
  private readonly secretResolver: SecretResolver;
  private readonly loadRunOperator: OperatorRunnerLoader;
  private readonly activeRuns = new Map<string, ActiveRun>();
  /**
   * Kept separate from `activeRuns` (which `finalize` clears *before* it stops
   * the recording, so a late abort is a no-op) so `whenSettled` still waits
   * for the recording to be finalized, not merely for the loop to return.
   */
  private readonly settling = new Map<string, Promise<void>>();

  constructor(options: OperatorRunEngineOptions) {
    this.store = options.store;
    this.sessionManager = options.sessionManager;
    this.passthrough = options.passthrough;
    this.spawnSidecar = options.spawnSidecar;
    this.secretResolver = options.secretResolver ?? new SecretResolver();
    this.loadRunOperator = options.loadRunOperator ?? defaultLoadRunOperator;
  }

  get activeRunCount(): number {
    return this.activeRuns.size;
  }

  /**
   * Best-effort, synchronous SIGKILL sweep over every `--no-record` run's
   * transient sidecar — for `process.on("exit")` (`bin.ts`), which cannot
   * await async work. A recording-backed run's sidecar is the same object
   * `RecordingEngine.activeSidecars` already owns and sweeps; nothing to do
   * here for those (per `phase-20-daemon-optional.md` "Graceful shutdown").
   */
  sigkillActiveSidecars(): void {
    for (const active of this.activeRuns.values()) {
      const pid = active.transientSidecar?.pid;
      if (pid !== undefined) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already dead — nothing to do.
        }
      }
    }
  }

  /**
   * Scans loaded runs for ones stuck in `pending`/`running` from a previous
   * (crashed) daemon instance and marks them `failed` — the operator loop and
   * its sidecar died with that process, so no run can resume. Mirrors
   * `RecordingEngine.recoverCrashedSessions()`; call once at startup, after
   * `OperatorRunStore.load()`.
   */
  async recoverCrashedRuns(): Promise<void> {
    for (const run of this.store.list()) {
      if (run.state === "pending" || run.state === "running") {
        await this.store.save({
          ...run,
          state: "failed",
          endedAt: nowIso(),
          error: {
            code: "INTERNAL_ERROR",
            message: "Daemon restarted while this operator run was in flight; marked failed.",
          },
        });
      }
    }
  }

  /**
   * `run_operator` — returns `{ runId }` promptly and does **not** block for
   * the whole run (contracts/mcp-tools.md: "Same non-blocking two-call shape
   * as `start_recording`"). Everything that can fail deterministically up
   * front (secret resolution, recording start, sidecar handshake) is awaited
   * before returning so the caller gets a structured error instead of a run
   * that dies a moment later.
   */
  async runOperator(
    params: DaemonMethodMap["run_operator"]["params"],
    context?: RequestContext,
  ): Promise<DaemonMethodMap["run_operator"]["result"]> {
    const runId = randomUUID();
    let run: OperatorRun = {
      id: runId,
      state: "pending",
      task: params.task,
      model: params.model,
      steps: [],
      startedAt: nowIso(),
    };
    await this.store.save(run);

    // Snapshotted now, not read from `context` later: a detached run outlives
    // the connection that started it (contracts/daemon-rpc.md's `cwd`
    // section), so anything the run's loop needs from the caller's
    // environment must be copied out before `execute()`'s promise chain
    // continues past this call's own stack frame.
    const envSnapshot: NodeJS.ProcessEnv | undefined = context ? { ...context.env } : undefined;

    let secrets: ResolvedSecret[];
    try {
      secrets = await this.secretResolver.resolveAll(
        params.secrets ?? [],
        context?.resolvedSecrets,
      );
    } catch (err) {
      const daemonErr = toDaemonError(err);
      await this.failRun(runId, daemonErr);
      throw daemonErr;
    }

    const recordingDisabled = params.recording?.disabled === true;
    let sessionId: string | undefined;
    let transientSidecar: SidecarHandle | undefined;
    let client: SidecarClient;
    let target: CaptureTarget;
    let transcriptPath: string | undefined;

    try {
      target = await this.resolveOperatorTarget();
      if (recordingDisabled) {
        // `--no-record` still needs a sidecar for performInput/captureFrame.
        // Same spawn path the passthrough operations use, held open for the
        // run's duration instead of one RPC.
        transientSidecar = this.spawnSidecar({});
        client = transientSidecar.client;
      } else {
        const started = await this.sessionManager.startRecording({
          target,
          video: params.recording?.video,
          audio: params.recording?.audio,
          outputDir: params.recording?.outputDir,
        });
        sessionId = started.sessionId;
        const sessionClient = this.sessionManager.getSidecarClient(sessionId);
        if (!sessionClient) {
          throw new DaemonError(
            "INTERNAL_ERROR",
            `Session "${sessionId}" has no active sidecar immediately after start`,
          );
        }
        client = sessionClient;
        const outputPath = this.sessionManager.getPlannedOutputPath(sessionId);
        if (outputPath) {
          transcriptPath = transcriptPathFor(outputPath);
          this.sessionManager.setOperatorRunPath(sessionId, transcriptPath);
        }
      }
    } catch (err) {
      const daemonErr = toDaemonError(err);
      await transientSidecar?.terminate().catch(() => {});
      await this.failRun(runId, daemonErr);
      throw daemonErr;
    }

    const capabilities = await client
      .describe()
      .then((result) => result.capabilities as readonly string[])
      .catch(() => [] as readonly string[]);

    const deps = this.createDeps({ client, capabilities, sessionId, target });

    const controller = new AbortController();
    const guardrails = params.guardrails ?? {};
    run = { ...run, state: "running", sessionId, transcriptPath };
    await this.store.save(run);

    // Registered *before* the loop starts: a stub/loop that returns without
    // ever yielding would otherwise reach `finalize` before this entry exists,
    // stranding the run's recording and sidecar.
    this.activeRuns.set(runId, {
      controller,
      aborted: false,
      sessionId,
      transientSidecar,
    });

    const settled = this.execute({
      runId,
      deps,
      options: {
        runId,
        task: params.task,
        model: params.model,
        secrets,
        maxSteps: guardrails.maxSteps ?? DEFAULT_OPERATOR_MAX_STEPS,
        timeoutMs:
          guardrails.timeoutSeconds !== undefined
            ? Math.round(guardrails.timeoutSeconds * 1000)
            : DEFAULT_OPERATOR_TIMEOUT_MS,
        unbounded: guardrails.unbounded ?? false,
        bounds: targetBounds(target),
        transcriptPath,
        signal: controller.signal,
        onStep: (step) => this.appendStep(runId, step, secrets),
        // Root fix for the bug that started phase-20
        // (phase-20-daemon-optional.md): resolveModel must see the
        // *caller's* API-key env var, not the daemon process's own frozen
        // environment. Undefined when no `hello` context was captured for
        // this connection (e.g. an old pre-handshake client) — `runOperator`
        // in @windower/operator falls back to `process.env` in that case,
        // same as before this fix existed.
        env: envSnapshot,
      },
      secrets,
    });

    this.settling.set(
      runId,
      settled.finally(() => {
        this.settling.delete(runId);
      }),
    );
    return { runId };
  }

  getOperatorRun(
    params: DaemonMethodMap["get_operator_run"]["params"],
  ): DaemonMethodMap["get_operator_run"]["result"] {
    return this.requireRun(params.runId);
  }

  listOperatorRuns(
    params: DaemonMethodMap["list_operator_runs"]["params"],
  ): DaemonMethodMap["list_operator_runs"]["result"] {
    return { runs: this.store.list(params.state) };
  }

  /**
   * `abort_operator_run` — the kill switch (contracts/operator.md §Guardrails).
   * Fires the `AbortSignal` the loop was handed, marks the run `aborted`
   * immediately (so a poll right after abort never reports `running`), and
   * lets `execute`'s finalizer stop and finalize the recording cleanly.
   */
  async abortOperatorRun(
    params: DaemonMethodMap["abort_operator_run"]["params"],
  ): Promise<DaemonMethodMap["abort_operator_run"]["result"]> {
    const run = this.requireRun(params.runId);
    if (isTerminalOperatorRunState(run.state)) {
      throw new DaemonError(
        "INVALID_ARGS",
        `Operator run "${run.id}" already ended (state: "${run.state}")`,
      );
    }
    const active = this.activeRuns.get(run.id);
    if (active) {
      active.aborted = true;
      active.controller.abort();
      await this.store.save({ ...run, state: "aborted" });
    } else {
      // No in-flight loop (e.g. still `pending` when the process that owned it
      // died) — nothing to signal, just close the record out.
      await this.store.save({ ...run, state: "aborted", endedAt: nowIso() });
    }
    return { aborted: true };
  }

  /** Test/consumer hook: resolves once the run's loop and its finalizer have completed. */
  async whenSettled(runId: string): Promise<void> {
    await this.settling.get(runId);
  }

  // ---- internals ----

  /**
   * Adapts a sidecar client to `OperatorDeps` (`@windower/core`'s operator
   * seam). Capability gating happens here, per call, against
   * `describe().capabilities` — never against a platform string — so an
   * operator loop asking for something this backend doesn't advertise gets a
   * structured `UNSUPPORTED_CAPABILITY` rather than an opaque crash.
   */
  private createDeps(ctx: {
    client: SidecarClient;
    capabilities: readonly string[];
    sessionId?: string;
    target: CaptureTarget;
  }): OperatorDeps {
    const requireCapability = (capability: string): void => {
      if (!ctx.capabilities.includes(capability)) {
        throw new DaemonError(
          "UNSUPPORTED_CAPABILITY",
          `Sidecar does not advertise "${capability}"`,
        );
      }
    };

    return {
      captureFrame: async (frameParams) => {
        requireCapability("screenshot");
        try {
          return await ctx.client.captureFrame({
            target: ctx.target,
            format: frameParams.format,
            maxWidth: frameParams.maxWidth,
            quality: frameParams.quality,
          });
        } catch (err) {
          throw toDaemonError(err);
        }
      },
      performInput: async (actions: InputAction[]) => {
        for (const action of actions) {
          const capability = requiredCapabilityForInputAction(action.kind);
          if (capability) requireCapability(capability);
        }
        try {
          return await ctx.client.performInput({
            ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
            actions,
          });
        } catch (err) {
          throw toDaemonError(err);
        }
      },
      listTargets: async (kinds) => {
        try {
          const { targets } = await this.passthrough.listTargets(kinds ? { kinds } : {});
          return targets;
        } catch (err) {
          throw toDaemonError(err);
        }
      },
      resizeWindow: async (targetId, bounds) => {
        try {
          return await this.passthrough.resizeWindow({ targetId, bounds });
        } catch (err) {
          throw toDaemonError(err);
        }
      },
    };
  }

  private async execute(ctx: {
    runId: string;
    deps: OperatorDeps;
    options: Parameters<RunOperator>[0];
    secrets: readonly ResolvedSecret[];
  }): Promise<void> {
    let result: OperatorRunResult;
    try {
      const runOperator = await this.loadRunOperator();
      result = await runOperator(ctx.options, ctx.deps);
    } catch (err) {
      const daemonErr = toDaemonError(err);
      result = {
        state: "failed",
        steps: this.store.get(ctx.runId)?.steps ?? [],
        error: { code: daemonErr.code, message: daemonErr.message },
      };
    }
    await this.finalize(ctx.runId, result, ctx.secrets);
  }

  /**
   * Stops the recording (so the video, manifest and event timeline are
   * finalized exactly as a normal `stop_recording` would leave them), releases
   * the `--no-record` sidecar, and writes the run's terminal state. A stop
   * failure never overwrites a successful run's state — it is logged and the
   * run keeps whatever the loop reported, matching `RecordingEngine`'s
   * "post-processing failure must not fail a good recording" convention.
   */
  private async finalize(
    runId: string,
    result: OperatorRunResult,
    secrets: readonly ResolvedSecret[],
  ): Promise<void> {
    const active = this.activeRuns.get(runId);
    this.activeRuns.delete(runId);

    if (active?.sessionId) {
      try {
        const session = this.sessionManager.getSession({ sessionId: active.sessionId });
        if (session.state === "recording") {
          await this.sessionManager.stopRecording({ sessionId: active.sessionId });
        }
      } catch (err) {
        console.error(`[OperatorRunEngine] stopping recording for run ${runId} failed:`, err);
      }
    }
    await active?.transientSidecar?.terminate().catch(() => {});

    const current = this.store.get(runId);
    if (!current) return;
    const steps = result.steps.length > 0 ? redactSecrets(result.steps, secrets) : current.steps;
    await this.store.save({
      ...current,
      state: active?.aborted ? "aborted" : result.state,
      steps,
      endedAt: nowIso(),
      ...(result.error ? { error: redactSecrets(result.error, secrets) } : {}),
    });
  }

  /** Persists one completed step — every step is a state transition, so every step hits disk. */
  private async appendStep(
    runId: string,
    step: OperatorStep,
    secrets: readonly ResolvedSecret[],
  ): Promise<void> {
    const current = this.store.get(runId);
    if (!current) return;
    await this.store.save({
      ...current,
      steps: [...current.steps, redactSecrets(step, secrets)],
    });
  }

  private async failRun(runId: string, err: DaemonError): Promise<void> {
    const run = this.store.get(runId);
    if (!run) return;
    await this.store.save({
      ...run,
      state: "failed",
      endedAt: nowIso(),
      error: { code: err.code, message: err.message },
    });
  }

  private requireRun(runId: string): OperatorRun {
    const run = this.store.get(runId);
    if (!run) {
      throw new DaemonError("OPERATOR_RUN_NOT_FOUND", `No operator run "${runId}"`);
    }
    return run;
  }

  /**
   * `run_operator` takes no `target` (contracts/mcp-tools.md §run_operator) —
   * an operator drives whatever the user is looking at — so the run targets
   * the primary display, falling back to the first enumerated display. Windows
   * are reachable from inside the loop via `list_targets`/`resize_window`.
   */
  private async resolveOperatorTarget(): Promise<CaptureTarget> {
    const { targets } = await this.passthrough.listTargets({ kinds: ["display"] });
    const displays = targets.filter(
      (t): t is Extract<CaptureTarget, { kind: "display" }> => t.kind === "display",
    );
    const target = displays.find((t) => t.isPrimary) ?? displays[0];
    if (!target) {
      throw new DaemonError("TARGET_NOT_FOUND", "No display available for the operator run");
    }
    return target;
  }
}
