import { z } from "zod";

/**
 * VideoSettings — see data-model.md §VideoSettings.
 */
export const VideoSettingsSchema = z.object({
  fps: z.union([z.literal(24), z.literal(30), z.literal(60)]),
  codec: z.enum(["h264", "hevc"]),
  container: z.enum(["mp4", "mov"]),
  resolution: z.object({ width: z.number(), height: z.number() }).optional(),
  quality: z.enum(["low", "medium", "high", "lossless_ish"]),
  showCursor: z.boolean(),
});
export type VideoSettings = z.infer<typeof VideoSettingsSchema>;
