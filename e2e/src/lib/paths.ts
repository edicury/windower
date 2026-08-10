import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findRepoRoot } from "@windower/core";

function thisModuleDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

/** Monorepo root, resolved the same way `@windower/core`'s sidecar-path.ts does. */
export function repoRoot(): string {
  return findRepoRoot(thisModuleDir());
}

/** Env var override for the demo-app fixture binary, mirrors `WINDOWER_SIDECAR_BINARY_PATH`. */
export const DEMO_APP_BINARY_PATH_ENV = "WINDOWER_DEMO_APP_BINARY_PATH";

/**
 * Resolves the demo-app fixture binary built by
 * `fixtures/demo-app/package-app.sh` (see fixtures/demo-app/README.md).
 * Does not build it — the e2e README documents the required build step as a
 * prerequisite.
 *
 * Must be the bundled `.app`'s executable, not the raw `swift build` output
 * — `native/macos`'s window enumeration filters out any window whose owning
 * app has an empty `bundleIdentifier` (see `Enumeration.swift`), which a
 * bare unbundled executable always has.
 */
export function resolveDemoAppBinaryPath(): string {
  const override = process.env[DEMO_APP_BINARY_PATH_ENV];
  if (override && override.trim().length > 0) return override;
  return join(
    repoRoot(),
    "fixtures/demo-app/.build/release/WindowerDemoApp.app/Contents/MacOS/windower-demo-app",
  );
}

/** Whether the demo-app fixture binary has been built. */
export function demoAppBinaryExists(): boolean {
  return existsSync(resolveDemoAppBinaryPath());
}

/**
 * Whether the macOS capture-surface binary's dev build has been built
 * (`swift build --package-path native/macos`). Phase 21 split the sidecar
 * into two binaries; this gate keeps its old name/meaning (capture is what
 * "the sidecar" meant to every existing e2e test) — see
 * `controlBinaryExists` for the control surface.
 */
export function sidecarBinaryExists(): boolean {
  const override = process.env.WINDOWER_SIDECAR_BINARY_PATH;
  if (override && override.trim().length > 0) return existsSync(override);
  return existsSync(join(repoRoot(), "native/macos/.build/debug/windower-capture-macos"));
}

/** Whether the macOS control-surface binary's dev build has been built. */
export function controlBinaryExists(): boolean {
  const override = process.env.WINDOWER_CONTROL_BINARY_PATH;
  if (override && override.trim().length > 0) return existsSync(override);
  return existsSync(join(repoRoot(), "native/macos/.build/debug/windower-control-macos"));
}

/** Resolves the daemon's node entrypoint, same resolution `@windower/core`'s connect.ts uses. */
export function resolveDaemonEntryPath(): string {
  const override = process.env.WINDOWER_DAEMON_BIN_PATH;
  if (override && override.trim().length > 0) return override;
  return join(repoRoot(), "apps/daemon/dist/bin.js");
}

/** Whether the daemon's TS build has been built (`pnpm turbo run build`). */
export function daemonEntryExists(): boolean {
  return existsSync(resolveDaemonEntryPath());
}
