import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CaptureTarget,
  DaemonError,
  EventTimelineSchema,
  OutputManifestSchema,
  type TimelineEvent,
  WINDOWER_HOME_ENV,
  writeConfig,
} from "@windower/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager, type SessionManagerOptions } from "./session-manager.js";
import { SessionStore } from "./session-store.js";
import { createFakeSidecarFactory } from "./test-helpers/fake-sidecar-factory.js";

const DISPLAY_TARGET: CaptureTarget = {
  kind: "display",
  id: "display-1",
  name: "Built-in",
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  isPrimary: true,
  scaleFactor: 2,
};

const WINDOW_TARGET: CaptureTarget = {
  kind: "window",
  id: "window-1",
  title: "Terminal",
  appName: "Terminal",
  appBundleId: "com.apple.Terminal",
  bounds: { x: 0, y: 0, width: 800, height: 600 },
  isFocused: true,
  resizable: true,
};

describe("SessionManager", () => {
  let home: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "windower-session-manager-"));
    originalHome = process.env[WINDOWER_HOME_ENV];
    process.env[WINDOWER_HOME_ENV] = home;
    // Every test gets a config.json pointing outputDir at a dir under the
    // temp WINDOWER_HOME, so `defaultOutputDir()` (which resolves under the
    // real user homedir, ignoring WINDOWER_HOME) is never hit — recordings
    // in this suite must never touch a real user's filesystem.
    await writeConfig({ outputDir: join(home, "output") });
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env[WINDOWER_HOME_ENV];
    else process.env[WINDOWER_HOME_ENV] = originalHome;
    await rm(home, { recursive: true, force: true });
  });

  function makeManager(targets: CaptureTarget[] = [DISPLAY_TARGET, WINDOW_TARGET]) {
    const store = new SessionStore();
    const { spawnSidecar, spawns } = createFakeSidecarFactory({ targets });
    const manager = new SessionManager({ store, spawnSidecar });
    return { manager, store, spawns };
  }

  it("start -> stop finalizes with an output file and manifest", async () => {
    const { manager } = makeManager();

    const { sessionId } = await manager.startRecording({ target: DISPLAY_TARGET });
    expect(manager.getSession({ sessionId }).state).toBe("recording");
    expect(manager.activeSessionCount).toBe(1);

    const result = await manager.stopRecording({ sessionId });
    expect(result.outputPath).toBeTruthy();
    expect(result.manifestPath).toBe(result.manifestPath); // sanity
    expect(result.manifest.sessionId).toBe(sessionId);

    const session = manager.getSession({ sessionId });
    expect(session.state).toBe("finalized");
    expect(session.outputPath).toBe(result.outputPath);
    expect(manager.activeSessionCount).toBe(0);
  });

  it("resolves { targetId } via a transient enumerate call", async () => {
    const { manager } = makeManager();
    const { sessionId } = await manager.startRecording({ target: { targetId: "window-1" } });
    const session = manager.getSession({ sessionId });
    expect(session.target).toEqual(WINDOW_TARGET);
  });

  it("rejects a second start on the same target (TARGET_ALREADY_RECORDING)", async () => {
    const { manager } = makeManager();
    await manager.startRecording({ target: DISPLAY_TARGET });

    await expect(manager.startRecording({ target: DISPLAY_TARGET })).rejects.toMatchObject({
      code: "TARGET_ALREADY_RECORDING",
    });
  });

  it("allows concurrent sessions on different targets", async () => {
    const { manager } = makeManager();
    const a = await manager.startRecording({ target: DISPLAY_TARGET });
    const b = await manager.startRecording({ target: WINDOW_TARGET });
    expect(manager.activeSessionCount).toBe(2);
    expect(a.sessionId).not.toBe(b.sessionId);
  });

  it("cancelRecording discards without finalizing", async () => {
    const { manager } = makeManager();
    const { sessionId } = await manager.startRecording({ target: DISPLAY_TARGET });
    const result = await manager.cancelRecording({ sessionId });
    expect(result.canceled).toBe(true);
    expect(manager.getSession({ sessionId }).state).toBe("canceled");
    expect(manager.activeSessionCount).toBe(0);
  });

  it("fails fast when the target no longer exists", async () => {
    const { manager } = makeManager([]);
    await expect(
      manager.startRecording({ target: { targetId: "does-not-exist" } }),
    ).rejects.toMatchObject({ code: "TARGET_NOT_FOUND" });
  });

  it("marks the session failed when the sidecar sends captureEnded mid-recording", async () => {
    const { manager, spawns } = makeManager();
    const { sessionId } = await manager.startRecording({ target: DISPLAY_TARGET });

    const spawn = spawns.at(-1);
    spawn?.sidecar.emitCaptureEnded(sessionId, "target-closed");
    await new Promise((resolve) => setTimeout(resolve, 10)); // let the notification handler run

    const session = manager.getSession({ sessionId });
    expect(session.state).toBe("failed");
    expect(session.error?.code).toBe("CAPTURE_FAILED");
    expect(manager.activeSessionCount).toBe(0);
  });

  it("marks the session failed when the sidecar process exits unexpectedly", async () => {
    const { manager, spawns } = makeManager();
    const { sessionId } = await manager.startRecording({ target: DISPLAY_TARGET });

    const spawn = spawns.at(-1);
    spawn?.onExit?.({ code: 1, signal: null });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const session = manager.getSession({ sessionId });
    expect(session.state).toBe("failed");
    expect(session.error?.code).toBe("CAPTURE_FAILED");
  });

  it("recoverCrashedSessions marks stale recording/stopping sessions as failed", async () => {
    const store = new SessionStore();
    await store.save({
      id: "orphan-1",
      state: "recording",
      target: DISPLAY_TARGET,
      video: { fps: 30, codec: "h264", container: "mp4", quality: "high", showCursor: true },
      audio: { tracks: [], separateTracks: false },
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    await store.load();

    const { spawnSidecar } = createFakeSidecarFactory({ targets: [] });
    const manager = new SessionManager({ store, spawnSidecar });
    await manager.recoverCrashedSessions();

    const session = manager.getSession({ sessionId: "orphan-1" });
    expect(session.state).toBe("failed");
  });

  it("getSession throws SESSION_NOT_FOUND for an unknown id", () => {
    const { manager } = makeManager();
    expect(() => manager.getSession({ sessionId: "nope" })).toThrow(DaemonError);
  });

  it("captures streamed events and finalizes an eventTimelinePath on stop", async () => {
    const { manager, spawns } = makeManager();
    const { sessionId } = await manager.startRecording({ target: DISPLAY_TARGET });

    const events: TimelineEvent[] = [
      { t: 0, type: "cursor_move", x: 1, y: 1, source: "user" },
      { t: 5, type: "mouse_down", x: 1, y: 1, button: "left", source: "user" },
      { t: 6, type: "key_down", key: "x", source: "user" },
    ];
    const spawn = spawns.at(-1);
    for (const event of events) spawn?.sidecar.emitEvent(sessionId, event);
    await new Promise((resolve) => setTimeout(resolve, 10)); // let notifications land

    const result = await manager.stopRecording({ sessionId });
    expect(result.eventTimelinePath).toBeTruthy();
    expect(result.manifest.eventTimelinePath).toBe(result.eventTimelinePath);

    const session = manager.getSession({ sessionId });
    expect(session.eventTimelinePath).toBe(result.eventTimelinePath);

    const onDisk = JSON.parse(
      await (await import("node:fs/promises")).readFile(result.eventTimelinePath as string, "utf8"),
    );
    const timeline = EventTimelineSchema.parse(onDisk);
    expect(timeline.sessionId).toBe(sessionId);
    expect(timeline.events).toEqual(events);
    expect(timeline.capabilities.keystrokes).toBe(true);
  });

  it("leaves no .events.json behind when a recording is canceled", async () => {
    const { manager, spawns } = makeManager();
    const { sessionId } = await manager.startRecording({ target: DISPLAY_TARGET });

    const spawn = spawns.at(-1);
    spawn?.sidecar.emitEvent(sessionId, { t: 0, type: "cursor_move", x: 1, y: 1 });
    await new Promise((resolve) => setTimeout(resolve, 10));

    await manager.cancelRecording({ sessionId });

    // No final `.events.json` is ever computed for a canceled session (no
    // outputPath exists), and the writer's temp NDJSON file must be gone too.
    const tempPath = join(tmpdir(), `windower-${sessionId}.events.jsonl`);
    await expect(stat(tempPath)).rejects.toThrow();
  });

  it("capabilities.keystrokes is false when eventTimeline.keyboard is not advertised", async () => {
    const store = new SessionStore();
    const { spawnSidecar, spawns } = createFakeSidecarFactory({
      targets: [DISPLAY_TARGET],
      capabilities: [
        "capture.display",
        "capture.window",
        "capture.region",
        "eventTimeline.cursor",
        "eventTimeline.mouse",
      ],
    });
    const manager = new SessionManager({ store, spawnSidecar });

    const { sessionId } = await manager.startRecording({ target: DISPLAY_TARGET });
    const spawn = spawns.at(-1);
    spawn?.sidecar.emitEvent(sessionId, { t: 0, type: "cursor_move", x: 1, y: 1 });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const result = await manager.stopRecording({ sessionId });
    const raw = await (await import("node:fs/promises")).readFile(
      result.eventTimelinePath as string,
      "utf8",
    );
    const timeline = EventTimelineSchema.parse(JSON.parse(raw));
    expect(timeline.capabilities.keystrokes).toBe(false);
  });

  describe("narration", () => {
    function makeManagerWithNarration(overrides: {
      validateNarrationFile?: SessionManagerOptions["validateNarrationFile"];
      muxNarration?: SessionManagerOptions["muxNarration"];
    }) {
      const store = new SessionStore();
      const { spawnSidecar } = createFakeSidecarFactory({
        targets: [DISPLAY_TARGET, WINDOW_TARGET],
      });
      const manager = new SessionManager({ store, spawnSidecar, ...overrides });
      return { manager, store };
    }

    it("stop with narration pointing at a missing file throws INVALID_ARGS and leaves the session untouched", async () => {
      const validateNarrationFile = async () => {
        throw new DaemonError("INVALID_ARGS", "Narration file not found");
      };
      const { manager } = makeManagerWithNarration({ validateNarrationFile });

      const { sessionId } = await manager.startRecording({ target: DISPLAY_TARGET });

      await expect(
        manager.stopRecording({
          sessionId,
          narration: { filePath: "/nonexistent/narration.wav", offsetMs: 0 },
        }),
      ).rejects.toMatchObject({ code: "INVALID_ARGS" });

      const session = manager.getSession({ sessionId });
      expect(session.state).toBe("recording");
      expect(manager.activeSessionCount).toBe(1);
    });

    it("stop with valid narration populates manifest.narration with the correct trackIndex", async () => {
      let muxCalledWith: unknown;
      const validateNarrationFile = async () => {};
      const muxNarration = async (opts: unknown) => {
        muxCalledWith = opts;
      };
      const { manager } = makeManagerWithNarration({ validateNarrationFile, muxNarration });

      const { sessionId } = await manager.startRecording({ target: DISPLAY_TARGET });
      const result = await manager.stopRecording({
        sessionId,
        narration: { filePath: "/tmp/narration.wav", offsetMs: 1500 },
      });

      expect(muxCalledWith).toMatchObject({
        narrationFilePath: "/tmp/narration.wav",
        offsetMs: 1500,
      });
      expect(result.manifest.narration).toEqual({
        filePath: "/tmp/narration.wav",
        offsetMs: 1500,
        trackIndex: 0,
      });
    });

    it("a throwing muxNarration does not fail stopRecording; base video/manifest still saved, manifest.narration absent", async () => {
      const validateNarrationFile = async () => {};
      const muxNarration = async () => {
        throw new Error("ffmpeg exploded");
      };
      const { manager } = makeManagerWithNarration({ validateNarrationFile, muxNarration });

      const { sessionId } = await manager.startRecording({ target: DISPLAY_TARGET });
      const result = await manager.stopRecording({
        sessionId,
        narration: { filePath: "/tmp/narration.wav", offsetMs: 0 },
      });

      expect(result.outputPath).toBeTruthy();
      expect(result.manifest.narration).toBeUndefined();

      const session = manager.getSession({ sessionId });
      expect(session.state).toBe("finalized");
      expect(session.outputPath).toBe(result.outputPath);
    });
  });

  describe("output management", () => {
    it("moves the finalized recording into the configured output dir using the filename template", async () => {
      const outputDir = join(home, "custom-output");
      await writeConfig({ outputDir, filenameTemplate: "{target}-recording" });
      const { manager } = makeManager();

      const { sessionId } = await manager.startRecording({ target: DISPLAY_TARGET });
      const result = await manager.stopRecording({ sessionId });

      expect(result.outputPath).toBe(join(outputDir, "Built-in-recording.mp4"));
      const fileStat = await stat(result.outputPath);
      expect(fileStat.isFile()).toBe(true);
      expect(result.manifest.file.path).toBe(result.outputPath);
    });

    it("appends -2 rather than overwriting on a filename collision", async () => {
      const outputDir = join(home, "collide-output");
      await writeConfig({ outputDir, filenameTemplate: "fixed-name" });
      const { manager: managerA } = makeManager();
      const { sessionId: sessionIdA } = await managerA.startRecording({ target: DISPLAY_TARGET });
      const resultA = await managerA.stopRecording({ sessionId: sessionIdA });
      expect(resultA.outputPath).toBe(join(outputDir, "fixed-name.mp4"));

      const { manager: managerB } = makeManager();
      const { sessionId: sessionIdB } = await managerB.startRecording({ target: DISPLAY_TARGET });
      const resultB = await managerB.stopRecording({ sessionId: sessionIdB });
      expect(resultB.outputPath).toBe(join(outputDir, "fixed-name-2.mp4"));

      // The first file must still exist, untouched — never silently overwritten.
      await expect(stat(resultA.outputPath)).resolves.toBeDefined();
    });

    it("fails fast at start with OUTPUT_DIR_NOT_WRITABLE when outputDir is not writable, and persists no session", async () => {
      const { manager, store } = makeManager();
      // A regular file can never be mkdir'd into / written to as a directory.
      const notADir = join(home, "not-a-dir");
      await writeFile(notADir, "not a directory");

      await expect(
        manager.startRecording({ target: DISPLAY_TARGET, outputDir: notADir }),
      ).rejects.toMatchObject({ code: "OUTPUT_DIR_NOT_WRITABLE" });

      expect(store.list()).toHaveLength(0);
      expect(manager.activeSessionCount).toBe(0);
    });

    it("finalized manifest validates against OutputManifestSchema", async () => {
      const { manager } = makeManager();
      const { sessionId } = await manager.startRecording({ target: DISPLAY_TARGET });
      const result = await manager.stopRecording({ sessionId });

      expect(() => OutputManifestSchema.parse(result.manifest)).not.toThrow();
    });
  });
});
