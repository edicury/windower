import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  DaemonError,
  FileLock,
  LockHeldError,
  type SidecarClient,
  type SpawnSidecarOptions,
  windowerHome,
} from "@windower/core";
import type { SidecarFactory, SidecarHandle } from "./recording-engine.js";

/**
 * `~/.windower/capture.lock` — the global file mutex that makes one invalid
 * state impossible: two Windower processes concurrently owning
 * ScreenCaptureKit (`contracts/screen-capture-exclusivity.md`, Phase 21).
 *
 * This is a **low-level platform safety mechanism**, not a component, not a
 * service, not a domain concept. It is deliberately the smallest thing that
 * satisfies the invariant:
 *
 * > needs ScreenCaptureKit → try to acquire exclusivity → **acquired**:
 * > proceed · **busy**: wait briefly, then fail cleanly.
 *
 * Enforcement has two tiers. *Inside* a process (the daemon's normal path),
 * ordinary bookkeeping: it simply never starts a second capture sidecar, and
 * every in-process caller reuses the one it already has — no file I/O at all.
 * *Across* processes (daemon-optional execution, Phase 20), this lock file:
 * acquire before spawning `windower-capture-macos`, hold for that child's
 * entire lifetime, release when it dies.
 *
 * There is **no** capture-process discovery, **no** routing of a capture call
 * to the lock holder, **no** IPC socket, **no** cross-process capture RPC and
 * **no** holder lifecycle/promotion semantics. A caller that finds the lock
 * held waits briefly, then fails with `SCREEN_CAPTURE_BUSY`. It never connects
 * to the holder and asks it to capture on its behalf.
 *
 * Orphan prevention is a property of **process ownership**, not bookkeeping:
 * the capture sidecar is a child of the lock holder and exits on stdin EOF, so
 * the payload names no child pid and no pid-tracking infrastructure exists.
 *
 * NOTE (CLAUDE.md "protocol before platform"): nothing here branches on a
 * platform string. A backend that has no such contention (Windows/Linux) sees
 * an acquire that always succeeds.
 */

/** `~/.windower/capture.lock`. Resolved per call so a test's `WINDOWER_HOME` override is honored. */
export function captureLockPath(): string {
  return join(windowerHome(), "capture.lock");
}

/** Default bounded-wait budget for a live same-home holder before `SCREEN_CAPTURE_BUSY`. */
export const CAPTURE_LOCK_WAIT_MS = 2000;

const BACKOFF_START_MS = 5;
const BACKOFF_MAX_MS = 100;

/**
 * The `capture.lock` payload, verbatim per
 * `contracts/screen-capture-exclusivity.md` §Lock file. Nothing else belongs
 * in it: no holder kind, no capture-child pid, no socket path, no `sessionId`.
 */
export interface CaptureLockPayload {
  /** The process that spawned the capture sidecar — `FileLock`'s liveness pid. */
  pid: number;
  /** ISO 8601. Diagnostics only. */
  acquiredAt: string;
  /** The holder's resolved `WINDOWER_HOME` — split-brain guard, same as `hello`. */
  windowerHome: string;
  [key: string]: unknown;
}

/**
 * `SCREEN_CAPTURE_BUSY` — ScreenCaptureKit is owned by another live process:
 * a same-home holder that outlived the wait budget, or any holder from a
 * different `WINDOWER_HOME`. Carries the holder payload for diagnostics.
 */
export class ScreenCaptureBusyError extends DaemonError {
  readonly holder: CaptureLockPayload | undefined;

  constructor(message: string, holder?: CaptureLockPayload) {
    super("SCREEN_CAPTURE_BUSY", message);
    this.name = "ScreenCaptureBusyError";
    this.holder = holder;
  }
}

/**
 * The one seam every capture-surface caller uses. `PassthroughService`,
 * `RecordingEngine.resolveTarget`, and (via the daemon) the operator all take
 * this instead of a raw `SidecarFactory`, so there is no code path left that
 * can spawn a capture process without going through the lock.
 */
export interface CaptureAccess {
  /**
   * Runs `fn` against this process's capture sidecar — the one it already has
   * if it has one, otherwise one spawned under a freshly-acquired lock and
   * torn down afterwards. Never routes anywhere.
   */
  withCaptureClient<T>(fn: (client: SidecarClient) => Promise<T>): Promise<T>;
}

/** An active, this-process hold on the capture lock. */
export interface CaptureHold {
  /** The spawned `windower-capture-macos` handle — `RecordingEngine` drives capture through this. */
  readonly handle: SidecarHandle;
  readonly client: SidecarClient;
  readonly released: boolean;
  /** Terminates the capture child and releases the lock file. Idempotent. */
  release(): Promise<void>;
}

export interface CaptureLockOptions {
  /** Spawns `windower-capture-macos`. Injected so tests (and hosts) own binary resolution. */
  spawnSidecar: SidecarFactory;
  /** Bounded-wait budget override; defaults to `CAPTURE_LOCK_WAIT_MS`. MUST be finite. */
  waitMs?: number;
  /** Logging seam; defaults to `console.error`. */
  onLog?: (message: string) => void;
}

interface InternalHold extends CaptureHold {
  released: boolean;
  /**
   * How many holders share this one capture process. Multiple *concurrent
   * recordings on different targets* are one capture process serving several
   * `startCapture` sessions — the sidecar protocol keys capture state by
   * `sessionId` precisely so that works — not one ScreenCaptureKit process
   * each, which is the thing the invariant forbids. The lock (and the capture
   * child) is torn down when the last holder releases.
   */
  refs: number;
}

/**
 * Per-**process** hold registry, keyed by lock path. Deliberately module-level
 * rather than per-`CaptureLock`-instance: row 1 ("this process already has a
 * capture sidecar → reuse it, no file I/O, no spawn") must hold across two
 * `CaptureLock` instances in the same process just as much as across two calls
 * on one instance. A daemon that constructed one lock for `RecordingEngine`
 * and another for `PassthroughService` would otherwise deadlock against
 * itself.
 */
const PROCESS_HOLDS = new Map<string, InternalHold>();

/** Per-lock-path acquisition queue — serializes concurrent spawn attempts *within* this process (`O_EXCL` covers across processes). */
const ACQUIRE_QUEUES = new Map<string, Promise<unknown>>();

/**
 * Hands a second (third, …) holder a view onto the capture process this
 * process already owns, refcounted so the lock and the capture child survive
 * until the last one releases.
 */
function shareHold(existing: InternalHold): CaptureHold {
  existing.refs += 1;
  let released = false;
  return {
    handle: existing.handle,
    client: existing.client,
    get released(): boolean {
      return released;
    },
    release: async () => {
      if (released) return;
      released = true;
      await existing.release();
    },
  };
}

function activeHold(lockPath: string): InternalHold | undefined {
  const hold = PROCESS_HOLDS.get(lockPath);
  if (hold && !hold.released) return hold;
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `process.kill(pid, 0)`: `ESRCH` means dead; `EPERM` means alive but owned by another user (NOT stealable). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "EPERM") return true;
    return false;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function asPayload(raw: Record<string, unknown>): CaptureLockPayload {
  return {
    pid: typeof raw.pid === "number" ? raw.pid : -1,
    acquiredAt: typeof raw.acquiredAt === "string" ? raw.acquiredAt : "",
    windowerHome: typeof raw.windowerHome === "string" ? raw.windowerHome : "",
  };
}

function describeHolder(holder: CaptureLockPayload): string {
  return `pid ${holder.pid} (acquired ${holder.acquiredAt})`;
}

/**
 * The screen-capture exclusivity lock. See the file-header block above and
 * `contracts/screen-capture-exclusivity.md`.
 *
 * `FileTargetLock`'s shape with one global key instead of a
 * `sha1(targetKey)`-derived path: `O_EXCL` acquire, pid-liveness stale-steal,
 * `unlink` release, mode `0600` — all inherited from `FileLock` rather than
 * reimplemented. It adds exactly two things on top: a bounded wait (because
 * `FileLock` has no wait-for-release facility) and the `windowerHome`
 * split-brain guard.
 */
export class CaptureLock implements CaptureAccess {
  private readonly spawnSidecar: SidecarFactory;
  private readonly waitMs: number;
  private readonly log: (message: string) => void;

  constructor(options: CaptureLockOptions) {
    this.spawnSidecar = options.spawnSidecar;
    this.waitMs = options.waitMs ?? CAPTURE_LOCK_WAIT_MS;
    this.log = options.onLog ?? ((message) => console.error(`[CaptureLock] ${message}`));
  }

  /** `~/.windower/capture.lock`, resolved against the *current* `WINDOWER_HOME`. */
  get lockPath(): string {
    return captureLockPath();
  }

  /** This process's active hold, if any (row 1's backing state). */
  get hold(): CaptureHold | undefined {
    return activeHold(this.lockPath);
  }

  /** Reads the current holder's payload without acquiring or stealing. */
  async readHolder(): Promise<CaptureLockPayload | undefined> {
    const raw = await new FileLock(this.lockPath).readHolder();
    return raw ? asPayload(raw) : undefined;
  }

  /**
   * Takes the hold a recording keeps for its whole duration, spawning the
   * capture sidecar under the lock. There is only one kind of hold: a
   * long-lived one is simply one that is released late.
   *
   * Row 1 first (this process already has a capture sidecar → share it,
   * refcounted, no file I/O and no spawn), then rows 2–4 under the per-lock
   * acquisition queue. Throws `ScreenCaptureBusyError` when another live
   * process holds the lock past the wait budget, or immediately when that
   * holder belongs to a different `WINDOWER_HOME`.
   */
  async acquireCaptureHold(options: { spawn?: SpawnSidecarOptions } = {}): Promise<CaptureHold> {
    // Checked OUTSIDE the acquisition queue on purpose: a recording starting
    // while a one-shot call is in flight is legitimately called from inside
    // that call's own queued task, and enqueuing it there would deadlock.
    // Nothing needs serializing anyway — this process already owns the lock.
    const existing = activeHold(this.lockPath);
    if (existing) return shareHold(existing);

    return this.enqueue(async () => {
      const raced = activeHold(this.lockPath);
      if (raced) return shareHold(raced);
      return this.acquireUnderLock(options.spawn);
    });
  }

  /**
   * The acquire-or-wait table
   * (`contracts/screen-capture-exclusivity.md` §Acquire-or-wait) for a caller
   * that needs the capture surface for exactly one call: reuse this process's
   * capture sidecar if it has one, otherwise spawn one under the lock, run
   * `fn`, and tear it down again.
   */
  async withCaptureClient<T>(fn: (client: SidecarClient) => Promise<T>): Promise<T> {
    // Row 1 — this process already has a capture sidecar. No file I/O, no
    // spawn. The hot path for a daemon serving `list_targets`/`captureFrame`
    // during its own recording.
    const hold = activeHold(this.lockPath);
    if (hold) return fn(hold.client);

    return this.enqueue(async () => {
      // Re-checked inside the queue: a hold may have been taken by a
      // previously-queued `acquireCaptureHold` while we waited.
      const raced = activeHold(this.lockPath);
      if (raced) return fn(raced.client);

      const acquired = await this.acquireUnderLock(undefined);
      try {
        return await fn(acquired.client);
      } finally {
        // If a recording took a share of this hold mid-call, `release()` only
        // drops our reference and the capture child stays alive for it.
        await acquired.release().catch(() => {});
      }
    });
  }

  /** Releases this process's hold, if any (capture child terminated, lock file removed). */
  async releaseAll(): Promise<void> {
    const hold = activeHold(this.lockPath);
    if (hold) await hold.release();
  }

  // ---- internals ----

  /**
   * Rows 2–4 of the acquire-or-wait table, re-run on every poll so a holder
   * that dies mid-wait is picked up as row 2 (stale steal) rather than waited
   * out. Never routes, and never spawns while another live process holds the
   * lock.
   */
  private async acquireUnderLock(spawn: SpawnSidecarOptions | undefined): Promise<InternalHold> {
    const startedAt = Date.now();
    const deadline = startedAt + this.waitMs;
    let backoff = BACKOFF_START_MS;

    for (;;) {
      const holder = await this.readHolder();

      if (holder && isAlive(holder.pid)) {
        // Row 4 — a holder from a different install. Never wait, never steal,
        // never spawn: two installs contending for `replayd` is the hazard.
        if (holder.windowerHome !== windowerHome()) {
          throw new ScreenCaptureBusyError(
            `Screen capture is owned by ${describeHolder(holder)} from a different WINDOWER_HOME ("${holder.windowerHome}", this process resolved "${windowerHome()}"). Run both callers through the same daemon/home.`,
            holder,
          );
        }
        // Row 3 — a live same-home holder. Wait, bounded; then fail cleanly.
        if (Date.now() >= deadline) {
          throw new ScreenCaptureBusyError(
            `Screen capture is owned by ${describeHolder(holder)} and did not become available within ${this.waitMs}ms (waited ${Date.now() - startedAt}ms). Stop the holding recording and retry.`,
            holder,
          );
        }
        await sleep(backoff);
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
        continue;
      }

      // Row 2 — lock file absent, or holder pid dead. `FileLock.acquire()`
      // unlinks-and-recreates on a dead holder; session state is deliberately
      // untouched (the daemon's `recoverCrashedSessions()` owns that, and lock
      // recovery runs in contexts with no business finalizing someone else's
      // recording).
      try {
        await this.acquireLockFileOrThrow();
      } catch (err) {
        if (err instanceof ScreenCaptureBusyError && Date.now() < deadline) {
          // Lost the race to another process between readHolder and acquire.
          await sleep(backoff);
          backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
          continue;
        }
        throw err;
      }

      let handle: SidecarHandle;
      try {
        handle = this.spawnSidecar(spawn ?? {});
      } catch (err) {
        await this.releaseLockFile();
        throw err;
      }
      return this.registerHold(handle);
    }
  }

  private async acquireLockFileOrThrow(): Promise<void> {
    await mkdir(windowerHome(), { recursive: true });
    const lock = new FileLock(this.lockPath);
    try {
      await lock.acquire({
        pid: process.pid,
        acquiredAt: nowIso(),
        windowerHome: windowerHome(),
      });
    } catch (err) {
      if (err instanceof LockHeldError) {
        const holder = asPayload(err.holder);
        throw new ScreenCaptureBusyError(
          `Screen capture is owned by ${describeHolder(holder)}`,
          holder,
        );
      }
      throw err;
    }
    // `FileLock` opens with the default mode; the payload names a pid and a
    // home path and has no reason to be world-readable
    // (contracts/screen-capture-exclusivity.md §Lock file).
    await chmod(this.lockPath, 0o600).catch(() => {});
  }

  private async releaseLockFile(): Promise<void> {
    await new FileLock(this.lockPath).release();
  }

  private registerHold(handle: SidecarHandle): InternalHold {
    const lockPath = this.lockPath;
    const hold: InternalHold = {
      handle,
      client: handle.client,
      released: false,
      refs: 1,
      release: async () => {
        if (hold.released) return;
        hold.refs -= 1;
        if (hold.refs > 0) return; // another holder still shares this capture process
        hold.released = true;
        if (PROCESS_HOLDS.get(lockPath) === hold) PROCESS_HOLDS.delete(lockPath);
        await handle.terminate().catch((err: unknown) => {
          this.log(
            `capture sidecar did not terminate cleanly: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
        await new FileLock(lockPath).release().catch(() => {});
      },
    };
    PROCESS_HOLDS.set(lockPath, hold);
    return hold;
  }

  /** Serializes acquisition attempts within this process; `O_EXCL` serializes them across processes. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const lockPath = this.lockPath;
    const previous = ACQUIRE_QUEUES.get(lockPath) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    ACQUIRE_QUEUES.set(
      lockPath,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }
}

/**
 * Test/host escape hatch: forgets this process's in-memory hold registry
 * without touching the lock file. Only for tests that need a clean slate
 * between cases — production code releases holds through `CaptureHold.release()`.
 */
export function resetCaptureHoldsForTesting(): void {
  PROCESS_HOLDS.clear();
  ACQUIRE_QUEUES.clear();
}
