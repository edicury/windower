import type { RecordingSession } from "@windower/core";
import { describe, expect, it } from "vitest";
import { renderStatus } from "./status.js";

const BASE_SESSION: RecordingSession = {
  id: "sess-1",
  state: "recording",
  target: {
    kind: "window",
    id: "42",
    title: "Terminal",
    appName: "iTerm2",
    appBundleId: "com.googlecode.iterm2",
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    isFocused: true,
    resizable: true,
  },
  video: { fps: 30, codec: "h264", container: "mp4", quality: "high", showCursor: true },
  audio: { tracks: [], separateTracks: false },
  startedAt: "2026-08-09T10:00:00.000Z",
};

describe("renderStatus", () => {
  it("reports state, target summary, and elapsed time between startedAt and stoppedAt", () => {
    const session: RecordingSession = {
      ...BASE_SESSION,
      state: "finalized",
      stoppedAt: "2026-08-09T10:01:30.000Z",
      outputPath: "/out/recording.mp4",
    };
    const output = renderStatus(session);
    expect(output).toContain("Session sess-1: finalized");
    expect(output).toContain("Terminal");
    expect(output).toContain("iTerm2");
    expect(output).toContain("01:30");
    expect(output).toContain("/out/recording.mp4");
  });

  it("summarizes display and region targets", () => {
    const display = renderStatus({
      ...BASE_SESSION,
      target: {
        kind: "display",
        id: "1",
        name: "Built-in",
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        isPrimary: true,
        scaleFactor: 2,
      },
    });
    expect(display).toContain("display 1 (Built-in)");

    const region = renderStatus({
      ...BASE_SESSION,
      target: { kind: "region", displayId: "1", bounds: { x: 0, y: 0, width: 400, height: 300 } },
    });
    expect(region).toContain("region on display 1");
  });

  it("includes error details when present", () => {
    const session: RecordingSession = {
      ...BASE_SESSION,
      state: "failed",
      error: { code: "SIDECAR_CRASHED", message: "sidecar exited unexpectedly" },
    };
    expect(renderStatus(session)).toContain("[SIDECAR_CRASHED] sidecar exited unexpectedly");
  });

  it("surfaces a CAPTURE_FAILED session error (contracts/sidecar-protocol.md taxonomy code) in `windower status` output", () => {
    const session: RecordingSession = {
      ...BASE_SESSION,
      state: "failed",
      stoppedAt: "2026-08-09T10:00:05.000Z",
      error: { code: "CAPTURE_FAILED", message: "Sidecar-initiated stop: target-closed" },
    };
    const output = renderStatus(session);
    expect(output).toContain("Session sess-1: failed");
    expect(output).toContain("[CAPTURE_FAILED] Sidecar-initiated stop: target-closed");
  });
});
