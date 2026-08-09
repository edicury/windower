import type {
  OperatorDeps,
  OperatorRun,
  OperatorRunOptions,
  OperatorRunResult,
  OperatorRunState,
  OperatorStep,
  OperatorToolCall,
  RunOperator,
} from "@windower/core";
import { formatModelConfig } from "@windower/core";
import type { LanguageModel, ModelMessage } from "ai";
import { generateText } from "ai";
import { OPERATOR_ERROR_CODES, OperatorError, toOperatorError } from "./errors.js";
import { type ExecutionContext, executeToolCall } from "./executor.js";
import { Deadline } from "./guardrails.js";
import { buildSystemPrompt } from "./prompt.js";
import { resolveModel } from "./providers.js";
import { type LogSink, createRedactedLogger, createRedactor } from "./redaction.js";
import { isOperatorToolName } from "./tools.js";
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
  /** Environment used for API-key lookup. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Redacted log sink. Defaults to stderr when WINDOWER_OPERATOR_DEBUG is set. */
  logSink?: LogSink;
  /** Injected clock, for deterministic `tMs` in tests. */
  now?: () => number;
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
  const deadline = new Deadline(options.timeoutMs, now);
  const writer: TranscriptWriter =
    options.transcriptPath === undefined
      ? createNullTranscriptWriter()
      : createTranscriptWriter(options.transcriptPath, redactor);

  const steps: OperatorStep[] = [];
  const run: OperatorRun = {
    id: options.runId,
    state: "running",
    task: options.task,
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

  try {
    const model = internals.languageModel ?? resolveModel(options.model, internals.env);
    const tools = buildToolSet();
    const system = buildSystemPrompt({
      task: options.task,
      secretNames: options.secrets.map((s) => s.name),
      maxSteps: options.maxSteps,
      timeoutMs: options.timeoutMs,
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
      const recorded: OperatorToolCall[] = [];
      const toolResults: Array<{ toolCallId: string; toolName: string; output: unknown }> = [];
      let terminal: { kind: "done" | "fail"; message: string } | undefined;

      const stepBase = { index, observationRef, reasoning, tMs: deadline.elapsedMs() };

      for (const call of modelResult.toolCalls) {
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

        let outcome: Awaited<ReturnType<typeof executeToolCall>>;
        try {
          outcome = await executeToolCall(toolName, call.input, ctx);
        } catch (err) {
          // `call.input` is the placeholder-form arguments the model sent —
          // recorded as-is, never the substituted value.
          recorded.push({ name: toolName, args: call.input });
          await recordStep({ ...stepBase, toolCalls: recorded });
          throw err;
        }

        if (outcome.kind === "done") {
          recorded.push({ name: toolName, args: call.input });
          terminal = { kind: "done", message: outcome.summary };
          break;
        }
        if (outcome.kind === "fail") {
          recorded.push({ name: toolName, args: call.input });
          terminal = { kind: "fail", message: outcome.reason };
          break;
        }

        const result = redactor.redact(outcome.result);
        recorded.push({ name: toolName, args: call.input, result });
        toolResults.push({ toolCallId: call.toolCallId, toolName, output: result });
      }

      await recordStep({ ...stepBase, toolCalls: recorded });

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
              text: "You did not call a tool. Call exactly one tool, or call `done`/`fail` to end the run.",
            },
          ],
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
