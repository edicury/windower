import type {
  AudioSettings,
  CaptureTarget,
  ListSessionsResult,
  RecordingSession,
  VideoSettings,
} from "@windower/core";
import { describe, expect, it } from "vitest";
import { renderSessionsTable } from "./list.js";

const VIDEO: VideoSettings = {
  fps: 30,
  codec: "h264",
  container: "mp4",
  quality: "high",
  showCursor: true,
};

const AUDIO: AudioSettings = { tracks: [], separateTracks: false };

const DISPLAY_TARGET: CaptureTarget = {
  kind: "display",
  id: "1",
  name: "Built-in",
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  isPrimary: true,
  scaleFactor: 2,
};

function session(
  id: string,
  state: RecordingSession["state"],
  startedAt: string,
): RecordingSession {
  return { id, state, target: DISPLAY_TARGET, video: VIDEO, audio: AUDIO, startedAt };
}

describe("renderSessionsTable", () => {
  it("reports no sessions found for an empty list", () => {
    expect(renderSessionsTable({ sessions: [] })).toBe("No sessions found.");
  });

  it("renders a header and one row per session", () => {
    const result: ListSessionsResult = {
      sessions: [session("a", "finalized", "2026-08-09T10:00:00.000Z")],
    };
    const output = renderSessionsTable(result);
    const lines = output.split("\n");
    expect(lines[0]).toMatch(/ID/);
    expect(lines[0]).toMatch(/STATE/);
    expect(lines[1]).toContain("a");
    expect(lines[1]).toContain("finalized");
    expect(lines[1]).toContain("display:Built-in");
  });
});
