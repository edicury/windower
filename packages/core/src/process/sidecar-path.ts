import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

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
 * Phase 14 packaging: per-(platform, arch) npm package name that ships the
 * release-built sidecar binary as an `optionalDependencies` entry, resolved
 * via npm's `os`/`cpu` package fields — same pattern as esbuild/swc. Only
 * darwin has real binaries in MVP; windows/linux stay absent (post-MVP, see
 * phase-16/17), same convention as `DEV_BUILD_RELATIVE_PATH` above.
 */
const SIDECAR_PACKAGE_BY_PLATFORM_ARCH: Partial<
  Record<NodeJS.Platform, Partial<Record<NodeJS.Architecture, string>>>
> = {
  darwin: {
    arm64: "@windower/sidecar-macos-arm64",
    x64: "@windower/sidecar-macos-x64",
  },
};

/** The binary's filename within its platform-sidecar npm package. */
const SIDECAR_BINARY_FILENAME_BY_PLATFORM: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "windower-sidecar-macos",
};

/**
 * Resolves the filesystem path to the native sidecar binary.
 *
 * Resolution order:
 * 1. `WINDOWER_SIDECAR_BINARY_PATH` env var, if set — an explicit override,
 *    also the natural extension point for a packaged build that wants to
 *    pin an exact binary without touching resolution logic.
 * 2. The dev build output under `native/<os>/.build/debug/...`, relative to
 *    the monorepo root — used when working inside the monorepo, so local
 *    dev builds keep working unchanged.
 * 3. (Phase 14) The platform-specific `@windower/sidecar-<os>-<arch>` npm
 *    package, resolved via `require.resolve` — used when installed as a
 *    real npm package (e.g. `npm install -g @windower/cli`) where there is
 *    no monorepo checkout to walk up to.
 *
 * This function decides *which file* to spawn for the current OS/arch —
 * that's platform-dependent I/O (like picking a file extension), not a
 * capability decision, so it does not violate the "packages/core never
 * branches on platform" rule from CLAUDE.md. Callers above this (daemon,
 * CLI, MCP server) never call this with a platform they're branching logic
 * on; they just ask "give me the sidecar binary" and react to capabilities
 * from `describe()` afterward.
 */
export function resolveSidecarBinaryPath(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): string {
  const override = process.env[SIDECAR_BINARY_PATH_ENV];
  if (override && override.trim().length > 0) {
    return override;
  }

  const relativePath = DEV_BUILD_RELATIVE_PATH[platform];
  if (relativePath) {
    try {
      const repoRoot = findRepoRoot(thisModuleDir());
      const resolved = join(repoRoot, relativePath);
      if (existsSync(resolved)) {
        return resolved;
      }
    } catch {
      // Not running inside a monorepo checkout (e.g. installed from npm) —
      // fall through to the packaged-binary resolution below.
    }
  }

  const packageName = SIDECAR_PACKAGE_BY_PLATFORM_ARCH[platform]?.[arch];
  const binaryFilename = SIDECAR_BINARY_FILENAME_BY_PLATFORM[platform];
  if (packageName && binaryFilename) {
    try {
      return require.resolve(`${packageName}/bin/${binaryFilename}`);
    } catch {
      // Optional dependency not installed (wrong platform/arch, or not
      // installed via npm at all) — fall through to the error below.
    }
  }

  throw new Error(
    `No sidecar available for platform "${platform}"/arch "${arch}" yet (windows/linux backends are post-MVP — see specs/001-windower-mvp/tasks/phase-16-windows-backend.md and phase-17-linux-backend.md). ` +
      `Set ${SIDECAR_BINARY_PATH_ENV} to point at a binary explicitly if you're testing a custom build.`,
  );
}
