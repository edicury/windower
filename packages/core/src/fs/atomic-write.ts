import { randomBytes } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";

/**
 * Writes `data` to `path` without ever leaving a torn/partial read visible to
 * a concurrent reader: write to a temp file in the same directory, then
 * `rename()` it into place. `rename` is atomic on the same filesystem, so any
 * reader of `path` sees either the previous complete contents or the new
 * complete contents, never a partial write.
 *
 * Extracted here so `SessionStore`, `FileLock`, and any other `~/.windower`
 * writer share one implementation (`phase-20-daemon-optional.md` "Core
 * primitives").
 *
 * The temp file must live in the same directory as `path` — `rename` across
 * filesystems/mounts is not atomic (and on some platforms not even allowed).
 */
export async function writeFileAtomic(path: string, data: string | Buffer): Promise<void> {
  const tempPath = `${path}.tmp-${randomBytes(6).toString("hex")}`;
  await writeFile(tempPath, data);
  await rename(tempPath, path);
}
