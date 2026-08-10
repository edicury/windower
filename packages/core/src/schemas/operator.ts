import { z } from "zod";
import { CaptureTargetSchema } from "./capture-target.js";

/**
 * Operator schemas (Phase 19) — `OperatorRun`, `OperatorStep`, `SecretRef`,
 * `ModelConfig`. See data-model.md §OperatorRun/§OperatorStep/§SecretRef/
 * §ModelConfig and contracts/operator.md.
 *
 * `OperatorRun` is deliberately parallel in shape to `RecordingSession`
 * (schemas/session.ts) so the daemon's `OperatorRunManager` can reuse
 * `SessionManager`'s persist-on-every-transition pattern
 * (`~/.windower/operator-runs/<id>.json`).
 */

// ---- SecretRef ----

export const SecretSourceSchema = z.enum(["env", "keychain", "literal"]);
export type SecretSource = z.infer<typeof SecretSourceSchema>;

/**
 * A *reference* to a credential — never the credential's value (except the
 * discouraged `literal` source). Resolved at call time inside
 * `packages/operator`; never persisted, never logged, never sent to the model.
 */
export const SecretRefSchema = z.object({
  /** Placeholder name substituted into `task`, e.g. "password" for "{{password}}". */
  name: z.string().min(1),
  source: SecretSourceSchema,
  /** Env var name, keychain item name, or (discouraged) the literal value itself. */
  ref: z.string(),
});
export type SecretRef = z.infer<typeof SecretRefSchema>;

/**
 * `--secret <name>=<source>:<ref>` (contracts/cli.md `windower operate`).
 * `<ref>` may itself contain `:` (e.g. a URL), so only the first colon after
 * the source is a separator.
 */
export function parseSecretRef(spec: string): SecretRef {
  const eq = spec.indexOf("=");
  if (eq <= 0) {
    throw new Error(`Invalid --secret "${spec}": expected <name>=<source>:<ref>`);
  }
  const name = spec.slice(0, eq);
  const rest = spec.slice(eq + 1);
  const colon = rest.indexOf(":");
  if (colon <= 0) {
    throw new Error(`Invalid --secret "${spec}": expected <name>=<source>:<ref>`);
  }
  const source = rest.slice(0, colon);
  const ref = rest.slice(colon + 1);
  return SecretRefSchema.parse({ name, source, ref });
}

// ---- ModelConfig ----

/**
 * Selects the LLM the operator's own reasoning loop uses — independent of
 * whatever model drives the calling agent/harness. Provider dispatch is a thin
 * layer over the Vercel AI SDK, so swapping this config swaps the model with
 * zero code change (contracts/operator.md §Model configuration).
 */
export const ModelConfigSchema = z.object({
  /** e.g. "anthropic" | "openai" | "openai-compatible" | ... */
  provider: z.string().min(1),
  /** Provider-specific model id. */
  model: z.string().min(1),
  /** Override, e.g. a local Ollama/LM Studio server for "openai-compatible". */
  baseUrl: z.string().optional(),
  /** Env var to read the API key from — never the key itself. */
  apiKeyEnvVar: z.string().optional(),
});
export type ModelConfig = z.infer<typeof ModelConfigSchema>;

/**
 * Parses the `--model <provider>:<model>` string form
 * (e.g. `anthropic:claude-sonnet-5`, `openai-compatible:llama-3.3`).
 *
 * Split on the **first** colon only: provider ids never contain `:`, model ids
 * routinely do (`ollama`-style `llama3:8b`), so everything after the first
 * colon is the model id.
 */
export function parseModelConfig(
  spec: string,
  extra: Omit<Partial<ModelConfig>, "provider" | "model"> = {},
): ModelConfig {
  const colon = spec.indexOf(":");
  if (colon <= 0 || colon === spec.length - 1) {
    throw new Error(`Invalid --model "${spec}": expected <provider>:<model>`);
  }
  return ModelConfigSchema.parse({
    provider: spec.slice(0, colon),
    model: spec.slice(colon + 1),
    ...extra,
  });
}

/** Inverse of `parseModelConfig` — the `provider:model` display/config form. */
export function formatModelConfig(config: ModelConfig): string {
  return `${config.provider}:${config.model}`;
}

// ---- OperatorPlan ----

/**
 * One revision of the run's action plan (Phase 21 — contracts/operator.md
 * §"Execution model — plan → execute → verify", data-model.md §OperatorPlan).
 *
 * The model produces it by calling the `plan` tool; the daemon owns its
 * *identity* (`revision`, `atStepIndex`, `tMs`) while the model supplies only
 * its *content* (`steps`, `rationale`), so a plan revision can't be
 * renumbered, backdated, or edited in place. Plan steps are one line of
 * natural-language intent each and are never dispatched mechanically.
 */
export const OperatorPlanSchema = z.object({
  /** 0 for the initial plan, +1 per replan; never reused, never edited in place. */
  revision: z.number().int().nonnegative(),
  /** Ordered, one concise line of intent per planned step. */
  steps: z.array(z.string()),
  /** Why this plan (or, on a replan, what invalidated the previous one). */
  rationale: z.string().optional(),
  /** Index of the step whose turn produced this revision. */
  atStepIndex: z.number().int().nonnegative(),
  /** ms since run start. */
  tMs: z.number(),
});
export type OperatorPlan = z.infer<typeof OperatorPlanSchema>;

// ---- OperatorStep ----

/**
 * The literal `result` recorded for an action the loop never issued because an
 * earlier action in the same batch failed or the batch hit `maxBatchActions`
 * (contracts/operator.md §"Batch failure semantics"). A skipped action stays a
 * row in `toolCalls` — never a missing one — so "ran / failed / never ran" is
 * stated rather than inferred from array length.
 */
export const BATCH_ABORTED_RESULT = { skipped: "BATCH_ABORTED" } as const;

export const BatchAbortedResultSchema = z.object({
  skipped: z.literal("BATCH_ABORTED"),
});
export type BatchAbortedResult = z.infer<typeof BatchAbortedResultSchema>;

/** One tool invocation the model made within a step. */
export const OperatorToolCallSchema = z.object({
  name: z.string(),
  /** Secrets already redacted to `{{name}}` placeholders before persistence. */
  args: z.unknown(),
  /**
   * The action's real result, `{ error: { code, message } }` for the action
   * that failed, or `BATCH_ABORTED_RESULT` for every action after it.
   */
  result: z.unknown().optional(),
});
export type OperatorToolCall = z.infer<typeof OperatorToolCallSchema>;

/**
 * The outcome of checking an executed batch against what the plan expected at
 * that point (`contracts/operator.md` §Execution model). Exactly three, and the
 * distinction matters: the runtime cannot derive `held` vs `failed-plan-sound`
 * on its own — only the turn that observed the screen knows whether the
 * expectation was met.
 */
export const OperatorCheckpointOutcomeSchema = z.enum([
  "held",
  "failed-plan-sound",
  "failed-plan-invalid",
]);
export type OperatorCheckpointOutcome = z.infer<typeof OperatorCheckpointOutcomeSchema>;

export const OperatorCheckpointSchema = z.object({
  /** What the plan expected to be true after this batch. */
  expectation: z.string(),
  outcome: OperatorCheckpointOutcomeSchema,
  /** Optional elaboration — what was observed instead, typically. */
  detail: z.string().optional(),
});
export type OperatorCheckpoint = z.infer<typeof OperatorCheckpointSchema>;

/** One perceive → decide → act cycle within an `OperatorRun`. */
export const OperatorStepSchema = z.object({
  index: z.number().int().nonnegative(),
  /** Reference to the captured frame this step reasoned over (path or handle). */
  observationRef: z.string(),
  toolCalls: z.array(OperatorToolCallSchema),
  /** Model's stated rationale, when the provider exposes one. */
  reasoning: z.string().optional(),
  /**
   * Set only on a step whose turn called `plan`. The ordered `step.plan`
   * values across the transcript *are* the full plan history — there is no
   * second history array to keep in sync.
   */
  plan: OperatorPlanSchema.optional(),
  /**
   * The verification this step's batch was checked against, per
   * `contracts/operator.md` §Execution model. Optional: a step that executed
   * no batch (the opening observe-and-plan turn, say) verifies nothing.
   *
   * The three outcomes are exhaustive and load-bearing — only
   * `failed-plan-invalid` is a replan; `failed-plan-sound` means retry or
   * adjust within the current plan.
   */
  checkpoint: OperatorCheckpointSchema.optional(),
  /** ms since run start. */
  tMs: z.number(),
});
export type OperatorStep = z.infer<typeof OperatorStepSchema>;

// ---- OperatorRun ----

export const OperatorRunStateSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
  "aborted",
  "timed_out",
]);
export type OperatorRunState = z.infer<typeof OperatorRunStateSchema>;

/** Terminal states — a run in one of these will never transition again. */
export const TERMINAL_OPERATOR_RUN_STATES = [
  "succeeded",
  "failed",
  "aborted",
  "timed_out",
] as const satisfies readonly OperatorRunState[];

export function isTerminalOperatorRunState(state: OperatorRunState): boolean {
  return (TERMINAL_OPERATOR_RUN_STATES as readonly OperatorRunState[]).includes(state);
}

export const OperatorRunSchema = z.object({
  id: z.string(),
  state: OperatorRunStateSchema,
  /** The natural-language instruction. */
  task: z.string(),
  model: ModelConfigSchema,
  /**
   * The resolved target this run operates — the same selector shape
   * `start_recording` takes (`CaptureTarget`), resolved through
   * `enumerateTargets` exactly as capture does. An `OperatorRun` carries no
   * recording or session identifier of any kind (contracts/operator.md
   * §Recording independence, §Transcript format).
   */
  target: CaptureTargetSchema,
  /**
   * The CURRENT (highest-revision) plan; absent until the first `plan` call.
   * Redundant with the last `step.plan` by construction — it exists so a
   * consumer polling `get_operator_run` reads the current plan without walking
   * the transcript.
   */
  plan: OperatorPlanSchema.optional(),
  steps: z.array(OperatorStepSchema),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  /**
   * The `done`/`fail` summary — the run's own statement of what it
   * accomplished or why it stopped, persisted on the terminal transition so a
   * consumer polling `get_operator_run` reads the outcome's payload without
   * subscribing to anything (contracts/operator.md §"How they surface").
   *
   * Optional, in two directions: a crashed run (`OPERATOR_LOOP_CRASHED`) died
   * without reporting one and MUST NOT have one fabricated for it, and an
   * older on-disk record written before this field existed still parses.
   */
  summary: z.string().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  /**
   * Full reasoning/tool-call transcript, written to operator-owned storage:
   * `~/.windower/operator-runs/<runId>/transcript.json`, with observation
   * frames in `~/.windower/operator-runs/<runId>/frames/`. Never next to a
   * video file, and no `OutputManifest` field points at it
   * (contracts/operator.md §Transcript format).
   */
  transcriptPath: z.string().optional(),
});
export type OperatorRun = z.infer<typeof OperatorRunSchema>;

// ---- Guardrails ----

/** contracts/operator.md §Guardrails — defaults enforced by the runtime, not the prompt. */
export const DEFAULT_OPERATOR_MAX_STEPS = 40;
export const DEFAULT_OPERATOR_TIMEOUT_MS = 300_000;
/**
 * contracts/operator.md §Action batching — how many *action* tool calls
 * (`performInput`/`resizeWindow`; observations don't count) one step may
 * execute. Exceeding it is `OPERATOR_BATCH_LIMIT_EXCEEDED` and is NOT
 * run-terminating.
 */
export const DEFAULT_OPERATOR_MAX_BATCH_ACTIONS = 8;

export const OperatorGuardrailsSchema = z.object({
  maxSteps: z.number().int().positive().optional(),
  timeoutSeconds: z.number().positive().optional(),
  /** `--max-batch <n>`; `DEFAULT_OPERATOR_MAX_BATCH_ACTIONS` when omitted. */
  maxBatchActions: z.number().int().positive().optional(),
  unbounded: z.boolean().optional(),
});
export type OperatorGuardrails = z.infer<typeof OperatorGuardrailsSchema>;
