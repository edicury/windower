import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Writable } from "node:stream";
import {
  DaemonError,
  type StopRecordingResult,
  WINDOWER_HOME_ENV,
  connectToDaemon,
} from "@windower/core";
import { SessionStore } from "@windower/engine";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildNarrationParam, registerStopCommand, renderStopResult } from "./stop.js";

vi.mock("@windower/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@windower/core")>();
  return { ...actual, connectToDaemon: vi.fn() };
});

describe("buildNarrationParam", () => {
  it("returns undefined when neither flag is given", () => {
    expect(buildNarrationParam({})).toBeUndefined();
  });

  it("builds a narration param when both flags are given", () => {
    expect(buildNarrationParam({ narration: "/tmp/n.wav", narrationOffset: "500" })).toEqual({
      filePath: "/tmp/n.wav",
      offsetMs: 500,
    });
  });

  it("throws INVALID_ARGS when only --narration is given", () => {
    expect(() => buildNarrationParam({ narration: "/tmp/n.wav" })).toThrow(/together/);
  });

  it("throws INVALID_ARGS when only --narration-offset is given", () => {
    expect(() => buildNarrationParam({ narrationOffset: "500" })).toThrow(/together/);
  });

  it("throws INVALID_ARGS when the offset isn't numeric", () => {
    expect(() =>
      buildNarrationParam({ narration: "/tmp/n.wav", narrationOffset: "not-a-number" }),
    ).toThrow(/narration-offset/);
  });
});

describe("renderStopResult", () => {
  it("reports outputPath and manifestPath", () => {
    const result: StopRecordingResult = {
      outputPath: "/out/rec.mp4",
      manifestPath: "/out/rec.manifest.json",
      manifest: {} as StopRecordingResult["manifest"],
    };
    const output = renderStopResult(result);
    expect(output).toContain("/out/rec.mp4");
    expect(output).toContain("/out/rec.manifest.json");
    expect(output).not.toContain("Event timeline");
  });

  it("reports eventTimelinePath when present", () => {
    const result: StopRecordingResult = {
      outputPath: "/out/rec.mp4",
      manifestPath: "/out/rec.manifest.json",
      eventTimelinePath: "/out/rec.events.json",
      manifest: {} as StopRecordingResult["manifest"],
    };
    expect(renderStopResult(result)).toContain("/out/rec.events.json");
  });
});

// `windower stop`'s `attach`-mode dead-owner fallback wired end-to-end
// through the real command action (registerStopCommand -> withAttachBackend
// -> markOrphanedSessionTerminal), not just backend.test.ts's direct calls.
function spyOnWrite(stream: Writable): { calls: string[]; restore: () => void } {
  const calls: string[] = [];
  const original = stream.write.bind(stream);
  const spy = vi.spyOn(stream, "write").mockImplementation(((chunk: string) => {
    calls.push(chunk);
    return true;
  }) as unknown as typeof original);
  return { calls, restore: () => spy.mockRestore() };
}

async function runStop(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerStopCommand(program);
  await program.parseAsync(["stop", ...args], { from: "user" });
}

describe("registerStopCommand (attach mode, dead-owner fallback)", () => {
  const mockedConnectToDaemon = vi.mocked(connectToDaemon);
  let home: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "windower-stop-test-"));
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

  it("marks an orphaned recording session failed when no daemon is listening", async () => {
    const store = new SessionStore();
    await store.save({ ...baseSession, state: "recording" });
    mockedConnectToDaemon.mockRejectedValue(
      new DaemonError("DAEMON_UNREACHABLE", "Could not connect to daemon"),
    );

    const stdoutWrite = spyOnWrite(process.stdout);
    const originalExitCode = process.exitCode;

    await runStop(["sess-1", "--json"]);

    expect(stdoutWrite.calls.join("")).toContain('"state": "failed"');
    expect(process.exitCode).toBeFalsy();

    const reloaded = new SessionStore();
    await reloaded.load();
    expect(reloaded.get("sess-1")?.state).toBe("failed");

    stdoutWrite.restore();
    process.exitCode = originalExitCode as number | string | undefined;
  });
});
