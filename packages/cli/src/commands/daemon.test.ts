import type { Writable } from "node:stream";
import {
  type DaemonClient,
  DaemonError,
  connectToDaemon,
  killDaemonAndSidecars,
  restartDaemon,
} from "@windower/core";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerDaemonCommand } from "./daemon.js";

// `windower daemon restart`/`kill` propagation through the real command
// action (`registerDaemonCommand`, `restartDaemon`, `killDaemonAndSidecars`,
// `printError`) — the underlying implementations are mocked since the real
// ones spawn/connect to/signal an actual daemon process, which a unit test
// can't do. `FileLock` (used by `daemon kill` to check/release a stale
// `capture.lock`) is mocked at the instance-method level via its prototype
// so the command's `new FileLock(...)` construction still works untouched.
vi.mock("@windower/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@windower/core")>();
  return {
    ...actual,
    restartDaemon: vi.fn(),
    connectToDaemon: vi.fn(),
    killDaemonAndSidecars: vi.fn(),
  };
});

vi.mock("@windower/engine", async () => ({
  captureLockPath: () => "/fake/.windower/capture.lock",
}));

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
  return {
    dispose: () => {},
    shutdown: vi.fn().mockResolvedValue({ shuttingDown: true }),
  } as unknown as DaemonClient;
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

describe("registerDaemonCommand kill", () => {
  const mockedKillDaemonAndSidecars = vi.mocked(killDaemonAndSidecars);
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
    mockedKillDaemonAndSidecars.mockReset();
  });

  it("reports nothing killed when idempotent (nothing was running)", async () => {
    mockedKillDaemonAndSidecars.mockResolvedValue({
      daemonKilled: false,
      daemonPid: undefined,
      sidecarPidsKilled: [],
    });

    await runDaemon(["kill", "--json"]);

    expect(mockedKillDaemonAndSidecars).toHaveBeenCalled();
    const output = stdoutWrite.calls.join("");
    expect(output).toContain('"daemonKilled": false');
    expect(output).toContain('"sidecarPidsKilled": []');
    expect(process.exitCode).toBeFalsy();
  });

  it("reports the killed daemon pid and sidecar pids", async () => {
    mockedKillDaemonAndSidecars.mockResolvedValue({
      daemonKilled: true,
      daemonPid: 4242,
      sidecarPidsKilled: [111, 222],
    });

    await runDaemon(["kill", "--json"]);

    const output = stdoutWrite.calls.join("");
    expect(output).toContain('"daemonKilled": true');
    expect(output).toContain("4242");
    expect(output).toContain("111");
    expect(output).toContain("222");
    expect(process.exitCode).toBeFalsy();
  });

  it("renders a human-readable summary in non-JSON mode", async () => {
    mockedKillDaemonAndSidecars.mockResolvedValue({
      daemonKilled: true,
      daemonPid: 4242,
      sidecarPidsKilled: [111],
    });

    await runDaemon(["kill"]);

    const output = stdoutWrite.calls.join("");
    expect(output).toContain("daemon (pid 4242) killed");
    expect(output).toContain("sidecar(s) killed: 111");
  });

  it("renders 'nothing to kill' in non-JSON mode when idempotent", async () => {
    mockedKillDaemonAndSidecars.mockResolvedValue({
      daemonKilled: false,
      daemonPid: undefined,
      sidecarPidsKilled: [],
    });

    await runDaemon(["kill"]);

    expect(stdoutWrite.calls.join("")).toContain("daemon kill: nothing to kill");
  });

  it("propagates an unexpected error via printError", async () => {
    mockedKillDaemonAndSidecars.mockRejectedValue(new Error("disk on fire"));

    await runDaemon(["kill", "--json"]);

    expect(stderrWrite.calls.join("")).toContain("disk on fire");
    expect(process.exitCode).toBeTruthy();
  });
});
