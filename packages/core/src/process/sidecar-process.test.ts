import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SidecarError } from "../protocol/errors.js";
import { SIDECAR_BINARY_PATH_ENV, findRepoRoot, resolveSidecarBinaryPath } from "./sidecar-path.js";
import { type SidecarProcess, spawnSidecar } from "./sidecar-process.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, "fixtures", "fake-sidecar-cli.mjs");

/** Spawns the fixture via `node`, since it's a script rather than a binary. */
function spawnFixture(args: string[] = [], env: NodeJS.ProcessEnv = process.env): SidecarProcess {
  return spawnSidecar({ binaryPath: process.execPath, args: [FIXTURE_PATH, ...args], env });
}

describe("resolveSidecarBinaryPath / findRepoRoot", () => {
  it("finds the monorepo root by walking up to pnpm-workspace.yaml", () => {
    const root = findRepoRoot(__dirname);
    expect(existsSync(join(root, "pnpm-workspace.yaml"))).toBe(true);
  });

  it("honors the WINDOWER_SIDECAR_BINARY_PATH env var override", () => {
    const original = process.env[SIDECAR_BINARY_PATH_ENV];
    process.env[SIDECAR_BINARY_PATH_ENV] = "/custom/path/to/sidecar";
    try {
      expect(resolveSidecarBinaryPath("darwin")).toBe("/custom/path/to/sidecar");
    } finally {
      if (original === undefined) delete process.env[SIDECAR_BINARY_PATH_ENV];
      else process.env[SIDECAR_BINARY_PATH_ENV] = original;
    }
  });

  it("resolves the dev-build path for darwin relative to the repo root", () => {
    const original = process.env[SIDECAR_BINARY_PATH_ENV];
    delete process.env[SIDECAR_BINARY_PATH_ENV];
    try {
      const resolved = resolveSidecarBinaryPath("darwin");
      expect(resolved.endsWith("native/macos/.build/debug/windower-sidecar-macos")).toBe(true);
    } finally {
      if (original !== undefined) process.env[SIDECAR_BINARY_PATH_ENV] = original;
    }
  });

  it("throws a clear error for platforms with no sidecar yet", () => {
    const original = process.env[SIDECAR_BINARY_PATH_ENV];
    delete process.env[SIDECAR_BINARY_PATH_ENV];
    try {
      expect(() => resolveSidecarBinaryPath("win32")).toThrow(/no sidecar available for platform/i);
    } finally {
      if (original !== undefined) process.env[SIDECAR_BINARY_PATH_ENV] = original;
    }
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
