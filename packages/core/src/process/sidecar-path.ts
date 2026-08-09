import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Env var override for the sidecar binary path. Checked before any other
 * resolution strategy — useful for tests, CI, and (later) a packaged build
 * that wants to pin an exact binary without touching resolution logic.
 */
export const SIDECAR_BINARY_PATH_ENV = "WINDOWER_SIDECAR_BINARY_PATH";

/**
 * Walks up from a starting directory looking for `pnpm-workspace.yaml`,
 * which marks the monorepo root. There's no existing precedent for this in
 * the repo (checked), so this is the first instance — kept small and
 * dependency-free rather than pulling in a "find workspace root" package.
 */
export function findRepoRoot(startDir: string): string {
  let dir = startDir;
  let parent = dirname(dir);
  while (!existsSync(join(dir, "pnpm-workspace.yaml"))) {
    if (parent === dir) {
      throw new Error(
        `Could not locate repo root (pnpm-workspace.yaml) walking up from "${startDir}"`,
      );
    }
    dir = parent;
    parent = dirname(dir);
  }
  return dir;
}

/** This module's own directory, used as the walk-up starting point. */
function thisModuleDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

/**
 * Per-platform dev-build relative path (from repo root) to the sidecar
 * binary produced by that platform's native build. Only macOS exists in
 * MVP (Phase 2); windows/linux are Phase 16/17 and have no binary to
 * resolve to yet, so they're intentionally absent from this table rather
 * than mapped to a guessed path.
 */
const DEV_BUILD_RELATIVE_PATH: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "native/macos/.build/debug/windower-sidecar-macos",
};

/**
 * Resolves the filesystem path to the native sidecar binary.
 *
 * Resolution order:
 * 1. `WINDOWER_SIDECAR_BINARY_PATH` env var, if set — an explicit override,
 *    also the natural extension point for Phase 14's packaged-binary
 *    resolution (e.g. resolving an `optionalDependencies` platform package)
 *    without having to change this function's shape.
 * 2. The dev build output under `native/<os>/.build/debug/...`, relative to
 *    the monorepo root.
 *
 * This function decides *which file* to spawn for the current OS — that's
 * platform-dependent I/O (like picking a file extension), not a capability
 * decision, so it does not violate the "packages/core never branches on
 * platform" rule from CLAUDE.md. Callers above this (daemon, CLI, MCP
 * server) never call this with a platform they're branching logic on; they
 * just ask "give me the sidecar binary" and react to capabilities from
 * `describe()` afterward.
 */
export function resolveSidecarBinaryPath(platform: NodeJS.Platform = process.platform): string {
  const override = process.env[SIDECAR_BINARY_PATH_ENV];
  if (override && override.trim().length > 0) {
    return override;
  }

  const relativePath = DEV_BUILD_RELATIVE_PATH[platform];
  if (!relativePath) {
    throw new Error(
      `No sidecar available for platform "${platform}" yet (windows/linux backends are post-MVP — see specs/001-windower-mvp/tasks/phase-16-windows-backend.md and phase-17-linux-backend.md). ` +
        `Set ${SIDECAR_BINARY_PATH_ENV} to point at a binary explicitly if you're testing a custom build.`,
    );
  }

  const repoRoot = findRepoRoot(thisModuleDir());
  const resolved = join(repoRoot, relativePath);
  return resolved;
}
