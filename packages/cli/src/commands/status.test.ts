import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Writable } from "node:stream";
import type { RecordingSession } from "@windower/core";
import { WINDOWER_HOME_ENV } from "@windower/core";
import { SessionStore } from "@windower/engine";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerStatusCommand, renderStatus } from "./status.js";

const BASE_SESSION: RecordingSession = {
  id: "sess-1",
  state: "recording",
  target: {
    kind: "window",
    id: "42",
    title: "Terminal",
    appName: "iTerm2",
    appBundleId: "com.googlecode.iterm2",
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    isFocused: true,
    resizable: true,
  },
  video: { fps: 30, codec: "h264", container: "mp4", quality: "high", showCursor: true },
  audio: { tracks: [], separateTracks: false },
  startedAt: "2026-08-09T10:00:00.000Z",
};

describe("renderStatus", () => {
  it("reports state, target summary, and elapsed time between startedAt and stoppedAt", () => {
    const session: RecordingSession = {
      ...BASE_SESSION,
      state: "finalized",
      stoppedAt: "2026-08-09T10:01:30.000Z",
      outputPath: "/out/recording.mp4",
    };
    const output = renderStatus(session);
    expect(output).toContain("Session sess-1: finalized");
    expect(output).toContain("Terminal");
    expect(output).toContain("iTerm2");
    expect(output).toContain("01:30");
    expect(output).toContain("/out/recording.mp4");
  });

  it("summarizes display and region targets", () => {
    const display = renderStatus({
      ...BASE_SESSION,
      target: {
        kind: "display",
        id: "1",
        name: "Built-in",
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        isPrimary: true,
        scaleFactor: 2,
      },
    });
    expect(display).toContain("display 1 (Built-in)");

    const region = renderStatus({
      ...BASE_SESSION,
      target: { kind: "region", displayId: "1", bounds: { x: 0, y: 0, width: 400, height: 300 } },
    });
    expect(region).toContain("region on display 1");
  });

  it("includes error details when present", () => {
    const session: RecordingSession = {
      ...BASE_SESSION,
      state: "failed",
      error: { code: "SIDECAR_CRASHED", message: "sidecar exited unexpectedly" },
    };
    expect(renderStatus(session)).toContain("[SIDECAR_CRASHED] sidecar exited unexpectedly");
  });

  it("surfaces a CAPTURE_FAILED session error (contracts/sidecar-protocol.md taxonomy code) in `windower status` output", () => {
    const session: RecordingSession = {
      ...BASE_SESSION,
      state: "failed",
      stoppedAt: "2026-08-09T10:00:05.000Z",
      error: { code: "CAPTURE_FAILED", message: "Sidecar-initiated stop: target-closed" },
    };
    const output = renderStatus(session);
    expect(output).toContain("Session sess-1: failed");
    expect(output).toContain("[CAPTURE_FAILED] Sidecar-initiated stop: target-closed");
  });
});

// `windower status` reads `SessionStore` directly (a "plain disk read" per
// phase-20-daemon-optional.md) — no daemon involved at all, not even a
// `LocalWindower`. Verified end-to-end through the real command action.
function spyOnWrite(stream: Writable): { calls: string[]; restore: () => void } {
  const calls: string[] = [];
  const original = stream.write.bind(stream);
  const spy = vi.spyOn(stream, "write").mockImplementation(((chunk: string) => {
    calls.push(chunk);
    return true;
  }) as unknown as typeof original);
  return { calls, restore: () => spy.mockRestore() };
}

async function runStatus(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerStatusCommand(program);
  await program.parseAsync(["status", ...args], { from: "user" });
}

describe("registerStatusCommand (plain disk read)", () => {
  let home: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "windower-status-test-"));
    originalHome = process.env[WINDOWER_HOME_ENV];
    process.env[WINDOWER_HOME_ENV] = home;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env[WINDOWER_HOME_ENV];
    else process.env[WINDOWER_HOME_ENV] = originalHome;
    await rm(home, { recursive: true, force: true });
  });

  it("reads a session straight from disk, no daemon required", async () => {
    const store = new SessionStore();
    await store.save(BASE_SESSION);

    const stdoutWrite = spyOnWrite(process.stdout);
    await runStatus(["sess-1", "--json"]);

    expect(stdoutWrite.calls.join("")).toContain('"id": "sess-1"');
    stdoutWrite.restore();
  });

  it("reports SESSION_NOT_FOUND for an unknown session id", async () => {
    const stderrWrite = spyOnWrite(process.stderr);
    const originalExitCode = process.exitCode;

    await runStatus(["nonexistent", "--json"]);

    expect(stderrWrite.calls.join("")).toContain("SESSION_NOT_FOUND");
    expect(process.exitCode).toBe(1);

    stderrWrite.restore();
    process.exitCode = originalExitCode as number | string | undefined;
  });
});
