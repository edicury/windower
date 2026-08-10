import type {
  ObservationRef,
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
  UIElement,
} from "@windower/core";
import { BATCH_ABORTED_RESULT, formatModelConfig } from "@windower/core";
import type { Instructions, LanguageModel, ModelMessage } from "ai";
import { generateText } from "ai";
import {
  OPERATOR_ERROR_CODES,
  OperatorError,
  isTerminalOperatorErrorCode,
  toOperatorError,
} from "./errors.js";
import { type ExecutionContext, executeToolCall } from "./executor.js";
import { Deadline } from "./guardrails.js";
import { ELEMENTS_OBSERVATION_MARKER, renderElementsAsText } from "./observation.js";
import {
  MIN_USEFUL_ELEMENT_COUNT,
  buildExecutorSystemPrompt,
  buildSystemPrompt,
  formatPlanReminder,
} from "./prompt.js";
import { promptCacheProviderOptions, resolveModel } from "./providers.js";
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
 *
 * Phase 22 folds two things into this one loop: the observation policy
 * (elements by default, a frame on the conditions in "Observe" below) and the
 * planner/executor model-tier split with escalation (contracts/operator.md
 * §Model tiers). Both are pure additions over the Phase 21 shape — a run
 * started with `observe: "vision"` and a single `--model` exercises neither
 * and is the parity baseline tests compare against.
 */

/** How many observation frames stay in the model's context window. */
const MAX_RETAINED_IMAGES = 3;

/** How many rendered element-list observations stay in the model's context window. */
const MAX_RETAINED_ELEMENT_OBSERVATIONS = 3;

/** Downscale target for observation frames when the model doesn't ask for one. */
const DEFAULT_FRAME_MAX_WIDTH = 1280;

const OBSERVATION_FORMAT = "png" as const;

type Tier = "planner" | "executor";

/**
 * Test/daemon-only extension points. `RunOperator`'s public signature is fixed
 * by `@windower/core`, so these ride along on the options object and are read
 * structurally — production callers never set them.
 */
export interface OperatorRunInternals {
  /** Injected language model, bypassing the provider registry (tests). Applies to BOTH tiers when `languageModels` is absent — this is what makes single-`--model` parity mechanical to test. */
  languageModel?: LanguageModel;
  /** Injected per-tier language models (tests). Takes precedence over `languageModel` per tier. */
  languageModels?: { planner?: LanguageModel; executor?: LanguageModel };
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

/**
 * Phase 22 — the same pruning, generalized to the element-list observation
 * text. An element list from six steps ago is exactly as stale and useless as
 * a screenshot from six steps ago (contracts/operator.md §Observation
 * policy: "MUST NOT cache an element list between steps"). Elements messages
 * are tagged by content (`ELEMENTS_OBSERVATION_MARKER`) rather than tracked
 * by index, the same style `pruneObservationImages` already uses (scanning
 * for a `file` content part).
 */
function pruneObservationElements(messages: ModelMessage[]): void {
  const elementMessageIndexes: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message?.role !== "user" || !Array.isArray(message.content)) continue;
    const first = message.content[0];
    if (first?.type === "text" && first.text.startsWith(ELEMENTS_OBSERVATION_MARKER)) {
      elementMessageIndexes.push(i);
    }
  }
  const stale = elementMessageIndexes.slice(0, -MAX_RETAINED_ELEMENT_OBSERVATIONS);
  for (const index of stale) {
    messages[index] = {
      role: "user",
      content: [{ type: "text", text: "[earlier element list omitted from context]" }],
    };
  }
}

/** Wraps a system prompt string in an `Instructions` value carrying `cache_control` when the tier's provider supports it (`providers.ts`). Pure optimization — see `providers.ts`'s `promptCacheProviderOptions`. */
function buildInstructions(systemText: string, provider: string): Instructions {
  const providerOptions = promptCacheProviderOptions(provider);
  return providerOptions === undefined
    ? systemText
    : { role: "system", content: systemText, providerOptions };
}

/** A compact summary handed to the planner on escalation (contracts/operator.md §Model tiers: "compact run summary plus a fresh frame"). */
function buildEscalationSummary(params: {
  stepsUsed: number;
  plan?: OperatorPlan;
  checkpoint?: OperatorCheckpoint;
}): string {
  const lines = [
    "ESCALATION: the executor could not make the current plan work and control has returned to you, the planner.",
    `Steps used so far: ${params.stepsUsed}.`,
  ];
  if (params.plan !== undefined) {
    lines.push(
      `Current plan (revision ${params.plan.revision}):`,
      params.plan.steps.map((s, i) => `${i + 1}. ${s}`).join("\n"),
    );
  } else {
    lines.push("No plan has been recorded yet.");
  }
  if (params.checkpoint !== undefined) {
    lines.push(
      `Triggering checkpoint — expectation: "${params.checkpoint.expectation}", outcome: ${params.checkpoint.outcome}${params.checkpoint.detail === undefined ? "" : `, detail: "${params.checkpoint.detail}"`}`,
    );
  }
  lines.push("Revise the plan by calling `plan` again with a new plan that accounts for this.");
  return lines.join("\n");
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

  const observeMode = options.observe ?? "auto";

  const steps: OperatorStep[] = [];
  const run: OperatorRun = {
    id: options.runId,
    state: "running",
    task: options.task,
    // The resolved target this run drives — and the run's only notion of what
    // it is operating. There is no session or recording identifier to carry
    // alongside it (contracts/operator.md §Recording independence).
    target: options.target,
    models: options.models,
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
  /**
   * Distinct from `nextFrameMaxWidth`'s own value: a `screenshot` call with no
   * `maxWidth` arg sets the width override to `undefined`, which must not be
   * confused with "no screenshot was requested" — that would silently drop
   * the request under the observation policy's `auto` mode.
   */
  let screenshotRequested = false;
  let nextObserveElementsParams:
    | { role?: string; labelContains?: string; maxElements?: number }
    | undefined;
  /** Set by a `checkpoint` call with `visual: true` — forces a frame on the NEXT step. */
  let forceFrameNextStep = false;
  /** Local fallback when no authority (the daemon) is assigning revisions. */
  let nextLocalPlanRevision = 0;

  // Phase 22 model tiers/escalation state (contracts/operator.md §Model tiers).
  let currentTier: Tier = "planner";
  /**
   * Run-level sticky flag (bug fix): `enumerateElements` returning
   * `UNSUPPORTED_CAPABILITY`, or the target not being a window, are both
   * run-invariant conditions — a capability a sidecar doesn't advertise
   * doesn't start advertising it mid-run, and a target's kind doesn't change.
   * Once true, it stays true for the rest of the run: the five element tools
   * are removed from both tiers' surfaces (`buildToolSet`) for every
   * remaining step, rather than staying present-but-unusable and inviting a
   * real model to fabricate a ref. Distinct from the per-step
   * `elementsInsufficient` below, which is legitimately transient and does
   * NOT gate the tool surface.
   */
  let elementsUnsupportedForRun = false;
  /** Consecutive `failed-plan-sound` checkpoints since the current plan was (re)issued — the runtime's proxy for "same plan step", since plan steps are natural language and never tracked mechanically (YAGNI: no deterministic plan compiler). Two in a row escalates. */
  let consecutiveFailedPlanSound = 0;
  let replansUsed = 0;

  try {
    const plannerModelConfig = options.models.planner;
    const executorModelConfig = options.models.executor ?? options.models.planner;

    const plannerModel: LanguageModel =
      internals.languageModels?.planner ??
      internals.languageModel ??
      resolveModel(plannerModelConfig, options.env);
    const executorModel: LanguageModel =
      internals.languageModels?.executor ??
      internals.languageModel ??
      resolveModel(executorModelConfig, options.env);

    const secretNames =
      options.secrets.length > 0
        ? options.secrets.map((s) => s.name)
        : (internals.secretNames ?? []);

    const plannerSystem = buildSystemPrompt({
      task: options.task,
      secretNames,
      maxSteps: options.maxSteps,
      timeoutMs: options.timeoutMs,
      maxBatchActions: options.maxBatchActions,
      unbounded: options.unbounded,
      bounds: options.bounds,
    });
    const executorSystem = buildExecutorSystemPrompt({
      task: options.task,
      secretNames,
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
        screenshotRequested = true;
        nextFrameMaxWidth = maxWidth;
      },
      onObserveElementsRequest: (params) => {
        nextObserveElementsParams = params;
      },
    };

    logger.log("run started", {
      runId: options.runId,
      planner: formatModelConfig(plannerModelConfig),
      executor: formatModelConfig(executorModelConfig),
      observe: observeMode,
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

      const tier: Tier = currentTier;

      // ── Observe ──────────────────────────────────────────────────────────
      const observations: ObservationRef[] = [];
      let elements: UIElement[] | undefined;
      let elementsTruncated = false;
      let elementsUnsupported = false;

      // display/region targets have no AX tree of their own — enumerateElements
      // would fail TARGET_NOT_FOUND on every step, so treat that the same as a
      // capability-absent sidecar (elementsUnsupported) rather than calling an
      // RPC known to fail and rethrowing a terminal error.
      if (observeMode !== "vision" && options.target.kind !== "window") {
        elementsUnsupported = true;
      } else if (observeMode !== "vision") {
        try {
          const result = await deps.enumerateElements({
            filter: "interactable",
            maxElements: nextObserveElementsParams?.maxElements,
          });
          let filtered = result.elements;
          const role = nextObserveElementsParams?.role;
          const labelContains = nextObserveElementsParams?.labelContains?.toLowerCase();
          if (role !== undefined) filtered = filtered.filter((e) => e.role === role);
          if (labelContains !== undefined) {
            filtered = filtered.filter((e) => e.label?.toLowerCase().includes(labelContains));
          }
          elements = filtered;
          elementsTruncated = result.truncated;
        } catch (err) {
          const opErr = toOperatorError(err, OPERATOR_ERROR_CODES.DEPENDENCY_ERROR);
          if (opErr.code === "UNSUPPORTED_CAPABILITY") {
            elementsUnsupported = true;
          } else {
            throw opErr;
          }
        }
      }
      nextObserveElementsParams = undefined;

      // Sticky for the rest of the run (bug fix, see `elementsUnsupportedForRun`'s
      // declaration): capability-absent and non-window-target are both
      // run-invariant, so once true this step it can never become false on a
      // later one.
      elementsUnsupportedForRun = elementsUnsupportedForRun || elementsUnsupported;

      const elementsInsufficient =
        elements !== undefined && elements.length < MIN_USEFUL_ELEMENT_COUNT;
      const wantsFrame =
        observeMode === "vision" ||
        (observeMode === "auto" &&
          (elementsUnsupported ||
            screenshotRequested ||
            elementsInsufficient ||
            tier === "planner" ||
            forceFrameNextStep));
      forceFrameNextStep = false;

      if (elements !== undefined) {
        const elementsRef = await writer.writeElements(elements);
        observations.push({ kind: "elements", ref: elementsRef });
        messages.push({
          role: "user",
          content: [
            {
              type: "text",
              text: renderElementsAsText(elements, { truncatedByServer: elementsTruncated }),
            },
          ],
        });
      }

      if (wantsFrame) {
        let frame: Awaited<ReturnType<OperatorDeps["captureFrame"]>>;
        try {
          frame = await deps.captureFrame({
            format: OBSERVATION_FORMAT,
            maxWidth: nextFrameMaxWidth ?? DEFAULT_FRAME_MAX_WIDTH,
          });
        } catch (err) {
          throw toOperatorError(err, OPERATOR_ERROR_CODES.DEPENDENCY_ERROR);
        }
        const frameRef = await writer.writeFrame(frame.imageBase64, OBSERVATION_FORMAT);
        observations.push({ kind: "frame", ref: frameRef });
        const frameText = `Observation ${index + 1}/${options.maxSteps} — ${frame.width}x${frame.height} px (scale ${frame.scale}).`;
        // Bug fix: tell the model outright that element tools are gone this
        // run, rather than leaving it to infer that from a missing element
        // list. `elementsUnsupportedForRun` is sticky, so this note appears on
        // every frame observation for the rest of the run once it's true.
        const unavailableNote = elementsUnsupportedForRun
          ? " Accessibility elements are unavailable for this run — click_element/double_click_element/type_into_element/scroll_element/observe_elements are not offered; use the pixel-based click/double_click/drag/scroll/type_text/move_mouse tools against this image instead."
          : "";
        messages.push({
          role: "user",
          content: [
            {
              type: "text",
              text: frameText + unavailableNote,
            },
            { type: "file", data: frame.imageBase64, mediaType: "image/png" },
          ],
        });
      }
      nextFrameMaxWidth = undefined;
      screenshotRequested = false;

      if (observations.length === 0) {
        // Only reachable with `--observe ax` against a backend that doesn't
        // advertise `ui.elements` at all — a caller misconfiguration, not the
        // normal degradation path (that's `elementsUnsupported` under
        // `"auto"`, which forces a frame above). There is no percept to give
        // the model; say so rather than sending an empty turn.
        messages.push({
          role: "user",
          content: [
            {
              type: "text",
              text: "No observation is available this step: accessibility elements are unsupported on this target and --observe ax does not fall back to a screenshot.",
            },
          ],
        });
      }

      pruneObservationImages(messages);
      pruneObservationElements(messages);

      // ── Decide ───────────────────────────────────────────────────────────
      if (options.signal.aborted) {
        throw new OperatorError(OPERATOR_ERROR_CODES.ABORTED, "Operator run aborted.");
      }
      const model = tier === "planner" ? plannerModel : executorModel;
      const system = tier === "planner" ? plannerSystem : executorSystem;
      // Built per step rather than once up front: `elementsUnsupportedForRun`
      // is only known after the first observation, and once it flips true the
      // five element tools drop out of both tiers' surfaces for the rest of
      // the run (bug fix — see the flag's declaration above).
      const tools = buildToolSet(tier, !elementsUnsupportedForRun);
      const provider =
        tier === "planner" ? plannerModelConfig.provider : executorModelConfig.provider;

      const combined = combineSignals(options.signal, deadline.remainingMs());
      let modelResult: Awaited<ReturnType<typeof generateText>>;
      try {
        modelResult = await generateText({
          model,
          instructions: buildInstructions(system, provider),
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

      const stepBase = { index, observations, reasoning, tMs: deadline.elapsedMs() };

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
        if (!isOperatorToolName(toolName) || (tier === "executor" && toolName === "plan")) {
          // Cannot happen with a well-behaved provider; refuse rather than guess.
          // The `plan` case covers a provider that ignores the executor's
          // narrower tool list and emits it anyway — the runtime is what
          // makes "executor never plans" structural, not just a smaller schema.
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

      // ── Model tiers: escalation (contracts/operator.md §Model tiers) ──────
      // Only the planner may create/revise a plan; a plan this turn always
      // hands control back to the executor. Escalation edges, exhaustively: a
      // `failed-plan-invalid` checkpoint, or a second consecutive
      // `failed-plan-sound` on the executor's watch.
      //
      // Deciding to escalate must NOT push a message yet: the assistant's
      // tool-call message was already appended above, and a well-formed
      // conversation requires its matching "tool" role tool-result message to
      // be the very next one — an escalation-summary "user" message pushed
      // here would land between them and fail provider-side validation. The
      // summary is queued and pushed after the tool-result block below.
      let escalationSummary: string | undefined;
      if (stepPlan !== undefined) {
        currentTier = "executor";
        consecutiveFailedPlanSound = 0;
      } else if (stepCheckpoint !== undefined) {
        if (stepCheckpoint.visual === true) forceFrameNextStep = true;
        if (stepCheckpoint.outcome === "held") {
          consecutiveFailedPlanSound = 0;
        } else if (stepCheckpoint.outcome === "failed-plan-sound") {
          consecutiveFailedPlanSound += 1;
        }
        const escalate =
          tier === "executor" &&
          (stepCheckpoint.outcome === "failed-plan-invalid" || consecutiveFailedPlanSound >= 2);
        if (escalate) {
          replansUsed += 1;
          if (replansUsed > options.maxReplans) {
            throw new OperatorError(
              OPERATOR_ERROR_CODES.MAX_REPLANS_EXCEEDED,
              `Operator run exceeded its ${options.maxReplans}-replan budget without converging.`,
            );
          }
          currentTier = "planner";
          consecutiveFailedPlanSound = 0;
          escalationSummary = buildEscalationSummary({
            stepsUsed: steps.length,
            plan: run.plan,
            checkpoint: stepCheckpoint,
          });
        }
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

      if (escalationSummary !== undefined) {
        messages.push({ role: "user", content: [{ type: "text", text: escalationSummary }] });
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
