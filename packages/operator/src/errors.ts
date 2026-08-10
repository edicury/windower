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
  /**
   * One turn emitted more action tool calls than `maxBatchActions` allows
   * (contracts/operator.md §Action batching). Deliberately **non-terminal**:
   * the over-limit action and everything after it are skipped, the step closes,
   * and the run continues — an over-long batch is a model mistake worth
   * correcting, not worth ending the run over.
   */
  BATCH_LIMIT_EXCEEDED: "OPERATOR_BATCH_LIMIT_EXCEEDED",
} as const;

export type OperatorErrorCode = (typeof OPERATOR_ERROR_CODES)[keyof typeof OPERATOR_ERROR_CODES];

/**
 * Errors that abort the rest of a batch but **not** the run
 * (contracts/operator.md §"Batch failure semantics", row "Run continuation").
 *
 * Everything not listed here is terminal, which is the safe default: batching
 * MUST NOT convert a terminal guardrail failure into a recoverable one, so the
 * classifier is an allowlist of known-recoverable codes rather than a denylist
 * of known-fatal ones. The proxied-surface codes below arrive verbatim from the
 * capture/control surface (in-process via `OperatorDeps`, or over
 * contracts/operator-loop-protocol.md as a JSON-RPC `data.code`).
 */
export const NON_TERMINAL_OPERATOR_ERROR_CODES: readonly string[] = [
  "TARGET_NOT_FOUND",
  "RESIZE_UNSUPPORTED",
  "CAPTURE_FAILED",
  "UNSUPPORTED_CAPABILITY",
  "INPUT_UNSUPPORTED",
  OPERATOR_ERROR_CODES.BATCH_LIMIT_EXCEEDED,
];

/** True when an error code ends the run (as opposed to just the batch). */
export function isTerminalOperatorErrorCode(code: string): boolean {
  return !NON_TERMINAL_OPERATOR_ERROR_CODES.includes(code);
}

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
  // A rejected `OperatorDeps` call may carry the proxied surface's own code —
  // that is what lets `isTerminalOperatorErrorCode` tell a `RESIZE_UNSUPPORTED`
  // (abort the batch, keep the run) from an `INPUT_OUT_OF_BOUNDS` (end the run)
  // without the loop having to know which transport produced it.
  const carried = (err as { code?: unknown } | null)?.code;
  if (typeof carried === "string" && carried.length > 0) {
    return new OperatorError(carried, message);
  }
  return new OperatorError(fallbackCode, message);
}
