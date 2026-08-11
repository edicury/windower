import { chmodSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

/**
 * Which method-ownership surface of the sidecar protocol a binary implements
 * (`contracts/sidecar-protocol.md` — capture surface: `describe`,
 * `enumerateTargets`, `startCapture`, `stopCapture`, `cancelCapture`,
 * `captureFrame`; control surface: `describe`, `performInput`,
 * `resizeWindow`). This selector is deliberately platform-neutral: it names a
 * protocol surface, not an OS. Whether a platform implements the two surfaces
 * with two binaries (macOS, Phase 21), one binary, or any other topology is a
 * per-platform detail confined to the lookup tables below.
 */
export type SidecarSurface = "capture" | "control";

/**
 * Env var override for the capture-surface binary path. Checked before any
 * other resolution strategy — useful for tests, CI, and (later) a packaged
 * build that wants to pin an exact binary without touching resolution logic.
 *
 * Kept under its pre-Phase-21 name (`WINDOWER_SIDECAR_BINARY_PATH`) rather
 * than renamed: it's documented in `README.md`'s env-var table and used by
 * existing e2e/CLI tests, and the capture surface is what it always pointed
 * at. The control surface gets its own var (below) rather than sharing this
 * one — a single var pointing at one binary can't describe two.
 */
export const SIDECAR_BINARY_PATH_ENV = "WINDOWER_SIDECAR_BINARY_PATH";

/** Env var override for the control-surface binary path (Phase 21). */
export const CONTROL_BINARY_PATH_ENV = "WINDOWER_CONTROL_BINARY_PATH";

/** Per-surface env-var override name. */
const BINARY_PATH_ENV_BY_SURFACE: Record<SidecarSurface, string> = {
  capture: SIDECAR_BINARY_PATH_ENV,
  control: CONTROL_BINARY_PATH_ENV,
};

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
 * Per-(platform, surface) dev-build relative path (from repo root) to the
 * sidecar binary produced by that platform's native build. Only macOS exists
 * in MVP (Phase 2); windows/linux are Phase 16/17 and have no binary to
 * resolve to yet, so they're intentionally absent from this table rather
 * than mapped to a guessed path.
 *
 * A platform that implements both surfaces in one binary simply maps both
 * keys to the same path — the two-binary split is macOS's answer to Phase
 * 21's single-ScreenCaptureKit-writer invariant, not a protocol requirement.
 */
const DEV_BUILD_RELATIVE_PATH: Partial<Record<NodeJS.Platform, Record<SidecarSurface, string>>> = {
  darwin: {
    capture: "native/macos/.build/debug/windower-capture-macos",
    control: "native/macos/.build/debug/windower-control-macos",
  },
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

/**
 * The binary's filename within its platform-sidecar npm package, per surface.
 * The npm package ships both binaries side by side under `bin/` (see
 * `packages/sidecar-macos-{arm64,x64}/README.md`).
 */
const SIDECAR_BINARY_FILENAME_BY_PLATFORM: Partial<
  Record<NodeJS.Platform, Record<SidecarSurface, string>>
> = {
  darwin: {
    capture: "windower-capture-macos",
    control: "windower-control-macos",
  },
};

/**
 * Which of the three resolution strategies in
 * `resolveSidecarBinaryPathWithSource` produced the resolved path — surfaced
 * by `windower doctor`'s `sidecar.source` field (`data-model.md`
 * §PermissionReport) so a diagnostic can say e.g. "you're running a dev
 * build, not the npm-installed binary" instead of just a bare path.
 */
export type SidecarBinarySource = "env-override" | "dev-build" | "npm-package";

export interface ResolvedSidecarBinary {
  path: string;
  source: SidecarBinarySource;
}

/**
 * Resolves the filesystem path to the native sidecar binary implementing a
 * given protocol surface, tagged with which resolution strategy produced it.
 * `resolveSidecarBinaryPath` below is a thin wrapper over this that drops the
 * tag — kept as the single place this resolution order is implemented so the
 * two can't drift.
 *
 * Resolution order (all per-surface):
 * 1. The surface's env var (`WINDOWER_SIDECAR_BINARY_PATH` for capture,
 *    `WINDOWER_CONTROL_BINARY_PATH` for control), if set — an explicit
 *    override, also the natural extension point for a packaged build that
 *    wants to pin an exact binary without touching resolution logic.
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
 * branches on platform" rule from CLAUDE.md. `surface` is likewise not a
 * platform branch: it names a protocol method group that exists on every
 * platform, and the mapping from surface to filename (one binary or two) is
 * confined to the per-platform tables above. Callers above this (daemon,
 * CLI, MCP server) ask for "the capture binary" or "the control binary" and
 * react to capabilities from `describe()` afterward.
 */
export function resolveSidecarBinaryPathWithSource(
  surface: SidecarSurface = "capture",
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): ResolvedSidecarBinary {
  const override = process.env[BINARY_PATH_ENV_BY_SURFACE[surface]];
  if (override && override.trim().length > 0) {
    return { path: override, source: "env-override" };
  }

  const relativePath = DEV_BUILD_RELATIVE_PATH[platform]?.[surface];
  if (relativePath) {
    try {
      const repoRoot = findRepoRoot(thisModuleDir());
      const resolved = join(repoRoot, relativePath);
      if (existsSync(resolved)) {
        return { path: resolved, source: "dev-build" };
      }
    } catch {
      // Not running inside a monorepo checkout (e.g. installed from npm) —
      // fall through to the packaged-binary resolution below.
    }
  }

  const packageName = SIDECAR_PACKAGE_BY_PLATFORM_ARCH[platform]?.[arch];
  const binaryFilename = SIDECAR_BINARY_FILENAME_BY_PLATFORM[platform]?.[surface];
  if (packageName && binaryFilename) {
    try {
      const resolved = require.resolve(`${packageName}/bin/${binaryFilename}`);
      // npm only preserves the executable bit for files declared in a
      // package's own `bin` field; these binaries ship under `files: ["bin"]`
      // instead (so callers resolve them by exact filename, not npm's own PATH
      // shimming), which means the bit is silently lost on publish/install —
      // confirmed via a real `npm install` of a signed sidecar package.
      chmodSync(resolved, 0o755);
      return { path: resolved, source: "npm-package" };
    } catch {
      // Optional dependency not installed (wrong platform/arch, or not
      // installed via npm at all) — fall through to the error below.
    }
  }

  throw new Error(
    `No sidecar available for platform "${platform}"/arch "${arch}" (${surface} surface) yet (windows/linux backends are post-MVP — see specs/001-windower-mvp/tasks/phase-16-windows-backend.md and phase-17-linux-backend.md). ` +
      `Set ${BINARY_PATH_ENV_BY_SURFACE[surface]} to point at a binary explicitly if you're testing a custom build.`,
  );
}

/** `resolveSidecarBinaryPathWithSource(...).path` — see that function for resolution order/doc. */
export function resolveSidecarBinaryPath(
  surface: SidecarSurface = "capture",
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): string {
  return resolveSidecarBinaryPathWithSource(surface, platform, arch).path;
}
