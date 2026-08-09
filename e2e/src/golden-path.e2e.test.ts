import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EventTimelineSchema,
  OutputManifestSchema,
  type WindowCaptureTarget,
} from "@windower/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DaemonHarness, startDaemonHarness } from "./lib/daemon-harness.js";
import {
  DEMO_APP_BUTTONS,
  type LaunchedDemoApp,
  buttonCenterToScreenPixel,
  launchDemoApp,
  readClickLog,
  synthesizeClick,
} from "./lib/demo-app.js";
import { probeVideo } from "./lib/ffprobe.js";
import { assertPermissionsGrantedOrThrow, missingBuildPrerequisites } from "./lib/preflight.js";

const skipReasons = missingBuildPrerequisites();

/**
 * Golden path: enumerate the real demo-app window through a real daemon
 * talking to the real macOS sidecar (no fake sidecar, no macOS-specific
 * branching in this file — every call below is exactly what `packages/cli`
 * / `packages/mcp-server` issue over `DaemonClient`), resize it, record
 * with audio, click all 3 known buttons, stop, and cross-check windower's
 * own manifest/event-timeline output against the demo-app's independent
 * click-log ground truth.
 *
 * Locally-gated (see e2e/README.md): skipped outright if build artifacts
 * are missing, and fails with a clear message (not a hang) if TCC grants
 * are missing.
 */
describe.skipIf(skipReasons.length > 0)("golden path: record the demo-app fixture", () => {
  let harness: DaemonHarness;
  let demoApp: LaunchedDemoApp;
  let workDir: string;
  let logPath: string;

  beforeAll(async () => {
    if (skipReasons.length > 0) return;
    workDir = await mkdtemp(join(tmpdir(), "windower-e2e-golden-"));
    logPath = join(workDir, "demo-app-clicks.jsonl");

    harness = await startDaemonHarness();

    const permissions = await harness.client.checkPermissions();
    assertPermissionsGrantedOrThrow(permissions);

    demoApp = await launchDemoApp({ logPath });
  });

  afterAll(async () => {
    demoApp?.kill();
    await harness?.teardown();
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  it("enumerates the demo-app window via list_targets", async () => {
    const { targets } = await harness.client.listTargets({ kinds: ["window"] });
    const window = targets.find(
      (t): t is WindowCaptureTarget => t.kind === "window" && t.title === "Windower Demo App",
    );
    expect(window).toBeDefined();
    expect(window?.appName).toBeTruthy();
  });

  it("resizes the demo-app window to a known size", async () => {
    const { targets } = await harness.client.listTargets({ kinds: ["window"] });
    const window = targets.find(
      (t): t is WindowCaptureTarget => t.kind === "window" && t.title === "Windower Demo App",
    );
    expect(window).toBeDefined();
    if (!window) return;

    const result = await harness.client.resizeWindow({
      targetId: window.id,
      bounds: { x: window.bounds.x, y: window.bounds.y, width: 960, height: 720 },
    });
    expect(["success", "partial"]).toContain(result.result);
    // Allow small AX rounding slack rather than requiring bit-exact pixels.
    expect(Math.abs(result.actualBounds.width - 960)).toBeLessThanOrEqual(4);
    expect(Math.abs(result.actualBounds.height - 720)).toBeLessThanOrEqual(4);
  });

  it("records the resized window with audio, clicks all 3 buttons, and stops cleanly", async () => {
    const { targets } = await harness.client.listTargets({ kinds: ["window", "display"] });
    const window = targets.find(
      (t): t is WindowCaptureTarget => t.kind === "window" && t.title === "Windower Demo App",
    );
    expect(window).toBeDefined();
    if (!window) return;

    const display = targets.find((t) => t.kind === "display" && t.isPrimary);
    // See lib/demo-app.ts's buttonCenterToScreenPixel doc comment: falls
    // back to 2x (the common Retina default) if no primary display is
    // reported, overridable via WINDOWER_DEMO_SCALE_FACTOR.
    const scaleFactor =
      process.env.WINDOWER_DEMO_SCALE_FACTOR !== undefined
        ? Number(process.env.WINDOWER_DEMO_SCALE_FACTOR)
        : ((display && "scaleFactor" in display ? display.scaleFactor : undefined) ?? 2);

    const { sessionId } = await harness.client.startRecording({
      target: { targetId: window.id },
      video: { fps: 30 },
      audio: {
        tracks: [
          { source: "system", enabled: true },
          { source: "microphone", enabled: true },
        ],
        separateTracks: true,
      },
      outputDir: workDir,
    });
    expect(sessionId).toBeTruthy();

    // Two-call recording pattern (CLAUDE.md): actions happen between start
    // and stop. Re-fetch the (possibly re-positioned) bounds post-start
    // just in case the sidecar's own capture setup nudged anything, then
    // click all 3 known buttons in order.
    const { targets: postStartTargets } = await harness.client.listTargets({ kinds: ["window"] });
    const liveWindow = postStartTargets.find(
      (t): t is WindowCaptureTarget => t.kind === "window" && t.title === "Windower Demo App",
    );
    expect(liveWindow).toBeDefined();
    const bounds = liveWindow?.bounds ?? window.bounds;

    for (const button of DEMO_APP_BUTTONS) {
      const { x, y } = buttonCenterToScreenPixel(button, bounds, scaleFactor);
      await synthesizeClick(x, y);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    const stopResult = await harness.client.stopRecording({ sessionId });

    // --- manifest ---
    const manifest = OutputManifestSchema.parse(stopResult.manifest);
    expect(manifest.sessionId).toBe(sessionId);
    expect(manifest.file.path).toBe(stopResult.outputPath);

    // --- video file exists and roughly matches the request ---
    const probed = await probeVideo(stopResult.outputPath);
    expect(probed.width).toBeGreaterThan(0);
    expect(probed.height).toBeGreaterThan(0);
    // fps requested was 30; allow the container's rounding.
    expect(probed.fps).toBeGreaterThanOrEqual(24);
    expect(probed.fps).toBeLessThanOrEqual(31);
    expect(probed.audioStreamCount).toBeGreaterThanOrEqual(1);

    // --- event timeline vs demo-app's own independent click log ---
    expect(stopResult.eventTimelinePath).toBeTruthy();
    if (!stopResult.eventTimelinePath) return;

    const fs = await import("node:fs/promises");
    const rawTimeline = JSON.parse(await fs.readFile(stopResult.eventTimelinePath, "utf8"));
    const timeline = EventTimelineSchema.parse(rawTimeline);
    const clickEvents = timeline.events.filter((e) => e.type === "mouse_down");

    const clickLog = await readClickLog(logPath);
    expect(clickLog).toHaveLength(3);
    expect(clickLog.map((c) => c.button)).toEqual([...DEMO_APP_BUTTONS]);

    // windower's own timeline should have observed at least one mouse-down
    // per real click (it may also see extra system-generated moves, but
    // never fewer button-presses than the ground truth).
    expect(clickEvents.length).toBeGreaterThanOrEqual(clickLog.length);
  });
});
