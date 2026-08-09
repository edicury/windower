import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WINDOWER_HOME_ENV } from "@windower/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TargetLockConflictError } from "./recording-engine.js";
import { FileTargetLock } from "./target-lock.js";

describe("FileTargetLock", () => {
  let home: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "windower-target-lock-"));
    originalHome = process.env[WINDOWER_HOME_ENV];
    process.env[WINDOWER_HOME_ENV] = home;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env[WINDOWER_HOME_ENV];
    else process.env[WINDOWER_HOME_ENV] = originalHome;
    await rm(home, { recursive: true, force: true });
  });

  it("acquires an uncontended lock and writes {sessionId, pid, startedAt, targetKey} to disk", async () => {
    const lock = new FileTargetLock();
    await lock.acquire("display:1", {
      sessionId: "session-a",
      pid: process.pid,
      startedAt: "2026-01-01T00:00:00.000Z",
    });

    const digest = await import("node:crypto").then((c) =>
      c.createHash("sha1").update("display:1").digest("hex"),
    );
    const raw = await readFile(join(home, "locks", `target-${digest}.lock`), "utf8");
    const payload = JSON.parse(raw);
    expect(payload).toMatchObject({
      sessionId: "session-a",
      pid: process.pid,
      startedAt: "2026-01-01T00:00:00.000Z",
      targetKey: "display:1",
    });
  });

  it("a second FileTargetLock instance against the same key rejects with the owning session/pid when the owner is alive", async () => {
    const first = new FileTargetLock();
    const second = new FileTargetLock();

    await first.acquire("display:1", {
      sessionId: "session-a",
      pid: process.pid, // this test process is alive — no steal
      startedAt: "2026-01-01T00:00:00.000Z",
    });

    await expect(
      second.acquire("display:1", {
        sessionId: "session-b",
        pid: process.pid,
        startedAt: "2026-01-01T00:05:00.000Z",
      }),
    ).rejects.toThrow(TargetLockConflictError);

    try {
      await second.acquire("display:1", {
        sessionId: "session-b",
        pid: process.pid,
        startedAt: "2026-01-01T00:05:00.000Z",
      });
      throw new Error("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(TargetLockConflictError);
      const conflict = err as TargetLockConflictError;
      expect(conflict.owner.sessionId).toBe("session-a");
      expect(conflict.owner.pid).toBe(process.pid);
      expect(conflict.message).toContain("session-a");
      expect(conflict.message).toContain(String(process.pid));
    }
  });

  it("steals a lock left behind by a dead pid instead of refusing", async () => {
    const first = new FileTargetLock();
    // A pid that is essentially guaranteed not to be alive in the test
    // sandbox: a huge value outside any real pid range.
    const deadPid = 999_999;
    await first.acquire("display:1", {
      sessionId: "session-dead",
      pid: deadPid,
      startedAt: "2020-01-01T00:00:00.000Z",
    });

    const second = new FileTargetLock();
    await expect(
      second.acquire("display:1", {
        sessionId: "session-b",
        pid: process.pid,
        startedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).resolves.toBeUndefined();
  });

  it("release() frees the key so a subsequent acquire() by a different owner succeeds", async () => {
    const first = new FileTargetLock();
    await first.acquire("display:1", {
      sessionId: "session-a",
      pid: process.pid,
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    await first.release("display:1");

    const second = new FileTargetLock();
    await expect(
      second.acquire("display:1", {
        sessionId: "session-b",
        pid: process.pid,
        startedAt: "2026-01-01T00:01:00.000Z",
      }),
    ).resolves.toBeUndefined();
  });

  it("different targetKeys don't contend", async () => {
    const lock = new FileTargetLock();
    await lock.acquire("display:1", {
      sessionId: "session-a",
      pid: process.pid,
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    await expect(
      lock.acquire("display:2", {
        sessionId: "session-b",
        pid: process.pid,
        startedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).resolves.toBeUndefined();
  });
});
