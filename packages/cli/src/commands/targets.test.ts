import type { CaptureTarget } from "@windower/core";
import { describe, expect, it } from "vitest";
import { renderTargetsTable } from "./targets.js";

const DISPLAY: CaptureTarget = {
  kind: "display",
  id: "1",
  name: "Built-in",
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  isPrimary: true,
  scaleFactor: 2,
};

const WINDOW: CaptureTarget = {
  kind: "window",
  id: "42",
  title: "Terminal",
  appName: "iTerm2",
  appBundleId: "com.googlecode.iterm2",
  bounds: { x: 10, y: 20, width: 800, height: 600 },
  isFocused: true,
  resizable: true,
};

const REGION: CaptureTarget = {
  kind: "region",
  displayId: "1",
  bounds: { x: 0, y: 0, width: 400, height: 300 },
};

describe("renderTargetsTable", () => {
  it("reports no targets found for an empty list", () => {
    expect(renderTargetsTable({ targets: [] })).toBe("No capture targets found.");
  });

  it("renders a header and one row per target across all kinds", () => {
    const output = renderTargetsTable({ targets: [DISPLAY, WINDOW, REGION] });
    const lines = output.split("\n");
    expect(lines[0]).toMatch(/KIND/);
    expect(lines[0]).toMatch(/BOUNDS/);
    expect(lines).toHaveLength(4);
    expect(lines[1]).toContain("display");
    expect(lines[1]).toContain("Built-in");
    expect(lines[2]).toContain("window");
    expect(lines[2]).toContain("Terminal");
    expect(lines[3]).toContain("region");
  });
});
