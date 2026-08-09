import type { StartRecordingResult } from "@windower/core";
import { describe, expect, it } from "vitest";
import { renderStartResult } from "./start.js";

describe("renderStartResult", () => {
  it("reports the new session id, no waiting language", () => {
    const result: StartRecordingResult = { sessionId: "sess-123" };
    expect(renderStartResult(result)).toBe("Started recording session sess-123");
  });
});
