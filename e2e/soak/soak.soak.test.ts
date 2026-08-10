import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DisplayCaptureTarget } from "@windower/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DaemonHarness, startDaemonHarness } from "../src/lib/daemon-harness.js";
import { probeStreamDurations, probeVideo } from "../src/lib/ffprobe.js";
import { findChildPidByCommand } from "../src/lib/find-child-pid.js";
import {
  assertPermissionsGrantedOrThrow,
  missingBuildPrerequisites,
} from "../src/lib/preflight.js";
import {
  type RssSample,
  assertNoUnboundedGrowth,
  startRssSampler,
} from "../src/lib/process-rss.js";

const skipReasons = missingBuildPrerequisites();

/**
 * 30-minute continuous-recording soak test (phase-13 exit criteria). Not
 * part of `pnpm test:e2e` (own vitest config/script, `pnpm test:soak`) —
 * see e2e/README.md.
 *
 * Records a display (not the demo-app window) — this test cares about
 * sustained capture behavior over time, not click/geometry precision, so a
 * display target keeps setup simpler and avoids depending on the demo-app
 * process staying alive and responsive for half an hour.
 *
 * Duration is overridable via `WINDOWER_SOAK_DURATION_MS` for a faster
 * local smoke run of this file's mechanics (drift/RSS-plateau assertions
 * scale down accordingly since the "expect growth to plateau" check is
 * ratio-based, not absolute).
 */
describe.skipIf(skipReasons.length > 0)("soak: 30-minute continuous recording", () => {
  let harness: DaemonHarness;
  let workDir: string;

  beforeAll(async () => {
    if (skipReasons.length > 0) return;
    workDir = await mkdtemp(join(tmpdir(), "windower-e2e-soak-"));
    harness = await startDaemonHarness();
    const permissions = await harness.client.checkPermissions();
    assertPermissionsGrantedOrThrow(permissions);
  });

  afterAll(async () => {
    await harness?.teardown();
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  it(
    "runs a long recording without drift, memory growth, or a corrupt output",
    async () => {
      const durationMs = Number(process.env.WINDOWER_SOAK_DURATION_MS ?? 30 * 60 * 1000);

      const { targets } = await harness.client.listTargets({ kinds: ["display"] });
      const display = targets.find(
        (t): t is DisplayCaptureTarget => t.kind === "display" && t.isPrimary,
      );
      expect(display).toBeDefined();
      if (!display) return;

      const { sessionId } = await harness.client.startRecording({
        target: { targetId: display.id },
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

      // Phase 21: the recording's sidecar is the capture-surface binary.
      // (A long-run RSS soak of `windower-control-macos` would need an
      // operator/control workload driving it — not this test's scenario.)
      const sidecarPid = await findChildPidByCommand(harness.pid, "windower-capture-macos");
      expect(sidecarPid).toBeDefined();

      const sampleIntervalMs = Math.max(1000, Math.floor(durationMs / 180)); // ~180 samples over the run
      const daemonSampler = startRssSampler(harness.pid, sampleIntervalMs);
      const sidecarSampler = sidecarPid ? startRssSampler(sidecarPid, sampleIntervalMs) : undefined;

      await new Promise((resolve) => setTimeout(resolve, durationMs));

      daemonSampler.stop();
      sidecarSampler?.stop();

      const stopResult = await harness.client.stopRecording({ sessionId });

      // --- finalizes correctly: valid manifest, playable video ---
      expect(stopResult.manifest.file.sizeBytes).toBeGreaterThan(0);
      const probed = await probeVideo(stopResult.outputPath);
      expect(probed.width).toBeGreaterThan(0);
      expect(probed.height).toBeGreaterThan(0);
      const expectedDurationSec = durationMs / 1000;
      // 5-second slack: sidecar startup/teardown framing, not a drift signal.
      expect(Math.abs(probed.durationSec - expectedDurationSec)).toBeLessThanOrEqual(5);

      // --- no audio/video drift ---
      const streamDurations = await probeStreamDurations(stopResult.outputPath);
      const videoStream = streamDurations.find((s) => s.codecType === "video");
      const audioStreams = streamDurations.filter((s) => s.codecType === "audio");
      expect(videoStream).toBeDefined();
      expect(audioStreams.length).toBeGreaterThanOrEqual(1);
      for (const audioStream of audioStreams) {
        const driftSec = Math.abs((videoStream?.durationSec ?? 0) - audioStream.durationSec);
        expect(driftSec).toBeLessThanOrEqual(1);
      }

      // --- event timeline present ---
      expect(stopResult.eventTimelinePath).toBeTruthy();

      // --- no unbounded memory growth ---
      const evaluate = (label: string, samples: RssSample[]): void => {
        if (samples.length < 10) {
          // Too few samples (e.g. a very short WINDOWER_SOAK_DURATION_MS smoke
          // run) to draw a growth conclusion — skip rather than false-fail.
          return;
        }
        const { headMeanKb, tailMeanKb, growthRatio } = assertNoUnboundedGrowth(samples);
        console.log(
          `[soak] ${label} RSS: head=${headMeanKb.toFixed(0)}KB tail=${tailMeanKb.toFixed(0)}KB ratio=${growthRatio.toFixed(2)}`,
        );
      };
      evaluate("daemon", daemonSampler.samples);
      if (sidecarSampler) evaluate("sidecar", sidecarSampler.samples);
    },
    45 * 60 * 1000,
  );
});
