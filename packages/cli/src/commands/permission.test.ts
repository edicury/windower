import { describe, expect, it } from "vitest";
import { renderPermissionResult } from "./permission.js";

describe("renderPermissionResult", () => {
  it("renders a granted status", () => {
    expect(renderPermissionResult("accessibility", { status: "granted" })).toBe(
      'Permission "accessibility" status: granted',
    );
  });

  it("renders a denied status for a different kind", () => {
    expect(renderPermissionResult("microphone", { status: "denied" })).toBe(
      'Permission "microphone" status: denied',
    );
  });

  it("renders a not_determined status", () => {
    expect(renderPermissionResult("screenRecording", { status: "not_determined" })).toBe(
      'Permission "screenRecording" status: not_determined',
    );
  });
});
