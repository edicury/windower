import type { CaptureTarget } from "../schemas/capture-target.js";
import type { InputAction } from "../schemas/input-action.js";
import type { OperatorModels, OperatorRunState, OperatorStep } from "../schemas/operator.js";
import type { Rect } from "../schemas/rect.js";
import type { UIElement } from "../schemas/ui-element.js";

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
 * `enumerateTargets`, `resizeWindow`, `enumerateElements`) and
 * capability-gated behavior, never an OS branch (CLAUDE.md §protocol before
 * platform).
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
  /**
   * Phase 22 — compact interactable accessibility-element list for the run's
   * target. Control-surface, capture-free: makes no captureFrame-equivalent
   * call and takes no `~/.windower/capture.lock`. `refs` re-reads exactly
   * those elements' current attributes/bounds (the freshness path a
   * re-resolve-before-act uses) instead of walking the tree.
   */
  enumerateElements(params: {
    refs?: string[];
    filter?: "interactable" | "all";
    maxDepth?: number;
    maxElements?: number;
  }): Promise<{ elements: UIElement[]; generation: string; truncated: boolean }>;
}

export interface OperatorRunOptions {
  runId: string;
  task: string;
  /**
   * Phase 22 — two model tiers (contracts/operator.md §Model tiers).
   * `executor` defaults to `planner` wherever it is resolved. The CLI/MCP
   * boundary accepts a bare `ModelConfig` too and normalizes it inward via
   * `normalizeOperatorModels` before it ever reaches this package — this type
   * only ever sees the tiered shape.
   */
  models: OperatorModels;
  /** Already resolved from env/keychain/literal by the daemon. */
  secrets: ResolvedSecret[];
  /** Guardrail; `DEFAULT_OPERATOR_MAX_STEPS` applied by the caller. */
  maxSteps: number;
  /** Guardrail; `DEFAULT_OPERATOR_TIMEOUT_MS` applied by the caller. */
  timeoutMs: number;
  /**
   * Guardrail; `DEFAULT_OPERATOR_MAX_BATCH_ACTIONS` (8) applied by the caller.
   * Bounds how many *action* tool calls (`performInput`/`resizeWindow`) one
   * step may execute — observations don't count. Exceeding it is
   * `OPERATOR_BATCH_LIMIT_EXCEEDED` and is NOT run-terminating: the remaining
   * actions are recorded as `BATCH_ABORTED_RESULT` and the step closes
   * normally (contracts/operator.md §Action batching).
   */
  maxBatchActions: number;
  /**
   * Phase 22 guardrail; `DEFAULT_OPERATOR_MAX_REPLANS` (3) applied by the
   * caller. Bounds how many times the planner may re-enter and emit a new
   * plan revision. Exceeding it is `OPERATOR_MAX_REPLANS_EXCEEDED` and IS
   * run-terminating (contracts/operator.md §Guardrails).
   */
  maxReplans: number;
  /**
   * Phase 22 — `"auto"` (default: elements, falling back to a frame per the
   * observation policy), `"ax"` (never capture a frame), or `"vision"`
   * (always capture a frame, never read elements — pre-Phase-22 parity
   * baseline). Applied by the caller; `packages/operator` treats an absent
   * value as `"auto"`.
   */
  observe?: "auto" | "ax" | "vision";
  /** `--unbounded`: disables the target-bounds coordinate clamp. */
  unbounded: boolean;
  /**
   * The resolved target this run operates — the same selector shape
   * `start_recording` takes, already resolved through `enumerateTargets`
   * (contracts/operator.md §Inputs). It is the run's *only* notion of what it
   * is driving: a run carries no recording or session identifier of any kind,
   * and behaves identically whether the screen is being recorded or not
   * (contracts/operator.md §Recording independence).
   */
  target: CaptureTarget;
  /** The operator's own target's rect — coordinate clamp source when `!unbounded`. */
  bounds?: Rect;
  /**
   * Where to write the run's transcript —
   * `~/.windower/operator-runs/<runId>/transcript.json`, with observation
   * frames in `~/.windower/operator-runs/<runId>/frames/`. Operator-owned
   * storage: it is never written next to a video file, because locating one
   * would require knowing a recording exists (contracts/operator.md
   * §Transcript format).
   */
  transcriptPath?: string;
  /** Kill switch — `abort_operator_run` / `windower operate abort <runId>`. */
  signal: AbortSignal;
  /** Called per completed step; the caller persists it. */
  onStep?: (step: OperatorStep) => void | Promise<void>;
  /**
   * Environment `resolveModel` reads the model's API-key var from. Defaults
   * to `process.env` inside `packages/operator` when omitted (tests / the
   * blocking `operate` in-process path, which runs in the caller's own
   * process already). Daemon-backed runs (`operate --detach`, MCP's
   * `run_operator`) must set this to a **snapshot** of the connection's
   * `hello` env — never a live reference — since a detached run outlives the
   * connection that started it (phase-20-daemon-optional.md "Daemon
   * lifecycle hardening"). This is what makes `resolveModel` see the
   * *caller's* key instead of the daemon process's own frozen environment.
   */
  env?: NodeJS.ProcessEnv;
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
