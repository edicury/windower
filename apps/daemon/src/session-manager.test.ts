import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CaptureTarget, DaemonError, WINDOWER_HOME_ENV } from "@windower/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "./session-manager.js";
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
});
