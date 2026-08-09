import type { PermissionReport } from "@windower/core";
import { daemonEntryExists, demoAppBinaryExists, sidecarBinaryExists } from "./paths.js";

/**
 * Synchronous, no-daemon-needed prerequisite check: platform + build
 * artifacts. Evaluated at module-load time so `describe.skipIf(...)` can
 * skip an entire file cleanly (no daemon spawn attempt, no hang) when e.g.
 * this suite is accidentally run on a non-macOS machine or before the
 * fixture/daemon have been built. See e2e/README.md's "Prerequisites"
 * section for the exact build commands this expects to have already run.
 */
export function missingBuildPrerequisites(): string[] {
  const missing: string[] = [];
  if (process.platform !== "darwin") {
    missing.push(`platform is "${process.platform}", this suite requires macOS ("darwin")`);
  }
  if (!daemonEntryExists()) {
    missing.push('apps/daemon is not built — run "pnpm turbo run build" first');
  }
  if (!sidecarBinaryExists()) {
    missing.push(
      'native/macos sidecar is not built — run "pnpm turbo run build" or "swift build --package-path native/macos" first',
    );
  }
  if (!demoAppBinaryExists()) {
    missing.push('fixtures/demo-app is not built — run "fixtures/demo-app/package-app.sh" first');
  }
  return missing;
}

/**
 * Asserts every TCC grant this suite needs is present. Throws a single,
 * clearly-labeled error (rather than letting a downstream RPC call hang or
 * fail with an opaque `PERMISSION_DENIED`) so a run against an ungranted
 * terminal fails fast with next steps instead of hanging on a system
 * permission prompt that GitHub Actions / a headless run can never satisfy.
 * See e2e/README.md's "Prerequisites" section for the exact
 * System Settings / tccutil steps.
 */
export function assertPermissionsGrantedOrThrow(report: PermissionReport): void {
  const missing: string[] = [];
  if (report.screenRecording !== "granted")
    missing.push(`screenRecording (${report.screenRecording})`);
  if (report.accessibility !== "granted") missing.push(`accessibility (${report.accessibility})`);
  if (report.microphone !== "granted") missing.push(`microphone (${report.microphone})`);
  if (missing.length === 0) return;

  throw new Error(
    `windower e2e: missing TCC grant(s) for the terminal/Node binary running this suite: ${missing.join(", ")}. ` +
      "This is expected on a fresh machine or CI — these permissions cannot be granted non-interactively. " +
      "See e2e/README.md's Prerequisites section for exact steps, then re-run.",
  );
}
