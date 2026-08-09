import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolves a package's real semver version from its own `package.json` at
 * runtime, replacing hardcoded strings like the daemon's old
 * `WINDOWER_VERSION = "0.1.0"` and the CLI's old `.version("0.0.0")`.
 *
 * Callers must pass their own `import.meta.url` (e.g.
 * `packageVersion(import.meta.url)` called from `apps/daemon/src/session-manager.ts`
 * or `packages/cli/src/index.ts`) — `@windower/core`'s version is not
 * necessarily the daemon's or the CLI's, since every package in this
 * pnpm+turbo monorepo has its own `package.json` and versions independently.
 *
 * Implementation walks up from the caller's own module directory looking for
 * the nearest `package.json`. This is preferred over
 * `process.env.npm_package_version` because that variable is only set by
 * `npm run`/`pnpm run` invocations of the *top-level* script — it is not
 * reliably present (or correct) when, e.g., the daemon is spawned as a
 * detached child process with a snapshotted environment
 * (`packages/core/src/daemon/connect.ts`'s `spawnDaemonDetached`), and it
 * would report the wrong package's version for a nested workspace command.
 * Walking from `import.meta.url` works identically whether the caller is
 * running from `src/` (dev) or `dist/` (built), since both sit one level
 * inside the package root next to its `package.json`.
 */
export function packageVersion(callerUrl: string, fallback = "0.0.0"): string {
  let dir = dirname(fileURLToPath(callerUrl));

  // Bounded walk: a real package is never more than a handful of directories
  // deep from its package.json, and this guards against an unexpected
  // filesystem layout spinning forever.
  for (let i = 0; i < 20; i++) {
    const candidate = join(dir, "package.json");
    try {
      const raw = readFileSync(candidate, "utf8");
      const pkg = JSON.parse(raw) as { version?: unknown };
      return typeof pkg.version === "string" && pkg.version.length > 0 ? pkg.version : fallback;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        // Found a package.json but couldn't read/parse it — don't keep
        // walking past a package's own (malformed) manifest.
        return fallback;
      }
    }

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return fallback;
}
