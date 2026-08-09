import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Writable } from "node:stream";
import {
  type CancelRecordingResult,
  DaemonError,
  WINDOWER_HOME_ENV,
  connectToDaemon,
} from "@windower/core";
import { SessionStore } from "@windower/engine";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerCancelCommand, renderCancelResult } from "./cancel.js";

vi.mock("@windower/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@windower/core")>();
  return { ...actual, connectToDaemon: vi.fn() };
});

describe("renderCancelResult", () => {
  it("confirms cancellation with the session id", () => {
    const result: CancelRecordingResult = { canceled: true };
    expect(renderCancelResult("sess-1", result)).toBe("Canceled recording session sess-1");
  });
});

// `windower cancel`'s `attach`-mode dead-owner fallback wired end-to-end,
// mirroring stop.test.ts's coverage of `stop` — marks `canceled` rather than
// `failed`.
function spyOnWrite(stream: Writable): { calls: string[]; restore: () => void } {
  const calls: string[] = [];
  const original = stream.write.bind(stream);
  const spy = vi.spyOn(stream, "write").mockImplementation(((chunk: string) => {
    calls.push(chunk);
    return true;
  }) as unknown as typeof original);
  return { calls, restore: () => spy.mockRestore() };
}

async function runCancel(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerCancelCommand(program);
  await program.parseAsync(["cancel", ...args], { from: "user" });
}

describe("registerCancelCommand (attach mode, dead-owner fallback)", () => {
  const mockedConnectToDaemon = vi.mocked(connectToDaemon);
  let home: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "windower-cancel-test-"));
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

  it("marks an orphaned pending session canceled when no daemon is listening", async () => {
    const store = new SessionStore();
    await store.save({ ...baseSession, state: "pending" });
    mockedConnectToDaemon.mockRejectedValue(
      new DaemonError("DAEMON_UNREACHABLE", "Could not connect to daemon"),
    );

    const stdoutWrite = spyOnWrite(process.stdout);
    const originalExitCode = process.exitCode;

    await runCancel(["sess-1", "--json"]);

    expect(stdoutWrite.calls.join("")).toContain('"state": "canceled"');
    expect(process.exitCode).toBeFalsy();

    const reloaded = new SessionStore();
    await reloaded.load();
    expect(reloaded.get("sess-1")?.state).toBe("canceled");

    stdoutWrite.restore();
    process.exitCode = originalExitCode as number | string | undefined;
  });
});
