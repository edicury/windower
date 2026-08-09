import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Same CJS-interop workaround as apps/daemon/src/narration-mux.ts — see that
// file's top-of-module comment for why `createRequire` is used instead of a
// normal `import`. `ffprobe-static` ships a `path` string (plus platform
// metadata) rather than ffmpeg-static's bare string, so the shape read back
// differs slightly.
const ffprobeStatic = createRequire(import.meta.url)("ffprobe-static") as { path: string };

function resolveFfprobePath(): string {
  if (!ffprobeStatic?.path) {
    throw new Error("ffprobe-static did not resolve a binary path");
  }
  return ffprobeStatic.path;
}

export interface ProbedVideo {
  durationSec: number;
  width: number;
  height: number;
  /** Parsed from the stream's `avg_frame_rate` (e.g. "30/1" -> 30). */
  fps: number;
  audioStreamCount: number;
  videoCodec: string;
}

interface FfprobeStream {
  codec_type: "video" | "audio" | "subtitle" | "data";
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  duration?: string;
}

interface FfprobeOutput {
  streams: FfprobeStream[];
  format: { duration?: string };
}

function parseFrameRate(rate: string | undefined): number {
  if (!rate) return 0;
  const [num, den] = rate.split("/").map(Number);
  if (!num || !den) return 0;
  return num / den;
}

/** Probes a media file's video/audio characteristics via `ffprobe -print_format json`. */
export async function probeVideo(filePath: string): Promise<ProbedVideo> {
  const ffprobe = resolveFfprobePath();
  const { stdout } = await execFileAsync(ffprobe, [
    "-v",
    "quiet",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    filePath,
  ]);

  const parsed = JSON.parse(stdout) as FfprobeOutput;
  const videoStream = parsed.streams.find((s) => s.codec_type === "video");
  if (!videoStream) {
    throw new Error(`No video stream found in "${filePath}"`);
  }
  const audioStreamCount = parsed.streams.filter((s) => s.codec_type === "audio").length;

  const durationSec = Number(parsed.format.duration ?? videoStream.duration ?? 0);

  return {
    durationSec,
    width: videoStream.width ?? 0,
    height: videoStream.height ?? 0,
    fps: parseFrameRate(videoStream.avg_frame_rate),
    audioStreamCount,
    videoCodec: videoStream.codec_name ?? "unknown",
  };
}

/** Per-stream duration (seconds), keyed by stream index — used by the soak test's audio/video drift check. */
export async function probeStreamDurations(
  filePath: string,
): Promise<{ index: number; codecType: string; durationSec: number }[]> {
  const ffprobe = resolveFfprobePath();
  const { stdout } = await execFileAsync(ffprobe, [
    "-v",
    "quiet",
    "-print_format",
    "json",
    "-show_streams",
    filePath,
  ]);
  const parsed = JSON.parse(stdout) as { streams: (FfprobeStream & { index: number })[] };
  return parsed.streams.map((s) => ({
    index: s.index,
    codecType: s.codec_type,
    durationSec: Number(s.duration ?? 0),
  }));
}
