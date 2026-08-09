import { describe, expect, it } from "vitest";
import { buildStartRecordingParams } from "./record-params.js";

describe("buildStartRecordingParams", () => {
  it("throws INVALID_ARGS when --target is missing", () => {
    expect(() => buildStartRecordingParams({})).toThrow(/--target/);
  });

  it("builds a bare targetId target for window/display kinds", () => {
    const params = buildStartRecordingParams({ target: "42" });
    expect(params.target).toEqual({ targetId: "42" });
  });

  it("builds a full RegionCaptureTarget for --kind region --region x,y,w,h", () => {
    const params = buildStartRecordingParams({
      target: "1",
      kind: "region",
      region: "10,20,300,400",
    });
    expect(params.target).toEqual({
      kind: "region",
      displayId: "1",
      bounds: { x: 10, y: 20, width: 300, height: 400 },
    });
  });

  it("throws INVALID_ARGS when --kind region is given without --region", () => {
    expect(() => buildStartRecordingParams({ target: "1", kind: "region" })).toThrow(/--region/);
  });

  it("throws INVALID_ARGS on a malformed --region", () => {
    expect(() =>
      buildStartRecordingParams({ target: "1", kind: "region", region: "not,a,rect" }),
    ).toThrow(/--region/);
  });

  it("maps video flags into a VideoSettings partial", () => {
    const params = buildStartRecordingParams({
      target: "1",
      fps: "60",
      codec: "hevc",
      container: "mov",
      resolution: "1920x1080",
      quality: "lossless_ish",
      cursor: false,
    });
    expect(params.video).toEqual({
      fps: 60,
      codec: "hevc",
      container: "mov",
      resolution: { width: 1920, height: 1080 },
      quality: "lossless_ish",
      showCursor: false,
    });
  });

  it("throws INVALID_ARGS on an invalid --fps", () => {
    expect(() => buildStartRecordingParams({ target: "1", fps: "15" })).toThrow(/--fps/);
  });

  it("throws INVALID_ARGS on a malformed --resolution", () => {
    expect(() => buildStartRecordingParams({ target: "1", resolution: "big" })).toThrow(
      /--resolution/,
    );
  });

  it("defaults separateTracks to true when both system and mic audio are enabled", () => {
    const params = buildStartRecordingParams({ target: "1", audioSystem: true, audioMic: true });
    expect(params.audio).toEqual({
      tracks: [
        { source: "system", enabled: true },
        { source: "microphone", enabled: true },
      ],
      separateTracks: true,
    });
  });

  it("defaults separateTracks to false for a single audio source", () => {
    const params = buildStartRecordingParams({ target: "1", audioSystem: true });
    expect(params.audio).toEqual({
      tracks: [{ source: "system", enabled: true }],
      separateTracks: false,
    });
  });

  it("honors an explicit --separate-tracks override", () => {
    const params = buildStartRecordingParams({
      target: "1",
      audioSystem: true,
      separateTracks: true,
    });
    expect(params.audio?.separateTracks).toBe(true);
  });

  it("includes a mic deviceId from --mic-device", () => {
    const params = buildStartRecordingParams({
      target: "1",
      audioMic: true,
      micDevice: "mic-42",
    });
    expect(params.audio?.tracks).toEqual([
      { source: "microphone", enabled: true, deviceId: "mic-42" },
    ]);
  });

  it("maps --out to outputDir", () => {
    const params = buildStartRecordingParams({ target: "1", out: "/tmp/out" });
    expect(params.outputDir).toBe("/tmp/out");
  });

  it("omits video/audio/outputDir entirely when no related flags are given", () => {
    const params = buildStartRecordingParams({ target: "1" });
    expect(params.video).toBeUndefined();
    expect(params.audio).toBeUndefined();
    expect(params.outputDir).toBeUndefined();
  });
});
