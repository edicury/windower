import type { StopRecordingResult } from "@windower/core";
import { describe, expect, it } from "vitest";
import { buildNarrationParam, renderStopResult } from "./stop.js";

describe("buildNarrationParam", () => {
  it("returns undefined when neither flag is given", () => {
    expect(buildNarrationParam({})).toBeUndefined();
  });

  it("builds a narration param when both flags are given", () => {
    expect(buildNarrationParam({ narration: "/tmp/n.wav", narrationOffset: "500" })).toEqual({
      filePath: "/tmp/n.wav",
      offsetMs: 500,
    });
  });

  it("throws INVALID_ARGS when only --narration is given", () => {
    expect(() => buildNarrationParam({ narration: "/tmp/n.wav" })).toThrow(/together/);
  });

  it("throws INVALID_ARGS when only --narration-offset is given", () => {
    expect(() => buildNarrationParam({ narrationOffset: "500" })).toThrow(/together/);
  });

  it("throws INVALID_ARGS when the offset isn't numeric", () => {
    expect(() =>
      buildNarrationParam({ narration: "/tmp/n.wav", narrationOffset: "not-a-number" }),
    ).toThrow(/narration-offset/);
  });
});

describe("renderStopResult", () => {
  it("reports outputPath and manifestPath", () => {
    const result: StopRecordingResult = {
      outputPath: "/out/rec.mp4",
      manifestPath: "/out/rec.manifest.json",
      manifest: {} as StopRecordingResult["manifest"],
    };
    const output = renderStopResult(result);
    expect(output).toContain("/out/rec.mp4");
    expect(output).toContain("/out/rec.manifest.json");
    expect(output).not.toContain("Event timeline");
  });

  it("reports eventTimelinePath when present", () => {
    const result: StopRecordingResult = {
      outputPath: "/out/rec.mp4",
      manifestPath: "/out/rec.manifest.json",
      eventTimelinePath: "/out/rec.events.json",
      manifest: {} as StopRecordingResult["manifest"],
    };
    expect(renderStopResult(result)).toContain("/out/rec.events.json");
  });
});
