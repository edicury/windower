import { describe, expect, it, vi } from "vitest";
import type { CaptureTarget } from "../schemas/capture-target.js";
import type { TimelineEvent } from "../schemas/event-timeline.js";
import { SidecarError } from "./errors.js";
import { createFakeSidecarPair } from "./fake-sidecar.js";

const displayTarget: CaptureTarget = {
  kind: "display",
  id: "display-1",
  name: "Built-in Display",
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  isPrimary: true,
  scaleFactor: 2,
};

const windowTarget: CaptureTarget = {
  kind: "window",
  id: "window-1",
  title: "Terminal",
  appName: "Terminal",
  appBundleId: "com.apple.Terminal",
  bounds: { x: 10, y: 10, width: 800, height: 600 },
  isFocused: true,
  resizable: true,
};

const defaultVideo = {
  fps: 30 as const,
  codec: "h264" as const,
  container: "mp4" as const,
  quality: "medium" as const,
  showCursor: true,
};

const defaultAudio = {
  tracks: [],
  separateTracks: false,
};

describe("SidecarClient <-> FakeSidecar", () => {
  it("round-trips describe()", async () => {
    const { client, dispose } = createFakeSidecarPair({
      platform: "macos",
      version: "9.9.9",
      capabilities: ["capture.display"],
    });
    try {
      const result = await client.describe();
      expect(result).toEqual({
        platform: "macos",
        version: "9.9.9",
        capabilities: ["capture.display"],
      });
    } finally {
      dispose();
    }
  });

  it("round-trips enumerateTargets()", async () => {
    const { client, dispose } = createFakeSidecarPair({
      targets: [displayTarget, windowTarget],
    });
    try {
      const all = await client.enumerateTargets();
      expect(all.targets).toHaveLength(2);

      const windowsOnly = await client.enumerateTargets({ kinds: ["window"] });
      expect(windowsOnly.targets).toEqual([windowTarget]);
    } finally {
      dispose();
    }
  });

  it("round-trips getPermissions() and requestPermission()", async () => {
    const { client, dispose } = createFakeSidecarPair({
      permissions: {
        screenRecording: "granted",
        accessibility: "not_determined",
        microphone: "denied",
      },
    });
    try {
      const report = await client.getPermissions();
      expect(report.screenRecording).toBe("granted");
      expect(report.accessibility).toBe("not_determined");
      expect(report.microphone).toBe("denied");

      const requested = await client.requestPermission({ kind: "microphone" });
      expect(requested.status).toBe("denied");
    } finally {
      dispose();
    }
  });

  it("round-trips resizeWindow()", async () => {
    const { client, dispose } = createFakeSidecarPair({
      capabilities: ["window-control"],
      targets: [windowTarget],
    });
    try {
      const bounds = { x: 0, y: 0, width: 1024, height: 768 };
      const result = await client.resizeWindow({ targetId: "window-1", bounds });
      expect(result).toEqual({ actualBounds: bounds, result: "success" });
    } finally {
      dispose();
    }
  });

  it("round-trips startCapture -> stopCapture", async () => {
    const { client, dispose } = createFakeSidecarPair({
      capabilities: ["capture.display"],
      targets: [displayTarget],
    });
    try {
      const started = await client.startCapture({
        sessionId: "session-1",
        target: displayTarget,
        video: defaultVideo,
        audio: defaultAudio,
      });
      expect(started).toEqual({ started: true });

      const stopped = await client.stopCapture({ sessionId: "session-1" });
      expect(stopped.outputFilePath).toContain("session-1");
      expect(stopped.actualResolution).toEqual({ width: 1920, height: 1080 });
      expect(typeof stopped.actualDurationMs).toBe("number");
    } finally {
      dispose();
    }
  });

  it("round-trips startCapture -> cancelCapture", async () => {
    const { client, dispose } = createFakeSidecarPair({
      capabilities: ["capture.window"],
      targets: [windowTarget],
    });
    try {
      await client.startCapture({
        sessionId: "session-2",
        target: windowTarget,
        video: defaultVideo,
        audio: defaultAudio,
      });
      const canceled = await client.cancelCapture({ sessionId: "session-2" });
      expect(canceled).toEqual({ canceled: true });
    } finally {
      dispose();
    }
  });

  describe("error taxonomy propagation", () => {
    it("surfaces UNSUPPORTED_CAPABILITY when startCapture needs a missing capability", async () => {
      const { client, dispose } = createFakeSidecarPair({
        capabilities: [], // no capture.* capability advertised
        targets: [displayTarget],
      });
      try {
        await expect(
          client.startCapture({
            sessionId: "session-3",
            target: displayTarget,
            video: defaultVideo,
            audio: defaultAudio,
          }),
        ).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
      } finally {
        dispose();
      }
    });

    it("surfaces RESIZE_UNSUPPORTED when window-control capability is absent", async () => {
      const { client, dispose } = createFakeSidecarPair({
        capabilities: [],
        targets: [windowTarget],
      });
      try {
        const err = await client
          .resizeWindow({ targetId: "window-1", bounds: windowTarget.bounds })
          .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(SidecarError);
        expect((err as SidecarError).code).toBe("RESIZE_UNSUPPORTED");
      } finally {
        dispose();
      }
    });

    it("surfaces TARGET_NOT_FOUND for an unknown targetId", async () => {
      const { client, dispose } = createFakeSidecarPair({
        capabilities: ["window-control"],
        targets: [windowTarget],
      });
      try {
        await expect(
          client.resizeWindow({ targetId: "does-not-exist", bounds: windowTarget.bounds }),
        ).rejects.toMatchObject({ code: "TARGET_NOT_FOUND" });
      } finally {
        dispose();
      }
    });

    it("surfaces SESSION_NOT_FOUND for stopCapture on an unknown session", async () => {
      const { client, dispose } = createFakeSidecarPair();
      try {
        await expect(client.stopCapture({ sessionId: "ghost" })).rejects.toMatchObject({
          code: "SESSION_NOT_FOUND",
        });
      } finally {
        dispose();
      }
    });

    it("rejects with a SidecarError instance, not a generic Error", async () => {
      const { client, dispose } = createFakeSidecarPair();
      try {
        let caught: unknown;
        try {
          await client.cancelCapture({ sessionId: "ghost" });
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(SidecarError);
        expect((caught as SidecarError).code).toBe("SESSION_NOT_FOUND");
      } finally {
        dispose();
      }
    });
  });

  describe("streamed notifications", () => {
    it("delivers event notifications emitted during an active capture", async () => {
      const { client, sidecar, dispose } = createFakeSidecarPair({
        capabilities: ["capture.display", "eventTimeline.cursor", "eventTimeline.mouse"],
        targets: [displayTarget],
      });
      try {
        const received: TimelineEvent[] = [];
        client.on("event", (payload) => {
          expect(payload.sessionId).toBe("session-4");
          received.push(payload.event);
        });

        await client.startCapture({
          sessionId: "session-4",
          target: displayTarget,
          video: defaultVideo,
          audio: defaultAudio,
        });

        sidecar.emitEvent("session-4", { t: 0, type: "cursor_move", x: 1, y: 2 });
        sidecar.emitEvent("session-4", { t: 10, type: "mouse_down", x: 1, y: 2, button: "left" });
        sidecar.emitEvent("session-4", { t: 20, type: "mouse_up", x: 1, y: 2, button: "left" });

        // Notifications arrive over the same newline-delimited stream as
        // responses; give the event loop a tick to flush/parse them.
        await new Promise((resolve) => setImmediate(resolve));

        expect(received).toHaveLength(3);
        // Phase 19: `source` defaults to "user" on parse for events emitted
        // without one (back-compat with pre-Phase-19 sidecars).
        expect(received[0]).toEqual({ t: 0, type: "cursor_move", x: 1, y: 2, source: "user" });

        await client.stopCapture({ sessionId: "session-4" });
      } finally {
        dispose();
      }
    });

    it("delivers captureEnded when the sidecar ends a capture unilaterally", async () => {
      const { client, sidecar, dispose } = createFakeSidecarPair({
        capabilities: ["capture.window"],
        targets: [windowTarget],
      });
      try {
        const listener = vi.fn();
        client.on("captureEnded", listener);

        await client.startCapture({
          sessionId: "session-5",
          target: windowTarget,
          video: defaultVideo,
          audio: defaultAudio,
        });

        sidecar.emitCaptureEnded("session-5", "target-closed");
        await new Promise((resolve) => setImmediate(resolve));

        expect(listener).toHaveBeenCalledWith({ sessionId: "session-5", reason: "target-closed" });
      } finally {
        dispose();
      }
    });

    it("delivers log notifications", async () => {
      const { client, sidecar, dispose } = createFakeSidecarPair();
      try {
        const listener = vi.fn();
        client.on("log", listener);
        sidecar.emitLog({ level: "info", message: "hello from sidecar" });
        await new Promise((resolve) => setImmediate(resolve));
        expect(listener).toHaveBeenCalledWith({ level: "info", message: "hello from sidecar" });
      } finally {
        dispose();
      }
    });
  });
});
