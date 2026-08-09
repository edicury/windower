import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { DaemonError } from "@windower/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clampOffsetMsToSeconds, muxNarration, validateNarrationFile } from "./narration-mux.js";

const execFileAsync = promisify(execFile);
// See narration-mux.ts for why this uses createRequire instead of a default import.
const ffmpegPath = createRequire(import.meta.url)("ffmpeg-static") as string;

/**
 * `ffmpeg-static`'s bundled binary needs to actually execute for the mux
 * round-trip tests below to mean anything (some sandboxes block spawning
 * downloaded binaries). We probe once and skip the ffmpeg-dependent tests
 * with a clear message if it can't run here, per the phase-11 task brief.
 */
let ffmpegWorks = false;
try {
  await execFileAsync(ffmpegPath, ["-version"]);
  ffmpegWorks = true;
} catch {
  ffmpegWorks = false;
}

describe("validateNarrationFile", () => {
  it("throws INVALID_ARGS for a missing file", async () => {
    await expect(validateNarrationFile("/nonexistent/narration.wav")).rejects.toMatchObject({
      code: "INVALID_ARGS",
    });
    await expect(validateNarrationFile("/nonexistent/narration.wav")).rejects.toBeInstanceOf(
      DaemonError,
    );
  });

  it.runIf(ffmpegWorks)("resolves for a real audio file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "windower-narration-"));
    const wavPath = join(dir, "narration.wav");
    try {
      await execFileAsync(ffmpegPath, ["-f", "lavfi", "-i", "anullsrc", "-t", "1", "-y", wavPath]);
      await expect(validateNarrationFile(wavPath)).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.runIf(ffmpegWorks)("throws INVALID_ARGS for a non-audio file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "windower-narration-"));
    const textPath = join(dir, "not-audio.txt");
    try {
      await (await import("node:fs/promises")).writeFile(textPath, "not an audio file");
      await expect(validateNarrationFile(textPath)).rejects.toMatchObject({
        code: "INVALID_ARGS",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("clampOffsetMsToSeconds", () => {
  it("clamps negative offsets to 0", () => {
    expect(clampOffsetMsToSeconds(-5000)).toBe(0);
  });

  it("converts a positive offset to seconds", () => {
    expect(clampOffsetMsToSeconds(2500)).toBe(2.5);
  });

  it("passes zero through unchanged", () => {
    expect(clampOffsetMsToSeconds(0)).toBe(0);
  });
});

describe.runIf(ffmpegWorks)("muxNarration (round trip)", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "windower-narration-mux-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function probeStreams(filePath: string): Promise<string> {
    try {
      await execFileAsync(ffmpegPath, ["-i", filePath]);
      return "";
    } catch (err) {
      return (err as { stderr?: string }).stderr ?? "";
    }
  }

  it("adds an audio track and truncates it to the video duration", async () => {
    const videoPath = join(dir, "video.mp4");
    const narrationPath = join(dir, "narration.wav");

    await execFileAsync(ffmpegPath, [
      "-f",
      "lavfi",
      "-i",
      "testsrc",
      "-t",
      "2",
      "-pix_fmt",
      "yuv420p",
      "-y",
      videoPath,
    ]);
    // Narration is longer than the video (3s narration vs 2s video) to
    // exercise the truncate-never-extend policy.
    await execFileAsync(ffmpegPath, [
      "-f",
      "lavfi",
      "-i",
      "anullsrc",
      "-t",
      "3",
      "-y",
      narrationPath,
    ]);

    const before = await stat(videoPath);

    await muxNarration({
      videoPath,
      narrationFilePath: narrationPath,
      offsetMs: 500,
      videoDurationMs: 2000,
    });

    const after = await stat(videoPath);
    expect(after.size).toBeGreaterThan(0);

    const streams = await probeStreams(videoPath);
    expect(streams).toMatch(/Stream #\d+:\d+.*Video:/);
    expect(streams).toMatch(/Stream #\d+:\d+.*Audio:/);

    const durationMatch = streams.match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
    expect(durationMatch).toBeTruthy();
    const [, hh, mm, ss] = durationMatch as unknown as [string, string, string, string];
    const durationSec = Number(hh) * 3600 + Number(mm) * 60 + Number(ss);
    // Video track duration must not be extended past ~2s (small ffmpeg
    // container/muxing slack allowed).
    expect(durationSec).toBeLessThan(2.5);

    // Sanity: the original video path was rewritten in place (temp-file-then-rename).
    expect(before.ino).not.toBe(after.ino);
  });

  it("throws and leaves the original file untouched when the narration file is bad", async () => {
    const videoPath = join(dir, "video2.mp4");
    await execFileAsync(ffmpegPath, [
      "-f",
      "lavfi",
      "-i",
      "testsrc",
      "-t",
      "1",
      "-pix_fmt",
      "yuv420p",
      "-y",
      videoPath,
    ]);
    const before = await stat(videoPath);

    await expect(
      muxNarration({
        videoPath,
        narrationFilePath: "/nonexistent/narration.wav",
        offsetMs: 0,
        videoDurationMs: 1000,
      }),
    ).rejects.toThrow();

    const after = await stat(videoPath);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.size).toBe(before.size);

    // No leftover temp file.
    await expect(stat(join(dir, "video2.narration-tmp.mp4"))).rejects.toThrow();
  });
});
