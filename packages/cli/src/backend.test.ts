import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Writable } from "node:stream";
import {
  DaemonError,
  WINDOWER_HOME_ENV,
  connectToDaemon,
  ensureDaemonRunning,
} from "@windower/core";
import { LocalWindower, SessionStore } from "@windower/engine";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireBackend,
  effectiveMode,
  markOrphanedSessionTerminal,
  resolveForcedMode,
  withAttachBackend,
  withBackend,
} from "./backend.js";

vi.mock("@windower/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@windower/core")>();
  return { ...actual, ensureDaemonRunning: vi.fn(), connectToDaemon: vi.fn() };
});

vi.mock("@windower/engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@windower/engine")>();
  return { ...actual, LocalWindower: vi.fn() };
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

describe("resolveForcedMode", () => {
  const originalEnv = process.env.WINDOWER_BACKEND;

  // An `= undefined` assignment would leave the var set to the *string*
  // "undefined" (Node coerces env values to strings), not actually unset it
  // — `delete` is the only way to restore "the var was never set" for this
  // describe block's assertions.
  afterEach(() => {
    // biome-ignore lint/performance/noDelete: see the block comment above.
    if (originalEnv === undefined) delete process.env.WINDOWER_BACKEND;
    else process.env.WINDOWER_BACKEND = originalEnv;
  });

  it("returns undefined when neither the flag nor the env var is set", () => {
    // biome-ignore lint/performance/noDelete: see the block comment above `describe`.
    delete process.env.WINDOWER_BACKEND;
    expect(resolveForcedMode({})).toBeUndefined();
  });

  it("--daemon forces daemon mode", () => {
    expect(resolveForcedMode({ daemon: true })).toBe("daemon");
  });

  it("--no-daemon forces local mode", () => {
    expect(resolveForcedMode({ daemon: false })).toBe("local");
  });

  it("falls back to WINDOWER_BACKEND when no flag was passed", () => {
    process.env.WINDOWER_BACKEND = "daemon";
    expect(resolveForcedMode({})).toBe("daemon");
    process.env.WINDOWER_BACKEND = "local";
    expect(resolveForcedMode({})).toBe("local");
  });

  it("an explicit flag wins over WINDOWER_BACKEND", () => {
    process.env.WINDOWER_BACKEND = "local";
    expect(resolveForcedMode({ daemon: true })).toBe("daemon");
  });

  it("ignores a garbage WINDOWER_BACKEND value", () => {
    process.env.WINDOWER_BACKEND = "bogus";
    expect(resolveForcedMode({})).toBeUndefined();
  });
});

describe("effectiveMode", () => {
  it("applies forcedMode for a policy-local command", () => {
    expect(effectiveMode("targets", { forcedMode: "daemon" })).toBe("daemon");
  });

  it("applies forcedMode for a policy-daemon command", () => {
    expect(effectiveMode("start", { forcedMode: "local" })).toBe("local");
  });

  it("ignores forcedMode for an attach-mode command", () => {
    expect(effectiveMode("stop", { forcedMode: "daemon" })).toBe("attach");
    expect(effectiveMode("daemon status", { forcedMode: "local" })).toBe("attach");
  });

  it("falls through to the policy table when no forcedMode is given", () => {
    expect(effectiveMode("record")).toBe("local");
    expect(effectiveMode("start")).toBe("daemon");
  });
});

describe("acquireBackend / withBackend", () => {
  const mockedEnsureDaemonRunning = vi.mocked(ensureDaemonRunning);
  const mockedConnectToDaemon = vi.mocked(connectToDaemon);
  const mockedLocalWindower = vi.mocked(LocalWindower);

  afterEach(() => {
    mockedEnsureDaemonRunning.mockReset();
    mockedConnectToDaemon.mockReset();
    mockedLocalWindower.mockReset();
  });

  it("local mode constructs a LocalWindower and never touches the daemon", async () => {
    mockedLocalWindower.mockImplementation(() => ({}) as unknown as LocalWindower);

    const acquired = await acquireBackend("targets");
    expect(acquired.mode).toBe("local");
    expect(mockedLocalWindower).toHaveBeenCalledTimes(1);
    expect(mockedEnsureDaemonRunning).not.toHaveBeenCalled();
    expect(mockedConnectToDaemon).not.toHaveBeenCalled();
    acquired.dispose();
  });

  it("daemon mode auto-spawns via ensureDaemonRunning", async () => {
    const dispose = vi.fn();
    mockedEnsureDaemonRunning.mockResolvedValue({ dispose } as never);

    const acquired = await acquireBackend("start");
    expect(acquired.mode).toBe("daemon");
    expect(mockedEnsureDaemonRunning).toHaveBeenCalledTimes(1);
    acquired.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("attach mode connects without spawning, even when forcedMode requests daemon", async () => {
    const dispose = vi.fn();
    mockedConnectToDaemon.mockResolvedValue({ dispose } as never);

    const acquired = await acquireBackend("stop", { forcedMode: "daemon" });
    expect(acquired.mode).toBe("attach");
    expect(mockedConnectToDaemon).toHaveBeenCalledTimes(1);
    expect(mockedEnsureDaemonRunning).not.toHaveBeenCalled();
    acquired.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("withBackend runs fn against the acquired backend and disposes it", async () => {
    const dispose = vi.fn();
    mockedLocalWindower.mockImplementation(() => ({ dispose }) as unknown as LocalWindower);

    const fn = vi.fn().mockResolvedValue(undefined);
    await withBackend("targets", false, fn);

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("withBackend prints the error and sets a nonzero exit code when fn throws", async () => {
    mockedLocalWindower.mockImplementation(() => ({}) as unknown as LocalWindower);
    const stderrWrite = spyOnWrite(process.stderr);
    const originalExitCode = process.exitCode;

    await withBackend("targets", true, async () => {
      throw new DaemonError("INVALID_ARGS", "bad input");
    });

    expect(stderrWrite.calls.join("")).toContain("INVALID_ARGS");
    expect(process.exitCode).toBe(3);

    stderrWrite.restore();
    process.exitCode = originalExitCode as number | string | undefined;
  });

  it("withBackend disposes the backend even when fn throws", async () => {
    const dispose = vi.fn();
    mockedEnsureDaemonRunning.mockResolvedValue({ dispose } as never);
    const originalExitCode = process.exitCode;

    await withBackend("start", true, async () => {
      throw new DaemonError("INVALID_ARGS", "bad input");
    });

    expect(dispose).toHaveBeenCalledTimes(1);
    process.exitCode = originalExitCode as number | string | undefined;
  });
});

describe("markOrphanedSessionTerminal / withAttachBackend", () => {
  let home: string;
  let originalHome: string | undefined;

  const mockedConnectToDaemon = vi.mocked(connectToDaemon);

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "windower-backend-test-"));
    originalHome = process.env[WINDOWER_HOME_ENV];
    process.env[WINDOWER_HOME_ENV] = home;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env[WINDOWER_HOME_ENV];
    else process.env[WINDOWER_HOME_ENV] = originalHome;
    await rm(home, { recursive: true, force: true });
    mockedConnectToDaemon.mockReset();
  });

  const baseSession = {
    id: "sess-1",
    target: {
      kind: "display" as const,
      id: "display-1",
      name: "Built-in",
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      isPrimary: true,
      scaleFactor: 2,
    },
    video: {
      fps: 30 as const,
      codec: "h264" as const,
      container: "mp4" as const,
      quality: "high" as const,
      showCursor: true,
    },
    audio: { tracks: [], separateTracks: false },
    startedAt: "2026-08-09T10:00:00.000Z",
  };

  it("throws SESSION_NOT_FOUND for an unknown session id", async () => {
    await expect(markOrphanedSessionTerminal("nope", "failed")).rejects.toThrow(
      /Session "nope" not found/,
    );
  });

  it("marks a recording session failed and persists it to disk", async () => {
    const store = new SessionStore();
    await store.save({ ...baseSession, state: "recording" });

    const result = await markOrphanedSessionTerminal("sess-1", "failed");
    expect(result).toEqual({ sessionId: "sess-1", state: "failed", alreadyTerminal: false });

    const reloaded = new SessionStore();
    await reloaded.load();
    const session = reloaded.get("sess-1");
    expect(session?.state).toBe("failed");
    expect(session?.error?.code).toBe("DAEMON_UNREACHABLE");
  });

  it("marks a pending session canceled", async () => {
    const store = new SessionStore();
    await store.save({ ...baseSession, state: "pending" });

    const result = await markOrphanedSessionTerminal("sess-1", "canceled");
    expect(result.alreadyTerminal).toBe(false);
    expect(result.state).toBe("canceled");
  });

  it("is a no-op (alreadyTerminal: true) for a session that's already terminal", async () => {
    const store = new SessionStore();
    await store.save({ ...baseSession, state: "finalized", outputPath: "/out/rec.mp4" });

    const result = await markOrphanedSessionTerminal("sess-1", "failed");
    expect(result).toEqual({ sessionId: "sess-1", state: "finalized", alreadyTerminal: true });

    const reloaded = new SessionStore();
    await reloaded.load();
    expect(reloaded.get("sess-1")?.state).toBe("finalized");
    expect(reloaded.get("sess-1")?.outputPath).toBe("/out/rec.mp4");
  });

  it("withAttachBackend runs fn normally when a daemon is listening", async () => {
    const dispose = vi.fn();
    const fn = vi.fn().mockResolvedValue(undefined);
    mockedConnectToDaemon.mockResolvedValue({ dispose } as never);

    await withAttachBackend("stop", false, "sess-1", "failed", fn);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("withAttachBackend falls back to marking the session terminal when nothing is listening", async () => {
    const store = new SessionStore();
    await store.save({ ...baseSession, state: "recording" });

    mockedConnectToDaemon.mockRejectedValue(
      new DaemonError("DAEMON_UNREACHABLE", "Could not connect to daemon"),
    );
    const stdoutWrite = spyOnWrite(process.stdout);
    const originalExitCode = process.exitCode;

    const fn = vi.fn();
    await withAttachBackend("stop", true, "sess-1", "failed", fn);

    expect(fn).not.toHaveBeenCalled();
    expect(stdoutWrite.calls.join("")).toContain('"state": "failed"');
    expect(process.exitCode).toBeFalsy();

    const reloaded = new SessionStore();
    await reloaded.load();
    expect(reloaded.get("sess-1")?.state).toBe("failed");

    stdoutWrite.restore();
    process.exitCode = originalExitCode as number | string | undefined;
  });

  it("withAttachBackend surfaces a non-DAEMON_UNREACHABLE error normally", async () => {
    mockedConnectToDaemon.mockRejectedValue(new DaemonError("INVALID_ARGS", "bad"));
    const stderrWrite = spyOnWrite(process.stderr);
    const originalExitCode = process.exitCode;

    await withAttachBackend("stop", true, "sess-1", "failed", vi.fn());

    expect(stderrWrite.calls.join("")).toContain("INVALID_ARGS");
    expect(process.exitCode).toBe(3);

    stderrWrite.restore();
    process.exitCode = originalExitCode as number | string | undefined;
  });
});
