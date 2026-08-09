import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Writable } from "node:stream";
import type {
  AudioSettings,
  CaptureTarget,
  ListSessionsResult,
  RecordingSession,
  VideoSettings,
} from "@windower/core";
import { WINDOWER_HOME_ENV } from "@windower/core";
import { SessionStore } from "@windower/engine";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerListCommand, renderSessionsTable } from "./list.js";

const VIDEO: VideoSettings = {
  fps: 30,
  codec: "h264",
  container: "mp4",
  quality: "high",
  showCursor: true,
};

const AUDIO: AudioSettings = { tracks: [], separateTracks: false };

const DISPLAY_TARGET: CaptureTarget = {
  kind: "display",
  id: "1",
  name: "Built-in",
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  isPrimary: true,
  scaleFactor: 2,
};

function session(
  id: string,
  state: RecordingSession["state"],
  startedAt: string,
): RecordingSession {
  return { id, state, target: DISPLAY_TARGET, video: VIDEO, audio: AUDIO, startedAt };
}

describe("renderSessionsTable", () => {
  it("reports no sessions found for an empty list", () => {
    expect(renderSessionsTable({ sessions: [] })).toBe("No sessions found.");
  });

  it("renders a header and one row per session", () => {
    const result: ListSessionsResult = {
      sessions: [session("a", "finalized", "2026-08-09T10:00:00.000Z")],
    };
    const output = renderSessionsTable(result);
    const lines = output.split("\n");
    expect(lines[0]).toMatch(/ID/);
    expect(lines[0]).toMatch(/STATE/);
    expect(lines[1]).toContain("a");
    expect(lines[1]).toContain("finalized");
    expect(lines[1]).toContain("display:Built-in");
  });
});

// `windower list` reads `SessionStore` directly (a "plain disk read") — no
// daemon involved. Verified end-to-end through the real command action.
function spyOnWrite(stream: Writable): { calls: string[]; restore: () => void } {
  const calls: string[] = [];
  const original = stream.write.bind(stream);
  const spy = vi.spyOn(stream, "write").mockImplementation(((chunk: string) => {
    calls.push(chunk);
    return true;
  }) as unknown as typeof original);
  return { calls, restore: () => spy.mockRestore() };
}

async function runList(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerListCommand(program);
  await program.parseAsync(["list", ...args], { from: "user" });
}

describe("registerListCommand (plain disk read)", () => {
  let home: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "windower-list-test-"));
    originalHome = process.env[WINDOWER_HOME_ENV];
    process.env[WINDOWER_HOME_ENV] = home;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env[WINDOWER_HOME_ENV];
    else process.env[WINDOWER_HOME_ENV] = originalHome;
    await rm(home, { recursive: true, force: true });
  });

  it("lists sessions straight from disk, no daemon required, even with none present", async () => {
    const stdoutWrite = spyOnWrite(process.stdout);
    await runList(["--json"]);
    expect(stdoutWrite.calls.join("")).toContain('"sessions": []');
    stdoutWrite.restore();
  });

  it("filters by --state", async () => {
    const store = new SessionStore();
    await store.save(session("a", "finalized", "2026-08-09T10:00:00.000Z"));
    await store.save(session("b", "recording", "2026-08-09T10:01:00.000Z"));

    const stdoutWrite = spyOnWrite(process.stdout);
    await runList(["--state", "recording", "--json"]);
    const output = stdoutWrite.calls.join("");
    expect(output).toContain('"id": "b"');
    expect(output).not.toContain('"id": "a"');
    stdoutWrite.restore();
  });
});
