import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { WindowCaptureTarget } from "@windower/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DaemonHarness, startDaemonHarness } from "./lib/daemon-harness.js";
import { type LaunchedDemoApp, launchDemoApp } from "./lib/demo-app.js";
import { findChildPidByCommand } from "./lib/find-child-pid.js";
import { pollUntil } from "./lib/poll.js";
import { assertPermissionsGrantedOrThrow, missingBuildPrerequisites } from "./lib/preflight.js";

const execFileAsync = promisify(execFile);

const skipReasons = missingBuildPrerequisites();

/**
 * contracts/screen-capture-exclusivity.md §Process ownership: orphan
 * prevention is a property of process ownership, not of bookkeeping. The
 * capture sidecar is spawned as a child of the lock holder and exits when
 * stdin reaches EOF; if the parent dies, the OS closes the pipe and the child
 * terminates by that same path. **That is the only orphan-prevention
 * mechanism** — there is no pid tracking, no reaper, and no supervisor, and
 * the lock payload is still exactly `{ pid, acquiredAt, windowerHome }`. This
 * test is what makes that claim falsifiable: `kill -9` the parent, then assert
 * via `ps` that no `windower-capture-macos` process survives it.
 *
 * Complements, and does not duplicate:
 * - `native/macos/Tests/WindowerCaptureCoreTests/CaptureEofCleanupTests.swift`,
 *   which drives the same EOF path directly (close stdin → the process exits
 *   and leaves a *finalized, decodable* file). That unit test proves the
 *   cleanup half but closes stdin itself; only a real `kill -9` of a real
 *   parent proves the OS actually delivers that EOF in the crash case.
 * - `src/crash-sidecar.e2e.test.ts`, which kills the *child* and asserts the
 *   daemon's session state machine reacts. This kills the *parent* and asserts
 *   the child is gone. Opposite direction, different invariant.
 *
 * Not covered here (and deliberately still not written): the control-surface
 * crash-injection case from Phase 21's exit criteria, which needs the
 * `ControlEngine`/operator-loop work to land first — see
 * `src/crash-sidecar.e2e.test.ts`'s header.
 */
describe.skipIf(skipReasons.length > 0)(
  "orphan prevention: killing the parent leaves no capture child behind",
  () => {
    let harness: DaemonHarness;
    let demoApp: LaunchedDemoApp;
    let workDir: string;

    beforeAll(async () => {
      if (skipReasons.length > 0) return;
      workDir = await mkdtemp(join(tmpdir(), "windower-e2e-orphan-capture-"));
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

    it("kill -9 of the daemon leaves no windower-capture-macos process alive", async () => {
      const { targets } = await harness.client.listTargets({ kinds: ["window"] });
      const window = targets.find(
        (t): t is WindowCaptureTarget => t.kind === "window" && t.title === "Windower Demo App",
      );
      expect(window).toBeDefined();
      if (!window) return;

      await harness.client.startRecording({
        target: { targetId: window.id },
        outputDir: workDir,
      });

      const capturePid = await pollUntil(
        () => findChildPidByCommand(harness.pid, "windower-capture-macos"),
        {
          timeoutMs: 10_000,
          timeoutMessage:
            "Could not find the spawned capture sidecar's OS pid via the process table",
        },
      );

      // Give the capture a moment of real recording, so the EOF path has an
      // active `SCStream`/`AVAssetWriter` to tear down rather than exiting
      // through the trivial no-active-capture case.
      await new Promise((resolve) => setTimeout(resolve, 2_000));

      // SIGKILL: the parent gets no chance to stop or kill anything. The only
      // thing that reaches the child is the OS closing its stdin pipe.
      harness.killDaemon();

      // Must be checked by pid, not by parent pid: an orphan is precisely a
      // process that has been reparented (to pid 1) and would no longer show
      // up as a child of the now-dead daemon.
      await pollUntil(
        async () => ((await captureProcessCommand(capturePid)) === undefined ? true : undefined),
        {
          timeoutMs: 30_000,
          timeoutMessage: `windower-capture-macos (pid ${capturePid}) was still alive after its parent was kill -9'd — the stdin-EOF exit path in contracts/screen-capture-exclusivity.md §Process ownership is the only mechanism preventing this orphan, so it has regressed.`,
        },
      );

      expect(await captureProcessCommand(capturePid)).toBeUndefined();
    });
  },
);

/**
 * The command line of `pid` if it is still running AND is still the capture
 * sidecar, else `undefined`. Matching on the command (not just liveness) keeps
 * a recycled pid from reading as a surviving orphan. Deliberately `ps`-based,
 * the same process-table introspection `lib/find-child-pid.ts` already uses —
 * the protocol has no RPC for this and must not grow one.
 */
async function captureProcessCommand(pid: number): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "command="]);
    const command = stdout.trim();
    return command.includes("windower-capture-macos") ? command : undefined;
  } catch {
    // `ps -p` exits non-zero when no such process exists.
    return undefined;
  }
}
