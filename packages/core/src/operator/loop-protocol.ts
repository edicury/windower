import { z } from "zod";
import {
  CaptureFrameResultSchema,
  PerformInputResultSchema,
  ResizeWindowResultSchema,
} from "../protocol/methods.js";
import { CaptureTargetSchema } from "../schemas/capture-target.js";
import { InputActionSchema } from "../schemas/input-action.js";
import {
  ModelConfigSchema,
  OperatorRunStateSchema,
  OperatorStepSchema,
} from "../schemas/operator.js";
import { RectSchema } from "../schemas/rect.js";

/**
 * The daemon ↔ operator-loop-child JSON-RPC surface —
 * contracts/operator-loop-protocol.md (Phase 21). This lives in core for the
 * same reason `operator/types.ts` does: it is the seam between `apps/daemon`
 * (which serves it) and `packages/operator`'s loop entry point (which speaks
 * it), and neither may import the other.
 *
 * It re-uses `data-model.md`'s types verbatim (`OperatorStep`, `InputAction`,
 * `Rect`, `CaptureTarget`, `ModelConfig`) and does not redefine them. Nothing
 * here is platform-specific — every OS/permission decision has already been
 * made on the daemon side before a proxied call reaches this protocol
 * (CLAUDE.md §protocol before platform).
 *
 * The channel is bidirectional: `OPERATOR_LOOP_CHILD_METHODS` are sent
 * child → daemon, `OPERATOR_LOOP_DAEMON_METHODS` daemon → child. Each side
 * numbers its own request ids.
 */

/**
 * Bumped on any wire-incompatible change. An **assertion, not a negotiation**
 * — both ends always ship from the same installed package version, so a
 * mismatch is a broken install and fails the run with
 * `LOOP_PROTOCOL_VERSION_MISMATCH` rather than degrading to a smaller method
 * set (contracts/operator-loop-protocol.md §No capability negotiation).
 */
export const LOOP_PROTOCOL_VERSION = 1;

/** Grace/timeout defaults from contracts/operator-loop-protocol.md §Shutdown. */
export const LOOP_PING_TIMEOUT_MS = 30_000;
export const LOOP_EXIT_GRACE_MS = 2_000;
export const LOOP_ABORT_GRACE_MS = 5_000;

// ---- Error taxonomy ----
// Codes new to this channel. Codes passed through unchanged from the proxied
// capture/control surfaces (`PERMISSION_DENIED`, `CAPTURE_FAILED`,
// `SCREEN_CAPTURE_BUSY`, …) are `DaemonErrorCodeSchema`'s and are not
// restated here — a routed error must reach the child verbatim.
export const OperatorLoopErrorCodeSchema = z.enum([
  "LOOP_PROTOCOL_VERSION_MISMATCH",
  "LOOP_NOT_STARTED",
  "LOOP_ALREADY_ENDED",
  "LOOP_PROTOCOL_VIOLATION",
  "NO_OPEN_STEP",
  "STEP_INDEX_MISMATCH",
  "OPERATOR_MAX_STEPS_EXCEEDED",
  /**
   * An action request (`performInput`/`resizeWindow`) arrived at
   * `actionsInStep >= maxBatchActions`. **Not run-terminating** — the step
   * stays open, the child abandons the rest of the batch (recording those
   * actions as `BATCH_ABORTED_RESULT`) and closes the step with `reportStep`
   * as normal.
   */
  "OPERATOR_BATCH_LIMIT_EXCEEDED",
  "OPERATOR_TIMEOUT",
  "OPERATOR_ABORTED",
  "UNKNOWN_SECRET_REF",
  "CONTROL_SURFACE_UNAVAILABLE",
  "INVALID_ARGS",
]);
export type OperatorLoopErrorCode = z.infer<typeof OperatorLoopErrorCodeSchema>;

// ---- GuardrailState ----
/**
 * The daemon's authoritative view of the run's budget. The child mirrors these
 * limits locally for transcript quality, but the daemon's copy is the one that
 * cannot be bypassed (contracts/operator-loop-protocol.md §Guardrails are
 * daemon-side).
 */
export const GuardrailStateSchema = z.object({
  /** Steps opened via `beginStep` — monotonic, daemon-owned. */
  stepsUsed: z.number().int().nonnegative(),
  maxSteps: z.number().int().positive(),
  /**
   * Action requests (`performInput`/`resizeWindow`) served inside the
   * currently open step; 0 when none is open. `captureFrame` and
   * `enumerateTargets` are observations and do not count.
   */
  actionsInStep: z.number().int().nonnegative(),
  /** Per-step action ceiling (contracts/operator.md §Action batching). */
  maxBatchActions: z.number().int().positive(),
  /** Wall-clock budget left, from the daemon's clock. */
  remainingMs: z.number(),
  aborted: z.boolean(),
  unbounded: z.boolean(),
  bounds: RectSchema.optional(),
  /** Highest plan revision the daemon has accepted; absent before the first `reportPlan`. */
  planRevision: z.number().int().nonnegative().optional(),
});
export type GuardrailState = z.infer<typeof GuardrailStateSchema>;

// ---- ready (child → daemon; must be first) ----
export const LoopReadyParamsSchema = z.object({
  loopProtocolVersion: z.number().int(),
  pid: z.number().int(),
});
export type LoopReadyParams = z.infer<typeof LoopReadyParamsSchema>;

/**
 * `OperatorRunOptions` minus the members that cannot cross a process boundary
 * (`signal` → the `abort` push, `onStep` → `reportStep`, `transcriptPath` →
 * the daemon owns all disk writes, `secrets` → `secretNames`), plus
 * `startedAtMs` so the child's `tMs` and the daemon's `timeoutMs` share one
 * origin.
 */
export const LoopReadyResultSchema = z.object({
  runId: z.string(),
  task: z.string(),
  /**
   * The RESOLVED target this run operates. The daemon resolves the caller's
   * `CaptureTarget | { targetId }` selector once, before the spawn, so the
   * child never enumerates to find out what it is driving and `bounds` is
   * always this target's own `Rect`.
   *
   * It is NOT, and MUST NOT become, a channel for telling the child that a
   * recording exists over that target — `contracts/operator-loop-protocol.md`
   * §Handshake.
   */
  target: CaptureTargetSchema,
  model: ModelConfigSchema,
  /** Placeholder names only — the child never receives a secret value. */
  secretNames: z.array(z.string()),
  maxSteps: z.number().int().positive(),
  /** Per-step action ceiling — `contracts/operator.md` §Action batching. */
  maxBatchActions: z.number().int().positive(),
  timeoutMs: z.number().int().positive(),
  unbounded: z.boolean(),
  bounds: RectSchema.optional(),
  /** Scoped snapshot of the model's API-key var, per `hello`'s env rules. */
  env: z.record(z.string(), z.string()).optional(),
  startedAtMs: z.number(),
});
export type LoopReadyResult = z.infer<typeof LoopReadyResultSchema>;

// ---- beginStep (child → daemon) ----
export const LoopBeginStepParamsSchema = z.object({
  index: z.number().int().nonnegative(),
});
export type LoopBeginStepParams = z.infer<typeof LoopBeginStepParamsSchema>;

export const LoopBeginStepResultSchema = z.object({ guardrail: GuardrailStateSchema });
export type LoopBeginStepResult = z.infer<typeof LoopBeginStepResultSchema>;

// ---- proxied screen-facing methods (child → daemon) ----
// Exactly `OperatorDeps`' four members. No target param: the daemon resolves
// the run's target itself, so the child cannot widen its own reach.
export const LoopCaptureFrameParamsSchema = z.object({
  format: z.enum(["png", "jpeg"]),
  maxWidth: z.number().positive().optional(),
  quality: z.number().optional(),
  /** Per contracts/sidecar-protocol.md's frame-sharing note; the loop leaves it unset. */
  fresh: z.boolean().optional(),
});
export type LoopCaptureFrameParams = z.infer<typeof LoopCaptureFrameParamsSchema>;

export const LoopPerformInputParamsSchema = z.object({
  /** May carry `{{name}}` placeholders; the daemon substitutes real values. */
  actions: z.array(InputActionSchema),
});
export type LoopPerformInputParams = z.infer<typeof LoopPerformInputParamsSchema>;

export const LoopEnumerateTargetsParamsSchema = z.object({
  kinds: z.array(z.enum(["display", "window", "app"])).optional(),
});
export type LoopEnumerateTargetsParams = z.infer<typeof LoopEnumerateTargetsParamsSchema>;

export const LoopEnumerateTargetsResultSchema = z.object({
  targets: z.array(CaptureTargetSchema),
});
export type LoopEnumerateTargetsResult = z.infer<typeof LoopEnumerateTargetsResultSchema>;

export const LoopResizeWindowParamsSchema = z.object({
  targetId: z.string(),
  bounds: RectSchema,
});
export type LoopResizeWindowParams = z.infer<typeof LoopResizeWindowParamsSchema>;

// ---- reportPlan (child → daemon) ----
/**
 * The child's model called the `plan` tool. The child sends only the plan's
 * *content*; the daemon assigns its *identity* — `revision` (monotonic from 0,
 * per run), `atStepIndex` (the open step's index), and `tMs` (from
 * `startedAtMs`) — sets `OperatorRun.plan`, and holds the revision for the
 * open step so it lands as `OperatorStep.plan` when `reportStep` closes it.
 *
 * Requires an open step (`NO_OPEN_STEP` otherwise); a second `reportPlan` in
 * one step is `LOOP_PROTOCOL_VIOLATION`. Planning consumes no step and does
 * not count toward `maxBatchActions`.
 */
export const LoopReportPlanParamsSchema = z.object({
  steps: z.array(z.string()),
  rationale: z.string().optional(),
});
export type LoopReportPlanParams = z.infer<typeof LoopReportPlanParamsSchema>;

export const LoopReportPlanResultSchema = z.object({
  accepted: z.literal(true),
  /** Daemon-assigned; the child never chooses or renumbers it. */
  revision: z.number().int().nonnegative(),
});
export type LoopReportPlanResult = z.infer<typeof LoopReportPlanResultSchema>;

// ---- reportStep / reportResult / guardrailState / log (child → daemon) ----
export const LoopReportStepParamsSchema = z.object({ step: OperatorStepSchema });
export type LoopReportStepParams = z.infer<typeof LoopReportStepParamsSchema>;

export const LoopReportStepResultSchema = z.object({
  accepted: z.literal(true),
  guardrail: GuardrailStateSchema,
});
export type LoopReportStepResult = z.infer<typeof LoopReportStepResultSchema>;

export const LoopReportResultParamsSchema = z.object({
  state: OperatorRunStateSchema,
  summary: z.string().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
export type LoopReportResultParams = z.infer<typeof LoopReportResultParamsSchema>;

export const LoopReportResultResultSchema = z.object({ accepted: z.literal(true) });
export type LoopReportResultResult = z.infer<typeof LoopReportResultResultSchema>;

export const LoopGuardrailStateParamsSchema = z.object({});
export type LoopGuardrailStateParams = z.infer<typeof LoopGuardrailStateParamsSchema>;

export const LoopLogParamsSchema = z.object({
  level: z.enum(["debug", "info", "warn", "error"]),
  message: z.string(),
  fields: z.record(z.string(), z.unknown()).optional(),
});
export type LoopLogParams = z.infer<typeof LoopLogParamsSchema>;

// ---- abort / ping (daemon → child) ----
/**
 * The reason set is **closed** and contains no recording-derived reason: a
 * recording starting, stopping, failing, or never having existed MUST NOT
 * abort an operator run (contracts/operator-loop-protocol.md §"Methods:
 * daemon → child"). An earlier draft's `"session-ended"` is removed — a run
 * that ends when a recording ends is a run that behaves differently depending
 * on whether it is being recorded, which contracts/operator.md forbids.
 */
export const LoopAbortReasonSchema = z.enum(["user", "timeout", "max-steps", "daemon-shutdown"]);
export type LoopAbortReason = z.infer<typeof LoopAbortReasonSchema>;

export const LoopAbortParamsSchema = z.object({ reason: LoopAbortReasonSchema });
export type LoopAbortParams = z.infer<typeof LoopAbortParamsSchema>;

export const LoopPingParamsSchema = z.object({});
export type LoopPingParams = z.infer<typeof LoopPingParamsSchema>;

export const LoopPingResultSchema = z.object({
  pong: z.literal(true),
  stepIndex: z.number().int(),
  uptimeMs: z.number(),
});
export type LoopPingResult = z.infer<typeof LoopPingResultSchema>;

// ---- Method tables ----

export const OPERATOR_LOOP_CHILD_METHODS = [
  "ready",
  "beginStep",
  "captureFrame",
  "performInput",
  "enumerateTargets",
  "resizeWindow",
  "reportPlan",
  "reportStep",
  "reportResult",
  "guardrailState",
] as const;
export type OperatorLoopChildMethod = (typeof OPERATOR_LOOP_CHILD_METHODS)[number];

/** The four proxied screen-facing methods — servable only inside an open step. */
export const OPERATOR_LOOP_PROXIED_METHODS = [
  "captureFrame",
  "performInput",
  "enumerateTargets",
  "resizeWindow",
] as const satisfies readonly OperatorLoopChildMethod[];

export interface OperatorLoopChildMethodMap {
  ready: { params: LoopReadyParams; result: LoopReadyResult };
  beginStep: { params: LoopBeginStepParams; result: LoopBeginStepResult };
  captureFrame: {
    params: LoopCaptureFrameParams;
    result: z.infer<typeof CaptureFrameResultSchema>;
  };
  performInput: {
    params: LoopPerformInputParams;
    result: z.infer<typeof PerformInputResultSchema>;
  };
  enumerateTargets: { params: LoopEnumerateTargetsParams; result: LoopEnumerateTargetsResult };
  resizeWindow: {
    params: LoopResizeWindowParams;
    result: z.infer<typeof ResizeWindowResultSchema>;
  };
  reportPlan: { params: LoopReportPlanParams; result: LoopReportPlanResult };
  reportStep: { params: LoopReportStepParams; result: LoopReportStepResult };
  reportResult: { params: LoopReportResultParams; result: LoopReportResultResult };
  guardrailState: { params: LoopGuardrailStateParams; result: GuardrailState };
}

export const OPERATOR_LOOP_CHILD_METHOD_SCHEMAS: {
  [M in OperatorLoopChildMethod]: {
    params: z.ZodType<OperatorLoopChildMethodMap[M]["params"]>;
    result: z.ZodType<OperatorLoopChildMethodMap[M]["result"]>;
  };
} = {
  ready: { params: LoopReadyParamsSchema, result: LoopReadyResultSchema },
  beginStep: { params: LoopBeginStepParamsSchema, result: LoopBeginStepResultSchema },
  captureFrame: { params: LoopCaptureFrameParamsSchema, result: CaptureFrameResultSchema },
  performInput: { params: LoopPerformInputParamsSchema, result: PerformInputResultSchema },
  enumerateTargets: {
    params: LoopEnumerateTargetsParamsSchema,
    result: LoopEnumerateTargetsResultSchema,
  },
  resizeWindow: { params: LoopResizeWindowParamsSchema, result: ResizeWindowResultSchema },
  reportPlan: { params: LoopReportPlanParamsSchema, result: LoopReportPlanResultSchema },
  reportStep: { params: LoopReportStepParamsSchema, result: LoopReportStepResultSchema },
  reportResult: { params: LoopReportResultParamsSchema, result: LoopReportResultResultSchema },
  guardrailState: { params: LoopGuardrailStateParamsSchema, result: GuardrailStateSchema },
};

/** `log` is child → daemon but takes no response. */
export const OPERATOR_LOOP_CHILD_NOTIFICATIONS = ["log"] as const;
export type OperatorLoopChildNotification = (typeof OPERATOR_LOOP_CHILD_NOTIFICATIONS)[number];

export const OPERATOR_LOOP_CHILD_NOTIFICATION_SCHEMAS: {
  [N in OperatorLoopChildNotification]: z.ZodType<LoopLogParams>;
} = {
  log: LoopLogParamsSchema,
};

export const OPERATOR_LOOP_DAEMON_METHODS = ["ping"] as const;
export type OperatorLoopDaemonMethod = (typeof OPERATOR_LOOP_DAEMON_METHODS)[number];

export interface OperatorLoopDaemonMethodMap {
  ping: { params: LoopPingParams; result: LoopPingResult };
}

export const OPERATOR_LOOP_DAEMON_METHOD_SCHEMAS: {
  [M in OperatorLoopDaemonMethod]: {
    params: z.ZodType<OperatorLoopDaemonMethodMap[M]["params"]>;
    result: z.ZodType<OperatorLoopDaemonMethodMap[M]["result"]>;
  };
} = {
  ping: { params: LoopPingParamsSchema, result: LoopPingResultSchema },
};

/** `abort` is a push with no response — see the contract for why it isn't polled. */
export const OPERATOR_LOOP_DAEMON_NOTIFICATIONS = ["abort"] as const;
export type OperatorLoopDaemonNotification = (typeof OPERATOR_LOOP_DAEMON_NOTIFICATIONS)[number];

export const OPERATOR_LOOP_DAEMON_NOTIFICATION_SCHEMAS: {
  [N in OperatorLoopDaemonNotification]: z.ZodType<LoopAbortParams>;
} = {
  abort: LoopAbortParamsSchema,
};

/** `abort.reason` → the terminal `OperatorRunState` the daemon applies regardless of the child's agreement. */
export const LOOP_ABORT_REASON_TO_STATE = {
  user: "aborted",
  timeout: "timed_out",
  "max-steps": "failed",
  "daemon-shutdown": "aborted",
} as const satisfies Record<LoopAbortReason, z.infer<typeof OperatorRunStateSchema>>;
