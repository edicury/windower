import type { PermissionReport } from "@windower/core";
import { describe, expect, it } from "vitest";
import { renderReport } from "./doctor.js";

const REPORT: PermissionReport = {
  screenRecording: "granted",
  accessibility: "denied",
  microphone: "not_determined",
  daemonRunning: true,
  sidecarAvailable: true,
  sidecarVersion: "0.1.0",
};

describe("renderReport", () => {
  it("marks granted/true items as checked and others as unchecked", () => {
    const output = renderReport(REPORT);
    const lines = output.split("\n");
    expect(lines[1]).toContain("[x]");
    expect(lines[1]).toContain("Screen Recording: granted");
    expect(lines[2]).toContain("[ ]");
    expect(lines[2]).toContain("Accessibility: denied");
    expect(output).toContain("[x] Daemon running");
    expect(output).toContain("[x] Sidecar available (v0.1.0)");
  });

  it("suggests `windower permission request <kind>` for each ungranted permission", () => {
    const output = renderReport(REPORT);
    expect(output).toContain("windower permission request accessibility");
    expect(output).toContain("windower permission request microphone");
    expect(output).not.toContain("windower permission request screenRecording");
  });

  it("omits the version suffix when sidecarVersion is absent", () => {
    const output = renderReport({ ...REPORT, sidecarVersion: undefined });
    expect(output).toContain("Sidecar available");
    expect(output).not.toContain("(v");
    expect(output).not.toContain("version mismatch");
  });

  it("flags a sidecar version mismatch clearly", () => {
    const output = renderReport({ ...REPORT, sidecarVersion: "0.9.9" });
    expect(output).toContain("version mismatch");
    expect(output).toContain("0.9.9");
  });
});
