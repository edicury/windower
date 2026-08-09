import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WINDOWER_HOME_ENV, sessionFilePath } from "@windower/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionStore } from "./session-store.js";

describe("SessionStore", () => {
  let home: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "windower-session-store-"));
    originalHome = process.env[WINDOWER_HOME_ENV];
    process.env[WINDOWER_HOME_ENV] = home;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env[WINDOWER_HOME_ENV];
    else process.env[WINDOWER_HOME_ENV] = originalHome;
    await rm(home, { recursive: true, force: true });
  });

  const baseSession = {
    id: "session-1",
    state: "pending" as const,
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
    startedAt: "2026-01-01T00:00:00.000Z",
  };

  it("persists a session and reads it back via load()", async () => {
    const writer = new SessionStore();
    await writer.save(baseSession);

    const reader = new SessionStore();
    await reader.load();
    expect(reader.get("session-1")).toEqual(baseSession);
  });

  it("writes to sessionFilePath(id) as pretty JSON", async () => {
    const store = new SessionStore();
    await store.save(baseSession);
    const raw = await import("node:fs/promises").then((fs) =>
      fs.readFile(sessionFilePath("session-1"), "utf8"),
    );
    expect(JSON.parse(raw)).toEqual(baseSession);
  });

  it("list() filters by state", async () => {
    const store = new SessionStore();
    await store.save(baseSession);
    await store.save({ ...baseSession, id: "session-2", state: "recording" });

    expect(store.list()).toHaveLength(2);
    expect(store.list("recording")).toEqual([
      { ...baseSession, id: "session-2", state: "recording" },
    ]);
  });

  it("skips malformed session files instead of crashing load()", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { sessionsDir } = await import("@windower/core");
    await mkdir(sessionsDir(), { recursive: true });
    await writeFile(join(sessionsDir(), "broken.json"), "{ not json", "utf8");

    const store = new SessionStore();
    const loaded = await store.load();
    expect(loaded).toEqual([]);
  });

  it("save() writes atomically — no torn file ever visible, temp file cleaned up", async () => {
    const store = new SessionStore();
    await store.save(baseSession);

    const { readdir } = await import("node:fs/promises");
    const { sessionsDir } = await import("@windower/core");
    const entries = await readdir(sessionsDir());
    // Only the final file should remain — no leftover `.tmp-*` file from
    // `writeFileAtomic`'s temp-then-rename.
    expect(entries).toEqual(["session-1.json"]);
    const raw = await readFile(sessionFilePath("session-1"), "utf8");
    expect(JSON.parse(raw)).toEqual(baseSession);
  });

  it("get() sees a write made by a second SessionStore instance pointed at the same directory, without a cache-clearing call", async () => {
    const writer = new SessionStore();
    await writer.save(baseSession);

    const reader = new SessionStore();
    await reader.load();
    expect(reader.get("session-1")?.state).toBe("pending");

    // A different process (simulated here by a second in-process instance,
    // since the mtime-invalidation mechanism can't tell the difference)
    // writes an update to the same file.
    await writer.save({ ...baseSession, state: "recording" });

    // `reader` never called load() again or was told to invalidate — mtime
    // checking inside get() must pick this up on its own.
    expect(reader.get("session-1")?.state).toBe("recording");
  });

  it("list() sees a write made by a second SessionStore instance, including a brand-new session file it never loaded", async () => {
    const writer = new SessionStore();
    await writer.save(baseSession);

    const reader = new SessionStore();
    await reader.load();
    expect(reader.list()).toHaveLength(1);

    await writer.save({ ...baseSession, id: "session-2", state: "recording" });

    expect(reader.list()).toHaveLength(2);
    expect(reader.list("recording")).toEqual([
      { ...baseSession, id: "session-2", state: "recording" },
    ]);
  });

  describe("owner", () => {
    const withOwner = {
      ...baseSession,
      owner: { pid: process.pid, startedAt: "2026-01-01T00:00:00.000Z" },
    };

    it("round-trips the optional owner field", async () => {
      const store = new SessionStore();
      await store.save(withOwner);
      const reader = new SessionStore();
      await reader.load();
      expect(reader.get("session-1")?.owner).toEqual(withOwner.owner);
    });

    it("isOwnedByLiveProcess is true for the current (live) process's pid", async () => {
      const store = new SessionStore();
      await store.save(withOwner);
      expect(store.isOwnedByLiveProcess(withOwner)).toBe(true);
    });

    it("isOwnedByLiveProcess is false for a dead pid", async () => {
      const store = new SessionStore();
      const dead = { ...withOwner, owner: { pid: 999_999, startedAt: withOwner.owner.startedAt } };
      await store.save(dead);
      expect(store.isOwnedByLiveProcess(dead)).toBe(false);
    });

    it("isOwnedByLiveProcess is false when owner is absent (back-compat, conservative default)", async () => {
      const store = new SessionStore();
      await store.save(baseSession); // no `owner` field at all
      expect(store.isOwnedByLiveProcess(baseSession)).toBe(false);
    });

    it("a 0.1.x session file with no owner field still parses without crashing", async () => {
      const { mkdir, writeFile } = await import("node:fs/promises");
      const { sessionsDir } = await import("@windower/core");
      await mkdir(sessionsDir(), { recursive: true });
      // Hand-written fixture matching pre-Phase-20 shape: no `owner` key at all.
      const legacySession = {
        id: "legacy-session",
        state: "finalized",
        target: baseSession.target,
        video: baseSession.video,
        audio: baseSession.audio,
        startedAt: "2025-06-01T00:00:00.000Z",
        stoppedAt: "2025-06-01T00:10:00.000Z",
        outputPath: "/tmp/legacy.mp4",
        manifestPath: "/tmp/legacy.manifest.json",
      };
      await writeFile(
        join(sessionsDir(), "legacy-session.json"),
        `${JSON.stringify(legacySession, null, 2)}\n`,
        "utf8",
      );

      const store = new SessionStore();
      const loaded = await store.load();
      expect(loaded).toHaveLength(1);
      expect(loaded[0]?.owner).toBeUndefined();
      expect(store.get("legacy-session")?.id).toBe("legacy-session");
      expect(store.isOwnedByLiveProcess(loaded[0] as (typeof loaded)[number])).toBe(false);
    });
  });
});
