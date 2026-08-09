import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileLock, LockHeldError } from "./file-lock.js";

/** Spawns and waits for a child process to exit, returning its now-dead pid. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
  const pid = child.pid;
  if (pid === undefined) throw new Error("failed to spawn helper process");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  return pid;
}

describe("FileLock", () => {
  let dir: string;
  let lockPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "windower-file-lock-"));
    lockPath = join(dir, "test.lock");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("acquires and releases a lock round trip", async () => {
    const lock = new FileLock(lockPath);
    await lock.acquire({ pid: process.pid, acquiredAt: new Date().toISOString() });

    const holder = await lock.readHolder();
    expect(holder?.pid).toBe(process.pid);

    await lock.release();
    expect(await lock.readHolder()).toBeUndefined();
  });

  it("release() is a no-op (does not throw) when the lock is already gone", async () => {
    const lock = new FileLock(lockPath);
    await expect(lock.release()).resolves.toBeUndefined();
  });

  it("rejects concurrent acquire while the current holder's pid is alive", async () => {
    const first = new FileLock(lockPath);
    await first.acquire({ pid: process.pid, acquiredAt: new Date().toISOString() });

    const second = new FileLock(lockPath);
    await expect(
      second.acquire({ pid: process.pid, acquiredAt: new Date().toISOString() }),
    ).rejects.toThrow(LockHeldError);

    // Original lock is untouched by the failed attempt.
    const holder = await first.readHolder();
    expect(holder?.pid).toBe(process.pid);
  });

  it("steals a stale lock left behind by a dead pid", async () => {
    const stalePid = await deadPid();
    const lock = new FileLock(lockPath);

    // Simulate a crashed owner: a lock file recording a pid that no longer exists.
    await lock.acquire({ pid: stalePid, acquiredAt: new Date(0).toISOString() });

    const newLock = new FileLock(lockPath);
    const acquiredAt = new Date().toISOString();
    await newLock.acquire({ pid: process.pid, acquiredAt });

    const holder = await newLock.readHolder();
    expect(holder?.pid).toBe(process.pid);
    expect(holder?.acquiredAt).toBe(acquiredAt);
  });

  it("stores arbitrary extra payload fields alongside pid/acquiredAt", async () => {
    const lock = new FileLock(lockPath);
    await lock.acquire({
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
      sessionId: "sess-123",
      targetKey: "display:0",
    });

    const raw = JSON.parse(await readFile(lockPath, "utf8"));
    expect(raw).toMatchObject({ sessionId: "sess-123", targetKey: "display:0" });
  });
});
