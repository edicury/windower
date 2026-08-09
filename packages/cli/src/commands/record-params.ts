import {
  type AudioSettings,
  type AudioTrackConfig,
  DaemonError,
  type Rect,
  type StartRecordingParams,
  type VideoSettings,
} from "@windower/core";
import type { Command } from "commander";

/**
 * Flags shared by `start` and `record` — moved out of `stubs.ts` (where
 * they originated as `addSharedRecordingFlags`) now that both commands are
 * implemented for real; see `contracts/cli.md`'s `start`/`record` sections.
 */
export function addSharedRecordingFlags(command: Command): Command {
  return command
    .option("--target <id>", "target id from `windower targets`")
    .option("--kind <kind>", "window|display|region")
    .option("--region <x,y,w,h>", "region bounds, only with --kind region")
    .option("--fps <fps>", "24|30|60", "30")
    .option("--codec <codec>", "h264|hevc", "h264")
    .option("--container <container>", "mp4|mov", "mp4")
    .option("--resolution <WxH>", "output resolution, default target's native resolution")
    .option("--quality <quality>", "low|medium|high|lossless_ish", "high")
    .option("--no-cursor", "hide the cursor (default: shown)")
    .option("--audio-system", "capture system audio (default: off)")
    .option("--audio-mic", "capture microphone audio (default: off)")
    .option("--mic-device <id>", "microphone device id, only with --audio-mic")
    .option("--separate-tracks", "write audio tracks to separate files")
    .option("--out <dir>", "output directory (default: configured output folder)")
    .option("--json", "output JSON");
}

/**
 * Shared `--target`/`--kind`/`--region` + video/audio flag parsing for
 * `start` and `record` — see `stubs.ts`'s `addSharedRecordingFlags` for the
 * flag definitions these options come from (both commands register the same
 * flags via that helper).
 */
export interface SharedRecordingOpts {
  target?: string;
  kind?: string;
  region?: string;
  fps?: string;
  codec?: string;
  container?: string;
  resolution?: string;
  quality?: string;
  cursor?: boolean;
  audioSystem?: boolean;
  audioMic?: boolean;
  micDevice?: string;
  separateTracks?: boolean;
  out?: string;
  json?: boolean;
}

function parseRegion(raw: string): Rect {
  const parts = raw.split(",").map((p) => Number(p.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    throw new DaemonError(
      "INVALID_ARGS",
      `Invalid --region "${raw}" — expected "x,y,w,h" (four numbers)`,
    );
  }
  const [x, y, width, height] = parts as [number, number, number, number];
  return { x, y, width, height };
}

function parseFps(raw: string | undefined): VideoSettings["fps"] | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (value !== 24 && value !== 30 && value !== 60) {
    throw new DaemonError("INVALID_ARGS", `Invalid --fps "${raw}" — expected 24, 30, or 60`);
  }
  return value;
}

function parseResolution(raw: string | undefined): { width: number; height: number } | undefined {
  if (raw === undefined) return undefined;
  const match = /^(\d+)x(\d+)$/i.exec(raw.trim());
  if (!match) {
    throw new DaemonError("INVALID_ARGS", `Invalid --resolution "${raw}" — expected "WxH"`);
  }
  return { width: Number(match[1]), height: Number(match[2]) };
}

/**
 * Exported so `operate` (contracts/cli.md `windower operate`) can reuse the
 * exact same video-flag parsing without going through
 * `buildStartRecordingParams` — `run_operator` takes no target, so it needs
 * the video/audio half of the shared flag block only.
 */
export function buildVideo(opts: SharedRecordingOpts): Partial<VideoSettings> | undefined {
  const fps = parseFps(opts.fps);
  const resolution = parseResolution(opts.resolution);
  const video: Partial<VideoSettings> = {};
  if (fps !== undefined) video.fps = fps;
  if (opts.codec !== undefined) video.codec = opts.codec as VideoSettings["codec"];
  if (opts.container !== undefined) video.container = opts.container as VideoSettings["container"];
  if (resolution !== undefined) video.resolution = resolution;
  if (opts.quality !== undefined) video.quality = opts.quality as VideoSettings["quality"];
  // commander's `--no-cursor` sets `opts.cursor === false`; the flag is
  // absent (undefined) when not passed either way, so only forward an
  // explicit value.
  if (opts.cursor !== undefined) video.showCursor = opts.cursor;
  return Object.keys(video).length > 0 ? video : undefined;
}

/**
 * Builds the `tracks` array from `--audio-system`/`--audio-mic` (+
 * `--mic-device`), and derives `separateTracks`: explicit `--separate-tracks`
 * wins, otherwise defaults to `true` when more than one source is enabled
 * (contracts/cli.md's stated default for multi-source captures) and `false`
 * otherwise.
 */
export function buildAudio(opts: SharedRecordingOpts): AudioSettings | undefined {
  const tracks: AudioTrackConfig[] = [];
  if (opts.audioSystem) tracks.push({ source: "system", enabled: true });
  if (opts.audioMic) {
    tracks.push({
      source: "microphone",
      enabled: true,
      ...(opts.micDevice !== undefined ? { deviceId: opts.micDevice } : {}),
    });
  }

  if (tracks.length === 0 && opts.separateTracks === undefined) return undefined;

  const separateTracks = opts.separateTracks ?? tracks.length > 1;
  return { tracks, separateTracks };
}

/** Builds `start_recording` params from `start`/`record`'s shared CLI flags. */
export function buildStartRecordingParams(opts: SharedRecordingOpts): StartRecordingParams {
  if (!opts.target) {
    throw new DaemonError("INVALID_ARGS", "--target is required");
  }

  const kind = opts.kind ?? "window";
  let target: StartRecordingParams["target"];
  if (kind === "region") {
    if (!opts.region) {
      throw new DaemonError("INVALID_ARGS", "--region is required when --kind region");
    }
    target = { kind: "region", displayId: opts.target, bounds: parseRegion(opts.region) };
  } else {
    target = { targetId: opts.target };
  }

  const video = buildVideo(opts);
  const audio = buildAudio(opts);

  return {
    target,
    ...(video !== undefined ? { video } : {}),
    ...(audio !== undefined ? { audio } : {}),
    ...(opts.out !== undefined ? { outputDir: opts.out } : {}),
  };
}
