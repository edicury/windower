import { mkdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type CaptureTarget, DaemonError } from "@windower/core";

/** Variables available for filename-template substitution — see resolveFilenameTemplate. */
export interface FilenameTemplateVars {
  target: CaptureTarget;
  sessionId: string;
  timestamp: Date;
}

/** Filesystem-safe slug for a capture target, used as the `{target}` placeholder. */
function targetSlug(target: CaptureTarget): string {
  switch (target.kind) {
    case "window":
      return target.appName;
    case "display":
      return target.name;
    case "region":
      return target.displayId;
  }
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Sortable, filesystem-safe timestamp, e.g. `2026-08-09T12-30-00` (no colons). */
function isoFilenameTimestamp(date: Date): string {
  const y = date.getFullYear();
  const mo = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const h = pad(date.getHours());
  const mi = pad(date.getMinutes());
  const s = pad(date.getSeconds());
  return `${y}-${mo}-${d}T${h}-${mi}-${s}`;
}

function dateOnly(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function timeOnly(date: Date): string {
  return `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

/**
 * Replaces characters unsafe/undesirable in a filename component (path
 * separators, null bytes, control chars, and a few other reserved-on-some-OS
 * characters) with `_`, while keeping the rest human-readable. Applied to
 * the whole resolved string, not per-placeholder, so literal template text
 * containing `/` (unlikely but possible) is sanitized too.
 */
function sanitizeFilenameComponent(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — stripping control chars from filenames
  return value.replace(/[/\\\0\x00-\x1f<>:"|?*]/g, "_").trim();
}

/**
 * Resolves a filename template (e.g. the default `{target}-{timestamp}`)
 * against a session's target/id/timestamp. Pure — no I/O, no uniqueness
 * check (see resolveUniqueOutputPath for that).
 */
export function resolveFilenameTemplate(template: string, vars: FilenameTemplateVars): string {
  const { target, sessionId, timestamp } = vars;
  const replacements: Record<string, string> = {
    target: targetSlug(target),
    sessionId,
    timestamp: isoFilenameTimestamp(timestamp),
    date: dateOnly(timestamp),
    time: timeOnly(timestamp),
  };

  const resolved = template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = replacements[key];
    return value !== undefined ? sanitizeFilenameComponent(value) : match;
  });

  return sanitizeFilenameComponent(resolved);
}

/**
 * Ensures `dir` exists (mkdir -p semantics) and is actually writable, by
 * writing and removing a small probe file rather than trusting
 * `fs.access`'s W_OK check (unreliable on some filesystems/platforms).
 * Throws `DaemonError("OUTPUT_DIR_NOT_WRITABLE")` on any failure, so a bad
 * `outputDir` fails at `start` preflight, not minutes into a recording.
 */
export async function ensureWritableOutputDir(dir: string): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
  } catch (err) {
    throw new DaemonError(
      "OUTPUT_DIR_NOT_WRITABLE",
      `Cannot create output directory "${dir}": ${reasonOf(err)}`,
    );
  }

  const probePath = join(dir, `.windower-write-probe-${process.pid}-${Date.now()}`);
  try {
    await writeFile(probePath, "");
  } catch (err) {
    throw new DaemonError(
      "OUTPUT_DIR_NOT_WRITABLE",
      `Output directory "${dir}" is not writable: ${reasonOf(err)}`,
    );
  }
  try {
    await unlink(probePath);
  } catch {
    // Best-effort cleanup — the probe write already proved writability.
  }
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Returns an absolute path `join(dir, baseName + ext)` if unused, otherwise
 * `baseName-2${ext}`, `baseName-3${ext}`, ... until an unused path is found.
 * Never overwrites an existing file. Not race-safe (stat-then-decide), which
 * is fine for the single-daemon, sequential-session-start use case.
 */
export async function resolveUniqueOutputPath(
  dir: string,
  baseName: string,
  ext: string,
): Promise<string> {
  let candidate = join(dir, `${baseName}${ext}`);
  let suffix = 2;
  while (await pathExists(candidate)) {
    candidate = join(dir, `${baseName}-${suffix}${ext}`);
    suffix += 1;
  }
  return candidate;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if (typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT") {
      return false;
    }
    throw err;
  }
}
