import { mkdtemp, rm } from "node:fs/promises";
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
});
