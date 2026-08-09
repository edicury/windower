import type { Writable } from "node:stream";
import { type DaemonClient, DaemonError, ensureDaemonRunning } from "@windower/core";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerResizeCommand, renderResizeResult } from "./resize.js";

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

// `windower resize` propagation of a DaemonError all the way through the
// real command action (`registerResizeCommand`'s `.action(...)`, `withDaemon`,
// `printError`) — not just `renderResizeResult`'s success-path rendering.
// `ensureDaemonRunning` is mocked (it spawns a real daemon process, which
// unit tests can't do) so the resolved `DaemonClient` is a fake whose
// `resizeWindow` rejects with the taxonomy code under test.
vi.mock("@windower/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@windower/core")>();
  return { ...actual, ensureDaemonRunning: vi.fn() };
});

function spyOnWrite(stream: Writable): { calls: string[]; restore: () => void } {
  const calls: string[] = [];
  const original = stream.write.bind(stream);
  const spy = vi.spyOn(stream, "write").mockImplementation(((chunk: string) => {
    calls.push(chunk);
    return true;
  }) as unknown as typeof original);
  return { calls, restore: () => spy.mockRestore() };
}

function fakeDaemonClient(resizeWindow: DaemonClient["resizeWindow"]): DaemonClient {
  return { dispose: () => {}, resizeWindow } as unknown as DaemonClient;
}

async function runResize(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerResizeCommand(program);
  await program.parseAsync(["resize", ...args], { from: "user" });
}

describe("registerResizeCommand (CLI propagation of DaemonError)", () => {
  const mockedEnsureDaemonRunning = vi.mocked(ensureDaemonRunning);
  let stderrWrite: ReturnType<typeof spyOnWrite>;
  let originalExitCode: number | string | null | undefined;

  beforeEach(() => {
    stderrWrite = spyOnWrite(process.stderr);
    originalExitCode = process.exitCode;
  });

  afterEach(() => {
    stderrWrite.restore();
    process.exitCode = originalExitCode as number | string | undefined;
    mockedEnsureDaemonRunning.mockReset();
  });

  it("surfaces RESIZE_UNSUPPORTED (window-control capability absent) with the generic failure exit code", async () => {
    mockedEnsureDaemonRunning.mockResolvedValue(
      fakeDaemonClient(
        vi.fn().mockRejectedValue(new DaemonError("RESIZE_UNSUPPORTED", "Backend does not support window-control")),
      ),
    );

    await runResize([
      "--window",
      "42",
      "--width",
      "100",
      "--height",
      "100",
      "--x",
      "0",
      "--y",
      "0",
      "--json",
    ]);

    expect(stderrWrite.calls.join("")).toContain("RESIZE_UNSUPPORTED");
    expect(process.exitCode).toBe(1);
  });

  it("surfaces UNSUPPORTED_CAPABILITY with the generic failure exit code", async () => {
    mockedEnsureDaemonRunning.mockResolvedValue(
      fakeDaemonClient(
        vi.fn().mockRejectedValue(new DaemonError("UNSUPPORTED_CAPABILITY", "Sidecar does not advertise resizeWindow")),
      ),
    );

    await runResize([
      "--window",
      "42",
      "--width",
      "100",
      "--height",
      "100",
      "--x",
      "0",
      "--y",
      "0",
      "--json",
    ]);

    expect(stderrWrite.calls.join("")).toContain("UNSUPPORTED_CAPABILITY");
    expect(process.exitCode).toBe(1);
  });

  it("surfaces PERMISSION_DENIED (Accessibility not granted, window-control gated) with its own exit code", async () => {
    mockedEnsureDaemonRunning.mockResolvedValue(
      fakeDaemonClient(
        vi.fn().mockRejectedValue(new DaemonError("PERMISSION_DENIED", "Accessibility permission not granted")),
      ),
    );

    await runResize([
      "--window",
      "42",
      "--width",
      "100",
      "--height",
      "100",
      "--x",
      "0",
      "--y",
      "0",
      "--json",
    ]);

    expect(stderrWrite.calls.join("")).toContain("PERMISSION_DENIED");
    // 5 === EXIT_PERMISSION_DENIED (packages/cli/src/exit-codes.ts) — asserted
    // as a literal here (rather than importing the constant) so this test
    // also catches an accidental renumbering of the exit-code map.
    expect(process.exitCode).toBe(5);
  });
});
