import { z } from "zod";

/**
 * AudioTrackConfig / AudioSettings — see data-model.md §AudioSettings.
 *
 * Narration is modeled as an audio track kind so a future "more track
 * types" addition doesn't require a shape change — see plan.md §8.
 */
export const SystemAudioTrackConfigSchema = z.object({
  source: z.literal("system"),
  enabled: z.boolean(),
});
export type SystemAudioTrackConfig = z.infer<typeof SystemAudioTrackConfigSchema>;

export const MicrophoneAudioTrackConfigSchema = z.object({
  source: z.literal("microphone"),
  enabled: z.boolean(),
  deviceId: z.string().optional(),
});
export type MicrophoneAudioTrackConfig = z.infer<typeof MicrophoneAudioTrackConfigSchema>;

export const NarrationAudioTrackConfigSchema = z.object({
  source: z.literal("narration"),
  filePath: z.string(),
  offsetMs: z.number(),
});
export type NarrationAudioTrackConfig = z.infer<typeof NarrationAudioTrackConfigSchema>;

export const AudioTrackConfigSchema = z.discriminatedUnion("source", [
  SystemAudioTrackConfigSchema,
  MicrophoneAudioTrackConfigSchema,
  NarrationAudioTrackConfigSchema,
]);
export type AudioTrackConfig = z.infer<typeof AudioTrackConfigSchema>;

export const AudioSettingsSchema = z.object({
  tracks: z.array(AudioTrackConfigSchema),
  separateTracks: z.boolean(),
});
export type AudioSettings = z.infer<typeof AudioSettingsSchema>;
