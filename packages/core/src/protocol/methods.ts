import { z } from "zod";
import { AudioSettingsSchema } from "../schemas/audio-settings.js";
import { CaptureTargetSchema } from "../schemas/capture-target.js";
import { TimelineEventSchema } from "../schemas/event-timeline.js";
import { type InputActionKind, InputActionSchema } from "../schemas/input-action.js";
import { PermissionReportSchema, PermissionStatusSchema } from "../schemas/permissions.js";
import { RectSchema } from "../schemas/rect.js";
import { VideoSettingsSchema } from "../schemas/video-settings.js";

/**
 * The method table from contracts/sidecar-protocol.md §Methods. Params/result
 * schemas here MUST stay shape-identical to that doc — if the doc needs a
 * shape change, change the doc first (see CLAUDE.md "protocol before
 * platform").
 */

export const CapabilitySchema = z.enum([
  "enumerate.displays",
  "enumerate.windows",
  "enumerate.apps",
  "window-control",
  "capture.display",
  "capture.window",
  "capture.region",
  "audio.system",
  "audio.system.perApp",
  "audio.microphone",
  "cursor.visible",
  "eventTimeline.cursor",
  "eventTimeline.mouse",
  "eventTimeline.keyboard",
  "input.mouse",
  "input.keyboard",
  "screenshot",
]);
export type Capability = z.infer<typeof CapabilitySchema>;

/**
 * Which capability `performInput` requires for a given action `kind`
 * (contracts/sidecar-protocol.md §Methods — "`input.mouse` / `input.keyboard`
 * (per action `kind`)"). `wait` is a local sleep and needs neither.
 */
export function requiredCapabilityForInputAction(
  kind: InputActionKind,
): Extract<Capability, "input.mouse" | "input.keyboard"> | null {
  switch (kind) {
    case "mouse_move":
    case "mouse_down":
    case "mouse_up":
    case "mouse_click":
    case "mouse_drag":
    case "scroll":
      return "input.mouse";
    case "type_text":
    case "key_press":
      return "input.keyboard";
    default:
      return null;
  }
}

export const PlatformSchema = z.enum(["macos", "windows", "linux"]);
export type Platform = z.infer<typeof PlatformSchema>;

// ---- describe ----
export const DescribeParamsSchema = z.object({});
export type DescribeParams = z.infer<typeof DescribeParamsSchema>;

export const DescribeResultSchema = z.object({
  platform: PlatformSchema,
  version: z.string(),
  capabilities: z.array(CapabilitySchema),
});
export type DescribeResult = z.infer<typeof DescribeResultSchema>;

/**
 * The sidecar `version` (from `describe`'s result) the daemon/CLI are tested
 * against — must track `sidecarVersion` in
 * `native/macos/Sources/windower-sidecar-macos/main.swift`. Used for a
 * simple exact-match compatibility check (Phase 14 "version compatibility");
 * bump both together when the sidecar's build version changes.
 */
export const EXPECTED_SIDECAR_VERSION = "0.1.0";

// ---- enumerateTargets ----
export const EnumerateTargetsParamsSchema = z.object({
  kinds: z.array(z.enum(["display", "window"])).optional(),
});
export type EnumerateTargetsParams = z.infer<typeof EnumerateTargetsParamsSchema>;

export const EnumerateTargetsResultSchema = z.object({
  targets: z.array(CaptureTargetSchema),
});
export type EnumerateTargetsResult = z.infer<typeof EnumerateTargetsResultSchema>;

// ---- getPermissions ----
export const GetPermissionsParamsSchema = z.object({});
export type GetPermissionsParams = z.infer<typeof GetPermissionsParamsSchema>;

// Contract: "PermissionReport (backend-relevant subset)" — the sidecar may
// omit fields it has no opinion on, so accept a partial report here.
export const GetPermissionsResultSchema = PermissionReportSchema.partial();
export type GetPermissionsResult = z.infer<typeof GetPermissionsResultSchema>;

// ---- requestPermission ----
export const RequestPermissionParamsSchema = z.object({
  kind: z.enum(["screenRecording", "accessibility", "microphone"]),
});
export type RequestPermissionParams = z.infer<typeof RequestPermissionParamsSchema>;

export const RequestPermissionResultSchema = z.object({
  status: PermissionStatusSchema,
});
export type RequestPermissionResult = z.infer<typeof RequestPermissionResultSchema>;

// ---- resizeWindow ----
export const ResizeWindowParamsSchema = z.object({
  targetId: z.string(),
  bounds: RectSchema,
});
export type ResizeWindowParams = z.infer<typeof ResizeWindowParamsSchema>;

export const ResizeWindowResultSchema = z.object({
  actualBounds: RectSchema,
  result: z.enum(["success", "partial", "unsupported"]),
});
export type ResizeWindowResult = z.infer<typeof ResizeWindowResultSchema>;

// ---- startCapture ----
export const StartCaptureParamsSchema = z.object({
  sessionId: z.string(),
  target: CaptureTargetSchema,
  video: VideoSettingsSchema,
  audio: AudioSettingsSchema,
});
export type StartCaptureParams = z.infer<typeof StartCaptureParamsSchema>;

export const StartCaptureResultSchema = z.object({
  started: z.literal(true),
});
export type StartCaptureResult = z.infer<typeof StartCaptureResultSchema>;

// ---- stopCapture ----
export const StopCaptureParamsSchema = z.object({
  sessionId: z.string(),
});
export type StopCaptureParams = z.infer<typeof StopCaptureParamsSchema>;

export const StopCaptureResultSchema = z.object({
  outputFilePath: z.string(),
  actualDurationMs: z.number(),
  actualResolution: z.object({ width: z.number(), height: z.number() }),
});
export type StopCaptureResult = z.infer<typeof StopCaptureResultSchema>;

// ---- cancelCapture ----
export const CancelCaptureParamsSchema = z.object({
  sessionId: z.string(),
});
export type CancelCaptureParams = z.infer<typeof CancelCaptureParamsSchema>;

export const CancelCaptureResultSchema = z.object({
  canceled: z.literal(true),
});
export type CancelCaptureResult = z.infer<typeof CancelCaptureResultSchema>;

// ---- performInput ----
// Takes an **array** deliberately: a click-then-type sequence is one atomic
// round trip and one capability check, not N round trips
// (contracts/sidecar-protocol.md §Methods).
export const PerformInputParamsSchema = z.object({
  sessionId: z.string().optional(),
  actions: z.array(InputActionSchema),
});
export type PerformInputParams = z.infer<typeof PerformInputParamsSchema>;

export const PerformInputResultSchema = z.object({
  performed: z.number(),
});
export type PerformInputResult = z.infer<typeof PerformInputResultSchema>;

// ---- captureFrame ----
export const CaptureFrameParamsSchema = z.object({
  target: CaptureTargetSchema,
  format: z.enum(["png", "jpeg"]),
  maxWidth: z.number().positive().optional(),
  quality: z.number().optional(),
});
export type CaptureFrameParams = z.infer<typeof CaptureFrameParamsSchema>;

export const CaptureFrameResultSchema = z.object({
  imageBase64: z.string(),
  width: z.number(),
  height: z.number(),
  scale: z.number(),
});
export type CaptureFrameResult = z.infer<typeof CaptureFrameResultSchema>;

// ---- Method table ----

export const SIDECAR_METHODS = [
  "describe",
  "enumerateTargets",
  "getPermissions",
  "requestPermission",
  "resizeWindow",
  "startCapture",
  "stopCapture",
  "cancelCapture",
  "performInput",
  "captureFrame",
] as const;
export type SidecarMethod = (typeof SIDECAR_METHODS)[number];

/** Maps each method name to its params/result Zod schemas and inferred types. */
export interface SidecarMethodMap {
  describe: { params: DescribeParams; result: DescribeResult };
  enumerateTargets: { params: EnumerateTargetsParams; result: EnumerateTargetsResult };
  getPermissions: { params: GetPermissionsParams; result: GetPermissionsResult };
  requestPermission: { params: RequestPermissionParams; result: RequestPermissionResult };
  resizeWindow: { params: ResizeWindowParams; result: ResizeWindowResult };
  startCapture: { params: StartCaptureParams; result: StartCaptureResult };
  stopCapture: { params: StopCaptureParams; result: StopCaptureResult };
  cancelCapture: { params: CancelCaptureParams; result: CancelCaptureResult };
  performInput: { params: PerformInputParams; result: PerformInputResult };
  captureFrame: { params: CaptureFrameParams; result: CaptureFrameResult };
}

export const SIDECAR_METHOD_SCHEMAS: {
  [M in SidecarMethod]: {
    params: z.ZodType<SidecarMethodMap[M]["params"]>;
    result: z.ZodType<SidecarMethodMap[M]["result"]>;
  };
} = {
  describe: { params: DescribeParamsSchema, result: DescribeResultSchema },
  enumerateTargets: { params: EnumerateTargetsParamsSchema, result: EnumerateTargetsResultSchema },
  getPermissions: { params: GetPermissionsParamsSchema, result: GetPermissionsResultSchema },
  requestPermission: {
    params: RequestPermissionParamsSchema,
    result: RequestPermissionResultSchema,
  },
  resizeWindow: { params: ResizeWindowParamsSchema, result: ResizeWindowResultSchema },
  startCapture: { params: StartCaptureParamsSchema, result: StartCaptureResultSchema },
  stopCapture: { params: StopCaptureParamsSchema, result: StopCaptureResultSchema },
  cancelCapture: { params: CancelCaptureParamsSchema, result: CancelCaptureResultSchema },
  performInput: { params: PerformInputParamsSchema, result: PerformInputResultSchema },
  captureFrame: { params: CaptureFrameParamsSchema, result: CaptureFrameResultSchema },
};

// ---- Notifications (sidecar → daemon) ----

export const EventNotificationParamsSchema = z.object({
  sessionId: z.string(),
  event: TimelineEventSchema,
});
export type EventNotificationParams = z.infer<typeof EventNotificationParamsSchema>;

export const LogNotificationParamsSchema = z.object({
  sessionId: z.string().optional(),
  level: z.enum(["debug", "info", "warn", "error"]),
  message: z.string(),
});
export type LogNotificationParams = z.infer<typeof LogNotificationParamsSchema>;

export const CaptureEndedNotificationParamsSchema = z.object({
  sessionId: z.string(),
  reason: z.enum(["target-closed", "error"]),
});
export type CaptureEndedNotificationParams = z.infer<typeof CaptureEndedNotificationParamsSchema>;

export const SIDECAR_NOTIFICATIONS = ["event", "log", "captureEnded"] as const;
export type SidecarNotificationMethod = (typeof SIDECAR_NOTIFICATIONS)[number];

export interface SidecarNotificationMap {
  event: EventNotificationParams;
  log: LogNotificationParams;
  captureEnded: CaptureEndedNotificationParams;
}

export const SIDECAR_NOTIFICATION_SCHEMAS: {
  [N in SidecarNotificationMethod]: z.ZodType<SidecarNotificationMap[N]>;
} = {
  event: EventNotificationParamsSchema,
  log: LogNotificationParamsSchema,
  captureEnded: CaptureEndedNotificationParamsSchema,
};
