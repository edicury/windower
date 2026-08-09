/**
 * Structured operator errors. Codes reuse the sidecar protocol's error
 * taxonomy where one already exists (`INPUT_OUT_OF_BOUNDS`) — see
 * contracts/operator.md §Guardrails.
 */

export const OPERATOR_ERROR_CODES = {
  /** A coordinate fell outside the recorded target's Rect on a bounded run. */
  INPUT_OUT_OF_BOUNDS: "INPUT_OUT_OF_BOUNDS",
  /** `maxSteps` exhausted without the model calling `done`. */
  MAX_STEPS_EXCEEDED: "OPERATOR_MAX_STEPS_EXCEEDED",
  /** Wall-clock `timeoutMs` elapsed. */
  TIMEOUT: "OPERATOR_TIMEOUT",
  /** `options.signal` fired (kill switch). */
  ABORTED: "OPERATOR_ABORTED",
  /** The model called the `fail` tool. */
  MODEL_FAILED: "OPERATOR_MODEL_FAILED",
  /** The model call itself failed (auth, transport, provider error). */
  MODEL_ERROR: "OPERATOR_MODEL_ERROR",
  /** An unknown `provider:` prefix in the model config. */
  UNKNOWN_PROVIDER: "OPERATOR_UNKNOWN_PROVIDER",
  /** The provider's API key env var is unset. */
  MISSING_API_KEY: "OPERATOR_MISSING_API_KEY",
  /** A tool call's arguments failed schema validation. */
  INVALID_TOOL_INPUT: "OPERATOR_INVALID_TOOL_INPUT",
  /** A `deps` (sidecar/daemon) call rejected. */
  DEPENDENCY_ERROR: "OPERATOR_DEPENDENCY_ERROR",
} as const;

export type OperatorErrorCode = (typeof OPERATOR_ERROR_CODES)[keyof typeof OPERATOR_ERROR_CODES];

export class OperatorError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "OperatorError";
    this.code = code;
  }
}

export function toOperatorError(err: unknown, fallbackCode: string): OperatorError {
  if (err instanceof OperatorError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new OperatorError(fallbackCode, message);
}
