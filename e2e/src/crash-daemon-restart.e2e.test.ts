import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WindowCaptureTarget } from "@windower/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DaemonHarness, isProcessAlive, startDaemonHarness } from "./lib/daemon-harness.js";
import { type LaunchedDemoApp, launchDemoApp } from "./lib/demo-app.js";
import { pollUntil } from "./lib/poll.js";
import { assertPermissionsGrantedOrThrow, missingBuildPrerequisites } from "./lib/preflight.js";

const skipReasons = missingBuildPrerequisites();

/**
 * Real-process complement to
 * `apps/daemon/src/session-manager.test.ts`'s "recoverCrashedSessions marks
 * stale recording/stopping sessions as failed" (fake-sidecar unit test).
 * That test proves `SessionManager.recoverCrashedSessions` works in
 * isolation; this test proves the *whole real daemon binary* — including
 * `SessionStore.load()`'s on-disk read of `~/.windower/sessions/*.json` and
 * `bin.ts`'s startup wiring — recovers a session left `recording` by a
 * daemon that was killed (not gracefully shut down) mid-capture.
 */
describe.skipIf(skipReasons.length > 0)(
  "crash injection: daemon killed and restarted mid-recording",
  () => {
    let harness: DaemonHarness;
    let demoApp: LaunchedDemoApp;
    let workDir: string;

    beforeAll(async () => {
      if (skipReasons.length > 0) return;
      workDir = await mkdtemp(join(tmpdir(), "windower-e2e-crash-daemon-"));
      harness = await startDaemonHarness();
      const permissions = await harness.client.checkPermissions();
      assertPermissionsGrantedOrThrow(permissions);
      demoApp = await launchDemoApp({ logPath: join(workDir, "clicks.jsonl") });
    });

    afterAll(async () => {
      demoApp?.kill();
      // harness has been reassigned to the restarted daemon by the test —
      // teardown() on that instance also cleans up windowerHome.
      await harness?.teardown();
      if (workDir) await rm(workDir, { recursive: true, force: true });
    });

    it("marks the orphaned session failed on daemon restart, with no hung session", async () => {
      const { targets } = await harness.client.listTargets({ kinds: ["window"] });
      const window = targets.find(
        (t): t is WindowCaptureTarget => t.kind === "window" && t.title === "Windower Demo App",
      );
      expect(window).toBeDefined();
      if (!window) return;

      const { sessionId } = await harness.client.startRecording({
        target: { targetId: window.id },
        outputDir: workDir,
      });

      const sessionBeforeKill = await harness.client.getSession({ sessionId });
      expect(sessionBeforeKill.state).toBe("recording");

      const oldDaemonPid = harness.pid;
      harness.killDaemon();
      await pollUntil(async () => (await isProcessAlive(oldDaemonPid)) === false, {
        timeoutMs: 10_000,
        timeoutMessage: "Old daemon process did not die after SIGKILL",
      });

      // Restart against the same WINDOWER_HOME/socket — this is exactly what
      // Phase 6's crash recovery (`recoverCrashedSessions`, called from
      // `runDaemon()` at startup) is for.
      harness = await harness.restart();

      const session = await pollUntil(
        async () => {
          const s = await harness.client.getSession({ sessionId });
          return s.state === "failed" ? s : undefined;
        },
        {
          timeoutMs: 15_000,
          timeoutMessage: 'Restarted daemon did not mark the orphaned session "failed"',
        },
      );

      expect(session.state).toBe("failed");
      expect(session.error?.message).toMatch(/restarted|daemon/i);

      // No hung session: list_sessions must not report anything still "recording"/"stopping".
      const { sessions } = await harness.client.listSessions({});
      expect(sessions.some((s) => s.state === "recording" || s.state === "stopping")).toBe(false);
    });
  },
);
