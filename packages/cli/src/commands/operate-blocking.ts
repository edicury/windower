import { randomUUID } from "node:crypto";
import { basename, dirname, extname, join } from "node:path";
import {
  type CaptureTarget,
  DEFAULT_OPERATOR_MAX_STEPS,
  DEFAULT_OPERATOR_TIMEOUT_MS,
  DaemonError,
  type InputAction,
  type OperatorDeps,
  type OperatorRun,
  type OperatorStep,
  type Rect,
  type ResolvedSecret,
  type RunOperator,
  type RunOperatorParams,
  type SidecarClient,
  SidecarError,
  spawnSidecar as realSpawnSidecar,
  requiredCapabilityForInputAction,
} from "@windower/core";
import {
  OperatorRunStore,
  PassthroughService,
  type RecordingEngine,
  SecretResolver,
  type SidecarFactory,
  type SidecarHandle,
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

function transcriptPathFor(outputPath: string): string {
  const ext = extname(outputPath);
  return join(dirname(outputPath), `${basename(outputPath, ext)}.operator.json`);
}

function toDaemonError(err: unknown): DaemonError {
  if (err instanceof DaemonError) return err;
  if (err instanceof SidecarError) return new DaemonError(err.code, err.message);
  return new DaemonError("INTERNAL_ERROR", err instanceof Error ? err.message : String(err));
}

export interface RunOperatorBlockingOptions {
  /** Fires when the model calls `screenshot`/`click`/etc. — used to render step progress to stderr. */
  onStep?: (step: OperatorStep) => void;
  /** SIGINT wires here — aborting finalizes (not discards) any active recording, same as a normal completion. */
  signal: AbortSignal;
  /** The `RecordingEngine` behind the invoking CLI's `LocalWindower`/`withBackend` call — reused so `--no-record`
   *  and recording-backed runs share the exact same session/manifest machinery as `start`/`stop`. */
  recordingEngine: RecordingEngine;
  /** Injectable for tests — defaults to `@windower/core`'s real `spawnSidecar`. */
  spawnSidecar?: SidecarFactory;
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

  const runId = randomUUID();
  let run: OperatorRun = {
    id: runId,
    state: "pending",
    task: params.task,
    model: params.model,
    steps: [],
    startedAt: nowIso(),
  };
  await store.save(run);

  const spawnSidecar = options.spawnSidecar ?? realSpawnSidecar;
  const passthrough = new PassthroughService(spawnSidecar);
  const secretResolver = new SecretResolver();

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

  const recordingDisabled = params.recording?.disabled === true;
  let sessionId: string | undefined;
  let transientSidecar: SidecarHandle | undefined;
  let client: SidecarClient;
  let target: CaptureTarget;
  let transcriptPath: string | undefined;

  try {
    target = await resolveOperatorTarget(passthrough);
    if (recordingDisabled) {
      // `--no-record` still needs a sidecar for performInput/captureFrame —
      // same one-off spawn shape `PassthroughService` uses, held for the run.
      transientSidecar = spawnSidecar({});
      client = transientSidecar.client;
    } else {
      const started = await options.recordingEngine.startRecording({
        target,
        video: params.recording?.video,
        audio: params.recording?.audio,
        outputDir: params.recording?.outputDir,
      });
      sessionId = started.sessionId;
      const sessionClient = options.recordingEngine.getSidecarClient(sessionId);
      if (!sessionClient) {
        throw new DaemonError(
          "INTERNAL_ERROR",
          `Session "${sessionId}" has no active sidecar immediately after start`,
        );
      }
      client = sessionClient;
      const outputPath = options.recordingEngine.getPlannedOutputPath(sessionId);
      if (outputPath) {
        transcriptPath = transcriptPathFor(outputPath);
        options.recordingEngine.setOperatorRunPath(sessionId, transcriptPath);
      }
    }
  } catch (err) {
    const daemonErr = toDaemonError(err);
    await transientSidecar?.terminate().catch(() => {});
    await store.save({
      ...run,
      state: "failed",
      endedAt: nowIso(),
      error: { code: daemonErr.code, message: daemonErr.message },
    });
    throw daemonErr;
  }

  const capabilities = await client
    .describe()
    .then((result) => result.capabilities as readonly string[])
    .catch(() => [] as readonly string[]);

  const deps = createDeps({ client, capabilities, sessionId, target, passthrough });

  const guardrails = params.guardrails ?? {};
  run = { ...run, state: "running", sessionId, transcriptPath };
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
        model: params.model,
        secrets,
        maxSteps: guardrails.maxSteps ?? DEFAULT_OPERATOR_MAX_STEPS,
        timeoutMs:
          guardrails.timeoutSeconds !== undefined
            ? Math.round(guardrails.timeoutSeconds * 1000)
            : DEFAULT_OPERATOR_TIMEOUT_MS,
        unbounded: guardrails.unbounded ?? false,
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

  // Finalize: stop the recording (video/manifest/event timeline all land,
  // same as a normal `stop`) regardless of how the loop ended — including on
  // SIGINT-triggered abort, per contracts/cli.md: "Ctrl-C aborts the run and
  // finalizes (not discards) any active recording, same as a normal
  // completion."
  if (sessionId) {
    try {
      const session = options.recordingEngine.getSession({ sessionId });
      if (session.state === "recording") {
        await options.recordingEngine.stopRecording({ sessionId });
      }
    } catch (err) {
      console.error(`[operate] stopping recording for run ${runId} failed:`, err);
    }
  }
  await transientSidecar?.terminate().catch(() => {});

  const current = store.get(runId) ?? run;
  const steps = result.steps.length > 0 ? redactSecrets(result.steps, secrets) : current.steps;
  const finalState = aborted ? "aborted" : result.state;
  const finalRun: OperatorRun = {
    ...current,
    state: finalState,
    steps,
    endedAt: nowIso(),
    ...(result.error ? { error: redactSecrets(result.error, secrets) } : {}),
  };
  await store.save(finalRun);
  return finalRun;
}

function createDeps(ctx: {
  client: SidecarClient;
  capabilities: readonly string[];
  sessionId?: string;
  target: CaptureTarget;
  passthrough: PassthroughService;
}): OperatorDeps {
  const requireCapability = (capability: string): void => {
    if (!ctx.capabilities.includes(capability)) {
      throw new DaemonError("UNSUPPORTED_CAPABILITY", `Sidecar does not advertise "${capability}"`);
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
        const { targets } = await ctx.passthrough.listTargets(kinds ? { kinds } : {});
        return targets;
      } catch (err) {
        throw toDaemonError(err);
      }
    },
    resizeWindow: async (targetId, bounds: Rect) => {
      try {
        return await ctx.passthrough.resizeWindow({ targetId, bounds });
      } catch (err) {
        throw toDaemonError(err);
      }
    },
  };
}

/**
 * `run_operator`/`operate` take no `target` — the operator drives whatever
 * the user is looking at — so the run targets the primary display, falling
 * back to the first enumerated one. Mirrors
 * `OperatorRunEngine.resolveOperatorTarget` exactly.
 */
async function resolveOperatorTarget(passthrough: PassthroughService): Promise<CaptureTarget> {
  const { targets } = await passthrough.listTargets({ kinds: ["display"] });
  const displays = targets.filter(
    (t): t is Extract<CaptureTarget, { kind: "display" }> => t.kind === "display",
  );
  const target = displays.find((t) => t.isPrimary) ?? displays[0];
  if (!target) {
    throw new DaemonError("TARGET_NOT_FOUND", "No display available for the operator run");
  }
  return target;
}
