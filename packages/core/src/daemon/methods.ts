import { z } from "zod";
import { SidecarErrorCodeSchema } from "../protocol/jsonrpc.js";
import { AudioSettingsSchema } from "../schemas/audio-settings.js";
import { CaptureTargetSchema } from "../schemas/capture-target.js";
import { OutputManifestSchema } from "../schemas/manifest.js";
import {
  type ModelConfig,
  ModelConfigSchema,
  type OperatorModels,
  OperatorGuardrailsSchema,
  OperatorModelsSchema,
  OperatorRunSchema,
  OperatorRunStateSchema,
  SecretRefSchema,
} from "../schemas/operator.js";
import { PermissionReportSchema, PermissionStatusSchema } from "../schemas/permissions.js";
import { RectSchema } from "../schemas/rect.js";
import { RecordingSessionSchema, SessionStateSchema } from "../schemas/session.js";
import { VideoSettingsSchema } from "../schemas/video-settings.js";
import {
  type DaemonHelloRequest,
  DaemonHelloRequestSchema,
  type DaemonHelloResult,
  DaemonHelloResultSchema,
  type DaemonInfoParams,
  DaemonInfoParamsSchema,
  type DaemonInfoResult,
  DaemonInfoResultSchema,
} from "./protocol.js";

/**
 * The daemon RPC method table — contracts/mcp-tools.md operations, spoken
 * over the unix socket (`~/.windower/daemon.sock`) as newline-delimited
 * JSON-RPC 2.0, same framing as the sidecar protocol. CLI and MCP server are
 * both thin wrappers over `DaemonClient`; semantics must match
 * contracts/mcp-tools.md 1:1.
 */

// ---- Error taxonomy ----
// Sidecar codes pass through unchanged (a capture-side failure is still
// meaningful to a daemon-RPC caller); daemon-only codes are added on top.
export const DaemonErrorCodeSchema = z.enum([
  ...SidecarErrorCodeSchema.options,
  "DAEMON_UNREACHABLE",
  "INVALID_ARGS",
  "TARGET_ALREADY_RECORDING",
  "OUTPUT_DIR_NOT_WRITABLE",
  // Phase 19 (operator): daemon-only, mirrors SESSION_NOT_FOUND for
  // `get_operator_run`/`abort_operator_run` against an unknown runId.
  "OPERATOR_RUN_NOT_FOUND",
  // Phase 20 (daemon-optional): `hello` handshake outcomes. See
  // contracts/daemon-rpc.md's "Error codes" section.
  "DAEMON_VERSION_MISMATCH",
  "DAEMON_BUSY",
  // Phase 21 (capture/control split).
  // `OPERATOR_LOOP_CRASHED` — the operator decision-loop child process exited
  // without sending `reportResult` (non-zero exit, signal, `kill -9`, EOF, or
  // an unanswered `ping`). Daemon-internal, never on the loop wire; see
  // contracts/operator-loop-protocol.md §OPERATOR_LOOP_CRASHED.
  "OPERATOR_LOOP_CRASHED",
  // `SCREEN_CAPTURE_BUSY` — the ScreenCaptureKit resource is held by a live
  // process this caller cannot route to: a same-home holder that outlived the
  // bounded wait budget, or any holder from a different WINDOWER_HOME. See
  // contracts/screen-capture-exclusivity.md §Error codes.
  "SCREEN_CAPTURE_BUSY",
]);
export type DaemonErrorCode = z.infer<typeof DaemonErrorCodeSchema>;

// ---- list_targets ----
export const ListTargetsParamsSchema = z.object({
  kinds: z.array(z.enum(["display", "window", "app"])).optional(),
});
export type ListTargetsParams = z.infer<typeof ListTargetsParamsSchema>;

export const ListTargetsResultSchema = z.object({
  targets: z.array(CaptureTargetSchema),
});
export type ListTargetsResult = z.infer<typeof ListTargetsResultSchema>;

// ---- check_permissions ----
export const CheckPermissionsParamsSchema = z.object({});
export type CheckPermissionsParams = z.infer<typeof CheckPermissionsParamsSchema>;

export const CheckPermissionsResultSchema = PermissionReportSchema;
export type CheckPermissionsResult = z.infer<typeof CheckPermissionsResultSchema>;

// ---- request_permission ----
export const DaemonRequestPermissionParamsSchema = z.object({
  kind: z.enum(["screenRecording", "accessibility", "microphone"]),
});
export type DaemonRequestPermissionParams = z.infer<typeof DaemonRequestPermissionParamsSchema>;

export const DaemonRequestPermissionResultSchema = z.object({
  status: PermissionStatusSchema,
});
export type DaemonRequestPermissionResult = z.infer<typeof DaemonRequestPermissionResultSchema>;

// ---- resize_window ----
export const DaemonResizeWindowParamsSchema = z.object({
  targetId: z.string(),
  bounds: RectSchema,
});
export type DaemonResizeWindowParams = z.infer<typeof DaemonResizeWindowParamsSchema>;

export const DaemonResizeWindowResultSchema = z.object({
  actualBounds: RectSchema,
  result: z.enum(["success", "partial", "unsupported"]),
});
export type DaemonResizeWindowResult = z.infer<typeof DaemonResizeWindowResultSchema>;

// ---- start_recording ----
export const StartRecordingParamsSchema = z.object({
  target: z.union([CaptureTargetSchema, z.object({ targetId: z.string() })]),
  video: VideoSettingsSchema.partial().optional(),
  audio: AudioSettingsSchema.partial().optional(),
  outputDir: z.string().optional(),
});
export type StartRecordingParams = z.infer<typeof StartRecordingParamsSchema>;

export const StartRecordingResultSchema = z.object({
  sessionId: z.string(),
});
export type StartRecordingResult = z.infer<typeof StartRecordingResultSchema>;

// ---- get_session ----
export const GetSessionParamsSchema = z.object({
  sessionId: z.string(),
});
export type GetSessionParams = z.infer<typeof GetSessionParamsSchema>;

export const GetSessionResultSchema = RecordingSessionSchema;
export type GetSessionResult = z.infer<typeof GetSessionResultSchema>;

// ---- stop_recording ----
export const StopRecordingParamsSchema = z.object({
  sessionId: z.string(),
  narration: z.object({ filePath: z.string(), offsetMs: z.number() }).optional(),
});
export type StopRecordingParams = z.infer<typeof StopRecordingParamsSchema>;

export const StopRecordingResultSchema = z.object({
  outputPath: z.string(),
  manifestPath: z.string(),
  eventTimelinePath: z.string().optional(),
  manifest: OutputManifestSchema,
});
export type StopRecordingResult = z.infer<typeof StopRecordingResultSchema>;

// ---- cancel_recording ----
export const CancelRecordingParamsSchema = z.object({
  sessionId: z.string(),
});
export type CancelRecordingParams = z.infer<typeof CancelRecordingParamsSchema>;

export const CancelRecordingResultSchema = z.object({
  canceled: z.literal(true),
});
export type CancelRecordingResult = z.infer<typeof CancelRecordingResultSchema>;

// ---- list_sessions ----
export const ListSessionsParamsSchema = z.object({
  state: SessionStateSchema.optional(),
});
export type ListSessionsParams = z.infer<typeof ListSessionsParamsSchema>;

export const ListSessionsResultSchema = z.object({
  sessions: z.array(RecordingSessionSchema),
});
export type ListSessionsResult = z.infer<typeof ListSessionsResultSchema>;

// ---- run_operator ----
// contracts/mcp-tools.md §run_operator + contracts/cli.md `windower operate`.
// Returns immediately with `{ runId }` — same non-blocking two-call shape as
// `start_recording`; poll `get_operator_run` for progress.
// An operator run is fully specified by `{ task, target, model, secrets?,
// guardrails? }` and nothing else (contracts/operator.md §Inputs). It is
// recording-unaware: there is no `sessionId` member and no `recording` member,
// and the attach-vs-standalone refinement that used to police them is gone
// rather than kept as a no-op. `.strict()` is what makes passing either one
// `INVALID_ARGS` — by schema strictness, not by refinement.
export const RunOperatorParamsSchema = z.strictObject({
  task: z.string().min(1),
  /**
   * The **same target selector `start_recording` takes** — resolved through
   * `enumerateTargets` exactly as capture does, and the source of the bounds
   * clamp. Not a parallel operator-only type.
   */
  target: z.union([CaptureTargetSchema, z.object({ targetId: z.string() })]),
  /**
   * Phase 22 — accepts either a bare `ModelConfig` (one `--model`, both tiers
   * resolve to it) or an already-tiered `OperatorModels`
   * (`--planner-model`/`--executor-model`), mirroring
   * `normalizeOperatorModels`'s accepted shapes at the CLI/MCP boundary.
   * Optional: a caller may omit it entirely and rely on
   * `~/.windower/config.json`'s `operator.defaultPlannerModel` /
   * `defaultExecutorModel` / `defaultModel` — the same file the daemon
   * already reads for every other operator default, resolved daemon-side in
   * `OperatorRunEngine.resolveModels` (explicit → tier-specific config
   * default → `defaultModel` → error; executor additionally falls back to
   * the resolved planner). A caller that supplies a fully resolved `models`
   * (as `windower operate` does today) sees the config file consulted for
   * nothing — this is a fallback, not a second source of truth.
   */
  models: z.union([ModelConfigSchema, OperatorModelsSchema]).optional(),
  secrets: z.array(SecretRefSchema).optional(),
  guardrails: OperatorGuardrailsSchema.optional(),
  /** Phase 22 — `"auto"` (default) | `"ax"` | `"vision"`; see `contracts/operator.md` §Observation policy. */
  observe: z.enum(["auto", "ax", "vision"]).optional(),
});
export type RunOperatorParams = z.infer<typeof RunOperatorParamsSchema>;
/** The pre-normalization shape `RunOperatorParams.models` accepts. */
export type RunOperatorModelsInput = ModelConfig | OperatorModels;

export const RunOperatorResultSchema = z.object({
  runId: z.string(),
});
export type RunOperatorResult = z.infer<typeof RunOperatorResultSchema>;

// ---- get_operator_run ----
export const GetOperatorRunParamsSchema = z.object({
  runId: z.string(),
});
export type GetOperatorRunParams = z.infer<typeof GetOperatorRunParamsSchema>;

export const GetOperatorRunResultSchema = OperatorRunSchema;
export type GetOperatorRunResult = z.infer<typeof GetOperatorRunResultSchema>;

// ---- abort_operator_run ----
export const AbortOperatorRunParamsSchema = z.object({
  runId: z.string(),
});
export type AbortOperatorRunParams = z.infer<typeof AbortOperatorRunParamsSchema>;

export const AbortOperatorRunResultSchema = z.object({
  aborted: z.literal(true),
});
export type AbortOperatorRunResult = z.infer<typeof AbortOperatorRunResultSchema>;

// ---- list_operator_runs ----
// `windower operate list [--state <state>]` (contracts/cli.md) — mirrors
// `list_sessions`. Daemon-side only; not exposed as an MCP tool.
export const ListOperatorRunsParamsSchema = z.object({
  state: OperatorRunStateSchema.optional(),
});
export type ListOperatorRunsParams = z.infer<typeof ListOperatorRunsParamsSchema>;

export const ListOperatorRunsResultSchema = z.object({
  runs: z.array(OperatorRunSchema),
});
export type ListOperatorRunsResult = z.infer<typeof ListOperatorRunsResultSchema>;

// ---- shutdown ----
// Added in Phase 7 (CLI) for `windower daemon stop`: contracts/cli.md calls
// for explicit daemon lifecycle control, and there was no clean way to ask
// a running daemon to exit over the wire (SIGTERM works but is not
// reachable from a plain RPC client). Mirrors contracts/mcp-tools.md-style
// method shape; see that file for the prominent note on this addition.
// `mode` added Phase 20 (contracts/daemon-rpc.md "Graceful shutdown"):
// `"graceful"` (default) drains connections, finalizes in-flight
// recordings/operator runs, then exits; `"immediate"` skips the drain and
// exits as fast as possible, leaving `recoverCrashedSessions()` to clean up
// anything left `recording`. Optional so an old (pre-Phase-20) daemon still
// accepts a bare `{}` shutdown call unchanged.
export const ShutdownParamsSchema = z.object({
  mode: z.enum(["graceful", "immediate"]).optional(),
});
export type ShutdownParams = z.infer<typeof ShutdownParamsSchema>;

export const ShutdownResultSchema = z.object({
  shuttingDown: z.literal(true),
});
export type ShutdownResult = z.infer<typeof ShutdownResultSchema>;

// ---- hello / daemon_info ----
// Version handshake, contracts/daemon-rpc.md. `hello` is sent once per
// connection before any other RPC; `daemon_info` is a no-op probe with no
// handshake/env-snapshot side effects, used by `windower doctor`. Schemas
// live in `protocol.ts` alongside `DAEMON_PROTOCOL_VERSION` (and are
// re-exported from there via `index.ts`'s barrel, not re-exported again
// here) so they slot into the same DaemonMethodMap/DAEMON_METHOD_SCHEMAS
// pattern as every other method below.
type HelloParams = DaemonHelloRequest;
type HelloResult = DaemonHelloResult;

// ---- Method table ----

export const DAEMON_METHODS = [
  "hello",
  "daemon_info",
  "list_targets",
  "check_permissions",
  "request_permission",
  "resize_window",
  "start_recording",
  "get_session",
  "stop_recording",
  "cancel_recording",
  "list_sessions",
  "run_operator",
  "get_operator_run",
  "abort_operator_run",
  "list_operator_runs",
  "shutdown",
] as const;
export type DaemonMethod = (typeof DAEMON_METHODS)[number];

export interface DaemonMethodMap {
  hello: { params: HelloParams; result: HelloResult };
  daemon_info: { params: DaemonInfoParams; result: DaemonInfoResult };
  list_targets: { params: ListTargetsParams; result: ListTargetsResult };
  check_permissions: { params: CheckPermissionsParams; result: CheckPermissionsResult };
  request_permission: {
    params: DaemonRequestPermissionParams;
    result: DaemonRequestPermissionResult;
  };
  resize_window: { params: DaemonResizeWindowParams; result: DaemonResizeWindowResult };
  start_recording: { params: StartRecordingParams; result: StartRecordingResult };
  get_session: { params: GetSessionParams; result: GetSessionResult };
  stop_recording: { params: StopRecordingParams; result: StopRecordingResult };
  cancel_recording: { params: CancelRecordingParams; result: CancelRecordingResult };
  list_sessions: { params: ListSessionsParams; result: ListSessionsResult };
  run_operator: { params: RunOperatorParams; result: RunOperatorResult };
  get_operator_run: { params: GetOperatorRunParams; result: GetOperatorRunResult };
  abort_operator_run: { params: AbortOperatorRunParams; result: AbortOperatorRunResult };
  list_operator_runs: { params: ListOperatorRunsParams; result: ListOperatorRunsResult };
  shutdown: { params: ShutdownParams; result: ShutdownResult };
}

export const DAEMON_METHOD_SCHEMAS: {
  [M in DaemonMethod]: {
    params: z.ZodType<DaemonMethodMap[M]["params"]>;
    result: z.ZodType<DaemonMethodMap[M]["result"]>;
  };
} = {
  hello: { params: DaemonHelloRequestSchema, result: DaemonHelloResultSchema },
  daemon_info: { params: DaemonInfoParamsSchema, result: DaemonInfoResultSchema },
  list_targets: { params: ListTargetsParamsSchema, result: ListTargetsResultSchema },
  check_permissions: { params: CheckPermissionsParamsSchema, result: CheckPermissionsResultSchema },
  request_permission: {
    params: DaemonRequestPermissionParamsSchema,
    result: DaemonRequestPermissionResultSchema,
  },
  resize_window: { params: DaemonResizeWindowParamsSchema, result: DaemonResizeWindowResultSchema },
  start_recording: { params: StartRecordingParamsSchema, result: StartRecordingResultSchema },
  get_session: { params: GetSessionParamsSchema, result: GetSessionResultSchema },
  stop_recording: { params: StopRecordingParamsSchema, result: StopRecordingResultSchema },
  cancel_recording: { params: CancelRecordingParamsSchema, result: CancelRecordingResultSchema },
  list_sessions: { params: ListSessionsParamsSchema, result: ListSessionsResultSchema },
  run_operator: { params: RunOperatorParamsSchema, result: RunOperatorResultSchema },
  get_operator_run: { params: GetOperatorRunParamsSchema, result: GetOperatorRunResultSchema },
  abort_operator_run: {
    params: AbortOperatorRunParamsSchema,
    result: AbortOperatorRunResultSchema,
  },
  list_operator_runs: {
    params: ListOperatorRunsParamsSchema,
    result: ListOperatorRunsResultSchema,
  },
  shutdown: { params: ShutdownParamsSchema, result: ShutdownResultSchema },
};
