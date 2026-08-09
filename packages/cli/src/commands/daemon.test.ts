import type { Writable } from "node:stream";
import { type DaemonClient, DaemonError, connectToDaemon, restartDaemon } from "@windower/core";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerDaemonCommand } from "./daemon.js";

// `windower daemon restart` propagation through the real command action
// (`registerDaemonCommand`, `restartDaemon`, `printError`) — `restartDaemon`
// and `connectToDaemon` are mocked since the real implementations spawn/
// connect to an actual daemon process, which a unit test can't do.
vi.mock("@windower/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@windower/core")>();
  return { ...actual, restartDaemon: vi.fn(), connectToDaemon: vi.fn() };
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

function fakeDaemonClient(): DaemonClient {
  return { dispose: () => {}, shutdown: vi.fn().mockResolvedValue({ shuttingDown: true }) } as unknown as DaemonClient;
}

async function runDaemon(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerDaemonCommand(program);
  await program.parseAsync(["daemon", ...args], { from: "user" });
}

describe("registerDaemonCommand restart", () => {
  const mockedRestartDaemon = vi.mocked(restartDaemon);
  const mockedConnectToDaemon = vi.mocked(connectToDaemon);
  let stdoutWrite: ReturnType<typeof spyOnWrite>;
  let stderrWrite: ReturnType<typeof spyOnWrite>;
  let originalExitCode: number | string | null | undefined;

  beforeEach(() => {
    stdoutWrite = spyOnWrite(process.stdout);
    stderrWrite = spyOnWrite(process.stderr);
    originalExitCode = process.exitCode;
  });

  afterEach(() => {
    stdoutWrite.restore();
    stderrWrite.restore();
    process.exitCode = originalExitCode as number | string | undefined;
    mockedRestartDaemon.mockReset();
    mockedConnectToDaemon.mockReset();
  });

  it("restarts successfully and reports { restarted: true }", async () => {
    mockedRestartDaemon.mockResolvedValue(fakeDaemonClient());

    await runDaemon(["restart", "--json"]);

    expect(mockedRestartDaemon).toHaveBeenCalledWith({ force: false });
    expect(stdoutWrite.calls.join("")).toContain('"restarted": true');
    expect(process.exitCode).toBeFalsy();
  });

  it("passes force:true through when --force is given", async () => {
    mockedRestartDaemon.mockResolvedValue(fakeDaemonClient());

    await runDaemon(["restart", "--force", "--json"]);

    expect(mockedRestartDaemon).toHaveBeenCalledWith({ force: true });
  });

  it("reports { restarted: false } when nothing was running (DAEMON_UNREACHABLE)", async () => {
    mockedRestartDaemon.mockRejectedValue(
      new DaemonError("DAEMON_UNREACHABLE", "Could not connect to daemon"),
    );

    await runDaemon(["restart", "--json"]);

    expect(stdoutWrite.calls.join("")).toContain('"restarted": false');
    expect(process.exitCode).toBeFalsy();
  });

  it("surfaces DAEMON_BUSY with its own exit code when something is in flight and --force wasn't passed", async () => {
    mockedRestartDaemon.mockRejectedValue(
      new DaemonError("DAEMON_BUSY", "recording session(s) sess-1 still active"),
    );

    await runDaemon(["restart", "--json"]);

    expect(stderrWrite.calls.join("")).toContain("DAEMON_BUSY");
    // 6 === EXIT_DAEMON_BUSY (packages/cli/src/exit-codes.ts) — asserted as a
    // literal so this test also catches an accidental renumbering.
    expect(process.exitCode).toBe(6);
  });
});
