import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Repo root — scripts/release/lib.mjs lives two directories below it. */
export const REPO_ROOT = join(__dirname, "..", "..");

export function readPackageJson(dir, root = REPO_ROOT) {
  const path = join(root, dir, "package.json");
  return { path, json: JSON.parse(readFileSync(path, "utf8")) };
}

export function writePackageJson(path, json) {
  // Match the repo's existing package.json style: 2-space indent, trailing newline.
  writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
}

/** Increment the patch (last dot-separated numeric) segment of a semver string. */
export function bumpPatch(version) {
  const parts = version.split(".");
  if (parts.length !== 3 || parts.some((p) => !/^\d+$/.test(p))) {
    throw new Error(`Cannot patch-bump non-semver version "${version}"`);
  }
  const [major, minor, patch] = parts.map(Number);
  return `${major}.${minor}.${patch + 1}`;
}

/**
 * Check whether <pkgName>@<version> already exists on the real npm registry.
 * Returns true if it exists, false if npm reports it as not found (E404).
 * Any other failure (network, auth, malformed name) is rethrown — a
 * preflight check that silently treats "I don't know" as "safe to publish"
 * defeats the point of the check.
 */
export function registryVersionExists(pkgName, version, { exec = defaultExec } = {}) {
  const spec = `${pkgName}@${version}`;
  const result = exec("npm", ["view", spec, "version", "--json"]);
  if (result.status === 0) {
    // `npm view` on an existing version prints the version string (possibly
    // JSON-quoted with --json); any zero-exit output means it exists.
    return true;
  }
  const stderr = String(result.stderr ?? "");
  if (
    result.status !== 0 &&
    (/E404/.test(stderr) || /is not in this registry/i.test(stderr) || stderr.trim() === "")
  ) {
    return false;
  }
  // Non-404 failure (auth, network, registry outage) — don't silently treat as "safe".
  const err = new Error(`npm view ${spec} failed unexpectedly: ${stderr || result.error}`);
  err.cause = result;
  throw err;
}

function defaultExec(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", cwd: REPO_ROOT, ...opts });
}

export { defaultExec };

/**
 * Publish a single package via `pnpm publish` (not raw `npm publish`) so
 * `workspace:*` deps are rewritten to the exact published version, as
 * phase-14's manual publish log describes.
 */
export function publishPackage(entry, { exec = defaultExec, npmrcPath, extraArgs = [] } = {}) {
  const args = [
    "--filter",
    entry.pkgName,
    "publish",
    "--no-git-checks",
    ...(npmrcPath ? ["--config.userconfig", npmrcPath] : []),
    ...extraArgs,
  ];
  return exec("pnpm", args);
}

/**
 * Write a temp .npmrc authenticating against the real npm registry via
 * NPM_TOKEN (an Automation-type token in CI — see CODESIGNING.md's secrets
 * table and phase-23's settled decision 6). Never touches the repo's own
 * .npmrc. Returns { npmrcPath, cleanup }.
 */
export function setupNpmAuth(token) {
  if (!token) {
    throw new Error(
      "NPM_TOKEN is not set. Publishing requires an npm Automation-type token " +
        "(see native/macos/CODESIGNING.md's secrets table).",
    );
  }
  const dir = mkdtempSync(join(tmpdir(), "windower-release-"));
  const npmrcPath = join(dir, ".npmrc");
  writeFileSync(npmrcPath, `//registry.npmjs.org/:_authToken=${token}\n`);
  return {
    npmrcPath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
