import { z } from "zod";

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

// ---- OperatorStep ----

/** One tool invocation the model made within a step. */
export const OperatorToolCallSchema = z.object({
  name: z.string(),
  /** Secrets already redacted to `{{name}}` placeholders before persistence. */
  args: z.unknown(),
  result: z.unknown().optional(),
});
export type OperatorToolCall = z.infer<typeof OperatorToolCallSchema>;

/** One perceive → decide → act cycle within an `OperatorRun`. */
export const OperatorStepSchema = z.object({
  index: z.number().int().nonnegative(),
  /** Reference to the captured frame this step reasoned over (path or handle). */
  observationRef: z.string(),
  toolCalls: z.array(OperatorToolCallSchema),
  /** Model's stated rationale, when the provider exposes one. */
  reasoning: z.string().optional(),
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
  /** Present when recording was not disabled — the RecordingSession this run drives. */
  sessionId: z.string().optional(),
  steps: z.array(OperatorStepSchema),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  /** Full reasoning/tool-call transcript, written next to the recording if any. */
  transcriptPath: z.string().optional(),
});
export type OperatorRun = z.infer<typeof OperatorRunSchema>;

// ---- Guardrails ----

/** contracts/operator.md §Guardrails — defaults enforced by the runtime, not the prompt. */
export const DEFAULT_OPERATOR_MAX_STEPS = 40;
export const DEFAULT_OPERATOR_TIMEOUT_MS = 300_000;

export const OperatorGuardrailsSchema = z.object({
  maxSteps: z.number().int().positive().optional(),
  timeoutSeconds: z.number().positive().optional(),
  unbounded: z.boolean().optional(),
});
export type OperatorGuardrails = z.infer<typeof OperatorGuardrailsSchema>;
