import type { Rect } from "@windower/core";
import { OPERATOR_ERROR_CODES, OperatorError } from "./errors.js";

/**
 * Guardrails are enforced here, in the runtime — never delegated to the system
 * prompt (contracts/operator.md §Guardrails: "the model is never trusted to
 * self-limit"). The prompt *describes* the limits so the model can plan around
 * them; this module is what actually stops it.
 */

/** `wait` is a local sleep; cap it so it can't be used to stall out a run. */
export const MAX_WAIT_MS = 10_000;

export interface BoundsPolicy {
  /** `--unbounded` — disables the coordinate check entirely. */
  unbounded: boolean;
  /** The recorded target's rect, in pixels, global top-left-origin space. */
  bounds?: Rect;
}

export function isWithinBounds(bounds: Rect, x: number, y: number): boolean {
  return (
    x >= bounds.x && x <= bounds.x + bounds.width && y >= bounds.y && y <= bounds.y + bounds.height
  );
}

/**
 * Rejects an out-of-bounds coordinate with `INPUT_OUT_OF_BOUNDS`, which ends
 * the run `failed`. A bounded run with no known target rect is treated as
 * unbounded — there is nothing to clamp against, and inventing a rect would be
 * worse than not checking.
 */
export function assertWithinBounds(
  policy: BoundsPolicy,
  coordinates: ReadonlyArray<{ x: number; y: number }>,
  toolName: string,
): void {
  if (policy.unbounded || policy.bounds === undefined) return;
  const { bounds } = policy;
  for (const { x, y } of coordinates) {
    if (!isWithinBounds(bounds, x, y)) {
      throw new OperatorError(
        OPERATOR_ERROR_CODES.INPUT_OUT_OF_BOUNDS,
        `${toolName}: coordinate (${x}, ${y}) is outside the target bounds (${bounds.x}, ${bounds.y}, ${bounds.width}x${bounds.height}). Re-run with --unbounded to allow input outside the recorded target.`,
      );
    }
  }
}

/**
 * A wall-clock budget shared by the loop, the model call, and `wait`. The clock
 * is injectable so the whole runtime reads one consistent time source — tests
 * can drive a fake clock without any component silently falling back to
 * `Date.now()`.
 */
export class Deadline {
  readonly startedAtMs: number;
  readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(timeoutMs: number, now: () => number = Date.now) {
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.startedAtMs = now();
  }

  elapsedMs(): number {
    return this.now() - this.startedAtMs;
  }

  remainingMs(): number {
    return Math.max(0, this.timeoutMs - this.elapsedMs());
  }

  expired(): boolean {
    return this.remainingMs() <= 0;
  }
}

/** Bounded local sleep; resolves early on abort so the kill switch is prompt. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  const duration = Math.max(0, Math.min(ms, MAX_WAIT_MS));
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, duration);
    function onAbort() {
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
