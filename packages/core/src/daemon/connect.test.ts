import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  connectToDaemon,
  ensureDaemonRunning,
  killDaemonAndSidecars,
  restartDaemon,
  spawnDaemonDetached,
} from "./connect.js";
import { DaemonError } from "./errors.js";
import { FileLock } from "../fs/file-lock.js";
import { WINDOWER_HOME_ENV, daemonSocketPath } from "./paths.js";
import { DAEMON_PROTOCOL_VERSION } from "./protocol.js";
import { addSidecarPid, readSidecarPids } from "./sidecar-pids.js";
import { readDaemonState, writeDaemonState } from "./state-file.js";

/** `process.kill(pid, 0)` — true if `pid` is still alive. Mirrors `connect.ts`'s own private `isPidAlive`, duplicated here since it isn't exported. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Spawns a real, long-lived (but harmless) child process to use as a stand-in daemon/sidecar pid — killDaemonAndSidecars signals real OS pids, so a fabricated number isn't enough to exercise it. */
function spawnLongRunning(): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  return child;
}

async function waitUntilDead(pid: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`pid ${pid} never died`);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, "fixtures", "fake-daemon-cli.mjs");

/** Spawns the fixture directly (not via `spawnDaemonDetached`) so its env can be customized independently of this test process's own `process.env`. */
function spawnFixture(home: string, env: Record<string, string> = {}): ChildProcess {
  const child = spawn(process.execPath, [FIXTURE_PATH], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, WINDOWER_HOME: home, ...env },
  });
  child.unref();
  return child;
}

/**
 * Spawns a real listener on `socketPath` via the fixture, then SIGKILLs it
 * once it's up — leaving a genuinely abandoned socket file behind (Node
 * auto-unlinks on a clean `close()`, so simulating "stale socket" requires
 * an actual crash, not a graceful shutdown). Returns the killed pid.
 */
async function killLeavingStaleSocket(socketPath: string, home: string): Promise<number> {
  const child = spawnFixture(home);
  await waitForSocket(socketPath);
  const pid = child.pid;
  if (pid === undefined) throw new Error("failed to spawn fixture");
  child.kill("SIGKILL");
  // Give the OS a moment to reap the process and settle ECONNREFUSED.
  await new Promise((resolve) => setTimeout(resolve, 200));
  return pid;
}

async function waitForSocket(socketPath: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const client = await connectToDaemon(socketPath);
      client.dispose();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`nothing ever started listening on ${socketPath}`);
}

describe("connectToDaemon / ensureDaemonRunning / restartDaemon", () => {
  let home: string;
  let originalHome: string | undefined;
  const spawned: ChildProcess[] = [];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "windower-daemon-connect-"));
    originalHome = process.env[WINDOWER_HOME_ENV];
    process.env[WINDOWER_HOME_ENV] = home;
  });

  afterEach(async () => {
    for (const child of spawned) child.kill("SIGKILL");
    spawned.length = 0;
    if (originalHome === undefined) delete process.env[WINDOWER_HOME_ENV];
    else process.env[WINDOWER_HOME_ENV] = originalHome;
    await rm(home, { recursive: true, force: true });
  });

  it("rejects with DAEMON_UNREACHABLE when nothing is listening", async () => {
    await expect(connectToDaemon(daemonSocketPath())).rejects.toThrow(DaemonError);
    await expect(connectToDaemon(daemonSocketPath())).rejects.toMatchObject({
      code: "DAEMON_UNREACHABLE",
    });
  });

  it("connects once a daemon (spawned via spawnDaemonDetached) is listening", async () => {
    spawned.push(spawnDaemonDetached(FIXTURE_PATH));
    await waitForSocket(daemonSocketPath());

    const client = await connectToDaemon(daemonSocketPath());
    expect(client).toBeDefined();
    client.dispose();
  });

  it("ensureDaemonRunning takes the fast path and performs a successful hello handshake on version match", async () => {
    spawned.push(spawnDaemonDetached(FIXTURE_PATH));
    await waitForSocket(daemonSocketPath());

    const client = await ensureDaemonRunning({
      socketPath: daemonSocketPath(),
      entryPath: FIXTURE_PATH,
      spawnTimeoutMs: 3000,
    });
    expect(client).toBeDefined();
    // Handshake succeeded — ordinary RPCs still work on the same connection.
    await expect(client.listSessions({})).resolves.toEqual({ sessions: [] });
    client.dispose();
  }, 10_000);

  it("ensureDaemonRunning spawns a fresh daemon when none is listening, and it handshakes cleanly", async () => {
    const client = await ensureDaemonRunning({
      socketPath: daemonSocketPath(),
      entryPath: FIXTURE_PATH,
      spawnTimeoutMs: 5000,
      onSpawn: (child) => spawned.push(child),
    });
    expect(client).toBeDefined();
    client.dispose();
  }, 10_000);

  it("auto-restarts once, safely, when the connected daemon's protocol version mismatches and nothing is in flight", async () => {
    // Old daemon: mismatched protocol version, nothing recording/running.
    spawned.push(spawnFixture(home, { FAKE_DAEMON_PROTOCOL_VERSION: "999" }));
    await waitForSocket(daemonSocketPath());

    // The test process's own env has no FAKE_DAEMON_* overrides, so the
    // fresh daemon spawned by the auto-restart path matches
    // DAEMON_PROTOCOL_VERSION exactly.
    const client = await ensureDaemonRunning({
      socketPath: daemonSocketPath(),
      entryPath: FIXTURE_PATH,
      spawnTimeoutMs: 5000,
      onSpawn: (child) => spawned.push(child),
    });
    expect(client).toBeDefined();
    const info = await client.daemonInfo();
    expect(info.protocolVersion).toBe(DAEMON_PROTOCOL_VERSION);
    client.dispose();
  }, 15_000);

  it("treats a hello-less (pre-Phase-20) daemon as protocol version 0 and auto-restarts it", async () => {
    spawned.push(spawnFixture(home, { FAKE_DAEMON_NO_HELLO: "1" }));
    await waitForSocket(daemonSocketPath());

    const client = await ensureDaemonRunning({
      socketPath: daemonSocketPath(),
      entryPath: FIXTURE_PATH,
      spawnTimeoutMs: 5000,
      onSpawn: (child) => spawned.push(child),
    });
    expect(client).toBeDefined();
    const info = await client.daemonInfo();
    expect(info.protocolVersion).toBe(DAEMON_PROTOCOL_VERSION);
    client.dispose();
  }, 15_000);

  it("throws DAEMON_BUSY (naming active ids) instead of restarting when a mismatched daemon has a recording session in flight", async () => {
    spawned.push(
      spawnFixture(home, {
        FAKE_DAEMON_PROTOCOL_VERSION: "999",
        FAKE_DAEMON_ACTIVE_SESSION_IDS: "sess-abc123",
      }),
    );
    await waitForSocket(daemonSocketPath());

    await expect(
      ensureDaemonRunning({
        socketPath: daemonSocketPath(),
        entryPath: FIXTURE_PATH,
        spawnTimeoutMs: 3000,
      }),
    ).rejects.toMatchObject({ code: "DAEMON_BUSY", message: expect.stringContaining("sess-abc123") });

    // The busy old daemon must still be the one listening — no restart happened.
    const client = await connectToDaemon(daemonSocketPath());
    const info = await client.daemonInfo();
    expect(info.protocolVersion).toBe(999);
    client.dispose();
  }, 10_000);

  it("throws DAEMON_VERSION_MISMATCH on windowerHome disagreement, without attempting a restart", async () => {
    spawned.push(spawnFixture(home, { FAKE_DAEMON_WINDOWER_HOME: "/some/other/windower/home" }));
    await waitForSocket(daemonSocketPath());

    await expect(
      ensureDaemonRunning({
        socketPath: daemonSocketPath(),
        entryPath: FIXTURE_PATH,
        spawnTimeoutMs: 3000,
      }),
    ).rejects.toMatchObject({ code: "DAEMON_VERSION_MISMATCH" });

    // Original daemon must still be up — a windowerHome mismatch never restarts.
    const client = await connectToDaemon(daemonSocketPath());
    client.dispose();
  }, 10_000);

  it("spawn lockfile: does not spawn a second daemon while another process holds the lock, and polls instead", async () => {
    const lockPath = join(dirname(daemonSocketPath()), "daemon.lock");
    const lock = new FileLock(lockPath);
    await lock.acquire({ pid: process.pid, acquiredAt: new Date().toISOString() });

    try {
      // Nothing is listening and the lock is held — ensureDaemonRunning must
      // poll rather than spawn, and time out (short deadline) without ever
      // touching the lock file we hold.
      await expect(
        ensureDaemonRunning({
          socketPath: daemonSocketPath(),
          entryPath: FIXTURE_PATH,
          spawnTimeoutMs: 400,
        }),
      ).rejects.toMatchObject({ code: "DAEMON_UNREACHABLE" });

      const holder = await lock.readHolder();
      expect(holder?.pid).toBe(process.pid);
    } finally {
      await lock.release();
    }
  }, 10_000);

  it("spawn lockfile: picks up the socket once the lock-holder's own spawn finishes, without spawning itself", async () => {
    const lockPath = join(dirname(daemonSocketPath()), "daemon.lock");
    const lock = new FileLock(lockPath);
    await lock.acquire({ pid: process.pid, acquiredAt: new Date().toISOString() });

    // Simulate the lock-holder's spawn completing shortly after.
    const timer = setTimeout(() => {
      spawned.push(spawnFixture(home));
    }, 150);

    try {
      const client = await ensureDaemonRunning({
        socketPath: daemonSocketPath(),
        entryPath: FIXTURE_PATH,
        spawnTimeoutMs: 3000,
      });
      expect(client).toBeDefined();
      client.dispose();

      // We (the "waiter") never touched the lock — still held by "us" as
      // the simulated other process the whole time.
      const holder = await lock.readHolder();
      expect(holder?.pid).toBe(process.pid);
    } finally {
      clearTimeout(timer);
      await lock.release();
    }
  }, 10_000);

  it("unlinks a stale socket and respawns when the recorded daemon.json pid is dead and the socket refuses connections", async () => {
    const socketPath = daemonSocketPath();

    // Node auto-unlinks a Unix socket file on a clean `server.close()`, so
    // the only way to get a genuinely abandoned-but-present socket file (the
    // real "crashed daemon" scenario) is a process that never gets to clean
    // up after itself — SIGKILL a real listener.
    const deadPid = await killLeavingStaleSocket(socketPath, home);

    // The killed process's own `daemon.json` (written by the fixture on
    // listen) still names its now-dead pid — exactly the state a crashed
    // daemon leaves behind. No need to rewrite it.
    const client = await ensureDaemonRunning({
      socketPath,
      entryPath: FIXTURE_PATH,
      spawnTimeoutMs: 5000,
      onSpawn: (child) => spawned.push(child),
    });
    expect(client).toBeDefined();
    const info = await client.daemonInfo();
    expect(info.pid).not.toBe(deadPid);
    client.dispose();
  }, 15_000);

  it("does NOT unlink a stale-looking socket when the recorded daemon.json pid is still alive", async () => {
    const socketPath = daemonSocketPath();

    await killLeavingStaleSocket(socketPath, home);

    // Overwrite daemon.json to claim OUR OWN (very much alive) pid as the
    // owner — the socket file is still the real dead listener's leftover,
    // but the recorded owner now looks alive.
    await writeDaemonState({
      pid: process.pid,
      version: "0.0.0-fake",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      startedAt: new Date().toISOString(),
      socketPath,
      windowerHome: home,
      execPath: process.execPath,
      entryPath: FIXTURE_PATH,
    });

    // Never respawns (the socket is presumed to belong to a live daemon),
    // so it just times out waiting for a response that never comes.
    await expect(
      ensureDaemonRunning({ socketPath, entryPath: FIXTURE_PATH, spawnTimeoutMs: 400 }),
    ).rejects.toMatchObject({ code: "DAEMON_UNREACHABLE" });
  }, 10_000);

  describe("restartDaemon", () => {
    it("rejects with DAEMON_UNREACHABLE when nothing is listening (attach mode, never spawns)", async () => {
      await expect(
        restartDaemon({ socketPath: daemonSocketPath(), entryPath: FIXTURE_PATH }),
      ).rejects.toMatchObject({ code: "DAEMON_UNREACHABLE" });
    });

    it("gracefully stops the running daemon and starts a fresh one when nothing is in flight", async () => {
      spawned.push(spawnFixture(home));
      await waitForSocket(daemonSocketPath());

      const client = await restartDaemon({
        socketPath: daemonSocketPath(),
        entryPath: FIXTURE_PATH,
        spawnTimeoutMs: 5000,
        onSpawn: (child) => spawned.push(child),
      });
      expect(client).toBeDefined();
      client.dispose();
    }, 15_000);

    it("refuses with DAEMON_BUSY when a session is recording, unless --force", async () => {
      spawned.push(spawnFixture(home, { FAKE_DAEMON_ACTIVE_SESSION_IDS: "sess-live" }));
      await waitForSocket(daemonSocketPath());

      await expect(
        restartDaemon({ socketPath: daemonSocketPath(), entryPath: FIXTURE_PATH }),
      ).rejects.toMatchObject({ code: "DAEMON_BUSY", message: expect.stringContaining("sess-live") });

      // force overrides the busy check.
      const client = await restartDaemon({
        socketPath: daemonSocketPath(),
        entryPath: FIXTURE_PATH,
        spawnTimeoutMs: 5000,
        force: true,
        onSpawn: (child) => spawned.push(child),
      });
      expect(client).toBeDefined();
      client.dispose();
    }, 15_000);
  });
});

describe("killDaemonAndSidecars", () => {
  let home: string;
  let originalHome: string | undefined;
  const spawned: ChildProcess[] = [];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "windower-daemon-kill-"));
    originalHome = process.env[WINDOWER_HOME_ENV];
    process.env[WINDOWER_HOME_ENV] = home;
  });

  afterEach(async () => {
    for (const child of spawned) {
      if (child.pid !== undefined && isAlive(child.pid)) child.kill("SIGKILL");
    }
    spawned.length = 0;
    if (originalHome === undefined) delete process.env[WINDOWER_HOME_ENV];
    else process.env[WINDOWER_HOME_ENV] = originalHome;
    await rm(home, { recursive: true, force: true });
  });

  it("is idempotent — reports nothing killed when no state file exists", async () => {
    const result = await killDaemonAndSidecars();
    expect(result).toEqual({ daemonKilled: false, daemonPid: undefined, sidecarPidsKilled: [] });
  });

  it("kills a live daemon pid recorded in daemon.json and clears the state file", async () => {
    const daemon = spawnLongRunning();
    spawned.push(daemon);
    if (daemon.pid === undefined) throw new Error("failed to spawn");

    await writeDaemonState({
      pid: daemon.pid,
      version: "0.1.0",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      startedAt: new Date().toISOString(),
      socketPath: daemonSocketPath(),
      windowerHome: home,
      execPath: process.execPath,
      entryPath: "irrelevant.js",
    });

    const result = await killDaemonAndSidecars({ killTimeoutMs: 500 });

    expect(result.daemonKilled).toBe(true);
    expect(result.daemonPid).toBe(daemon.pid);
    await waitUntilDead(daemon.pid);
    expect(await readDaemonState()).toBeNull();
  }, 15_000);

  it("kills sidecar pids recorded in sidecar-pids.json and clears the tracking file", async () => {
    const sidecarA = spawnLongRunning();
    const sidecarB = spawnLongRunning();
    spawned.push(sidecarA, sidecarB);
    if (sidecarA.pid === undefined || sidecarB.pid === undefined) throw new Error("failed to spawn");

    await addSidecarPid(sidecarA.pid);
    await addSidecarPid(sidecarB.pid);

    const result = await killDaemonAndSidecars({ killTimeoutMs: 500 });

    expect(result.sidecarPidsKilled.sort()).toEqual([sidecarA.pid, sidecarB.pid].sort());
    await waitUntilDead(sidecarA.pid);
    await waitUntilDead(sidecarB.pid);
    expect(await readSidecarPids()).toEqual([]);
  }, 15_000);

  it("does not error on a dead pid left behind in the state files (already-crashed cleanup)", async () => {
    const ghost = spawnLongRunning();
    const ghostPid = ghost.pid;
    if (ghostPid === undefined) throw new Error("failed to spawn");
    ghost.kill("SIGKILL");
    await waitUntilDead(ghostPid);

    await writeDaemonState({
      pid: ghostPid,
      version: "0.1.0",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      startedAt: new Date().toISOString(),
      socketPath: daemonSocketPath(),
      windowerHome: home,
      execPath: process.execPath,
      entryPath: "irrelevant.js",
    });
    await addSidecarPid(ghostPid);

    const result = await killDaemonAndSidecars({ killTimeoutMs: 200 });

    expect(result.daemonKilled).toBe(false);
    expect(result.sidecarPidsKilled).toEqual([]);
    expect(await readDaemonState()).toBeNull();
    expect(await readSidecarPids()).toEqual([]);
  }, 10_000);
});
