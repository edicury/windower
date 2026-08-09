import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { FileLock, LockHeldError, windowerHome } from "@windower/core";
import {
  type TargetLock,
  TargetLockConflictError,
  type TargetLockOwner,
} from "./recording-engine.js";

/** `~/.windower/locks/target-<sha1(targetKey)>.lock` — see `target-lock.ts` doc block below. */
function lockPathFor(targetKey: string): string {
  const digest = createHash("sha1").update(targetKey).digest("hex");
  return join(windowerHome(), "locks", `target-${digest}.lock`);
}

/**
 * Real cross-process `TargetLock` (`phase-20-daemon-optional.md` "Cross-
 * process safety"), backed by `FileLock` at
 * `~/.windower/locks/target-<sha1(targetKey)>.lock`. Replaces
 * `InMemoryTargetLock` as the default so a daemon-backed `start` and a
 * daemon-free `record` on the same display correctly contend through the
 * shared filesystem lock instead of two separate in-memory maps that can't
 * see each other — the whole point of the seam `RecordingEngine` was left
 * with (see `recording-engine.ts`'s `TargetLock` doc block).
 *
 * Lock payload is `{sessionId, pid, startedAt, targetKey}` — `pid`/`startedAt`
 * double as `FileLock`'s required `pid`/`acquiredAt` fields (an
 * `acquiredAt` alias isn't needed; `FileLock` only requires `pid` plus
 * *some* ISO string under `acquiredAt`, so it's included alongside
 * `startedAt` for clarity and doc-comment accuracy elsewhere in this file).
 * Stale-stolen when the owning pid is dead — this falls out of `FileLock`'s
 * own `acquire()` liveness check, not reimplemented here.
 */
export class FileTargetLock implements TargetLock {
  async acquire(targetKey: string, owner: TargetLockOwner): Promise<void> {
    const path = lockPathFor(targetKey);
    await mkdir(join(windowerHome(), "locks"), { recursive: true });
    const lock = new FileLock(path);
    try {
      await lock.acquire({
        pid: owner.pid,
        acquiredAt: owner.startedAt,
        sessionId: owner.sessionId,
        startedAt: owner.startedAt,
        targetKey,
      });
    } catch (err) {
      if (err instanceof LockHeldError) {
        const holder = err.holder;
        throw new TargetLockConflictError({
          sessionId: typeof holder.sessionId === "string" ? holder.sessionId : "unknown",
          pid: holder.pid,
          startedAt: typeof holder.startedAt === "string" ? holder.startedAt : holder.acquiredAt,
        });
      }
      throw err;
    }
  }

  async release(targetKey: string): Promise<void> {
    await new FileLock(lockPathFor(targetKey)).release();
  }
}
