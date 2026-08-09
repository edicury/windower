/**
 * Narration mux (Phase 11).
 *
 * ## Mechanism: ffmpeg (via `ffmpeg-static`), not AVFoundation
 * Muxing a finished video with a supplied narration audio file is not
 * screen capture — it doesn't touch ScreenCaptureKit, AX, or any macOS-only
 * API. Per `CLAUDE.md`'s "protocol before platform" rule, it belongs in the
 * OS-agnostic TS daemon (`apps/daemon`), not `native/macos`. `ffmpeg-static`
 * bundles a portable, statically-linked ffmpeg binary with no system
 * install and no network call at runtime (consistent with "no network
 * calls anywhere in MVP" — the binary ships inside the npm package at
 * install time, nothing is fetched while the daemon runs).
 *
 * ## Validation: fail fast, before capture is stopped
 * `validateNarrationFile` is called at the very start of `stopRecording`,
 * before the sidecar's `stopCapture` is invoked. If the narration file is
 * missing or not decodable audio, `stopRecording` throws immediately and
 * the session is left untouched (still `"recording"`, never transitions to
 * `"stopping"`/`"finalized"`) — the caller can retry `stop` with a fixed
 * path without having lost the in-progress capture.
 *
 * ## Mux timing: after the base video is finalized, before the manifest write
 * `muxNarration` runs as a distinct post-step, once `stopCapture` has
 * already produced the finished video file, right before `manifest.json`
 * is written. If the mux step itself fails at this stage, the error is
 * swallowed by the caller (`session-manager.ts`) — `stopRecording` still
 * succeeds with the base video intact and `manifest.narration` simply
 * absent, matching the existing swallow-and-continue behavior used for
 * `EventTimelineWriter.finalize()` failures in the same function.
 *
 * ## Duration policy: truncate narration, never extend the video
 * The mux always applies `-t <videoDurationSec>` (from the sidecar's
 * `stopCapture` result, `actualDurationMs`). If the narration track is
 * longer than the video, it is cut off at the video's end — the video's
 * duration is never extended to fit a longer narration file. This keeps
 * "video duration" a single source of truth (the sidecar's capture
 * duration) instead of something narration mux could silently change.
 *
 * ## Offset policy: negative offsets clamp to 0
 * `offsetMs < 0` is clamped to `0` before building the ffmpeg
 * `-itsoffset` argument — negative offsets have no meaningful mapping onto
 * a video that has already been captured (there's no "before the
 * recording started" to place audio into). The manifest still records the
 * caller's original, unclamped `offsetMs` (see `session-manager.ts`) so the
 * request is auditable even though playback behavior clamped it.
 *
 * An offset at or beyond the video's duration is not special-cased as an
 * error — it degenerates naturally into the truncate policy above (0
 * audible seconds of narration end up in the output).
 */

import { execFile } from "node:child_process";
import { access, rename, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, extname, join } from "node:path";
import { promisify } from "node:util";
import { DaemonError } from "@windower/core";

const execFileAsync = promisify(execFile);

// `ffmpeg-static`'s bundled `.d.ts` declares an ESM `export default`, but the
// package itself is plain CommonJS (`module.exports = <path string>`) with
// no `"type": "module"` in its package.json. Under `moduleResolution:
// NodeNext` that mismatch makes a normal `import ffmpegPath from
// "ffmpeg-static"` resolve to the *whole module namespace* type instead of
// the string it actually is at runtime — a known TS/NodeNext CJS-interop
// quirk, not a bug in our code. Using `createRequire` sidesteps the
// type-resolution mismatch entirely and matches what esModuleInterop does
// under the hood anyway.
const ffmpegPath = createRequire(import.meta.url)("ffmpeg-static") as string | null;

function resolveFfmpegPath(): string {
  if (!ffmpegPath) {
    throw new DaemonError("INTERNAL_ERROR", "ffmpeg-static did not resolve a binary path");
  }
  return ffmpegPath;
}

/**
 * Confirms `filePath` exists and ffmpeg can decode at least one audio
 * stream from it. Throws `DaemonError("INVALID_ARGS", ...)` otherwise —
 * callers should let this throw naturally (see `session-manager.ts`
 * `stopRecording`, called before `stopCapture`).
 */
export async function validateNarrationFile(filePath: string): Promise<void> {
  try {
    await access(filePath);
  } catch {
    throw new DaemonError("INVALID_ARGS", `Narration file not found: "${filePath}"`);
  }

  const ffmpeg = resolveFfmpegPath();
  let stderr = "";
  try {
    // `ffmpeg -i <file>` always exits non-zero with no `-y`/output target,
    // but it still probes and prints stream info to stderr — that's what
    // we parse. execFileAsync rejects on the non-zero exit, so we read the
    // captured stderr off the rejection.
    await execFileAsync(ffmpeg, ["-i", filePath]);
  } catch (err) {
    stderr = (err as { stderr?: string }).stderr ?? "";
  }

  if (!/Stream #\d+:\d+.*Audio:/.test(stderr)) {
    throw new DaemonError(
      "INVALID_ARGS",
      `Narration file is not a decodable audio file: "${filePath}"`,
    );
  }
}

/** Clamps a requested offset to a non-negative ffmpeg `-itsoffset` value, in seconds. */
export function clampOffsetMsToSeconds(offsetMs: number): number {
  return Math.max(0, offsetMs) / 1000;
}

export interface MuxNarrationOptions {
  videoPath: string;
  narrationFilePath: string;
  offsetMs: number;
  videoDurationMs: number;
}

/**
 * Muxes `narrationFilePath` into `videoPath` as an additional audio track
 * starting at `offsetMs` (clamped to >= 0), truncated to the video's
 * duration, without re-encoding the video stream. Writes to a temp file
 * next to the original and atomically renames over it on success; on
 * failure, the temp file is removed and the original is left untouched.
 * Throws on any ffmpeg failure — callers should catch and swallow (see
 * `session-manager.ts`).
 */
export async function muxNarration(opts: MuxNarrationOptions): Promise<void> {
  const ffmpeg = resolveFfmpegPath();
  const offsetSec = clampOffsetMsToSeconds(opts.offsetMs);
  const durationSec = opts.videoDurationMs / 1000;
  const ext = extname(opts.videoPath);
  const tempOutput = join(
    dirname(opts.videoPath),
    `${basename(opts.videoPath, ext)}.narration-tmp.mp4`,
  );

  try {
    await execFileAsync(ffmpeg, [
      "-y",
      "-i",
      opts.videoPath,
      "-itsoffset",
      String(offsetSec),
      "-i",
      opts.narrationFilePath,
      "-map",
      "0:v",
      "-map",
      "0:a?",
      "-map",
      "1:a",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-t",
      String(durationSec),
      tempOutput,
    ]);
    await rename(tempOutput, opts.videoPath);
  } catch (err) {
    await rm(tempOutput, { force: true }).catch(() => {});
    throw err instanceof Error
      ? err
      : new DaemonError("INTERNAL_ERROR", `Narration mux failed: ${String(err)}`);
  }
}
