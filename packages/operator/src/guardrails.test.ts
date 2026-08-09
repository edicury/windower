import { describe, expect, it } from "vitest";
import { OPERATOR_ERROR_CODES, type OperatorError } from "./errors.js";
import { Deadline, MAX_WAIT_MS, assertWithinBounds, isWithinBounds, sleep } from "./guardrails.js";

const BOUNDS = { x: 100, y: 100, width: 800, height: 600 };

describe("bounds guardrail", () => {
  it("accepts coordinates inside the target rect", () => {
    expect(isWithinBounds(BOUNDS, 100, 100)).toBe(true);
    expect(isWithinBounds(BOUNDS, 900, 700)).toBe(true);
    expect(() =>
      assertWithinBounds({ unbounded: false, bounds: BOUNDS }, [{ x: 500, y: 400 }], "click"),
    ).not.toThrow();
  });

  it("rejects an out-of-bounds coordinate with INPUT_OUT_OF_BOUNDS", () => {
    try {
      assertWithinBounds({ unbounded: false, bounds: BOUNDS }, [{ x: 5000, y: 400 }], "click");
      expect.unreachable("expected INPUT_OUT_OF_BOUNDS");
    } catch (err) {
      expect((err as OperatorError).code).toBe(OPERATOR_ERROR_CODES.INPUT_OUT_OF_BOUNDS);
    }
  });

  it("is disabled by --unbounded, and by an unknown target rect", () => {
    expect(() =>
      assertWithinBounds({ unbounded: true, bounds: BOUNDS }, [{ x: -1, y: -1 }], "click"),
    ).not.toThrow();
    expect(() =>
      assertWithinBounds({ unbounded: false }, [{ x: -1, y: -1 }], "click"),
    ).not.toThrow();
  });
});

describe("deadline", () => {
  it("tracks elapsed/remaining and expires against an injected clock", () => {
    let t = 0;
    const deadline = new Deadline(1000, () => t);
    t = 400;
    expect(deadline.remainingMs()).toBe(600);
    expect(deadline.expired()).toBe(false);
    t = 1000;
    expect(deadline.expired()).toBe(true);
    t = 5000;
    expect(deadline.remainingMs()).toBe(0);
  });
});

describe("wait", () => {
  it("caps the local sleep", async () => {
    const started = Date.now();
    await sleep(MAX_WAIT_MS * 100, AbortSignal.timeout(20));
    expect(Date.now() - started).toBeLessThan(MAX_WAIT_MS);
  });

  it("returns immediately on an already-aborted signal", async () => {
    const started = Date.now();
    await sleep(5000, AbortSignal.abort());
    expect(Date.now() - started).toBeLessThan(100);
  });
});
