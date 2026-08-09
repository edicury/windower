import type { CaptureTarget } from "../schemas/capture-target.js";
import type { InputAction } from "../schemas/input-action.js";
import type { ModelConfig, OperatorRunState, OperatorStep } from "../schemas/operator.js";
import type { Rect } from "../schemas/rect.js";

/**
 * The integration seam between the daemon (which owns sidecar/session state and
 * disk persistence) and `packages/operator` (which owns the observe → decide →
 * act loop). Both sides import these types from `@windower/core` so the
 * contract can't drift.
 *
 * `runOperator(options, deps) => Promise<OperatorRunResult>` lives in
 * `packages/operator`; core owns only the types.
 *
 * Nothing here is platform-specific: `OperatorDeps` is expressed purely in
 * terms of sidecar protocol methods (`captureFrame`, `performInput`,
 * `enumerateTargets`, `resizeWindow`) and capability-gated behavior, never
 * an OS branch (CLAUDE.md §protocol before platform).
 */

/** A `SecretRef` after resolution from env/keychain/literal by the daemon. */
export interface ResolvedSecret {
  name: string;
  value: string;
}

export interface OperatorDeps {
  captureFrame(params: {
    format: "png" | "jpeg";
    maxWidth?: number;
    quality?: number;
  }): Promise<{ imageBase64: string; width: number; height: number; scale: number }>;
  performInput(actions: InputAction[]): Promise<{ performed: number }>;
  listTargets(kinds?: Array<"display" | "window" | "app">): Promise<CaptureTarget[]>;
  resizeWindow(
    targetId: string,
    bounds: Rect,
  ): Promise<{ actualBounds: Rect; result: "success" | "partial" | "unsupported" }>;
}

export interface OperatorRunOptions {
  runId: string;
  task: string;
  model: ModelConfig;
  /** Already resolved from env/keychain/literal by the daemon. */
  secrets: ResolvedSecret[];
  /** Guardrail; `DEFAULT_OPERATOR_MAX_STEPS` applied by the caller. */
  maxSteps: number;
  /** Guardrail; `DEFAULT_OPERATOR_TIMEOUT_MS` applied by the caller. */
  timeoutMs: number;
  /** `--unbounded`: disables the target-bounds coordinate clamp. */
  unbounded: boolean;
  /** The recorded target's rect — coordinate clamp source when `!unbounded`. */
  bounds?: Rect;
  /** Where to write `<recording>.operator.json`; frames go next to it. */
  transcriptPath?: string;
  /** Kill switch — `abort_operator_run` / `windower operate abort <runId>`. */
  signal: AbortSignal;
  /** Called per completed step; the caller persists it. */
  onStep?: (step: OperatorStep) => void | Promise<void>;
}

export interface OperatorRunResult {
  state: OperatorRunState;
  steps: OperatorStep[];
  summary?: string;
  error?: { code: string; message: string };
}

/** The signature `packages/operator` exports as `runOperator`. */
export type RunOperator = (
  options: OperatorRunOptions,
  deps: OperatorDeps,
) => Promise<OperatorRunResult>;
