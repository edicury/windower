import type { StopRecordingResult } from "@windower/core";
import { describe, expect, it } from "vitest";
import { renderRecordResult } from "./record.js";

describe("renderRecordResult", () => {
  it("renders the same as the stop result (record prints the final stop output)", () => {
    const result: StopRecordingResult = {
      outputPath: "/out/rec.mp4",
      manifestPath: "/out/rec.manifest.json",
      manifest: {} as StopRecordingResult["manifest"],
    };
    expect(renderRecordResult(result)).toContain("/out/rec.mp4");
    expect(renderRecordResult(result)).toContain("/out/rec.manifest.json");
  });
});
