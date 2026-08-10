import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DaemonError,
  type SidecarClient,
  type SpawnSidecarOptions,
  WINDOWER_HOME_ENV,
} from "@windower/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SidecarHandle } from "./recording-engine.js";
import {
  CaptureLock,
  type CaptureLockPayload,
  ScreenCaptureBusyError,
  captureLockPath,
  resetCaptureHoldsForTesting,
} from "./screen-capture-lock.js";
import { createFakeSidecarFactory } from "./test-helpers/fake-sidecar-factory.js";

const DEAD_PID = 999_999;

describe("CaptureLock", () => {
  let home: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "windower-capture-lock-"));
    originalHome = process.env[WINDOWER_HOME_ENV];
    process.env[WINDOWER_HOME_ENV] = home;
    resetCaptureHoldsForTesting();
  });

  afterEach(async () => {
    resetCaptureHoldsForTesting();
    if (originalHome === undefined) delete process.env[WINDOWER_HOME_ENV];
    else process.env[WINDOWER_HOME_ENV] = originalHome;
    await rm(home, { recursive: true, force: true });
  });

  async function readLock(): Promise<CaptureLockPayload | undefined> {
    try {
      return JSON.parse(await readFile(captureLockPath(), "utf8")) as CaptureLockPayload;
    } catch {
      return undefined;
    }
  }

  async function writeHolder(overrides: Partial<CaptureLockPayload>): Promise<void> {
    const payload: CaptureLockPayload = {
      pid: process.pid, // alive, but with no in-memory hold — i.e. "another process"
      acquiredAt: "2026-08-10T14:02:11.000Z",
      windowerHome: home,
      ...overrides,
    };
    await writeFile(captureLockPath(), `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  }

  describe("spawn under the lock", () => {
    it("holds the lock across spawn → RPC → terminate, then releases it", async () => {
      const { spawnSidecar, spawns } = createFakeSidecarFactory({});
      const lock = new CaptureLock({ spawnSidecar });

      let holderDuringCall: CaptureLockPayload | undefined;
      const result = await lock.withCaptureClient(async (client) => {
        holderDuringCall = await readLock();
        return client.enumerateTargets({});
      });

      expect(result.targets.length).toBeGreaterThanOrEqual(0);
      expect(spawns).toHaveLength(1);
      expect(holderDuringCall).toMatchObject({ pid: process.pid, windowerHome: home });
      // Exactly the three contracted fields, nothing else.
      expect(Object.keys(holderDuringCall ?? {}).sort()).toEqual([
        "acquiredAt",
        "pid",
        "windowerHome",
      ]);
      // Released afterwards — the machine has no capture process again.
      expect(await readLock()).toBeUndefined();
      expect(lock.hold).toBeUndefined();
    });

    it("writes the lock file with mode 0600", async () => {
      const { spawnSidecar } = createFakeSidecarFactory({});
      const lock = new CaptureLock({ spawnSidecar });
      let mode = 0;
      await lock.withCaptureClient(async () => {
        mode = (await stat(captureLockPath())).mode & 0o777;
      });
      expect(mode).toBe(0o600);
    });

    it("serializes concurrent spawn attempts — never two capture processes alive at once", async () => {
      let live = 0;
      let maxLive = 0;
      const spawnSidecar = (_options: SpawnSidecarOptions): SidecarHandle => {
        live += 1;
        maxLive = Math.max(maxLive, live);
        return {
          client: {
            enumerateTargets: async () => ({ targets: [] }),
          } as unknown as SidecarClient,
          terminate: async () => {
            live -= 1;
          },
        };
      };
      const lock = new CaptureLock({ spawnSidecar });

      await Promise.all(
        Array.from({ length: 5 }, () =>
          lock.withCaptureClient(async (client) => {
            await new Promise((resolve) => setTimeout(resolve, 5));
            return client.enumerateTargets({});
          }),
        ),
      );

      expect(maxLive).toBe(1);
      expect(live).toBe(0);
      expect(await readLock()).toBeUndefined();
    });
  });

  describe("holds", () => {
    it("spawns the capture sidecar under the lock and keeps it until release", async () => {
      const { spawnSidecar, spawns } = createFakeSidecarFactory({});
      const lock = new CaptureLock({ spawnSidecar });

      const hold = await lock.acquireCaptureHold();

      expect(spawns).toHaveLength(1);
      expect(await readLock()).toMatchObject({ pid: process.pid, windowerHome: home });
      expect(((await stat(captureLockPath())).mode & 0o777).toString(8)).toBe("600");

      await hold.release();
      expect(await readLock()).toBeUndefined();
      expect(lock.hold).toBeUndefined();
    });

    it("row 1: a capture call while this process holds the lock reuses the sidecar — no spawn, no file I/O", async () => {
      const { spawnSidecar, spawns } = createFakeSidecarFactory({});
      const lock = new CaptureLock({ spawnSidecar });
      const hold = await lock.acquireCaptureHold();

      const seen: SidecarClient[] = [];
      await lock.withCaptureClient(async (client) => {
        seen.push(client);
        return client.enumerateTargets({});
      });

      expect(spawns).toHaveLength(1);
      expect(seen[0]).toBe(hold.client);
      await hold.release();
    });

    it("a second CaptureLock instance in the same process takes row 1 too (module-level hold registry)", async () => {
      const { spawnSidecar, spawns } = createFakeSidecarFactory({});
      const owner = new CaptureLock({ spawnSidecar });
      const hold = await owner.acquireCaptureHold();

      const other = new CaptureLock({ spawnSidecar });
      await other.withCaptureClient(async (client) => {
        expect(client).toBe(hold.client);
        return client.enumerateTargets({});
      });

      expect(spawns).toHaveLength(1);
      await hold.release();
    });

    it("two concurrent recordings share ONE capture process, refcounted — the lock outlives the first release", async () => {
      const { spawnSidecar, spawns } = createFakeSidecarFactory({});
      const lock = new CaptureLock({ spawnSidecar });

      const first = await lock.acquireCaptureHold();
      const second = await lock.acquireCaptureHold();

      // One capture process serving two sessions — not two SCK processes.
      expect(spawns).toHaveLength(1);
      expect(second.client).toBe(first.client);

      await first.release();
      expect(await readLock()).toMatchObject({ pid: process.pid });
      expect(lock.hold).toBeDefined();

      await second.release();
      expect(await readLock()).toBeUndefined();
      expect(lock.hold).toBeUndefined();
    });

    it("a hold taken during a one-shot call keeps the capture process alive after that call ends", async () => {
      const { spawnSidecar, spawns } = createFakeSidecarFactory({});
      const lock = new CaptureLock({ spawnSidecar });

      let recording: Awaited<ReturnType<CaptureLock["acquireCaptureHold"]>> | undefined;
      await lock.withCaptureClient(async (client) => {
        recording = await lock.acquireCaptureHold();
        return client.enumerateTargets({});
      });

      expect(spawns).toHaveLength(1); // same capture child, not a second one
      expect(await readLock()).toMatchObject({ pid: process.pid });
      await recording?.release();
      expect(await readLock()).toBeUndefined();
    });
  });

  describe("a live holder (rows 3 and 4)", () => {
    it("row 4: a live holder from a different WINDOWER_HOME is SCREEN_CAPTURE_BUSY immediately, never stolen", async () => {
      const { spawnSidecar, spawns } = createFakeSidecarFactory({});
      await writeHolder({ windowerHome: "/some/other/install" });
      const lock = new CaptureLock({ spawnSidecar, waitMs: 5_000 });

      const startedAt = Date.now();
      const err = await lock.withCaptureClient(async () => undefined).catch((e) => e);
      expect(Date.now() - startedAt).toBeLessThan(1_000); // never waits
      expect(err).toBeInstanceOf(ScreenCaptureBusyError);
      expect((err as DaemonError).code).toBe("SCREEN_CAPTURE_BUSY");
      expect((err as Error).message).toContain("/some/other/install");
      expect((err as Error).message).toContain(home);
      expect(spawns).toHaveLength(0);
      expect(await readLock()).toMatchObject({ windowerHome: "/some/other/install" });
    });

    it("row 3: a live same-home holder that outlives the wait budget is SCREEN_CAPTURE_BUSY, never spawned past", async () => {
      const { spawnSidecar, spawns } = createFakeSidecarFactory({});
      await writeHolder({});
      const lock = new CaptureLock({ spawnSidecar, waitMs: 30 });

      const err = await lock.withCaptureClient(async () => undefined).catch((e) => e);
      expect(err).toBeInstanceOf(ScreenCaptureBusyError);
      expect((err as DaemonError).code).toBe("SCREEN_CAPTURE_BUSY");
      expect((err as ScreenCaptureBusyError).holder?.pid).toBe(process.pid);
      expect((err as Error).message).toContain("30ms");
      expect(spawns).toHaveLength(0);
      // The holder's lock file is untouched.
      expect(await readLock()).toMatchObject({ acquiredAt: "2026-08-10T14:02:11.000Z" });
    });

    it("row 3 → row 2: a holder that dies mid-wait is picked up as a stale steal, not waited out", async () => {
      const { spawnSidecar, spawns } = createFakeSidecarFactory({});
      await writeHolder({});
      const lock = new CaptureLock({ spawnSidecar, waitMs: 2_000 });

      // The "holder" becomes dead 30ms in — the poll re-runs the whole table.
      setTimeout(() => {
        void writeHolder({ pid: DEAD_PID });
      }, 30);

      const holderDuringCall = await lock.withCaptureClient(async () => readLock());
      expect(spawns).toHaveLength(1);
      expect(holderDuringCall).toMatchObject({ pid: process.pid });
      expect(await readLock()).toBeUndefined();
    });

    it("row 3 also gates a long-lived hold, not just one-shot calls", async () => {
      const { spawnSidecar, spawns } = createFakeSidecarFactory({});
      await writeHolder({});
      const lock = new CaptureLock({ spawnSidecar, waitMs: 20 });

      await expect(lock.acquireCaptureHold()).rejects.toBeInstanceOf(ScreenCaptureBusyError);
      expect(spawns).toHaveLength(0);
    });
  });

  describe("crashed holder recovery", () => {
    it("steals a lock left behind by a dead holder rather than wedging", async () => {
      const { spawnSidecar, spawns } = createFakeSidecarFactory({});
      await writeHolder({ pid: DEAD_PID, acquiredAt: "2020-01-01T00:00:00.000Z" });

      const lock = new CaptureLock({ spawnSidecar });

      let holderDuringCall: CaptureLockPayload | undefined;
      await lock.withCaptureClient(async (client) => {
        holderDuringCall = await readLock();
        return client.enumerateTargets({});
      });

      expect(spawns).toHaveLength(1);
      expect(holderDuringCall).toMatchObject({ pid: process.pid, windowerHome: home });
      expect(await readLock()).toBeUndefined();
    });

    it("leaves the crashed holder's session record alone (lock recovery is not session recovery)", async () => {
      const { spawnSidecar } = createFakeSidecarFactory({});
      await writeHolder({ pid: DEAD_PID, acquiredAt: "2020-01-01T00:00:00.000Z" });
      const sessionsDir = join(home, "sessions");

      const lock = new CaptureLock({ spawnSidecar });
      await lock.withCaptureClient(async (client) => client.enumerateTargets({}));

      // Nothing under ~/.windower/sessions was created or touched by the steal.
      await expect(stat(sessionsDir)).rejects.toThrow();
    });
  });
});
