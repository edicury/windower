import { z } from "zod";

/**
 * PermissionStatus / PermissionReport — used by `doctor` / `check_permissions`.
 * See data-model.md §Permission state.
 */
export const PermissionStatusSchema = z.enum([
  "granted",
  "denied",
  "not_determined",
  "not_applicable",
]);
export type PermissionStatus = z.infer<typeof PermissionStatusSchema>;

export const PermissionReportSchema = z.object({
  screenRecording: PermissionStatusSchema,
  accessibility: PermissionStatusSchema,
  microphone: PermissionStatusSchema,
  daemonRunning: z.boolean(),
  sidecarAvailable: z.boolean(),
  sidecarVersion: z.string().optional(),
});
export type PermissionReport = z.infer<typeof PermissionReportSchema>;
