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
  // Phase 21 invariant (contracts/operator.md §Transcript format): no manifest
  // field points at an operator artifact. `operatorRunPath` was exactly that
  // reverse dependency — a capture artifact referencing the operator — and is
  // removed. An operator run's transcript lives under
  // `~/.windower/operator-runs/<runId>/` and is nobody's business here; an
  // orchestrator that wants the two side by side copies them itself using the
  // two paths it already holds. Already-written `manifest.json` files carrying
  // the key still parse — the unknown key is stripped, never rejected.
  createdAt: z.string(),
  file: z.object({
    path: z.string(),
    sizeBytes: z.number(),
    codec: z.string(),
    container: z.string(),
  }),
});
export type OutputManifest = z.infer<typeof OutputManifestSchema>;
