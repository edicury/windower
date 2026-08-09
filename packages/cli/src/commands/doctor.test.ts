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
    expect(lines[3]).toContain("[ ]");
    expect(lines[4]).toContain("[x] Daemon running");
    expect(lines[5]).toContain("[x] Sidecar available (v0.1.0)");
  });

  it("omits the version suffix when sidecarVersion is absent", () => {
    const output = renderReport({ ...REPORT, sidecarVersion: undefined });
    expect(output).toContain("Sidecar available");
    expect(output).not.toContain("(v");
  });
});
