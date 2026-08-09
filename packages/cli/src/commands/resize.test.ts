import { describe, expect, it } from "vitest";
import { renderResizeResult } from "./resize.js";

describe("renderResizeResult", () => {
  it("renders a successful resize", () => {
    const result = renderResizeResult("42", {
      actualBounds: { x: 100, y: 100, width: 800, height: 600 },
      result: "success",
    });
    expect(result).toBe("Resize window 42: success — actual bounds 100,100 800x600");
  });

  it("renders a partial resize", () => {
    const result = renderResizeResult("7", {
      actualBounds: { x: 0, y: 0, width: 1024, height: 768 },
      result: "partial",
    });
    expect(result).toBe("Resize window 7: partial — actual bounds 0,0 1024x768");
  });

  it("renders an unsupported resize", () => {
    const result = renderResizeResult("99", {
      actualBounds: { x: 10, y: 20, width: 300, height: 200 },
      result: "unsupported",
    });
    expect(result).toBe("Resize window 99: unsupported — actual bounds 10,20 300x200");
  });
});
