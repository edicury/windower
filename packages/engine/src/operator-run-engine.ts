import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type CaptureTarget,
  DEFAULT_OPERATOR_MAX_BATCH_ACTIONS,
  DEFAULT_OPERATOR_MAX_STEPS,
  DEFAULT_OPERATOR_TIMEOUT_MS,
  DaemonError,
  type DaemonMethodMap,
  type InputAction,
  type OperatorDeps,
  type OperatorPlan,
  type OperatorRun,
  OperatorRunSchema,
  type OperatorStep,
  type Rect,
  type ResolvedSecret,
  SidecarError,
  isTerminalOperatorRunState,
  requiredCapabilityForInputAction,
} from "@windower/core";
import { ControlEngine } from "./control-engine.js";
import {
  type LoopChildFactory,
  type LoopTimings,
  type OperatorEvent,
  OperatorLoopHost,
  type OperatorLoopOutcome,
  spawnLoopChildProcess,
} from "./operator-loop-host.js";
import { type OperatorRunStore, operatorRunsDir } from "./operator-run-store.js";
import type { PassthroughService } from "./passthrough.js";
import type { SidecarFactory } from "./recording-engine.js";
import type { RequestContext } from "./request-context.js";
import { type CaptureAccess, CaptureLock } from "./screen-capture-lock.js";
import { SecretResolver, redactSecrets } from "./secret-resolver.js";

/**
 * The daemon half of Phase 19. `OperatorRunEngine` owns the `OperatorRun`
 * state machine (`pending -> running -> succeeded|failed|aborted|timed_out`,
 * data-model.md §OperatorRun), persists every transition through
 * `OperatorRunStore` exactly as `RecordingEngine` does for `RecordingSession`,
 * and wires the loop in `packages/operator` to a real sidecar.
 *
 * It deliberately owns *no* agent logic. Since Phase 21 the observe → decide →
 * act loop runs in **its own OS process**, one child per `OperatorRun`, and
 * this engine talks to it through `OperatorLoopHost`
 * (`contracts/operator-loop-protocol.md`). The loop is a different failure
 * domain — provider HTTP calls, a growing transcript, a third-party SDK in the
 * address space — and a wedged, leaking, or `kill -9`'d loop must not take the
 * daemon down with it.
 *
 * Nothing here branches on the host OS — capabilities are read from
 * `describe().capabilities` and the one platform-shaped concern (keychain
 * lookup) lives behind `SecretResolver`'s swappable resolver function
 * (CLAUDE.md §protocol before platform).
 *
 * Phase 21 — **this engine is recording-unaware**. It holds no
 * `RecordingEngine`, never starts/stops/looks up a recording, and carries no
 * session identifier. An `OperatorRun` is fully specified by
 * `{ task, target, model, secrets?, guardrails? }`
 * (`contracts/operator.md` §Inputs), and the same run behaves identically
 * whether the screen is being recorded or not (§Recording independence).
 * Screen-facing work is served by two independent peers: the capture surface
 * (`CaptureAccess`, which reuses this process's capture sidecar when one is
 * already live) and the control surface (`ControlEngine`, which never touches
 * the capture lock).
 */

export interface OperatorRunEngineOptions {
  store: OperatorRunStore;
  passthrough: PassthroughService;
  /** Backs the default `capture`/`control` surfaces below when the host injects neither. */
  spawnSidecar: SidecarFactory;
  /**
   * Capture surface for `captureFrame` — the screen-capture exclusivity seam
   * (`contracts/screen-capture-exclusivity.md`). Hosts pass the **same**
   * instance they gave `RecordingEngine`/`PassthroughService`; the default is
   * equivalent, since the per-process hold registry is module-level.
   */
  capture?: CaptureAccess;
  /**
   * Control surface for `performInput`/`resizeWindow`. Never takes the capture
   * lock — input and window control have no ScreenCaptureKit relationship
   * (`contracts/screen-capture-exclusivity.md` §What never takes this lock).
   */
  control?: ControlEngine;
  secretResolver?: SecretResolver;
  /**
   * Spawns the operator decision-loop child. Defaults to a real child process
   * whose entry point is resolved from this package's own module location —
   * both ends therefore always ship from the same installed version, which is
   * why the loop protocol asserts its version instead of negotiating it.
   */
  spawnLoopChild?: LoopChildFactory;
  /**
   * In-memory only. `contracts/operator.md` §Correlating the two streams: the
   * caller lines operator events up with a recording's timeline, because it
   * initiated both. Nothing here is persisted onto either peer's record.
   */
  onOperatorEvent?: (event: OperatorEvent) => void;
  /** Shutdown/liveness windows — overridden only by tests. */
  loopTimings?: Partial<LoopTimings>;
}

interface ActiveRun {
  host: OperatorLoopHost;
  aborted: boolean;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * `~/.windower/operator-runs/<runId>/transcript.json`, with observation frames
 * under `.../<runId>/frames/` — **operator-owned storage**
 * (`contracts/operator.md` §Transcript format). Derived from the run id and
 * nothing else: deriving it from a video path would require knowing a
 * recording exists and looking it up, both prohibited.
 */
function transcriptPathFor(runId: string): string {
  return join(operatorRunsDir(), runId, "transcript.json");
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
  private readonly passthrough: PassthroughService;
  private readonly capture: CaptureAccess;
  private readonly control: ControlEngine;
  private readonly secretResolver: SecretResolver;
  private readonly spawnLoopChild: LoopChildFactory;
  private readonly onOperatorEvent: ((event: OperatorEvent) => void) | undefined;
  private readonly loopTimings: Partial<LoopTimings> | undefined;
  private readonly activeRuns = new Map<string, ActiveRun>();
  /**
   * Kept separate from `activeRuns` (which `finalize` clears before it writes
   * the terminal record, so a late abort is a no-op) so `whenSettled` still
   * waits for the run to be fully persisted, not merely for the loop to
   * return.
   */
  private readonly settling = new Map<string, Promise<void>>();

  constructor(options: OperatorRunEngineOptions) {
    this.store = options.store;
    this.passthrough = options.passthrough;
    this.capture = options.capture ?? new CaptureLock({ spawnSidecar: options.spawnSidecar });
    // `surface: "control"` is load-bearing — `SpawnSidecarOptions.surface`
    // defaults to `"capture"`, so an unqualified control spawn would start a
    // second ScreenCaptureKit process to serve calls that touch no capture
    // state (`contracts/screen-capture-exclusivity.md` §What never takes this
    // lock).
    this.control =
      options.control ??
      new ControlEngine({
        spawnControl: options.spawnSidecar,
        spawnOptions: { surface: "control" },
      });
    this.secretResolver = options.secretResolver ?? new SecretResolver();
    this.spawnLoopChild = options.spawnLoopChild ?? spawnLoopChildProcess;
    this.onOperatorEvent = options.onOperatorEvent;
    this.loopTimings = options.loopTimings;
  }

  get activeRunCount(): number {
    return this.activeRuns.size;
  }

  /**
   * Best-effort, synchronous SIGKILL sweep for `process.on("exit")`
   * (`bin.ts`), which cannot await async work: every live loop child, plus the
   * control surface. The capture sidecar belongs to the capture lock and is
   * swept by whoever holds it. Nothing here consults, touches, or terminates a
   * recording — an operator run has no recording to wind down under any
   * outcome (`contracts/operator-loop-protocol.md` §`OPERATOR_LOOP_CRASHED`).
   */
  sigkillActiveSidecars(): void {
    for (const active of this.activeRuns.values()) active.host.sigkill();
    const pid = this.control.pid;
    if (pid === undefined || !this.control.isRunning) return;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already dead — nothing to do.
    }
  }

  /**
   * `abort({reason: "daemon-shutdown"})` to every live loop child, first thing
   * in a graceful shutdown (`contracts/operator-loop-protocol.md` §Shutdown).
   *
   * Any live recordings are finalized by the drain's own `stopRecording` pass,
   * **independently of and unordered with respect to** the loop children: the
   * two are drained as peers, and the loop's shutdown neither triggers nor
   * waits on the recording's.
   */
  signalDaemonShutdown(): void {
    for (const active of this.activeRuns.values()) {
      active.aborted = true;
      active.host.abort("daemon-shutdown");
    }
  }

  /**
   * Scans loaded runs for ones stuck in `pending`/`running` from a previous
   * (crashed) daemon instance and marks them `failed` — the loop child saw EOF
   * on stdin, aborted its model call, and exited without attempting
   * `reportResult`, so an orphaned run is a crashed run
   * (`contracts/operator-loop-protocol.md` §Shutdown, "Daemon `SIGKILL`").
   * Mirrors `RecordingEngine.recoverCrashedSessions()`; call once at startup,
   * after `OperatorRunStore.load()`.
   */
  async recoverCrashedRuns(): Promise<void> {
    for (const run of this.store.list()) {
      if (run.state === "pending" || run.state === "running") {
        await this.store.save({
          ...run,
          state: "failed",
          endedAt: nowIso(),
          error: {
            code: "OPERATOR_LOOP_CRASHED",
            message:
              "The daemon restarted while this operator run was in flight; its loop child is gone.",
          },
        });
      }
    }
  }

  /**
   * `run_operator` — returns `{ runId }` promptly and does **not** block for
   * the whole run (contracts/mcp-tools.md: "Same non-blocking two-call shape
   * as `start_recording`"). Everything that can fail deterministically up
   * front (target resolution, secret resolution, capability handshake) is
   * awaited before returning so the caller gets a structured error instead of
   * a run that dies a moment later.
   *
   * The caller's target selector — the same `CaptureTarget | { targetId }`
   * shape `start_recording` takes — is resolved **once, here, before the run
   * starts**, and the resolution is what the record holds and the bounds
   * clamp is evaluated against (`contracts/operator.md` §Inputs).
   */
  async runOperator(
    params: DaemonMethodMap["run_operator"]["params"],
    context?: RequestContext,
  ): Promise<DaemonMethodMap["run_operator"]["result"]> {
    const runId = randomUUID();
    // Resolved before the record exists: an `OperatorRun` without a resolved
    // target is not a representable value (data-model.md §OperatorRun), so a
    // selector that names nothing is a rejected call, not a persisted run.
    const target = await this.resolveOperatorTarget(params.target);
    const transcriptPath = transcriptPathFor(runId);
    let run: OperatorRun = {
      id: runId,
      state: "pending",
      task: params.task,
      target,
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
    // An EMPTY snapshot means "this caller scoped nothing", not "the
    // environment is empty": passing `{}` down would shadow `process.env` for
    // the run's key lookup (`@windower/operator`'s `resolveModel`) and fail
    // with `OPERATOR_MISSING_API_KEY` on a host that has the key. `undefined`
    // is the value that falls back to `process.env`.
    const envSnapshot: NodeJS.ProcessEnv | undefined =
      context && Object.keys(context.env).length > 0 ? { ...context.env } : undefined;

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

    // Capture-surface capabilities only: `screenshot` gates `captureFrame`.
    // Input/window capabilities are the CONTROL surface's and are asked of
    // `ControlEngine` per call — the two surfaces are independent binaries
    // and answer `describe` separately (contracts/sidecar-protocol.md).
    const captureCapabilities = await this.capture
      .withCaptureClient((client) => client.describe())
      .then((result) => result.capabilities as readonly string[])
      .catch(() => [] as readonly string[]);

    const deps = this.createDeps({ captureCapabilities, target });

    const guardrails = params.guardrails ?? {};
    run = { ...run, state: "running", transcriptPath };
    await this.store.save(run);

    const host = new OperatorLoopHost({
      config: {
        runId,
        task: params.task,
        target,
        model: params.model,
        maxSteps: guardrails.maxSteps ?? DEFAULT_OPERATOR_MAX_STEPS,
        timeoutMs:
          guardrails.timeoutSeconds !== undefined
            ? Math.round(guardrails.timeoutSeconds * 1000)
            : DEFAULT_OPERATOR_TIMEOUT_MS,
        maxBatchActions: guardrails.maxBatchActions ?? DEFAULT_OPERATOR_MAX_BATCH_ACTIONS,
        unbounded: guardrails.unbounded ?? false,
        bounds: targetBounds(target),
        // Root fix for the bug that started phase-20
        // (phase-20-daemon-optional.md): `resolveModel` must see the
        // *caller's* API-key env var, not the daemon process's own frozen
        // environment. It crosses the wire in `ready`'s result rather than on
        // `argv`, which `ps` would expose.
        env: envSnapshot,
        startedAtMs: Date.now(),
      },
      // Daemon-side only: the child gets `secretNames` and never a value.
      secrets,
      deps,
      spawn: this.spawnLoopChild,
      framesDir: join(dirname(transcriptPath), "frames"),
      persistPlan: (plan) => this.savePlan(runId, plan),
      persistStep: (step) => this.appendStep(runId, step),
      ...(this.onOperatorEvent === undefined ? {} : { onEvent: this.onOperatorEvent }),
      ...(this.loopTimings === undefined ? {} : { timings: this.loopTimings }),
    });

    // Registered *before* the loop starts: a host that settles without ever
    // yielding would otherwise reach `finalize` before this entry exists,
    // stranding the abort registration.
    this.activeRuns.set(runId, { host, aborted: false });

    const settled = this.execute({ runId, host, secrets });

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
   * Fires the `AbortSignal` the loop was handed and marks the run `aborted`
   * immediately, so a poll right after abort never reports `running`.
   * Aborting a run never touches a recording — if the caller started one
   * around this run, it keeps recording until the caller stops it.
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
      // A pushed notification, not a poll: the child spends most of every step
      // blocked inside a provider HTTP call. `SIGTERM`/`SIGKILL` remain the
      // backstop inside the host, never the first move — a clean abort still
      // produces a final partial step.
      active.host.abort("user");
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
   * Builds `OperatorDeps` (`@windower/core`'s operator seam) over the two
   * independent peers a run needs: the **capture surface** for observations
   * and the **control surface** for actions. Capability gating happens per
   * call against `describe().capabilities` — never against a platform string
   * — so an operator loop asking for something the backend doesn't advertise
   * gets a structured `UNSUPPORTED_CAPABILITY` rather than an opaque crash.
   *
   * Every capture-surface call goes through `~/.windower/capture.lock`
   * (`contracts/screen-capture-exclusivity.md`, `screen-capture-lock.ts`),
   * which serves it from this process's already-live capture sidecar when
   * there is one and otherwise spawns one under the lock. That is what makes
   * "there is only ever one ScreenCaptureKit process" true unconditionally,
   * for the operator and for every other caller alike — the operator does not
   * (and cannot) know which of the two happened, and nothing here tells it
   * whether a recording exists (`contracts/operator.md` §Recording
   * independence).
   *
   * Control-surface calls take no lock, ever: input and window control have
   * zero ScreenCaptureKit relationship, so they are never serialized against
   * a capture, a recording, or each other.
   */
  private createDeps(ctx: {
    captureCapabilities: readonly string[];
    target: CaptureTarget;
  }): OperatorDeps {
    const requireCaptureCapability = (capability: string): void => {
      if (!ctx.captureCapabilities.includes(capability)) {
        throw new DaemonError(
          "UNSUPPORTED_CAPABILITY",
          `Sidecar does not advertise "${capability}"`,
        );
      }
    };

    return {
      captureFrame: async (frameParams) => {
        requireCaptureCapability("screenshot");
        try {
          // Addressed by TARGET, never by a recording: there is no
          // session-shaped frame source the operator could name.
          return await this.capture.withCaptureClient((client) =>
            client.captureFrame({
              target: ctx.target,
              format: frameParams.format,
              maxWidth: frameParams.maxWidth,
              quality: frameParams.quality,
            }),
          );
        } catch (err) {
          throw toDaemonError(err);
        }
      },
      performInput: async (actions: InputAction[]) => {
        for (const action of actions) {
          const capability = requiredCapabilityForInputAction(action.kind);
          if (capability) await this.control.requireCapability(capability);
        }
        try {
          // No `sessionId`: it is an optional *correlation hint* on the wire
          // (contracts/sidecar-protocol.md §control surface), and an operator
          // run has none to give. Nothing replaces it.
          return await this.control.performInput({ actions });
        } catch (err) {
          throw toDaemonError(err);
        }
      },
      listTargets: async (kinds) => {
        try {
          // `PassthroughService` already applies the "app" filter the sidecar
          // protocol can't express and routes through the capture lock.
          const { targets } = await this.passthrough.listTargets(
            kinds ? { kinds: [...kinds] } : {},
          );
          return targets;
        } catch (err) {
          throw toDaemonError(err);
        }
      },
      resizeWindow: async (targetId, bounds) => {
        try {
          return await this.control.resizeWindow({ targetId, bounds });
        } catch (err) {
          throw toDaemonError(err);
        }
      },
    };
  }

  private async execute(ctx: {
    runId: string;
    host: OperatorLoopHost;
    secrets: readonly ResolvedSecret[];
  }): Promise<void> {
    let outcome: OperatorLoopOutcome;
    try {
      outcome = await ctx.host.run();
    } catch (err) {
      // `run()` is written not to reject; this is belt-and-braces so a bug in
      // the host fails the run rather than the daemon.
      const daemonErr = toDaemonError(err);
      outcome = {
        state: "failed",
        crashed: true,
        error: { code: daemonErr.code, message: daemonErr.message },
      };
    }
    await this.finalize(ctx.runId, outcome, ctx.secrets);
  }

  /**
   * Writes the run's terminal state, and **nothing else**.
   *
   * It consults nothing about recording — not whether one exists, not whose
   * it is, not what state it is in. Per
   * `contracts/operator-loop-protocol.md` §`OPERATOR_LOOP_CRASHED`, "a branch
   * here would be a defect, since [crash-with-recording and
   * crash-without-recording] must be the *same* code path, not two paths that
   * agree." There is no `ownsSession` question to answer, because the
   * operator never owns a recording under any configuration. A caller that
   * started a recording around this run stops it itself, having learned the
   * run ended by polling `get_operator_run`.
   */
  private async finalize(
    runId: string,
    outcome: OperatorLoopOutcome,
    secrets: readonly ResolvedSecret[],
  ): Promise<void> {
    const active = this.activeRuns.get(runId);
    this.activeRuns.delete(runId);

    const current = this.store.get(runId);
    if (!current) return;
    // Every step reported so far is already on disk — a crashed run keeps its
    // partial transcript rather than being discarded.
    const run: OperatorRun = {
      ...current,
      state: active?.aborted && outcome.state !== "succeeded" ? "aborted" : outcome.state,
      endedAt: nowIso(),
      // The child's `reportResult` summary is the run's own account of what it
      // did; persisting it is what makes polling `get_operator_run` a complete
      // view of the `result` event (contracts/operator.md §"How they
      // surface"). A daemon-synthesized result — `OPERATOR_LOOP_CRASHED`, the
      // child died without reporting — carries no summary, and none is
      // invented for it.
      ...(outcome.summary === undefined
        ? {}
        : { summary: redactSecrets(outcome.summary, secrets) }),
      ...(outcome.error ? { error: redactSecrets(outcome.error, secrets) } : {}),
    };
    await this.store.save(run);
    await this.writeTranscript(run);
  }

  /**
   * A plan revision is durable the moment the daemon accepts it, so a crashed
   * run's transcript still shows what it intended to do. The daemon assigned
   * the revision; the child only supplied the content.
   */
  private async savePlan(runId: string, plan: OperatorPlan): Promise<void> {
    const current = this.store.get(runId);
    if (!current) return;
    const run: OperatorRun = { ...current, plan };
    await this.store.save(run);
    await this.writeTranscript(run);
  }

  /** Persists one completed step — every step is a state transition, so every step hits disk. */
  private async appendStep(runId: string, step: OperatorStep): Promise<void> {
    const current = this.store.get(runId);
    if (!current) return;
    const run: OperatorRun = { ...current, steps: [...current.steps, step] };
    await this.store.save(run);
    await this.writeTranscript(run);
  }

  /**
   * `~/.windower/operator-runs/<runId>/transcript.json` — rewritten after every
   * transition, atomically. **The daemon owns every disk write**: the child has
   * no filesystem method and `transcriptPath` is not part of its configuration,
   * which is what keeps the redaction filter in one process and a compromised
   * child from writing to arbitrary paths.
   */
  private async writeTranscript(run: OperatorRun): Promise<void> {
    const path = run.transcriptPath;
    if (path === undefined) return;
    try {
      const sanitized = OperatorRunSchema.parse(run);
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      await writeFile(tmp, `${JSON.stringify(sanitized, null, 2)}\n`, "utf8");
      await rename(tmp, path);
    } catch (err) {
      console.error(`[OperatorRunEngine] could not write transcript for run ${run.id}:`, err);
    }
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
   * Resolves the caller's target selector — the **same**
   * `CaptureTarget | { targetId }` shape `start_recording` takes, resolved the
   * same way through `enumerateTargets` (`contracts/operator.md` §Inputs).
   * Done once, before the run starts, so the child never enumerates to find
   * out what it is driving and the bounds clamp always has the resolved
   * target's own `Rect`. Mirrors `RecordingEngine.resolveTarget`; a shared
   * `target` between the two is two independent capabilities being handed the
   * same value, not a link between them.
   */
  private async resolveOperatorTarget(
    selector: DaemonMethodMap["run_operator"]["params"]["target"],
  ): Promise<CaptureTarget> {
    if ("kind" in selector) return selector;
    const { targets } = await this.passthrough.listTargets({});
    const found = targets.find((t) => "id" in t && t.id === selector.targetId);
    if (!found) {
      throw new DaemonError("TARGET_NOT_FOUND", `No target with id "${selector.targetId}"`);
    }
    return found;
  }
}
