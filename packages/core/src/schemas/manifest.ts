import { z } from "zod";
import { CaptureTargetSchema } from "./capture-target.js";
import { VideoSettingsSchema } from "./video-settings.js";

/**
 * OutputManifest — manifest.json, written next to the video file.
 * See data-model.md §OutputManifest.
 */
export const OutputManifestSchema = z.object({
  windowerVersion: z.string(),
  sessionId: z.string(),
  target: CaptureTargetSchema,
  video: VideoSettingsSchema.extend({
    actualResolution: z.object({ width: z.number(), height: z.number() }),
    durationMs: z.number(),
  }),
  audio: z.object({
    tracks: z.array(z.object({ source: z.string(), trackIndex: z.number() })),
  }),
  narration: z
    .object({
      filePath: z.string(),
      offsetMs: z.number(),
      trackIndex: z.number(),
    })
    .optional(),
  eventTimelinePath: z.string().optional(),
  /**
   * Relative path to the `OperatorRun` record (`<recording>.operator.json`),
   * present when this recording was operator-driven (Phase 19,
   * contracts/operator.md §Transcript format).
   */
  operatorRunPath: z.string().optional(),
  createdAt: z.string(),
  file: z.object({
    path: z.string(),
    sizeBytes: z.number(),
    codec: z.string(),
    container: z.string(),
  }),
});
export type OutputManifest = z.infer<typeof OutputManifestSchema>;
