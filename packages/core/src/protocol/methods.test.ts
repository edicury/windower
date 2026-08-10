import { describe, expect, it } from "vitest";
import { CaptureFrameParamsSchema, SIDECAR_METHOD_SCHEMAS } from "./methods.js";

/**
 * Phase 21 — `captureFrame.fresh` (contracts/sidecar-protocol.md §captureFrame,
 * the frame-sharing opt-out).
 */

const target = {
  kind: "display" as const,
  id: "display:1",
  name: "Built-in Retina Display",
  bounds: { x: 0, y: 0, width: 3024, height: 1964 },
  isPrimary: true,
  scaleFactor: 2,
};

describe("CaptureFrameParamsSchema — fresh", () => {
  it("defaults to false when omitted", () => {
    const parsed = CaptureFrameParamsSchema.parse({ target, format: "png" });
    expect(parsed.fresh).toBe(false);
  });

  it("round-trips an explicit true", () => {
    expect(CaptureFrameParamsSchema.parse({ target, format: "png", fresh: true }).fresh).toBe(true);
  });

  it("round-trips an explicit false", () => {
    expect(CaptureFrameParamsSchema.parse({ target, format: "jpeg", fresh: false }).fresh).toBe(
      false,
    );
  });

  it("rejects a non-boolean fresh", () => {
    expect(
      CaptureFrameParamsSchema.safeParse({ target, format: "png", fresh: "yes" }).success,
    ).toBe(false);
  });

  it("still parses a pre-Phase-21 params object unchanged otherwise", () => {
    const legacy = { target, format: "jpeg" as const, maxWidth: 1280, quality: 0.8 };
    expect(CaptureFrameParamsSchema.parse(legacy)).toEqual({ ...legacy, fresh: false });
  });

  it("is wired into the method table", () => {
    expect(
      SIDECAR_METHOD_SCHEMAS.captureFrame.params.parse({ target, format: "png" }),
    ).toMatchObject({ fresh: false });
  });
});
