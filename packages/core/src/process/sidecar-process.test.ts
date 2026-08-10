import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SidecarError } from "../protocol/errors.js";
import {
  CONTROL_BINARY_PATH_ENV,
  SIDECAR_BINARY_PATH_ENV,
  findRepoRoot,
  resolveSidecarBinaryPath,
} from "./sidecar-path.js";
import { type SidecarProcess, spawnSidecar } from "./sidecar-process.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, "fixtures", "fake-sidecar-cli.mjs");

/** Spawns the fixture via `node`, since it's a script rather than a binary. */
function spawnFixture(args: string[] = [], env: NodeJS.ProcessEnv = process.env): SidecarProcess {
  return spawnSidecar({ binaryPath: process.execPath, args: [FIXTURE_PATH, ...args], env });
}

/**
 * Runs `fn` with exactly the given sidecar-path env vars set (every other
 * surface's override cleared), restoring the ambient environment afterward.
 * Both surfaces have their own var since Phase 21, so a test that only
 * cleared one could pick up the other from the developer's shell.
 */
function withEnv(vars: Record<string, string>, fn: () => void): void {
  const managed = [SIDECAR_BINARY_PATH_ENV, CONTROL_BINARY_PATH_ENV];
  const original = new Map(managed.map((name) => [name, process.env[name]]));
  try {
    for (const name of managed) delete process.env[name];
    for (const [name, value] of Object.entries(vars)) process.env[name] = value;
    fn();
  } finally {
    for (const [name, value] of original) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

describe("resolveSidecarBinaryPath / findRepoRoot", () => {
  it("finds the monorepo root by walking up to pnpm-workspace.yaml", () => {
    const root = findRepoRoot(__dirname);
    expect(existsSync(join(root, "pnpm-workspace.yaml"))).toBe(true);
  });

  it("honors the WINDOWER_SIDECAR_BINARY_PATH env var override (capture surface)", () => {
    withEnv({ [SIDECAR_BINARY_PATH_ENV]: "/custom/path/to/capture" }, () => {
      expect(resolveSidecarBinaryPath("capture", "darwin")).toBe("/custom/path/to/capture");
    });
  });

  it("honors the WINDOWER_CONTROL_BINARY_PATH env var override (control surface)", () => {
    withEnv({ [CONTROL_BINARY_PATH_ENV]: "/custom/path/to/control" }, () => {
      expect(resolveSidecarBinaryPath("control", "darwin")).toBe("/custom/path/to/control");
    });
  });

  it("keeps the two surfaces' overrides independent", () => {
    withEnv({ [SIDECAR_BINARY_PATH_ENV]: "/custom/path/to/capture" }, () => {
      // The legacy var names the capture binary only — it must not be picked
      // up for the control surface, which would spawn the wrong binary.
      expect(resolveSidecarBinaryPath("control", "darwin")).not.toBe("/custom/path/to/capture");
    });
  });

  it("defaults to the capture surface when none is given", () => {
    withEnv({ [SIDECAR_BINARY_PATH_ENV]: "/custom/path/to/capture" }, () => {
      expect(resolveSidecarBinaryPath()).toBe("/custom/path/to/capture");
    });
  });

  it("resolves the dev-build paths for darwin relative to the repo root", () => {
    withEnv({}, () => {
      expect(
        resolveSidecarBinaryPath("capture", "darwin").endsWith(
          "native/macos/.build/debug/windower-capture-macos",
        ),
      ).toBe(true);
      expect(
        resolveSidecarBinaryPath("control", "darwin").endsWith(
          "native/macos/.build/debug/windower-control-macos",
        ),
      ).toBe(true);
    });
  });

  it("throws a clear error for platforms with no sidecar yet", () => {
    withEnv({}, () => {
      expect(() => resolveSidecarBinaryPath("capture", "win32")).toThrow(
        /no sidecar available for platform/i,
      );
      expect(() => resolveSidecarBinaryPath("control", "win32")).toThrow(
        /no sidecar available for platform/i,
      );
    });
  });
});

describe("SidecarProcess (real child process, fixture fake sidecar)", () => {
  let proc: SidecarProcess | undefined;

  afterEach(async () => {
    if (proc && !proc.hasExited) {
      await proc.terminate();
    }
    proc = undefined;
  });

  it("spawns a real OS child process and round-trips describe() over its stdio", async () => {
    proc = spawnFixture([], { ...process.env, FAKE_SIDECAR_VERSION: "1.2.3" });
    expect(proc.pid).toBeGreaterThan(0);

    const result = await proc.client.describe();
    expect(result).toEqual({
      platform: "macos",
      version: "1.2.3",
      capabilities: ["capture.display"],
    });
  });

  it("captures stderr lines without treating them as protocol data", async () => {
    const stderrLines: string[] = [];
    proc = spawnSidecar({
      binaryPath: process.execPath,
      args: [FIXTURE_PATH],
      onStderrLine: (line) => stderrLines.push(line),
    });
    await proc.client.describe();
    // Give the stderr "data" event a tick to fire relative to stdout.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stderrLines.some((line) => line.includes("fake-sidecar-cli: started"))).toBe(true);
  });

  it("terminates the child cleanly via SIGTERM and disposes the client", async () => {
    proc = spawnFixture();
    await proc.client.describe();
    expect(proc.hasExited).toBe(false);

    await proc.terminate();
    expect(proc.hasExited).toBe(true);

    await expect(proc.client.describe()).rejects.toThrow();
  });

  it("rejects in-flight requests if the child process dies mid-request", async () => {
    proc = spawnFixture(["--ignore-requests"]);
    const pending = proc.client.describe();

    // Give the fixture time to receive (and ignore) the request, then kill it.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await proc.terminate();

    await expect(pending).rejects.toThrow();
  });

  it("rejects in-flight requests if the child exits unexpectedly (not via terminate())", async () => {
    proc = spawnFixture(["--exit-after-describe"]);
    const first = await proc.client.describe();
    expect(first.version).toBe("0.0.0-fixture");

    // The fixture process.exit(0)s right after answering describe; the next
    // call has nothing to talk to.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(proc.hasExited).toBe(true);

    await expect(proc.client.describe()).rejects.toThrow(SidecarError);
  });
});
