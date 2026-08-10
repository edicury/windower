import { spawn as spawnChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import {
  type CaptureTarget,
  DaemonError,
  type GuardrailState,
  type InputAction,
  LOOP_ABORT_GRACE_MS,
  LOOP_ABORT_REASON_TO_STATE,
  LOOP_EXIT_GRACE_MS,
  LOOP_PING_TIMEOUT_MS,
  LOOP_PROTOCOL_VERSION,
  type LoopAbortReason,
  LoopBeginStepParamsSchema,
  LoopCaptureFrameParamsSchema,
  LoopEnumerateTargetsParamsSchema,
  LoopLogParamsSchema,
  LoopPerformInputParamsSchema,
  type LoopReadyResult,
  LoopReportPlanParamsSchema,
  LoopReportResultParamsSchema,
  LoopReportStepParamsSchema,
  LoopResizeWindowParamsSchema,
  type ModelConfig,
  type OperatorCheckpoint,
  type OperatorDeps,
  type OperatorPlan,
  type OperatorRunState,
  type OperatorStep,
  type OperatorToolCall,
  type Rect,
  type ResolvedSecret,
  SidecarError,
  inputActionCoordinates,
} from "@windower/core";
import { redactSecrets } from "./secret-resolver.js";

/**
 * The **daemon-side half** of `contracts/operator-loop-protocol.md`: it spawns
 * one operator decision-loop child process per `OperatorRun`, serves every
 * child → daemon method over newline-delimited JSON-RPC 2.0 on the child's
 * stdin/stdout, and owns the guardrails, the secrets, the plan/step/event
 * identity, and all persistence.
 *
 * Why the loop is a separate process at all: it is a **different failure
 * domain** — provider HTTP calls, a growing transcript, a third-party SDK in
 * the address space. A wedged, leaking, or `kill -9`'d loop must not take the
 * daemon down.
 *
 * And it cannot affect a recording — **not because this host is careful about
 * it, but because there is no recording on this wire at all.** There is no
 * recording-related method, param, identifier, or error code here, and the
 * crash path deliberately contains no branch that asks whether something is
 * recording: "loop crashes with a recording running" and "loop crashes with
 * nothing recording" are the *same* code path, not two paths that agree.
 *
 * Guardrails live here rather than only in the child for the same reason
 * `contracts/operator.md` puts the model's limits in the runtime: *the thing
 * being bounded is not trusted to bound itself.* The child keeps its own
 * copies — two clamps in two processes is deliberate duplication, not
 * redundancy to refactor away. Deleting this copy removes the guarantee;
 * deleting the child's only degrades transcript quality.
 *
 * Nothing here branches on the host OS: every OS/permission decision has
 * already been made below the proxied surfaces (CLAUDE.md §protocol before
 * platform).
 */

// ---------------------------------------------------------------------------
// The child process handle
// ---------------------------------------------------------------------------

export interface LoopChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/**
 * The minimum a loop child must look like. Deliberately not `ChildProcess`:
 * tests drive a fake that speaks the same wire in-memory, exactly as
 * `packages/core/src/protocol/fake-sidecar.ts` does one layer down.
 */
export interface LoopChildHandle {
  readonly pid: number | undefined;
  readonly stdin: NodeJS.WritableStream;
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr?: NodeJS.ReadableStream;
  /** Resolves when the process is gone. Never rejects. */
  readonly exited: Promise<LoopChildExit>;
  kill(signal: "SIGTERM" | "SIGKILL"): void;
}

export interface LoopChildSpec {
  runId: string;
}

export type LoopChildFactory = (spec: LoopChildSpec) => LoopChildHandle | Promise<LoopChildHandle>;

/**
 * The loop entry point's path, computed from **this module's own resolved
 * location** — which is why `contracts/operator-loop-protocol.md` §No
 * capability negotiation can assert a version instead of negotiating one:
 * there is no path by which a 0.3.0 daemon talks to a 0.2.0 loop.
 */
export function resolveLoopEntryPath(): string {
  return createRequire(import.meta.url).resolve("@windower/operator/loop-entry");
}

/**
 * Production factory. **No run configuration on `argv`** — anything there is
 * visible in `ps`, which the contract rules out for API keys and extends to
 * the task string. The child learns everything from `ready`'s result, and the
 * model's API key crosses the wire rather than this process's environment.
 */
export const spawnLoopChildProcess: LoopChildFactory = () => {
  const child = spawnChildProcess(process.execPath, [resolveLoopEntryPath()], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });
  const exited = new Promise<LoopChildExit>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", () => resolve({ code: null, signal: null }));
  });
  return {
    pid: child.pid,
    stdin: child.stdin as NodeJS.WritableStream,
    stdout: child.stdout as NodeJS.ReadableStream,
    stderr: child.stderr as NodeJS.ReadableStream,
    exited,
    kill: (signal) => {
      try {
        child.kill(signal);
      } catch {
        // Already gone.
      }
    },
  };
};

// ---------------------------------------------------------------------------
// Events — derived by the daemon, never reported by the child
// ---------------------------------------------------------------------------

/**
 * `contracts/operator.md` §Operator events. The child reports *facts*; the
 * daemon derives *events*, which is why this protocol has no event method.
 * `seq`/`tMs` are the daemon's, assigned in acceptance order from
 * `startedAtMs`.
 *
 * These are **in-memory only** — Phase 21 explicitly defers any persistent
 * `DemoRun`/`WorkflowRun` record, and no event carries any identifier other
 * than `runId`.
 */
export type OperatorEventPayload =
  | { kind: "plan"; revision: number; steps: string[]; rationale?: string }
  | { kind: "action"; stepIndex: number; name: string; args?: unknown; result?: unknown }
  | ({ kind: "checkpoint"; stepIndex: number } & OperatorCheckpoint)
  | { kind: "narration"; stepIndex: number; text: string }
  | {
      kind: "result";
      state: OperatorRunState;
      summary?: string;
      error?: { code: string; message: string };
    };

/** The stamped event. `seq`/`tMs` are the daemon's, in acceptance order. */
export type OperatorEvent = { runId: string; seq: number; tMs: number } & OperatorEventPayload;

// ---------------------------------------------------------------------------
// Host configuration
// ---------------------------------------------------------------------------

export interface OperatorLoopRunConfig {
  runId: string;
  task: string;
  /** The RESOLVED target — the daemon resolves the caller's selector before the spawn. */
  target: CaptureTarget;
  model: ModelConfig;
  maxSteps: number;
  maxBatchActions: number;
  timeoutMs: number;
  unbounded: boolean;
  bounds?: Rect;
  /** Scoped snapshot of the model's API-key var; forwarded verbatim in `ready`. */
  env?: NodeJS.ProcessEnv;
  startedAtMs: number;
}

export interface LoopTimings {
  pingTimeoutMs: number;
  /** How often a liveness probe is sent. Defaults to the ping timeout. */
  pingIntervalMs: number;
  exitGraceMs: number;
  abortGraceMs: number;
  /** SIGTERM → SIGKILL escalation window, per the contract's shutdown table. */
  sigkillGraceMs: number;
}

export interface OperatorLoopHostOptions {
  config: OperatorLoopRunConfig;
  /** Daemon-side only. The child receives `secretNames` and never a value. */
  secrets: readonly ResolvedSecret[];
  /** The proxied capture + control surfaces the daemon serves on the child's behalf. */
  deps: OperatorDeps;
  spawn?: LoopChildFactory;
  /** `~/.windower/operator-runs/<runId>/frames` — the daemon owns every disk write. */
  framesDir: string;
  /** Called with an accepted, daemon-stamped plan revision. */
  persistPlan: (plan: OperatorPlan) => Promise<void>;
  /** Called with a closed, redacted step whose `observationRef` names a real frame. */
  persistStep: (step: OperatorStep) => Promise<void>;
  onEvent?: (event: OperatorEvent) => void;
  /** Redacted stderr / `log` sink. Defaults to `console.error`. */
  onLog?: (line: string) => void;
  now?: () => number;
  timings?: Partial<LoopTimings>;
}

export interface OperatorLoopOutcome {
  state: OperatorRunState;
  summary?: string;
  error?: { code: string; message: string };
  /**
   * True only when the child died without `reportResult` **and** the daemon
   * did not ask it to — a run that reaches SIGKILL after an abort the daemon
   * signalled is recorded with the signalled state, not as a crash.
   */
  crashed: boolean;
}

// ---------------------------------------------------------------------------
// Wire errors
// ---------------------------------------------------------------------------

/** A `data.code`-carrying rejection, same shape as the sidecar/daemon taxonomies. */
class LoopError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "LoopError";
    this.code = code;
  }
}

/** JSON-RPC application error; the taxonomy lives in `data.code`. */
const JSON_RPC_APPLICATION_ERROR = -32000;

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

/**
 * Terminal guardrail codes end the run mid-batch; proxied surface errors are
 * returned to the child as that action's result and the run continues
 * (`contracts/operator.md` §Batch failure semantics). `OPERATOR_BATCH_LIMIT_EXCEEDED`
 * is deliberately absent: it leaves the step open.
 */
const TERMINAL_GUARDRAIL_CODES = new Set([
  "INPUT_OUT_OF_BOUNDS",
  "OPERATOR_TIMEOUT",
  "OPERATOR_ABORTED",
  "OPERATOR_MAX_STEPS_EXCEEDED",
]);

export function isTerminalGuardrailCode(code: string): boolean {
  return TERMINAL_GUARDRAIL_CODES.has(code);
}

// ---------------------------------------------------------------------------

export class OperatorLoopHost {
  private readonly config: OperatorLoopRunConfig;
  private readonly secrets: readonly ResolvedSecret[];
  private readonly deps: OperatorDeps;
  private readonly spawn: LoopChildFactory;
  private readonly framesDir: string;
  private readonly persistPlan: (plan: OperatorPlan) => Promise<void>;
  private readonly persistStep: (step: OperatorStep) => Promise<void>;
  private readonly onEvent: (event: OperatorEvent) => void;
  private readonly onLog: (line: string) => void;
  private readonly now: () => number;
  private readonly timings: LoopTimings;

  // --- authoritative guardrail state ---
  private started = false;
  private ended = false;
  private stepsUsed = 0;
  private openStep: number | undefined;
  private actionsInStep = 0;
  private planRevision: number | undefined;
  private planForOpenStep: OperatorPlan | undefined;
  private abortReason: LoopAbortReason | undefined;

  // --- wire state ---
  private child: LoopChildHandle | undefined;
  private buffer = "";
  private stderrBuffer = "";
  private nextRequestId = 1;
  private readonly pendingPings = new Map<number, () => void>();
  private closed = false;
  private seq = 0;
  private resultEmitted = false;
  private reported: OperatorLoopOutcome | undefined;
  /** Content hash → the ref the daemon wrote the frame under. */
  private readonly frames = new Map<string, string>();
  private settle: ((outcome: OperatorLoopOutcome) => void) | undefined;
  private readonly timers = new Set<NodeJS.Timeout>();
  /** Serializes disk writes so a step never overtakes the plan that preceded it. */
  private writes: Promise<void> = Promise.resolve();

  constructor(options: OperatorLoopHostOptions) {
    this.config = options.config;
    this.secrets = options.secrets;
    this.deps = options.deps;
    this.spawn = options.spawn ?? spawnLoopChildProcess;
    this.framesDir = options.framesDir;
    this.persistPlan = options.persistPlan;
    this.persistStep = options.persistStep;
    this.onEvent = options.onEvent ?? (() => {});
    this.onLog = options.onLog ?? ((line) => console.error(line));
    this.now = options.now ?? Date.now;
    this.timings = {
      pingTimeoutMs: options.timings?.pingTimeoutMs ?? LOOP_PING_TIMEOUT_MS,
      pingIntervalMs:
        options.timings?.pingIntervalMs ?? options.timings?.pingTimeoutMs ?? LOOP_PING_TIMEOUT_MS,
      exitGraceMs: options.timings?.exitGraceMs ?? LOOP_EXIT_GRACE_MS,
      abortGraceMs: options.timings?.abortGraceMs ?? LOOP_ABORT_GRACE_MS,
      sigkillGraceMs: options.timings?.sigkillGraceMs ?? LOOP_EXIT_GRACE_MS,
    };
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** Best-effort synchronous SIGKILL, for `process.on("exit")` sweeps. */
  sigkill(): void {
    this.child?.kill("SIGKILL");
  }

  /**
   * Spawns the child, serves the wire, and resolves with the run's terminal
   * outcome. Never rejects: a failure to spawn, a version mismatch, and a
   * `kill -9` all resolve to an outcome the caller persists.
   */
  async run(): Promise<OperatorLoopOutcome> {
    let child: LoopChildHandle;
    try {
      child = await this.spawn({ runId: this.config.runId });
    } catch (err) {
      return {
        state: "failed",
        crashed: true,
        error: {
          code: "OPERATOR_LOOP_CRASHED",
          message: `Could not spawn the operator loop child: ${message_(err)}`,
        },
      };
    }
    this.child = child;

    const settled = new Promise<OperatorLoopOutcome>((resolve) => {
      this.settle = resolve;
    });

    child.stdout.setEncoding?.("utf8");
    child.stdout.on("data", (chunk: string | Buffer) => this.onStdout(String(chunk)));
    child.stderr?.setEncoding?.("utf8");
    // stderr is free-form human-readable logs only, never protocol data — and
    // it goes through the redaction filter before it reaches any log.
    child.stderr?.on("data", (chunk: string | Buffer) => this.onStderr(String(chunk)));

    void child.exited.then((exit) => this.onExit(exit));

    this.armDeadline();
    this.armPing();

    const outcome = await settled;
    this.clearTimers();
    await this.flushWrites();
    return outcome;
  }

  /**
   * The kill switch, and the daemon's own timeout/max-steps escalation. Pushes
   * `abort`, then escalates per `contracts/operator-loop-protocol.md`
   * §Shutdown. The outcome is the state the daemon **signalled** — it does not
   * depend on the child agreeing, and a run that reaches SIGKILL this way is
   * never recorded as `OPERATOR_LOOP_CRASHED`.
   */
  abort(reason: LoopAbortReason): void {
    if (this.abortReason !== undefined || this.settle === undefined) return;
    this.abortReason = reason;
    this.notify("abort", { reason });
    this.after(this.timings.abortGraceMs, () => {
      if (this.settle === undefined) return;
      this.child?.kill("SIGTERM");
      this.after(this.timings.sigkillGraceMs, () => {
        if (this.settle === undefined) return;
        this.child?.kill("SIGKILL");
        this.finishSignalled();
      });
    });
  }

  // -------------------------------------------------------------------------
  // Framing
  // -------------------------------------------------------------------------

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length === 0) continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        // An unparseable stdout line is not fatal on its own; a child that then
        // dies without `reportResult` is `OPERATOR_LOOP_CRASHED` on the EOF path.
        this.log(`[operator-loop] unparseable line from child: ${line.slice(0, 200)}`);
        continue;
      }
      // "A received message is a request if it has a `method` member, and a
      // response otherwise" — §Transport. Each side numbers its own ids.
      if (typeof parsed.method === "string") void this.onRequest(parsed);
      else this.onResponse(parsed);
    }
  }

  private onStderr(chunk: string): void {
    this.stderrBuffer += chunk;
    for (;;) {
      const newline = this.stderrBuffer.indexOf("\n");
      if (newline === -1) return;
      const line = this.stderrBuffer.slice(0, newline);
      this.stderrBuffer = this.stderrBuffer.slice(newline + 1);
      if (line.trim().length > 0) this.log(`[operator-loop:${this.config.runId}] ${line}`);
    }
  }

  private async onRequest(message: Record<string, unknown>): Promise<void> {
    const method = message.method as string;
    const id = message.id as number | string | undefined;
    try {
      const result = await this.serve(method, message.params);
      if (id !== undefined) this.write({ jsonrpc: "2.0", id, result });
    } catch (err) {
      const code = err instanceof LoopError ? err.code : codeOf(err);
      if (id !== undefined) {
        this.write({
          jsonrpc: "2.0",
          id,
          error: {
            code: JSON_RPC_APPLICATION_ERROR,
            message: message_(err),
            data: { code },
          },
        });
      }
      // A terminal guardrail refusal is also the daemon's cue to wind the run
      // down — the child is told, and asked to leave cleanly.
      if (isTerminalGuardrailCode(code)) this.beginFinalizationFor(code);
    }
  }

  private onResponse(message: Record<string, unknown>): void {
    const id = message.id as number | undefined;
    if (id === undefined) return;
    const resolve = this.pendingPings.get(id);
    if (resolve === undefined) return;
    this.pendingPings.delete(id);
    resolve();
  }

  private write(message: unknown): void {
    if (this.closed) return;
    try {
      this.child?.stdin.write(`${JSON.stringify(message)}\n`);
    } catch {
      // The child's stdin is gone; the exit path owns what happens next.
    }
  }

  private notify(method: "abort", params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  // -------------------------------------------------------------------------
  // Serving: child → daemon
  // -------------------------------------------------------------------------

  private async serve(method: string, rawParams: unknown): Promise<unknown> {
    const params = rawParams ?? {};

    if (method !== "ready" && !this.started) {
      throw new LoopError("LOOP_NOT_STARTED", `"${method}" arrived before "ready".`);
    }
    if (this.ended) {
      throw new LoopError("LOOP_ALREADY_ENDED", `"${method}" arrived after "reportResult".`);
    }

    switch (method) {
      case "ready":
        return this.serveReady(params);
      case "guardrailState":
        return this.guardrailState();
      case "beginStep":
        return this.serveBeginStep(params);
      case "captureFrame":
        return await this.serveCaptureFrame(params);
      case "enumerateTargets":
        return await this.serveEnumerateTargets(params);
      case "performInput":
        return await this.servePerformInput(params);
      case "resizeWindow":
        return await this.serveResizeWindow(params);
      case "reportPlan":
        return await this.serveReportPlan(params);
      case "reportStep":
        return await this.serveReportStep(params);
      case "reportResult":
        return this.serveReportResult(params);
      case "log":
        return this.serveLog(params);
      default:
        throw new LoopError(
          "LOOP_PROTOCOL_VIOLATION",
          `Unknown child → daemon method "${method}".`,
        );
    }
  }

  private serveReady(rawParams: unknown): LoopReadyResult {
    if (this.started) throw new LoopError("LOOP_PROTOCOL_VIOLATION", "A second `ready`.");
    const ready = (rawParams ?? {}) as { loopProtocolVersion?: unknown };
    // An assertion, not a negotiation: a mismatch means a corrupted or
    // half-upgraded install, and the correct response is to fail the run loudly
    // rather than degrade to a smaller method set. No method may be optional.
    if (ready.loopProtocolVersion !== LOOP_PROTOCOL_VERSION) {
      throw new LoopError(
        "LOOP_PROTOCOL_VERSION_MISMATCH",
        `The operator loop child speaks protocol ${String(ready.loopProtocolVersion)}; this daemon speaks ${LOOP_PROTOCOL_VERSION}.`,
      );
    }
    this.started = true;
    return {
      runId: this.config.runId,
      task: this.config.task,
      target: this.config.target,
      model: this.config.model,
      // Names only. The child never receives a resolved secret value, so no
      // bug in the process running provider SDK code can leak one.
      secretNames: this.secrets.map((secret) => secret.name),
      maxSteps: this.config.maxSteps,
      maxBatchActions: this.config.maxBatchActions,
      timeoutMs: this.config.timeoutMs,
      unbounded: this.config.unbounded,
      bounds: this.config.bounds,
      env: this.config.env as Record<string, string> | undefined,
      startedAtMs: this.config.startedAtMs,
    };
  }

  private serveBeginStep(rawParams: unknown): { guardrail: GuardrailState } {
    const { index } = parse(LoopBeginStepParamsSchema, rawParams);
    if (this.openStep !== undefined) {
      throw new LoopError(
        "LOOP_PROTOCOL_VIOLATION",
        `"beginStep" while step ${this.openStep} is open.`,
      );
    }
    // The child cannot skip, rewind, or reuse an index — `stepsUsed` is the
    // daemon's and monotonic.
    if (index !== this.stepsUsed) {
      throw new LoopError(
        "STEP_INDEX_MISMATCH",
        `"beginStep" expected index ${this.stepsUsed}, got ${index}.`,
      );
    }
    this.assertRunnable();
    if (index >= this.config.maxSteps) {
      throw new LoopError(
        "OPERATOR_MAX_STEPS_EXCEEDED",
        `Operator run exhausted its ${this.config.maxSteps}-step budget.`,
      );
    }
    // The ONLY thing that increments the authoritative step counter.
    this.stepsUsed += 1;
    this.openStep = index;
    this.actionsInStep = 0;
    this.planForOpenStep = undefined;
    return { guardrail: this.guardrailState() };
  }

  private async serveCaptureFrame(rawParams: unknown): Promise<unknown> {
    const params = parse(LoopCaptureFrameParamsSchema, rawParams);
    // An observation, not an action: it does not count toward maxBatchActions.
    this.requireOpenStep("captureFrame");
    this.assertRunnable();
    const frame = await this.proxy(() =>
      this.deps.captureFrame({
        format: params.format,
        maxWidth: params.maxWidth,
        quality: params.quality,
      }),
    );
    // The daemon already holds the bytes, because the frame came from its own
    // proxy — so it writes the frame and the child only ever sends a ref back
    // up. Frame results flow down, refs flow up.
    await this.rememberFrame(frame.imageBase64, params.format);
    return frame;
  }

  private async serveEnumerateTargets(rawParams: unknown): Promise<{ targets: CaptureTarget[] }> {
    const params = parse(LoopEnumerateTargetsParamsSchema, rawParams);
    this.requireOpenStep("enumerateTargets");
    this.assertRunnable();
    const targets = await this.proxy(() => this.deps.listTargets(params.kinds));
    return { targets: [...targets] };
  }

  private async servePerformInput(rawParams: unknown): Promise<{ performed: number }> {
    const params = parse(LoopPerformInputParamsSchema, rawParams);
    this.requireOpenStep("performInput");
    this.assertRunnable();
    this.chargeAction("performInput");
    // The clamp runs per action request, on arrival — there is no batch-level
    // fast path, and a batch is not a transaction.
    this.assertWithinBounds(params.actions);
    const actions = this.substituteSecrets(params.actions);
    return await this.proxy(() => this.deps.performInput(actions));
  }

  private async serveResizeWindow(rawParams: unknown): Promise<unknown> {
    const params = parse(LoopResizeWindowParamsSchema, rawParams);
    this.requireOpenStep("resizeWindow");
    this.assertRunnable();
    this.chargeAction("resizeWindow");
    return await this.proxy(() => this.deps.resizeWindow(params.targetId, params.bounds));
  }

  private async serveReportPlan(rawParams: unknown): Promise<{ accepted: true; revision: number }> {
    const params = parse(LoopReportPlanParamsSchema, rawParams);
    this.requireOpenStep("reportPlan");
    if (this.planForOpenStep !== undefined) {
      throw new LoopError("LOOP_PROTOCOL_VIOLATION", "A second `reportPlan` in one step.");
    }
    // The child carries a plan's *content*; the daemon owns its *identity*. A
    // child cannot renumber, backdate, or overwrite a revision.
    const revision = this.planRevision === undefined ? 0 : this.planRevision + 1;
    this.planRevision = revision;
    const plan: OperatorPlan = {
      revision,
      steps: params.steps,
      ...(params.rationale === undefined ? {} : { rationale: params.rationale }),
      atStepIndex: this.openStep as number,
      tMs: this.elapsedMs(),
    };
    this.planForOpenStep = plan;
    // Durable the moment it is accepted, so a crashed run's transcript still
    // shows what it intended to do. Planning consumes no guardrail budget.
    const redacted = redactSecrets(plan, this.secrets);
    this.enqueueWrite(() => this.persistPlan(redacted));
    this.emit({ kind: "plan", revision, steps: redacted.steps, rationale: redacted.rationale });
    return { accepted: true, revision };
  }

  private async serveReportStep(
    rawParams: unknown,
  ): Promise<{ accepted: true; guardrail: GuardrailState }> {
    const params = parse(LoopReportStepParamsSchema, rawParams);
    if (this.openStep === undefined) {
      throw new LoopError("LOOP_PROTOCOL_VIOLATION", "`reportStep` with no open step.");
    }
    const openStep = this.openStep;
    if (params.step.index !== openStep) {
      throw new LoopError(
        "STEP_INDEX_MISMATCH",
        `"reportStep" for index ${params.step.index}; step ${openStep} is open.`,
      );
    }

    const step: OperatorStep = redactSecrets(
      {
        ...params.step,
        // The child does not repeat the plan; if it does, the daemon's copy wins.
        ...(this.planForOpenStep === undefined ? {} : { plan: this.planForOpenStep }),
        observationRef: this.resolveObservationRef(params.step.observationRef),
      },
      this.secrets,
    );

    this.openStep = undefined;
    this.actionsInStep = 0;
    this.planForOpenStep = undefined;

    this.enqueueWrite(() => this.persistStep(step));
    this.deriveStepEvents(step);
    return { accepted: true, guardrail: this.guardrailState() };
  }

  private serveReportResult(rawParams: unknown): { accepted: true } {
    const params = parse(LoopReportResultParamsSchema, rawParams);
    this.ended = true;
    this.reported = {
      state: params.state,
      summary: params.summary,
      error: params.error,
      crashed: false,
    };
    // Normal completion: the child exits `0` after this response. The daemon
    // waits `LOOP_EXIT_GRACE_MS` and SIGKILLs if the process is still there.
    this.after(this.timings.exitGraceMs, () => {
      if (this.settle === undefined) return;
      this.child?.kill("SIGKILL");
      this.finish(this.terminalOutcome());
    });
    return { accepted: true };
  }

  private serveLog(rawParams: unknown): undefined {
    const params = parse(LoopLogParamsSchema, rawParams);
    // Redacted daemon-side before it reaches any log file.
    this.log(
      `[operator-loop:${this.config.runId}] ${params.level}: ${redactSecrets(params.message, this.secrets)}`,
    );
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Guardrails — daemon-side and authoritative
  // -------------------------------------------------------------------------

  private guardrailState(): GuardrailState {
    return {
      stepsUsed: this.stepsUsed,
      maxSteps: this.config.maxSteps,
      actionsInStep: this.openStep === undefined ? 0 : this.actionsInStep,
      maxBatchActions: this.config.maxBatchActions,
      remainingMs: Math.max(0, this.config.timeoutMs - this.elapsedMs()),
      aborted: this.abortReason !== undefined,
      unbounded: this.config.unbounded,
      ...(this.config.bounds === undefined ? {} : { bounds: this.config.bounds }),
      ...(this.planRevision === undefined ? {} : { planRevision: this.planRevision }),
    };
  }

  private requireOpenStep(method: string): void {
    if (this.openStep === undefined) {
      throw new LoopError("NO_OPEN_STEP", `"${method}" outside an open step.`);
    }
  }

  /** Abort state and the wall-clock deadline, re-evaluated on every request. */
  private assertRunnable(): void {
    if (this.abortReason !== undefined) {
      throw new LoopError("OPERATOR_ABORTED", "The operator run was aborted.");
    }
    if (this.elapsedMs() >= this.config.timeoutMs) {
      throw new LoopError(
        "OPERATOR_TIMEOUT",
        `Operator run exceeded its ${this.config.timeoutMs}ms wall-clock budget.`,
      );
    }
  }

  /**
   * Batching changes the *cost* of a step, never the *number* of steps or the
   * checks each action passes. `captureFrame`/`enumerateTargets` are
   * observations and never reach here.
   *
   * `OPERATOR_BATCH_LIMIT_EXCEEDED` is **not** run-terminating: the step stays
   * open, the child abandons the rest of the batch and closes the step
   * normally, so the counter is deliberately not incremented on refusal.
   */
  private chargeAction(method: string): void {
    if (this.actionsInStep >= this.config.maxBatchActions) {
      throw new LoopError(
        "OPERATOR_BATCH_LIMIT_EXCEEDED",
        `"${method}": more than ${this.config.maxBatchActions} action requests in one step.`,
      );
    }
    this.actionsInStep += 1;
  }

  /**
   * The child's own clamp is a courtesy that produces a better transcript; this
   * one is the enforcement point.
   */
  private assertWithinBounds(actions: readonly InputAction[]): void {
    const bounds = this.config.bounds;
    if (this.config.unbounded || bounds === undefined) return;
    for (const action of actions) {
      for (const { x, y } of inputActionCoordinates(action)) {
        const inside =
          x >= bounds.x &&
          x <= bounds.x + bounds.width &&
          y >= bounds.y &&
          y <= bounds.y + bounds.height;
        if (!inside) {
          throw new LoopError(
            "INPUT_OUT_OF_BOUNDS",
            `${action.kind}: coordinate (${x}, ${y}) is outside the target bounds (${bounds.x}, ${bounds.y}, ${bounds.width}x${bounds.height}).`,
          );
        }
      }
    }
  }

  /**
   * `{{name}}` is what the model emits, what the child forwards, and what
   * crosses this wire. The real value is substituted here, immediately before
   * the control-surface RPC, and exists only in daemon memory for the duration
   * of that one call.
   */
  private substituteSecrets(actions: readonly InputAction[]): InputAction[] {
    const byName = new Map(this.secrets.map((secret) => [secret.name, secret.value]));
    const replace = (value: unknown): unknown => {
      if (typeof value === "string") {
        return value.replace(PLACEHOLDER, (_whole, name: string) => {
          const resolved = byName.get(name);
          if (resolved === undefined) {
            // Never passed through literally: typing `{{password}}` into a
            // login form is a silent failure that looks like a model mistake.
            throw new LoopError(
              "UNKNOWN_SECRET_REF",
              `performInput referenced unknown secret "${name}".`,
            );
          }
          return resolved;
        });
      }
      if (Array.isArray(value)) return value.map(replace);
      if (value !== null && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
          out[key] = replace(item);
        }
        return out;
      }
      return value;
    };
    return replace(actions) as InputAction[];
  }

  /** Proxied surface errors reach the child verbatim — it cannot tell a proxied call from a direct one. */
  private async proxy<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (err) {
      throw new LoopError(codeOf(err), message_(err));
    }
  }

  // -------------------------------------------------------------------------
  // Persistence — entirely daemon-side
  // -------------------------------------------------------------------------

  private async rememberFrame(imageBase64: string, format: "png" | "jpeg"): Promise<void> {
    const hash = createHash("sha256").update(imageBase64, "base64").digest("hex").slice(0, 16);
    if (this.frames.has(hash)) return;
    const filename = `${hash}.${format === "jpeg" ? "jpg" : "png"}`;
    this.frames.set(hash, `frames/${filename}`);
    try {
      await mkdir(this.framesDir, { recursive: true });
      await writeFile(join(this.framesDir, filename), Buffer.from(imageBase64, "base64"));
    } catch (err) {
      this.log(`[operator-loop] could not persist observation frame: ${message_(err)}`);
    }
  }

  /**
   * The child names a frame by its content hash; the daemon holds the bytes,
   * so it maps the ref onto the file it already wrote.
   */
  private resolveObservationRef(ref: string): string {
    const hash = ref.split(":").pop() ?? ref;
    return this.frames.get(hash) ?? ref;
  }

  private enqueueWrite(write: () => Promise<void>): void {
    this.writes = this.writes.then(write).catch((err) => {
      this.log(`[operator-loop] persistence failed: ${message_(err)}`);
    });
  }

  private async flushWrites(): Promise<void> {
    await this.writes;
  }

  // -------------------------------------------------------------------------
  // Events — the daemon derives them from the child's reported facts
  // -------------------------------------------------------------------------

  private emit(event: OperatorEventPayload): void {
    this.onEvent({
      runId: this.config.runId,
      seq: this.seq++,
      tMs: this.elapsedMs(),
      ...event,
    } as OperatorEvent);
  }

  private deriveStepEvents(step: OperatorStep): void {
    if (step.reasoning !== undefined) {
      this.emit({ kind: "narration", stepIndex: step.index, text: step.reasoning });
    }
    for (const call of step.toolCalls as readonly OperatorToolCall[]) {
      this.emit({
        kind: "action",
        stepIndex: step.index,
        name: call.name,
        args: call.args,
        result: call.result,
      });
    }
    if (step.checkpoint !== undefined) {
      this.emit({ kind: "checkpoint", stepIndex: step.index, ...step.checkpoint });
    }
  }

  private emitResult(outcome: OperatorLoopOutcome): void {
    if (this.resultEmitted) return;
    this.resultEmitted = true;
    this.emit({
      kind: "result",
      state: outcome.state,
      summary: outcome.summary,
      error: outcome.error,
    });
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  private armDeadline(): void {
    const remaining = Math.max(0, this.config.timeoutMs - this.elapsedMs());
    this.after(remaining, () => {
      if (this.settle === undefined) return;
      // The daemon holds its own timer from `startedAtMs` — a child that
      // ignores its own `Deadline` still cannot run past this one.
      this.abort("timeout");
    });
  }

  private armPing(): void {
    const interval = this.timings.pingIntervalMs;
    if (interval <= 0 || !Number.isFinite(interval)) return;
    const tick = (): void => {
      if (this.settle === undefined || this.ended) return;
      const id = this.nextRequestId++;
      let answered = false;
      this.pendingPings.set(id, () => {
        answered = true;
      });
      this.write({ jsonrpc: "2.0", id, method: "ping", params: {} });
      this.after(this.timings.pingTimeoutMs, () => {
        this.pendingPings.delete(id);
        if (answered || this.settle === undefined || this.ended) return;
        // pid liveness is not health: a child wedged on a provider connection
        // is alive to `kill(pid, 0)` and useless to everyone.
        this.child?.kill("SIGKILL");
        this.crash("the loop child did not answer a liveness ping");
      });
      this.after(interval, tick);
    };
    this.after(interval, tick);
  }

  /** A terminal guardrail refusal is also the daemon's cue to wind the run down. */
  private beginFinalizationFor(code: string): void {
    switch (code) {
      case "OPERATOR_MAX_STEPS_EXCEEDED":
        this.abort("max-steps");
        return;
      case "OPERATOR_TIMEOUT":
        this.abort("timeout");
        return;
      default:
        // `INPUT_OUT_OF_BOUNDS` ends the run through the child's own loop,
        // which reports `failed`; nothing to signal.
        return;
    }
  }

  private onExit(exit: LoopChildExit): void {
    this.closed = true;
    if (this.settle === undefined) return;
    if (this.reported !== undefined || this.abortReason !== undefined) {
      this.finish(this.terminalOutcome());
      return;
    }
    // Non-zero exit, a signal, `kill -9`, or an unparseable stdout line
    // followed by EOF — all the same path.
    this.crash(
      exit.signal !== null
        ? `the loop child was terminated by ${exit.signal}`
        : `the loop child exited with code ${String(exit.code)}`,
    );
  }

  /**
   * `OPERATOR_LOOP_CRASHED`. The run is marked `failed` with every step
   * reported so far already persisted — a crashed run keeps its partial
   * transcript.
   *
   * **What happens to any recording: nothing, ever.** There is deliberately no
   * branch here that asks whether one exists; "crashed with a recording
   * running" and "crashed with nothing recording" are this one code path.
   */
  private crash(reason: string): void {
    this.child?.kill("SIGKILL");
    this.finish({
      state: "failed",
      crashed: true,
      error: { code: "OPERATOR_LOOP_CRASHED", message: `Operator loop crashed: ${reason}.` },
    });
  }

  /** The state the daemon signalled wins, whether or not the child agreed. */
  private terminalOutcome(): OperatorLoopOutcome {
    if (this.abortReason !== undefined) {
      const state = LOOP_ABORT_REASON_TO_STATE[this.abortReason];
      const error =
        this.abortReason === "max-steps"
          ? {
              code: "OPERATOR_MAX_STEPS_EXCEEDED",
              message: `Operator run exhausted its ${this.config.maxSteps}-step budget.`,
            }
          : this.reported?.error;
      return {
        state,
        summary: this.reported?.summary,
        ...(error === undefined ? {} : { error }),
        crashed: false,
      };
    }
    return this.reported ?? { state: "failed", crashed: false };
  }

  private finishSignalled(): void {
    this.finish(this.terminalOutcome());
  }

  private finish(outcome: OperatorLoopOutcome): void {
    const settle = this.settle;
    if (settle === undefined) return;
    this.settle = undefined;
    this.closed = true;
    this.clearTimers();
    // Exactly one `result` ends every run's stream — synthesized here when the
    // child died without sending one.
    this.emitResult(outcome);
    settle(outcome);
  }

  private after(ms: number, fn: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, ms);
    timer.unref?.();
    this.timers.add(timer);
  }

  private clearTimers(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  private elapsedMs(): number {
    return Math.max(0, this.now() - this.config.startedAtMs);
  }

  private log(line: string): void {
    this.onLog(redactSecrets(line, this.secrets));
  }
}

// ---------------------------------------------------------------------------

function parse<T>(schema: { parse: (value: unknown) => T }, value: unknown): T {
  try {
    return schema.parse(value);
  } catch (err) {
    throw new LoopError("INVALID_ARGS", message_(err));
  }
}

function codeOf(err: unknown): string {
  if (err instanceof DaemonError) return err.code;
  if (err instanceof SidecarError) return err.code;
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "INTERNAL_ERROR";
}

function message_(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
