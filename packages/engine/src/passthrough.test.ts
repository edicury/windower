import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CaptureTarget,
  type FakeSidecar,
  type FakeSidecarOptions,
  type PermissionReport,
  type SidecarClient,
  type SpawnSidecarOptions,
  WINDOWER_HOME_ENV,
  createFakeSidecarPair,
} from "@windower/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ControlEngine } from "./control-engine.js";
import { PassthroughService } from "./passthrough.js";
import type { SidecarFactory, SidecarHandle } from "./recording-engine.js";
import {
  CaptureLock,
  captureLockPath,
  resetCaptureHoldsForTesting,
} from "./screen-capture-lock.js";

/**
 * Phase 21 wiring coverage for the two-surface split
 * (`contracts/screen-capture-exclusivity.md`,
 * `contracts/sidecar-protocol.md` §Method-ownership surfaces). The properties
 * under test are all about *which binary a call reaches* and *what it locks*:
 *
 * - a control-surface call spawns the **control** binary, never the capture one;
 * - a control-surface call takes no capture lock, ever — so it works while a
 *   capture process is live and never serializes against it;
 * - `check_permissions` merges the two surfaces' partial reports, and a host
 *   holding only one surface reports the absent kinds as **unknown**, not denied.
 */

/** Capture-surface capabilities — no `window-control`, per the contract's Handshake section. */
const CAPTURE_CAPABILITIES: FakeSidecarOptions["capabilities"] = [
  "enumerate.displays",
  "enumerate.windows",
  "capture.display",
  "capture.window",
  "capture.region",
];

/** Control-surface capabilities — nothing capture-shaped. */
const CONTROL_CAPABILITIES: FakeSidecarOptions["capabilities"] = ["window-control"];

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

const OTHER_WINDOW_TARGET: CaptureTarget = { ...WINDOW_TARGET, id: "window-2" };

interface SurfaceSpawn {
  /** What the caller asked for; `undefined` means it passed none, which resolves to `"capture"`. */
  requested: SpawnSidecarOptions["surface"];
  surface: "capture" | "control";
  client: SidecarClient;
  sidecar: FakeSidecar;
  terminated: boolean;
}

/**
 * A `SidecarFactory` that behaves like the real one: it serves a *different*
 * fake depending on `options.surface`, so a call that forgets to ask for the
 * control surface visibly lands on a capture binary instead of silently
 * working.
 */
function createSurfaceAwareFactory(
  options: {
    capturePermissions?: Partial<PermissionReport>;
    controlPermissions?: Partial<PermissionReport>;
  } = {},
): { spawnSidecar: SidecarFactory; spawns: SurfaceSpawn[] } {
  const spawns: SurfaceSpawn[] = [];

  const spawnSidecar: SidecarFactory = (spawnOptions: SpawnSidecarOptions): SidecarHandle => {
    const surface = spawnOptions.surface ?? "capture";
    const { client, sidecar, dispose } = createFakeSidecarPair({
      targets: [WINDOW_TARGET, OTHER_WINDOW_TARGET],
      capabilities: surface === "control" ? CONTROL_CAPABILITIES : CAPTURE_CAPABILITIES,
      permissions:
        surface === "control"
          ? (options.controlPermissions ?? { accessibility: "granted" })
          : (options.capturePermissions ?? { screenRecording: "granted", microphone: "granted" }),
    });
    const record: SurfaceSpawn = {
      requested: spawnOptions.surface,
      surface,
      client,
      sidecar,
      terminated: false,
    };
    spawns.push(record);
    return {
      client,
      terminate: async () => {
        record.terminated = true;
        dispose();
      },
    };
  };

  return { spawnSidecar, spawns };
}

async function captureLockFileExists(): Promise<boolean> {
  try {
    await access(captureLockPath());
    return true;
  } catch {
    return false;
  }
}

describe("PassthroughService — capture/control surface split", () => {
  let home: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "windower-passthrough-"));
    originalHome = process.env[WINDOWER_HOME_ENV];
    process.env[WINDOWER_HOME_ENV] = home;
    resetCaptureHoldsForTesting();
  });

  afterEach(async () => {
    resetCaptureHoldsForTesting();
    if (originalHome === undefined) delete process.env[WINDOWER_HOME_ENV];
    else process.env[WINDOWER_HOME_ENV] = originalHome;
    await rm(home, { recursive: true, force: true });
  });

  const BOUNDS = { x: 0, y: 0, width: 800, height: 600 };

  describe("control-surface calls never reach the capture binary or the capture lock", () => {
    it("resize_window's one-off fallback spawns the CONTROL surface, not the default capture one", async () => {
      const { spawnSidecar, spawns } = createSurfaceAwareFactory();
      const passthrough = new PassthroughService(spawnSidecar);

      await passthrough.resizeWindow({ targetId: "window-1", bounds: BOUNDS });

      expect(spawns).toHaveLength(1);
      // Explicitly `"control"`, not merely "not capture": `SpawnSidecarOptions.surface`
      // defaults to `"capture"`, so omitting it spawns a ScreenCaptureKit process.
      expect(spawns[0]?.requested).toBe("control");
      expect(spawns.some((s) => s.surface === "capture")).toBe(false);
      expect(spawns[0]?.terminated).toBe(true);
    });

    it("resize_window takes no capture lock — no lock file is ever created", async () => {
      const { spawnSidecar } = createSurfaceAwareFactory();
      const passthrough = new PassthroughService(spawnSidecar);

      await passthrough.resizeWindow({ targetId: "window-1", bounds: BOUNDS });

      expect(await captureLockFileExists()).toBe(false);
    });

    it("routes resize_window through an injected ControlEngine, still on the control surface", async () => {
      const { spawnSidecar, spawns } = createSurfaceAwareFactory();
      const control = new ControlEngine({
        spawnControl: spawnSidecar,
        spawnOptions: { surface: "control" },
        onLog: () => {},
      });
      const passthrough = new PassthroughService(spawnSidecar, { control });

      await passthrough.resizeWindow({ targetId: "window-1", bounds: BOUNDS });
      await passthrough.resizeWindow({ targetId: "window-2", bounds: BOUNDS });

      // One long-lived control process serves both calls.
      expect(spawns).toHaveLength(1);
      expect(spawns[0]?.requested).toBe("control");
      expect(await captureLockFileExists()).toBe(false);

      await control.shutdown();
    });

    it("serves a control-surface call while a capture process is live, without waiting on it", async () => {
      const { spawnSidecar, spawns } = createSurfaceAwareFactory();
      const captureLock = new CaptureLock({ spawnSidecar, waitMs: 50, onLog: () => {} });
      const control = new ControlEngine({
        spawnControl: spawnSidecar,
        spawnOptions: { surface: "control" },
        onLog: () => {},
      });
      const passthrough = new PassthroughService(spawnSidecar, { capture: captureLock, control });

      // A recording-shaped hold: the capture lock is held for the whole test.
      const hold = await captureLock.acquireCaptureHold();
      expect(await captureLockFileExists()).toBe(true);

      await passthrough.resizeWindow({ targetId: "window-1", bounds: BOUNDS });

      // Two processes alive at once — one capture, one control — which is
      // explicitly allowed: the control binary touches no ScreenCaptureKit
      // state, so it is never serialized against a recording.
      expect(spawns.map((s) => s.surface)).toEqual(["capture", "control"]);
      expect(hold.released).toBe(false);
      expect(spawns[0]?.terminated).toBe(false);

      await hold.release();
      await control.shutdown();
    });

    it("request_permission routes accessibility to control and capture kinds to capture", async () => {
      const { spawnSidecar, spawns } = createSurfaceAwareFactory();
      const captureLock = new CaptureLock({ spawnSidecar, onLog: () => {} });
      const control = new ControlEngine({
        spawnControl: spawnSidecar,
        spawnOptions: { surface: "control" },
        onLog: () => {},
      });
      const passthrough = new PassthroughService(spawnSidecar, { capture: captureLock, control });

      await passthrough.requestPermission({ kind: "accessibility" });
      expect(spawns.map((s) => s.surface)).toEqual(["control"]);

      await passthrough.requestPermission({ kind: "screenRecording" });
      expect(spawns.map((s) => s.surface)).toEqual(["control", "capture"]);

      await control.shutdown();
    });
  });

  describe("check_permissions merges the two surfaces' partial reports", () => {
    it("merges capture (screenRecording/microphone) with control (accessibility)", async () => {
      const { spawnSidecar } = createSurfaceAwareFactory({
        capturePermissions: { screenRecording: "granted", microphone: "denied" },
        controlPermissions: { accessibility: "granted" },
      });
      const captureLock = new CaptureLock({ spawnSidecar, onLog: () => {} });
      const control = new ControlEngine({
        spawnControl: spawnSidecar,
        spawnOptions: { surface: "control" },
        onLog: () => {},
      });
      const passthrough = new PassthroughService(spawnSidecar, { capture: captureLock, control });

      const report = await passthrough.checkPermissions();

      expect(report.screenRecording).toBe("granted");
      expect(report.microphone).toBe("denied");
      // The capture surface has no opinion on Accessibility and omits it; the
      // control surface is where that answer comes from.
      expect(report.accessibility).toBe("granted");
      expect(report.sidecarAvailable).toBe(true);

      await control.shutdown();
    });

    it("reports a kind no held surface answered as unknown, never as denied", async () => {
      const { spawnSidecar } = createSurfaceAwareFactory({
        capturePermissions: { screenRecording: "granted", microphone: "granted" },
      });
      const captureLock = new CaptureLock({ spawnSidecar, onLog: () => {} });
      // No control surface — a partial view of the world.
      const passthrough = new PassthroughService(spawnSidecar, { capture: captureLock });

      const report = await passthrough.checkPermissions();

      expect(report.screenRecording).toBe("granted");
      expect(report.accessibility).toBe("not_determined");
      expect(report.accessibility).not.toBe("denied");
    });

    it("keeps the capture-derived kinds when the control surface can't be reached", async () => {
      const { spawnSidecar } = createSurfaceAwareFactory({
        capturePermissions: { screenRecording: "denied", microphone: "granted" },
      });
      const captureLock = new CaptureLock({ spawnSidecar, onLog: () => {} });
      const control = new ControlEngine({
        spawnControl: () => {
          throw new Error("control binary not installed");
        },
        onLog: () => {},
      });
      const passthrough = new PassthroughService(spawnSidecar, { capture: captureLock, control });

      const report = await passthrough.checkPermissions();

      expect(report.screenRecording).toBe("denied");
      expect(report.microphone).toBe("granted");
      expect(report.accessibility).toBe("not_determined");
      // A missing *control* surface is not a missing capture surface.
      expect(report.sidecarAvailable).toBe(true);
    });
  });
});
