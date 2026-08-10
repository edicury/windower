import type {
  OperatorCheckpoint,
  OperatorDeps,
  OperatorPlan,
  OperatorRun,
  OperatorRunOptions,
  OperatorRunResult,
  OperatorRunState,
  OperatorStep,
  OperatorToolCall,
  RunOperator,
} from "@windower/core";
import { BATCH_ABORTED_RESULT, formatModelConfig } from "@windower/core";
import type { LanguageModel, ModelMessage } from "ai";
import { generateText } from "ai";
import {
  OPERATOR_ERROR_CODES,
  OperatorError,
  isTerminalOperatorErrorCode,
  toOperatorError,
} from "./errors.js";
import { type ExecutionContext, executeToolCall } from "./executor.js";
import { Deadline } from "./guardrails.js";
import { buildSystemPrompt, formatPlanReminder } from "./prompt.js";
import { resolveModel } from "./providers.js";
import { type LogSink, createRedactedLogger, createRedactor } from "./redaction.js";
import { isActionToolName, isOperatorToolName } from "./tools.js";
import { buildToolSet } from "./tools.js";
import {
  type TranscriptWriter,
  createNullTranscriptWriter,
  createTranscriptWriter,
} from "./transcript.js";

/**
 * The observe → decide → act loop (contracts/operator.md).
 *
 * The daemon owns sidecar RPC, secret resolution, and run persistence; this
 * function owns the loop and nothing else. It is OS-agnostic by construction —
 * it only ever touches `OperatorDeps`, which is expressed purely in sidecar
 * protocol terms (CLAUDE.md §protocol before platform).
 */

/** How many observation frames stay in the model's context window. */
const MAX_RETAINED_IMAGES = 3;

/** Downscale target for observation frames when the model doesn't ask for one. */
const DEFAULT_FRAME_MAX_WIDTH = 1280;

const OBSERVATION_FORMAT = "png" as const;

/**
 * Test/daemon-only extension points. `RunOperator`'s public signature is fixed
 * by `@windower/core`, so these ride along on the options object and are read
 * structurally — production callers never set them.
 */
export interface OperatorRunInternals {
  /** Injected language model, bypassing the provider registry (tests). */
  languageModel?: LanguageModel;
  /** Redacted log sink. Defaults to stderr when WINDOWER_OPERATOR_DEBUG is set. */
  logSink?: LogSink;
  /** Injected clock, for deterministic `tMs` in tests. */
  now?: () => number;
  /** Run-start epoch; a loop child passes the daemon's, so both share one origin. */
  startedAtMs?: number;
  /**
   * Secret **names** for the prompt when no resolved values are available. Set
   * by the loop child, which receives `secretNames` and never a value
   * (contracts/operator-loop-protocol.md §Secrets): substitution and redaction
   * both become no-ops there because the process holds no secret material at
   * all, while the model still gets told which placeholders exist.
   */
  secretNames?: readonly string[];
  /**
   * Opens step `index` against the authoritative step counter before the
   * observation. The loop child maps this to `beginStep`; a rejection (max
   * steps, deadline, abort) carries the daemon's code and ends the run.
   */
  onBeginStep?: (index: number) => void | Promise<void>;
  /**
   * Assigns the identity of a plan revision. Returns the revision number. The
   * loop child maps this to `reportPlan`, so the daemon — never the model and
   * never the child — numbers and timestamps a plan. Defaults to a local
   * monotonic counter for the in-process path.
   */
  onPlan?: (
    content: { steps: string[]; rationale?: string },
    atStepIndex: number,
  ) => number | Promise<number>;
}

type InternalOptions = OperatorRunOptions & OperatorRunInternals;

function stateForError(code: string): OperatorRunState {
  switch (code) {
    case OPERATOR_ERROR_CODES.ABORTED:
      return "aborted";
    case OPERATOR_ERROR_CODES.TIMEOUT:
      return "timed_out";
    default:
      return "failed";
  }
}

/**
 * Combines the caller's kill switch with the wall-clock deadline so an
 * in-flight model call is torn down the instant either fires.
 */
function combineSignals(
  signal: AbortSignal,
  remainingMs: number,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal.aborted) controller.abort();
  else signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), remainingMs);
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    },
  };
}

/** Keeps only the newest observation frames attached; older ones become a text stub. */
function pruneObservationImages(messages: ModelMessage[]): void {
  const imageMessageIndexes: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message?.role !== "user" || !Array.isArray(message.content)) continue;
    if (message.content.some((part) => part.type === "file")) imageMessageIndexes.push(i);
  }
  const stale = imageMessageIndexes.slice(0, -MAX_RETAINED_IMAGES);
  for (const index of stale) {
    const message = messages[index];
    if (message?.role !== "user" || !Array.isArray(message.content)) continue;
    message.content = message.content.map((part) =>
      part.type === "file"
        ? { type: "text" as const, text: "[earlier screenshot omitted from context]" }
        : part,
    );
  }
}

export const runOperator: RunOperator = async (
  options: OperatorRunOptions,
  deps: OperatorDeps,
): Promise<OperatorRunResult> => {
  const internals = options as InternalOptions;
  const now = internals.now ?? Date.now;

  const redactor = createRedactor(options.secrets);
  const logger = createRedactedLogger(redactor, internals.logSink);
  const deadline = new Deadline(options.timeoutMs, now, internals.startedAtMs);
  const writer: TranscriptWriter =
    options.transcriptPath === undefined
      ? createNullTranscriptWriter()
      : createTranscriptWriter(options.transcriptPath, redactor);

  const steps: OperatorStep[] = [];
  const run: OperatorRun = {
    id: options.runId,
    state: "running",
    task: options.task,
    // The resolved target this run drives — and the run's only notion of what
    // it is operating. There is no session or recording identifier to carry
    // alongside it (contracts/operator.md §Recording independence).
    target: options.target,
    model: options.model,
    steps,
    startedAt: new Date(deadline.startedAtMs).toISOString(),
    transcriptPath: options.transcriptPath,
  };

  let state: OperatorRunState = "running";
  let summary: string | undefined;
  let error: { code: string; message: string } | undefined;

  const persist = async (): Promise<void> => {
    try {
      await writer.write({ ...run, state, steps, error });
    } catch (err) {
      logger.log("transcript write failed", { error: (err as Error).message });
    }
  };

  const recordStep = async (step: OperatorStep): Promise<void> => {
    // Last write barrier before the step leaves this package — the caller
    // persists whatever `onStep` receives, so it must already be redacted.
    const redacted = redactor.redact(step);
    steps.push(redacted);
    await persist();
    try {
      await options.onStep?.(redacted);
    } catch (err) {
      logger.log("onStep callback failed", { error: (err as Error).message });
    }
  };

  const messages: ModelMessage[] = [];
  let nextFrameMaxWidth: number | undefined;
  /** Local fallback when no authority (the daemon) is assigning revisions. */
  let nextLocalPlanRevision = 0;

  try {
    const model = internals.languageModel ?? resolveModel(options.model, options.env);
    const tools = buildToolSet();
    const system = buildSystemPrompt({
      task: options.task,
      secretNames:
        options.secrets.length > 0
          ? options.secrets.map((s) => s.name)
          : (internals.secretNames ?? []),
      maxSteps: options.maxSteps,
      timeoutMs: options.timeoutMs,
      maxBatchActions: options.maxBatchActions,
      unbounded: options.unbounded,
      bounds: options.bounds,
    });

    const ctx: ExecutionContext = {
      deps,
      secrets: options.secrets,
      boundsPolicy: { unbounded: options.unbounded, bounds: options.bounds },
      signal: options.signal,
      deadline,
      logger,
      onScreenshotRequest: (maxWidth) => {
        nextFrameMaxWidth = maxWidth;
      },
    };

    logger.log("run started", {
      runId: options.runId,
      model: formatModelConfig(options.model),
      maxSteps: options.maxSteps,
      timeoutMs: options.timeoutMs,
      unbounded: options.unbounded,
    });
    await persist();

    for (let index = 0; ; index++) {
      if (options.signal.aborted) {
        throw new OperatorError(OPERATOR_ERROR_CODES.ABORTED, "Operator run aborted.");
      }
      if (deadline.expired()) {
        throw new OperatorError(
          OPERATOR_ERROR_CODES.TIMEOUT,
          `Operator run exceeded its ${options.timeoutMs}ms wall-clock budget.`,
        );
      }
      if (index >= options.maxSteps) {
        throw new OperatorError(
          OPERATOR_ERROR_CODES.MAX_STEPS_EXCEEDED,
          `Operator run exhausted its ${options.maxSteps}-step budget without calling done.`,
        );
      }

      // Opening the step is what makes the step counter authoritative when the
      // loop runs as a child process — every screen-facing call the daemon
      // serves is gated on an open step (contracts/operator-loop-protocol.md
      // §"Step framing"). In-process there is no hook and this is a no-op.
      if (internals.onBeginStep !== undefined) {
        try {
          await internals.onBeginStep(index);
        } catch (err) {
          throw toOperatorError(err, OPERATOR_ERROR_CODES.DEPENDENCY_ERROR);
        }
      }

      // ── Observe ──────────────────────────────────────────────────────────
      let frame: Awaited<ReturnType<OperatorDeps["captureFrame"]>>;
      try {
        frame = await deps.captureFrame({
          format: OBSERVATION_FORMAT,
          maxWidth: nextFrameMaxWidth ?? DEFAULT_FRAME_MAX_WIDTH,
        });
      } catch (err) {
        throw toOperatorError(err, OPERATOR_ERROR_CODES.DEPENDENCY_ERROR);
      }
      nextFrameMaxWidth = undefined;
      const observationRef = await writer.writeFrame(frame.imageBase64, OBSERVATION_FORMAT);

      messages.push({
        role: "user",
        content: [
          {
            type: "text",
            text: `Observation ${index + 1}/${options.maxSteps} — ${frame.width}x${frame.height} px (scale ${frame.scale}).`,
          },
          { type: "file", data: frame.imageBase64, mediaType: "image/png" },
        ],
      });
      pruneObservationImages(messages);

      // ── Decide ───────────────────────────────────────────────────────────
      if (options.signal.aborted) {
        throw new OperatorError(OPERATOR_ERROR_CODES.ABORTED, "Operator run aborted.");
      }
      const combined = combineSignals(options.signal, deadline.remainingMs());
      let modelResult: Awaited<ReturnType<typeof generateText>>;
      try {
        modelResult = await generateText({
          model,
          system,
          messages,
          tools,
          abortSignal: combined.signal,
        });
      } catch (err) {
        if (options.signal.aborted) {
          throw new OperatorError(OPERATOR_ERROR_CODES.ABORTED, "Operator run aborted.");
        }
        if (deadline.expired()) {
          throw new OperatorError(
            OPERATOR_ERROR_CODES.TIMEOUT,
            `Operator run exceeded its ${options.timeoutMs}ms wall-clock budget.`,
          );
        }
        throw toOperatorError(err, OPERATOR_ERROR_CODES.MODEL_ERROR);
      } finally {
        combined.dispose();
      }

      messages.push(...(modelResult.response.messages as ModelMessage[]));

      const reasoningText =
        (modelResult as { reasoningText?: string }).reasoningText ?? modelResult.text;
      const reasoning = reasoningText.trim().length > 0 ? reasoningText.trim() : undefined;

      // ── Act ──────────────────────────────────────────────────────────────
      // One turn's tool calls are a *batch* (contracts/operator.md §Action
      // batching). They execute sequentially in emission order inside this one
      // step; the step costs one step from `maxSteps` no matter how many
      // actions it contains. When action k fails, k+1..n never execute, there
      // is no rollback, and every one of them is still recorded — as
      // `BATCH_ABORTED_RESULT` — so "ran / failed / never ran" is stated rather
      // than inferred from array length.
      const recorded: OperatorToolCall[] = [];
      const toolResults: Array<{ toolCallId: string; toolName: string; output: unknown }> = [];
      let terminal: { kind: "done" | "fail"; message: string } | undefined;
      /** Set when a terminal failure fired mid-batch; rethrown after the step is recorded. */
      let terminalError: OperatorError | undefined;
      /** True once the rest of the batch must be skipped, for any reason. */
      let batchAborted = false;
      /** Actions (not observations) already served in this step. */
      let actionsInStep = 0;
      let stepPlan: OperatorPlan | undefined;
      /**
       * Set only by an explicit `checkpoint` call. Never derived: "this turn
       * replanned" is not a proxy for `failed-plan-invalid`, and its absence is
       * not a proxy for `held` (contracts/operator.md §Execution model). A turn
       * that states nothing records nothing.
       */
      let stepCheckpoint: OperatorCheckpoint | undefined;

      const stepBase = { index, observationRef, reasoning, tMs: deadline.elapsedMs() };

      const seenToolCallIds = new Set<string>();

      for (const call of modelResult.toolCalls) {
        if (seenToolCallIds.has(call.toolCallId)) {
          // A well-behaved provider never repeats a toolCallId within one turn, but
          // the Anthropic Messages API hard-rejects a tool message with two
          // `tool-result` blocks sharing an id — skip the duplicate rather than crash.
          logger.log("duplicate toolCallId in model turn, skipping", {
            toolCallId: call.toolCallId,
            toolName: call.toolName,
          });
          continue;
        }
        seenToolCallIds.add(call.toolCallId);

        const toolName = call.toolName as string;
        if (!isOperatorToolName(toolName)) {
          // Cannot happen with a well-behaved provider; refuse rather than guess.
          recorded.push({ name: toolName, args: call.input, result: { error: "UNKNOWN_TOOL" } });
          toolResults.push({
            toolCallId: call.toolCallId,
            toolName,
            output: { error: `Unknown tool "${toolName}".` },
          });
          continue;
        }

        if (batchAborted) {
          recorded.push({ name: toolName, args: call.input, result: BATCH_ABORTED_RESULT });
          toolResults.push({
            toolCallId: call.toolCallId,
            toolName,
            output: BATCH_ABORTED_RESULT,
          });
          continue;
        }

        // Batch budget. Checked per action, on arrival — never once for the
        // batch up front, and never for observations or bookkeeping calls.
        if (isActionToolName(toolName)) {
          if (actionsInStep >= options.maxBatchActions) {
            const output = {
              error: {
                code: OPERATOR_ERROR_CODES.BATCH_LIMIT_EXCEEDED,
                message: `This turn emitted more than ${options.maxBatchActions} action tool calls. This one and everything after it in the turn were skipped; the run continues from the next observation.`,
              },
            };
            recorded.push({ name: toolName, args: call.input, result: output });
            toolResults.push({ toolCallId: call.toolCallId, toolName, output });
            batchAborted = true;
            continue;
          }
          actionsInStep += 1;
        }

        let outcome: Awaited<ReturnType<typeof executeToolCall>>;
        try {
          outcome = await executeToolCall(toolName, call.input, ctx);
        } catch (err) {
          const failure = toOperatorError(err, OPERATOR_ERROR_CODES.DEPENDENCY_ERROR);
          // `call.input` is the placeholder-form arguments the model sent —
          // recorded as-is, never the substituted value.
          const output = redactor.redact({
            error: { code: failure.code, message: failure.message },
          });
          recorded.push({ name: toolName, args: call.input, result: output });
          batchAborted = true;
          if (isTerminalOperatorErrorCode(failure.code)) {
            // Batching MUST NOT downgrade a terminal guardrail failure: the run
            // ends, but only after the remaining actions are recorded as
            // skipped, so the partial step is still a complete record.
            terminalError = failure;
          } else {
            toolResults.push({ toolCallId: call.toolCallId, toolName, output });
          }
          continue;
        }

        if (outcome.kind === "plan") {
          if (stepPlan !== undefined) {
            // One turn produces at most one plan revision
            // (contracts/operator-loop-protocol.md §"Plans on this wire").
            const output = {
              ok: false,
              note: "A plan was already recorded this turn. One `plan` call per turn.",
            };
            recorded.push({ name: toolName, args: call.input, result: output });
            toolResults.push({ toolCallId: call.toolCallId, toolName, output });
            continue;
          }
          let revision: number;
          try {
            revision =
              internals.onPlan === undefined
                ? nextLocalPlanRevision++
                : await internals.onPlan(
                    { steps: outcome.steps, rationale: outcome.rationale },
                    index,
                  );
          } catch (err) {
            throw toOperatorError(err, OPERATOR_ERROR_CODES.DEPENDENCY_ERROR);
          }
          stepPlan = {
            revision,
            steps: outcome.steps,
            rationale: outcome.rationale,
            atStepIndex: index,
            tMs: stepBase.tMs,
          };
          run.plan = redactor.redact(stepPlan);
          const output = { ok: true, revision };
          recorded.push({ name: toolName, args: call.input, result: output });
          toolResults.push({ toolCallId: call.toolCallId, toolName, output });
          continue;
        }

        if (outcome.kind === "checkpoint") {
          if (stepCheckpoint !== undefined) {
            // One verification per step, mirroring how a second `plan` in one
            // turn is refused: `OperatorStep.checkpoint` is a single optional
            // record, and silently overwriting it would lose the first one.
            const output = {
              ok: false,
              note: "A checkpoint was already recorded this turn. One `checkpoint` call per turn.",
            };
            recorded.push({ name: toolName, args: call.input, result: output });
            toolResults.push({ toolCallId: call.toolCallId, toolName, output });
            continue;
          }
          stepCheckpoint = outcome.checkpoint;
          const output = { ok: true, outcome: outcome.checkpoint.outcome };
          recorded.push({ name: toolName, args: call.input, result: output });
          toolResults.push({ toolCallId: call.toolCallId, toolName, output });
          continue;
        }

        if (outcome.kind === "done") {
          recorded.push({ name: toolName, args: call.input });
          terminal = { kind: "done", message: outcome.summary };
          batchAborted = true;
          continue;
        }
        if (outcome.kind === "fail") {
          recorded.push({ name: toolName, args: call.input });
          terminal = { kind: "fail", message: outcome.reason };
          batchAborted = true;
          continue;
        }

        const result = redactor.redact(outcome.result);
        recorded.push({ name: toolName, args: call.input, result });
        toolResults.push({ toolCallId: call.toolCallId, toolName, output: result });
      }

      // `checkpoint` stays `undefined` unless this turn stated one. The loop
      // child hands the whole step to `reportStep`, so this is also how the
      // checkpoint reaches the daemon as `reportStep.step.checkpoint`
      // (contracts/operator-loop-protocol.md §"Operator events on this wire") —
      // the child reports the fact, the daemon derives the event.
      await recordStep({
        ...stepBase,
        plan: stepPlan,
        checkpoint: stepCheckpoint,
        toolCalls: recorded,
      });

      if (terminalError !== undefined) throw terminalError;

      if (terminal !== undefined) {
        if (terminal.kind === "done") {
          state = "succeeded";
          summary = terminal.message;
        } else {
          state = "failed";
          error = {
            code: OPERATOR_ERROR_CODES.MODEL_FAILED,
            message: terminal.message,
          };
        }
        break;
      }

      if (toolResults.length > 0) {
        messages.push({
          role: "tool",
          content: toolResults.map((r) => ({
            type: "tool-result" as const,
            toolCallId: r.toolCallId,
            toolName: r.toolName,
            output: { type: "json" as const, value: r.output as never },
          })),
        });
      } else if (modelResult.toolCalls.length === 0) {
        messages.push({
          role: "user",
          content: [
            {
              type: "text",
              text: "You did not call a tool. Call `plan` if you have not planned yet, otherwise emit the next action (or a short batch of them), or call `done`/`fail` to end the run.",
            },
          ],
        });
      }

      if (stepPlan !== undefined) {
        // Keeps the current plan legible in context without the model having to
        // scroll back past pruned observations to find it.
        messages.push({
          role: "user",
          content: [{ type: "text", text: formatPlanReminder(stepPlan) }],
        });
      }
    }
  } catch (err) {
    const operatorError = toOperatorError(err, OPERATOR_ERROR_CODES.MODEL_ERROR);
    state = stateForError(operatorError.code);
    error = redactor.redact({ code: operatorError.code, message: operatorError.message });
  }

  run.state = state;
  run.endedAt = new Date(now()).toISOString();
  run.error = error;
  await persist();

  logger.log("run finished", { runId: options.runId, state, steps: steps.length });

  return {
    state,
    steps,
    summary: summary === undefined ? undefined : redactor.redactString(summary),
    error,
  };
};
