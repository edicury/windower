import { open, unlink } from "node:fs/promises";

/**
 * Minimum shape every lock payload must carry: the pid of the process that
 * holds the lock, used for the stale-lock liveness check, and the wall-clock
 * time it was acquired, for diagnostics (`windower doctor`, error messages).
 * Callers attach whatever else identifies the specific resource being locked
 * — `daemon.lock` adds nothing extra, the per-target lock
 * (`packages/engine/src/target-lock.ts`, not built here) adds
 * `{sessionId, targetKey}`. `FileLock` itself never interprets those extra
 * fields.
 */
export interface FileLockPayload {
  pid: number;
  acquiredAt: string;
  [key: string]: unknown;
}

/** Thrown by `acquire()` when the lock is currently held by a live process. */
export class LockHeldError extends Error {
  readonly holder: FileLockPayload;

  constructor(path: string, holder: FileLockPayload) {
    super(`Lock at ${path} is held by pid ${holder.pid}`);
    this.name = "LockHeldError";
    this.holder = holder;
  }
}

/**
 * Cross-process advisory lock backed by a single file, using `O_EXCL` create
 * for the mutual-exclusion guarantee (two processes racing `acquire()` can't
 * both succeed — the second `open(path, "wx")` fails with `EEXIST`) and
 * pid-liveness checking to recover from a lock left behind by a process that
 * crashed instead of releasing it.
 *
 * Backs both the daemon spawn lock (`~/.windower/daemon.lock`) and the
 * per-recording-target lock (`~/.windower/locks/target-<sha1>.lock`,
 * `packages/engine/src/target-lock.ts`) — see `contracts/daemon-rpc.md`
 * "Spawn lockfile" and `phase-20-daemon-optional.md` "Cross-process safety".
 * `FileLock` is deliberately payload-agnostic: it stores and returns whatever
 * JSON object the caller gives it, as long as it has `pid`/`acquiredAt`.
 */
export class FileLock {
  constructor(private readonly path: string) {}

  /**
   * Attempts to acquire the lock once (no internal polling/retry — callers
   * that want to wait for a held lock, e.g. `ensureDaemonRunning` polling the
   * socket instead of the lock itself, own that decision per
   * `contracts/daemon-rpc.md`).
   *
   * - Lock file absent: create it with the given payload, done.
   * - Lock file present, owning pid dead: steal it (unlink + recreate).
   * - Lock file present, owning pid alive: throws `LockHeldError`.
   */
  async acquire(payload: FileLockPayload): Promise<void> {
    const body = `${JSON.stringify(payload, null, 2)}\n`;
    try {
      const handle = await open(this.path, "wx");
      try {
        await handle.writeFile(body);
      } finally {
        await handle.close();
      }
      return;
    } catch (err) {
      if (!isErrnoException(err) || err.code !== "EEXIST") throw err;
    }

    // Lock file exists — decide whether to steal it.
    const holder = await this.readHolder();
    if (holder && isAlive(holder.pid)) {
      throw new LockHeldError(this.path, holder);
    }

    // Owner is dead (or the lock file was unreadable/corrupt) — steal it.
    await this.release();
    const handle = await open(this.path, "wx");
    try {
      await handle.writeFile(body);
    } finally {
      await handle.close();
    }
  }

  /** Unlinks the lock file. Safe to call even if the lock is already gone. */
  async release(): Promise<void> {
    try {
      await unlink(this.path);
    } catch (err) {
      if (!isErrnoException(err) || err.code !== "ENOENT") throw err;
    }
  }

  /** Reads the current holder's payload without acquiring/stealing. Returns `undefined` if no lock file exists or it's unreadable. */
  async readHolder(): Promise<FileLockPayload | undefined> {
    try {
      const handle = await open(this.path, "r");
      try {
        const raw = await handle.readFile("utf8");
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.pid === "number") return parsed as FileLockPayload;
        return undefined;
      } finally {
        await handle.close();
      }
    } catch {
      return undefined;
    }
  }
}

/** `process.kill(pid, 0)` throws `ESRCH` for a dead pid, `EPERM` for a live pid owned by another user — only `ESRCH` means "safe to steal". */
function isAlive(pid: number): boolean {
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
