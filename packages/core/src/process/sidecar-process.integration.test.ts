import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveSidecarBinaryPath } from "./sidecar-path.js";
import { spawnSidecar } from "./sidecar-process.js";

/**
 * Optional integration test against the REAL macOS Swift sidecar binary, if
 * one happens to be built locally (native/macos/.build/debug/...). Skips
 * gracefully — never fails — when the binary isn't present, since most
 * environments (CI, other contributors' machines before a Swift build)
 * won't have it. The primary spawner test suite (sidecar-process.test.ts)
 * uses a Node-script fixture and does not depend on this binary existing.
 */
const binaryPath = (() => {
  try {
    return resolveSidecarBinaryPath("darwin");
  } catch {
    return undefined;
  }
})();

const binaryAvailable = process.platform === "darwin" && !!binaryPath && existsSync(binaryPath);

describe.skipIf(!binaryAvailable)("SidecarProcess (real macOS sidecar binary)", () => {
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
