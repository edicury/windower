import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  type CaptureTarget,
  DEFAULT_OPERATOR_MAX_BATCH_ACTIONS,
  DEFAULT_OPERATOR_MAX_REPLANS,
  DEFAULT_OPERATOR_MAX_STEPS,
  DEFAULT_OPERATOR_TIMEOUT_MS,
  DaemonError,
  type InputAction,
  type OperatorDeps,
  type OperatorModels,
  type OperatorRun,
  type OperatorStep,
  type Rect,
  type ResolvedSecret,
  type RunOperator,
  type RunOperatorParams,
  SidecarError,
  normalizeOperatorModels,
  spawnSidecar as realSpawnSidecar,
  requiredCapabilityForInputAction,
} from "@windower/core";
import {
  type CaptureAccess,
  CaptureLock,
  ControlEngine,
  OperatorRunStore,
  PassthroughService,
  SecretResolver,
  type SidecarFactory,
  operatorRunsDir,
  redactSecrets,
} from "@windower/engine";

/**
 * The `local`-mode, blocking half of `windower operate` (`contracts/cli.md`
 * "operate blocks by default", `phase-20-daemon-optional.md` "operate
 * blocking by default"). Deliberately parallel to
 * `packages/engine/src/operator-run-engine.ts`'s `runOperator` (target
 * resolution, secret resolution, `OperatorDeps` construction, transcript path,
 * redaction-on-persist) but calls `@windower/operator`'s `runOperator`
 * directly and in-process instead of firing the loop in the background —
 * this is the "no daemon, no socket, no RPC" path, so there is no
 * `OperatorRunEngine`/daemon between this code and the loop.
 *
 * `operator-run-engine.ts` is intentionally left untouched: it remains the
 * `daemon`-mode (`operate --detach`) implementation, and this module does not
 * share its private internals (per the phase brief, "wiring a NEW caller,
 * not touching loop internals").
 *
 * Phase 21: this path records nothing and knows nothing about recording. A
 * caller who wants video runs `windower start` before and `windower stop`
 * after — three independent calls it sequences itself
 * (contracts/operator.md §Ownership).
 */

/** Resolved through a non-literal specifier so `@windower/cli` — and every command that
 * isn't `operate` — never eagerly loads the AI SDK. Mirrors
 * `operator-run-engine.ts`'s `defaultLoadRunOperator`. */
const OPERATOR_PACKAGE_SPECIFIER = "@windower/operator";

async function loadRunOperator(): Promise<RunOperator> {
  const specifier: string = OPERATOR_PACKAGE_SPECIFIER;
  const mod = (await import(specifier)) as { runOperator?: RunOperator };
  if (typeof mod.runOperator !== "function") {
    throw new DaemonError(
      "INTERNAL_ERROR",
      `"${OPERATOR_PACKAGE_SPECIFIER}" does not export runOperator`,
    );
  }
  return mod.runOperator;
}

function nowIso(): string {
  return new Date().toISOString();
}

function summarize(value: unknown, max: number): string {
  if (value === undefined) return "";
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * One human-readable line per completed `OperatorStep`, written to stderr by
 * `windower operate`'s blocking `onStep` callback (`contracts/cli.md`:
 * "Step-by-step progress (`onStep`) streams to stderr as it happens").
 * `toolCalls[].args` are already placeholder-form (never resolved secret
 * values, per `contracts/operator.md` §Secret refs) and `result`s have
 * already passed through the loop's redaction filter, so this is safe to
 * print verbatim.
 */
export function renderOperatorStepLine(step: OperatorStep): string {
  const seconds = (step.tMs / 1000).toFixed(1);
  const calls =
    step.toolCalls.length > 0
      ? step.toolCalls
          .map((call) => {
            const args = summarize(call.args, 60);
            const result = call.result === undefined ? "" : ` -> ${summarize(call.result, 40)}`;
            return `${call.name}(${args})${result}`;
          })
          .join(", ")
      : "(no tool call)";
  return `[operate] step ${step.index + 1} @ ${seconds}s: ${calls}`;
}

/** Operator-owned storage, derived from the run id — contracts/operator.md §Transcript format. */
function transcriptPathFor(runId: string): string {
  return join(operatorRunsDir(), runId, "transcript.json");
}

function toDaemonError(err: unknown): DaemonError {
  if (err instanceof DaemonError) return err;
  if (err instanceof SidecarError) return new DaemonError(err.code, err.message);
  return new DaemonError("INTERNAL_ERROR", err instanceof Error ? err.message : String(err));
}

export interface RunOperatorBlockingOptions {
  /** Fires when the model calls `screenshot`/`click`/etc. — used to render step progress to stderr. */
  onStep?: (step: OperatorStep) => void;
  /** SIGINT wires here — aborting ends the run and touches nothing else. */
  signal: AbortSignal;
  /** Injectable for tests — defaults to `@windower/core`'s real `spawnSidecar`. */
  spawnSidecar?: SidecarFactory;
  /** Capture surface (screen-capture exclusivity seam); defaults to a `CaptureLock` over `spawnSidecar`. */
  capture?: CaptureAccess;
  /** Control surface for input/window control; defaults to a `ControlEngine` over `spawnSidecar`. */
  control?: ControlEngine;
}

/**
 * Runs one operator task to completion in this process and returns the
 * terminal `OperatorRun`. Persists to `~/.windower/operator-runs/<id>.json`
 * on every step, exactly like the daemon-backed path, so `windower operate
 * status <runId>` can inspect a still-running or just-finished blocking run.
 */
export async function runOperatorBlocking(
  params: RunOperatorParams,
  options: RunOperatorBlockingOptions,
): Promise<OperatorRun> {
  const store = new OperatorRunStore();
  await store.load();

  const spawnSidecar = options.spawnSidecar ?? realSpawnSidecar;
  const capture = options.capture ?? new CaptureLock({ spawnSidecar });
  // `surface: "control"` is load-bearing — `SpawnSidecarOptions.surface`
  // defaults to `"capture"`, so an unqualified `spawnControl` would start the
  // *capture* binary for every `performInput`/`resizeWindow`: a second
  // ScreenCaptureKit process next to a possibly live recording, to serve calls
  // that touch no capture state at all. Same fix as
  // `packages/engine/src/operator-run-engine.ts`. It still takes no capture
  // lock (`contracts/screen-capture-exclusivity.md` §What never takes this
  // lock).
  const control =
    options.control ??
    new ControlEngine({ spawnControl: spawnSidecar, spawnOptions: { surface: "control" } });
  const passthrough = new PassthroughService(spawnSidecar, { capture });
  const secretResolver = new SecretResolver();

  // Resolved before the record exists: an `OperatorRun` without a resolved
  // target is not a representable value, so an unresolvable selector is a
  // rejected call rather than a persisted run.
  const target = await resolveOperatorTarget(passthrough, params.target);
  // Same treatment: `windower operate`'s blocking path never relies on the
  // daemon's config-fallback resolution — `buildRunOperatorParams`
  // (`operate-params.ts`) has already fully resolved `models` (erroring if
  // no planner could be resolved) before this function is ever called, so a
  // caller reaching here without `models` is a caller bypassing that
  // resolution — a rejected call, not a run with no model.
  if (params.models === undefined) {
    throw new DaemonError(
      "INVALID_ARGS",
      "No operator model resolved: `models` is required for a blocking operator run",
    );
  }
  const models: OperatorModels = normalizeOperatorModels(params.models);
  const runId = randomUUID();
  const transcriptPath = transcriptPathFor(runId);
  let run: OperatorRun = {
    id: runId,
    state: "pending",
    task: params.task,
    target,
    models,
    steps: [],
    startedAt: nowIso(),
  };
  await store.save(run);

  let secrets: ResolvedSecret[];
  try {
    secrets = await secretResolver.resolveAll(params.secrets ?? []);
  } catch (err) {
    const daemonErr = toDaemonError(err);
    await store.save({
      ...run,
      state: "failed",
      endedAt: nowIso(),
      error: { code: daemonErr.code, message: daemonErr.message },
    });
    throw daemonErr;
  }

  const captureCapabilities = await capture
    .withCaptureClient((client) => client.describe())
    .then((result) => result.capabilities as readonly string[])
    .catch(() => [] as readonly string[]);

  const deps = createDeps({ captureCapabilities, target, capture, control, passthrough });

  const guardrails = params.guardrails ?? {};
  run = { ...run, state: "running", transcriptPath };
  await store.save(run);

  let aborted = false;
  const onAbort = () => {
    aborted = true;
  };
  if (options.signal.aborted) aborted = true;
  else options.signal.addEventListener("abort", onAbort, { once: true });

  let result: Awaited<ReturnType<RunOperator>>;
  try {
    const runOperator = await loadRunOperator();
    result = await runOperator(
      {
        runId,
        task: params.task,
        models,
        secrets,
        maxSteps: guardrails.maxSteps ?? DEFAULT_OPERATOR_MAX_STEPS,
        timeoutMs:
          guardrails.timeoutSeconds !== undefined
            ? Math.round(guardrails.timeoutSeconds * 1000)
            : DEFAULT_OPERATOR_TIMEOUT_MS,
        maxBatchActions: guardrails.maxBatchActions ?? DEFAULT_OPERATOR_MAX_BATCH_ACTIONS,
        maxReplans: guardrails.maxReplans ?? DEFAULT_OPERATOR_MAX_REPLANS,
        observe: params.observe,
        unbounded: guardrails.unbounded ?? false,
        target,
        bounds: target.bounds,
        transcriptPath,
        signal: options.signal,
        onStep: async (step) => {
          const current = store.get(runId);
          if (current) await store.save({ ...current, steps: [...current.steps, step] });
          options.onStep?.(step);
        },
        // No `env` override: this loop already runs inside the invoking CLI
        // process, so `resolveModel` sees this process's own `process.env`
        // by default (see `OperatorRunOptions.env`'s doc) — the whole point
        // of blocking mode per phase-20-daemon-optional.md.
      },
      deps,
    );
  } catch (err) {
    const daemonErr = toDaemonError(err);
    result = {
      state: "failed",
      steps: store.get(runId)?.steps ?? [],
      error: { code: daemonErr.code, message: daemonErr.message },
    };
  } finally {
    options.signal.removeEventListener("abort", onAbort);
  }

  // Finalize: write the run's terminal state, and nothing else. There is no
  // recording to consult — a caller that started one around this run stops it
  // itself (contracts/operator-loop-protocol.md §OPERATOR_LOOP_CRASHED: "a
  // branch there would be a defect").
  if (options.control === undefined) await control.shutdown().catch(() => {});

  const current = store.get(runId) ?? run;
  const steps = result.steps.length > 0 ? redactSecrets(result.steps, secrets) : current.steps;
  const finalState = aborted ? "aborted" : result.state;
  const finalRun: OperatorRun = {
    ...current,
    state: finalState,
    steps,
    endedAt: nowIso(),
    // The run's `done`/`fail` summary is persisted, not just returned, so
    // `windower operate status` and `get_operator_run` show it too — the same
    // record either path produces (contracts/operator.md §"How they surface").
    ...(result.summary === undefined ? {} : { summary: redactSecrets(result.summary, secrets) }),
    ...(result.error ? { error: redactSecrets(result.error, secrets) } : {}),
  };
  await store.save(finalRun);
  return finalRun;
}

/**
 * `OperatorDeps` over the two independent peers a run needs: the capture
 * surface for observations (always through the screen-capture exclusivity
 * seam, so there is only ever one ScreenCaptureKit process) and the control
 * surface for actions (which never takes that lock). Capability gating is per
 * call against `describe().capabilities`, never a platform string.
 */
function createDeps(ctx: {
  captureCapabilities: readonly string[];
  target: CaptureTarget;
  capture: CaptureAccess;
  control: ControlEngine;
  passthrough: PassthroughService;
}): OperatorDeps {
  const requireCaptureCapability = (capability: string): void => {
    if (!ctx.captureCapabilities.includes(capability)) {
      throw new DaemonError("UNSUPPORTED_CAPABILITY", `Sidecar does not advertise "${capability}"`);
    }
  };

  return {
    captureFrame: async (frameParams) => {
      requireCaptureCapability("screenshot");
      try {
        // Addressed by TARGET, never by a recording — whether the frame comes
        // from a live capture source or a one-shot capture is unobservable
        // here (contracts/operator.md §Recording independence).
        return await ctx.capture.withCaptureClient((client) =>
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
        if (capability) await ctx.control.requireCapability(capability);
      }
      try {
        // No `sessionId`: it is an optional correlation hint on the wire and
        // an operator run has none to give. Nothing replaces it.
        return await ctx.control.performInput({ actions });
      } catch (err) {
        throw toDaemonError(err);
      }
    },
    listTargets: async (kinds) => {
      try {
        const { targets } = await ctx.passthrough.listTargets(kinds ? { kinds: [...kinds] } : {});
        return targets;
      } catch (err) {
        throw toDaemonError(err);
      }
    },
    resizeWindow: async (targetId, bounds: Rect) => {
      try {
        return await ctx.control.resizeWindow({ targetId, bounds });
      } catch (err) {
        throw toDaemonError(err);
      }
    },
    // Phase 22 — control-surface, capture-free: goes through `ControlEngine`
    // exactly like `performInput`/`resizeWindow` above, NEVER `ctx.capture`,
    // and takes no `~/.windower/capture.lock`. A structured
    // `UNSUPPORTED_CAPABILITY` here is what lets the operator's observation
    // policy fall back to a frame instead of crashing. Mirrors
    // `OperatorRunEngine.createDeps`'s `enumerateElements`.
    enumerateElements: async (elementsParams) => {
      await ctx.control.requireCapability("ui.elements");
      try {
        return await ctx.control.enumerateElements({ target: ctx.target, ...elementsParams });
      } catch (err) {
        throw toDaemonError(err);
      }
    },
  };
}

/**
 * Resolves the caller's target selector — the same `CaptureTarget |
 * { targetId }` shape `windower start` takes (contracts/operator.md §Inputs),
 * resolved once before the run starts. Mirrors
 * `OperatorRunEngine.resolveOperatorTarget`.
 */
async function resolveOperatorTarget(
  passthrough: PassthroughService,
  selector: RunOperatorParams["target"],
): Promise<CaptureTarget> {
  if ("kind" in selector) return selector;
  const { targets } = await passthrough.listTargets({});
  const found = targets.find((t) => "id" in t && t.id === selector.targetId);
  if (!found) {
    throw new DaemonError("TARGET_NOT_FOUND", `No target with id "${selector.targetId}"`);
  }
  return found;
}
