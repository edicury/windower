import { z } from "zod";
import { SidecarErrorCodeSchema } from "../protocol/jsonrpc.js";
import { AudioSettingsSchema } from "../schemas/audio-settings.js";
import { CaptureTargetSchema } from "../schemas/capture-target.js";
import { OutputManifestSchema } from "../schemas/manifest.js";
import { PermissionReportSchema, PermissionStatusSchema } from "../schemas/permissions.js";
import { RectSchema } from "../schemas/rect.js";
import { RecordingSessionSchema, SessionStateSchema } from "../schemas/session.js";
import { VideoSettingsSchema } from "../schemas/video-settings.js";

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

// ---- Method table ----

export const DAEMON_METHODS = [
  "list_targets",
  "check_permissions",
  "request_permission",
  "resize_window",
  "start_recording",
  "get_session",
  "stop_recording",
  "cancel_recording",
  "list_sessions",
] as const;
export type DaemonMethod = (typeof DAEMON_METHODS)[number];

export interface DaemonMethodMap {
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
}

export const DAEMON_METHOD_SCHEMAS: {
  [M in DaemonMethod]: {
    params: z.ZodType<DaemonMethodMap[M]["params"]>;
    result: z.ZodType<DaemonMethodMap[M]["result"]>;
  };
} = {
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
};
