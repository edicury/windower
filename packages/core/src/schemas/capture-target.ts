import { z } from "zod";
import { RectSchema } from "./rect.js";

/**
 * CaptureTarget — identifies what will be recorded. Returned by
 * enumerateTargets, passed to startCapture. See data-model.md §CaptureTarget.
 */
export const DisplayCaptureTargetSchema = z.object({
  kind: z.literal("display"),
  id: z.string(),
  name: z.string(),
  bounds: RectSchema,
  isPrimary: z.boolean(),
  scaleFactor: z.number(),
});
export type DisplayCaptureTarget = z.infer<typeof DisplayCaptureTargetSchema>;

export const WindowCaptureTargetSchema = z.object({
  kind: z.literal("window"),
  id: z.string(),
  title: z.string(),
  appName: z.string(),
  appBundleId: z.string(),
  bounds: RectSchema,
  isFocused: z.boolean(),
  resizable: z.boolean(),
});
export type WindowCaptureTarget = z.infer<typeof WindowCaptureTargetSchema>;

export const RegionCaptureTargetSchema = z.object({
  kind: z.literal("region"),
  displayId: z.string(),
  bounds: RectSchema,
});
export type RegionCaptureTarget = z.infer<typeof RegionCaptureTargetSchema>;

export const CaptureTargetSchema = z.discriminatedUnion("kind", [
  DisplayCaptureTargetSchema,
  WindowCaptureTargetSchema,
  RegionCaptureTargetSchema,
]);
export type CaptureTarget = z.infer<typeof CaptureTargetSchema>;
