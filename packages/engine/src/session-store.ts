import { readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import {
  type RecordingSession,
  RecordingSessionSchema,
  type SessionState,
  sessionFilePath,
  sessionsDir,
  writeFileAtomic,
} from "@windower/core";

interface CacheEntry {
  session: RecordingSession;
  mtimeMs: number;
}

/**
 * Persists `RecordingSession` records to `~/.windower/sessions/<id>.json` on
 * every state transition (phase-6 task file: "required for crash recovery
 * and `windower status` after a daemon restart"). Keeps an in-memory cache
 * so reads don't hit disk on every RPC call — the cache is always written
 * through, never the source of truth on its own.
 *
 * Phase 20 hardening (`phase-20-daemon-optional.md` "Cross-process safety"):
 * writes go through `writeFileAtomic` (temp + rename) so a concurrent reader
 * — e.g. a `windower status` CLI process reading the same directory a daemon
 * is writing to — never sees a torn/partial file, and `get`/`list` compare
 * each session file's mtime against the cached copy on every call so a
 * `SessionStore` instance in one process picks up another process's writes
 * without needing an explicit cache-clearing call. This is what makes a
 * daemon-free `record` (writing sessions from a CLI process) visible to
 * `windower status`/`windower list` run from a different process reading the
 * same files.
 */
export class SessionStore {
  private readonly cache = new Map<string, CacheEntry>();

  /** Loads every persisted session file into the in-memory cache. Call once at daemon startup. */
  async load(): Promise<RecordingSession[]> {
    await mkdir(sessionsDir(), { recursive: true });
    await this.refresh();
    return [...this.cache.values()].map((entry) => entry.session);
  }

  /**
   * Rescans `sessionsDir()` and reloads any file whose mtime has moved past
   * what's cached (or that isn't cached yet) — the mtime-invalidation half of
   * this class's cross-process contract. Malformed/partially-written files
   * are skipped, same as the old load()-only behavior — a torn read must
   * look like "not updated yet", never crash the caller.
   */
  private async refresh(): Promise<void> {
    const entries = await readdir(sessionsDir()).catch(() => [] as string[]);
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const id = entry.slice(0, -".json".length);
      const path = `${sessionsDir()}/${entry}`;
      let mtimeMs: number;
      try {
        mtimeMs = (await stat(path)).mtimeMs;
      } catch {
        continue; // Deleted between readdir() and stat() — skip.
      }
      const cached = this.cache.get(id);
      if (cached && cached.mtimeMs >= mtimeMs) continue;

      const session = await this.readFile(entry);
      if (session) this.cache.set(id, { session, mtimeMs });
    }
  }

  private async readFile(fileName: string): Promise<RecordingSession | undefined> {
    try {
      const raw = await readFile(`${sessionsDir()}/${fileName}`, "utf8");
      return RecordingSessionSchema.parse(JSON.parse(raw));
    } catch {
      // Malformed/partially-written session file — skip rather than crash
      // daemon startup over one bad record.
      return undefined;
    }
  }

  /**
   * Synchronous single-session refresh, used by `get()`/`list()` so they stay
   * sync (every caller in `RecordingEngine`/`OperatorRunEngine` calls them
   * synchronously) while still picking up another process's writes. Uses
   * `statSync`/`readFileSync` rather than the async `refresh()` above, which
   * is reserved for `load()`'s full-directory scan at startup.
   */
  private refreshOneSync(sessionId: string): void {
    const path = sessionFilePath(sessionId);
    let mtimeMs: number;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      return; // No file for this id (yet, or ever) — leave cache as-is.
    }
    const cached = this.cache.get(sessionId);
    if (cached && cached.mtimeMs >= mtimeMs) return;

    try {
      const raw = readFileSync(path, "utf8");
      const session = RecordingSessionSchema.parse(JSON.parse(raw));
      this.cache.set(sessionId, { session, mtimeMs });
    } catch {
      // Torn/partial read or malformed JSON — keep serving the last-known-good
      // cached copy (if any) rather than surfacing a spurious "not found".
    }
  }

  get(sessionId: string): RecordingSession | undefined {
    this.refreshOneSync(sessionId);
    return this.cache.get(sessionId)?.session;
  }

  list(state?: SessionState): RecordingSession[] {
    this.refreshDirectorySync();
    const all = [...this.cache.values()].map((entry) => entry.session);
    return state ? all.filter((s) => s.state === state) : all;
  }

  /** Sync counterpart to `refresh()`, for `list()` — see `refreshOneSync`'s doc for why sync. */
  private refreshDirectorySync(): void {
    let entries: string[];
    try {
      entries = readdirSync(sessionsDir());
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      this.refreshOneSync(entry.slice(0, -".json".length));
    }
  }

  /**
   * Persists a session to disk atomically (write-then-rename, so a
   * concurrent reader never sees a torn file) and updates the in-memory
   * cache. Call on every state transition.
   */
  async save(session: RecordingSession): Promise<void> {
    await mkdir(sessionsDir(), { recursive: true });
    const body = `${JSON.stringify(session, null, 2)}\n`;
    await writeFileAtomic(sessionFilePath(session.id), body);
    let mtimeMs = Date.now();
    try {
      mtimeMs = statSync(sessionFilePath(session.id)).mtimeMs;
    } catch {
      // Fall back to Date.now() above — file should always exist right after
      // writeFileAtomic, but don't let a stat race throw out of save().
    }
    this.cache.set(session.id, { session, mtimeMs });
  }

  /**
   * `session.owner` (Phase 20, `data-model.md` §RecordingSession) records the
   * pid + start time of the process that created the session. This checks
   * whether that process is still alive, using the same `process.kill(pid,
   * 0)` liveness probe `FileLock`'s stale-steal logic uses — `ESRCH` means
   * dead, `EPERM` means alive-but-owned-by-another-user (treated as alive,
   * since we can't prove otherwise). A session with no `owner` (0.1.x session
   * files, or any session created before this field existed) is treated as
   * NOT owned by a live process — conservative default, since a caller
   * relying on this (the `attach`-mode local `stop`/`cancel` fallback) wants
   * "safe to treat as orphaned" when it can't prove otherwise.
   */
  isOwnedByLiveProcess(session: RecordingSession): boolean {
    if (!session.owner) return false;
    return isPidAlive(session.owner.pid);
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (isErrnoException(err) && err.code === "EPERM") return true;
    return false;
  }
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}
