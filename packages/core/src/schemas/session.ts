import { z } from "zod";
import { AudioSettingsSchema } from "./audio-settings.js";
import { CaptureTargetSchema } from "./capture-target.js";
import { VideoSettingsSchema } from "./video-settings.js";

/**
 * SessionState / RecordingSession — the daemon's live/persisted session
 * record. Persisted at ~/.windower/sessions/<id>.json on every transition.
 * See data-model.md §RecordingSession.
 */
export const SessionStateSchema = z.enum([
  "pending",
  "recording",
  "stopping",
  "finalized",
  "canceled",
  "failed",
]);
export type SessionState = z.infer<typeof SessionStateSchema>;

export const RecordingSessionSchema = z.object({
  id: z.string(),
  state: SessionStateSchema,
  target: CaptureTargetSchema,
  video: VideoSettingsSchema,
  audio: AudioSettingsSchema,
  startedAt: z.string(),
  stoppedAt: z.string().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  outputPath: z.string().optional(),
  manifestPath: z.string().optional(),
  eventTimelinePath: z.string().optional(),
  // Phase 20: process that created/owns this session — see data-model.md
  // §RecordingSession. Optional so 0.1.x session files without it still
  // parse.
  owner: z.object({ pid: z.number(), startedAt: z.string() }).optional(),
  // Phase 21/24 invariant (data-model.md §RecordingSession, spec.md §1.1): a
  // `RecordingSession` must NOT know whether it is recording a human,
  // Claude Code, Playwright, another agent, or nothing at all. Windower never
  // synthesizes input or perceives the screen for decision-making — it only
  // records — so this schema carries no driving-agent-derived field of any
  // kind. Adding one would make the Capture plane depend on something outside
  // it.
});
export type RecordingSession = z.infer<typeof RecordingSessionSchema>;
