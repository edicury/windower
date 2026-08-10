import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type SidecarSurface, resolveSidecarBinaryPath } from "./sidecar-path.js";
import { spawnSidecar } from "./sidecar-process.js";

/**
 * Optional integration test against the REAL macOS Swift sidecar binaries, if
 * they happen to be built locally (native/macos/.build/debug/...). Skips
 * gracefully — never fails — when a binary isn't present, since most
 * environments (CI, other contributors' machines before a Swift build)
 * won't have it. The primary spawner test suite (sidecar-process.test.ts)
 * uses a Node-script fixture and does not depend on these binaries existing.
 *
 * Phase 21: both surfaces get the same round-trip, since `describe` is the
 * one method both binaries implement.
 */
function resolveIfPresent(surface: SidecarSurface): string | undefined {
  try {
    const path = resolveSidecarBinaryPath(surface, "darwin");
    return existsSync(path) ? path : undefined;
  } catch {
    return undefined;
  }
}

for (const surface of ["capture", "control"] as const) {
  const binaryPath = process.platform === "darwin" ? resolveIfPresent(surface) : undefined;

  describe.skipIf(!binaryPath)(`SidecarProcess (real macOS ${surface} binary)`, () => {
    it("spawns the real sidecar binary and round-trips describe()", async () => {
      const proc = spawnSidecar({ binaryPath });
      try {
        const result = await proc.client.describe();
        expect(result.platform).toBe("macos");
        expect(typeof result.version).toBe("string");
        expect(Array.isArray(result.capabilities)).toBe(true);
      } finally {
        await proc.terminate();
      }
    });
  });
}
