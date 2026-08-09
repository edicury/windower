import type { CancelRecordingResult } from "@windower/core";
import { describe, expect, it } from "vitest";
import { renderCancelResult } from "./cancel.js";

describe("renderCancelResult", () => {
  it("confirms cancellation with the session id", () => {
    const result: CancelRecordingResult = { canceled: true };
    expect(renderCancelResult("sess-1", result)).toBe("Canceled recording session sess-1");
  });
});
