import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WindowCaptureTarget } from "@windower/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DaemonHarness, startDaemonHarness } from "./lib/daemon-harness.js";
import { type LaunchedDemoApp, launchDemoApp } from "./lib/demo-app.js";
import { findChildPidByCommand } from "./lib/find-child-pid.js";
import { pollUntil } from "./lib/poll.js";
import { assertPermissionsGrantedOrThrow, missingBuildPrerequisites } from "./lib/preflight.js";

const skipReasons = missingBuildPrerequisites();

/**
 * Real-process complement to `apps/daemon/src/session-manager.test.ts`'s
 * "marks the session failed when the sidecar process exits unexpectedly"
 * (fake-sidecar unit test, covers `handleSidecarExit`'s daemon-side logic).
 * This test proves the same behavior end-to-end: a real `kill -9` against
 * the real sidecar OS process, observed through the real daemon's session
 * state machine. Does not duplicate or modify the existing unit test.
 */
describe.skipIf(skipReasons.length > 0)(
  "crash injection: sidecar process killed mid-recording",
  () => {
    let harness: DaemonHarness;
    let demoApp: LaunchedDemoApp;
    let workDir: string;

    beforeAll(async () => {
      if (skipReasons.length > 0) return;
      workDir = await mkdtemp(join(tmpdir(), "windower-e2e-crash-sidecar-"));
      harness = await startDaemonHarness();
      const permissions = await harness.client.checkPermissions();
      assertPermissionsGrantedOrThrow(permissions);
      demoApp = await launchDemoApp({ logPath: join(workDir, "clicks.jsonl") });
    });

    afterAll(async () => {
      demoApp?.kill();
      await harness?.teardown();
      if (workDir) await rm(workDir, { recursive: true, force: true });
    });

    it("transitions the session to failed, with no hung session, when the sidecar is kill -9'd", async () => {
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

      const sidecarPid = await pollUntil(
        () => findChildPidByCommand(harness.pid, "windower-sidecar-macos"),
        {
          timeoutMs: 10_000,
          timeoutMessage: "Could not find the spawned sidecar's OS pid via the process table",
        },
      );

      process.kill(sidecarPid, "SIGKILL");

      const session = await pollUntil(
        async () => {
          const s = await harness.client.getSession({ sessionId });
          return s.state === "failed" ? s : undefined;
        },
        {
          timeoutMs: 15_000,
          timeoutMessage: 'Session did not transition to "failed" after the sidecar was kill -9\'d',
        },
      );

      expect(session.state).toBe("failed");
      expect(session.error?.code).toBeTruthy();

      // The daemon itself must have survived the sidecar crash (no cascading
      // failure) — a follow-up RPC should still succeed normally.
      const { sessions } = await harness.client.listSessions({});
      expect(sessions.some((s) => s.id === sessionId && s.state === "failed")).toBe(true);
    });
  },
);
