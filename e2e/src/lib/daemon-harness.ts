import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { type DaemonClient, connectToDaemon, resolveDaemonEntryPath } from "@windower/core";

const execFileAsync = promisify(execFile);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface DaemonHarness {
  /** Connected `DaemonClient` — exactly what `packages/cli`/`packages/mcp-server` use, over the real unix socket. */
  client: DaemonClient;
  /** Isolated `~/.windower`-equivalent for this test run (never the real user's home). */
  windowerHome: string;
  /** Unix socket path for this harness's daemon. */
  socketPath: string;
  /** OS pid of the spawned daemon process — for the real-process kill-and-recover crash test. */
  pid: number;
  /** Terminates the daemon (SIGKILL, so it does *not* get a chance to clean up — for crash simulation) without cleaning up windowerHome. */
  killDaemon(): void;
  /** Spawns a fresh daemon process against the same windowerHome/socket and connects to it (crash-recovery restart step). */
  restart(): Promise<DaemonHarness>;
  /** Graceful shutdown (client.shutdown()) plus temp-dir cleanup. Always call in `afterEach`/`afterAll`. */
  teardown(): Promise<void>;
}

/**
 * Spawns a real daemon process (`node apps/daemon/dist/bin.js`, the exact
 * binary `packages/core`'s `spawnDaemonDetached` resolves and the exact
 * entrypoint CI's `pnpm turbo run build` produces) against an isolated
 * `WINDOWER_HOME`, so this suite never touches a real user's
 * `~/.windower/daemon.sock` or session files. Requires `apps/daemon` to
 * already be built (`pnpm turbo run build`) — see e2e/README.md.
 *
 * Deliberately does not call `@windower/core`'s `spawnDaemonDetached`
 * directly: that helper always forwards the *current* `process.env`
 * verbatim, but this harness needs a per-test-run `WINDOWER_HOME` override,
 * so it re-implements the same detached-spawn shape with a custom env
 * instead.
 */
export async function startDaemonHarness(
  options: { spawnTimeoutMs?: number } = {},
): Promise<DaemonHarness> {
  const windowerHome = await mkdtemp(join(tmpdir(), "windower-e2e-"));
  const socketPath = join(windowerHome, "daemon.sock");
  const entryPath = resolveDaemonEntryPath();
  const spawnTimeoutMs = options.spawnTimeoutMs ?? 10_000;

  const child = spawnDetached(entryPath, windowerHome);
  if (child.pid === undefined) {
    throw new Error("Failed to spawn daemon process (no pid)");
  }
  const pid = child.pid;

  const client = await waitForDaemon(socketPath, spawnTimeoutMs);

  return makeHarness({ client, windowerHome, socketPath, pid, spawnTimeoutMs });
}

function makeHarness(state: {
  client: DaemonClient;
  windowerHome: string;
  socketPath: string;
  pid: number;
  spawnTimeoutMs: number;
}): DaemonHarness {
  return {
    client: state.client,
    windowerHome: state.windowerHome,
    socketPath: state.socketPath,
    pid: state.pid,
    killDaemon: () => {
      try {
        process.kill(state.pid, "SIGKILL");
      } catch {
        // Already dead.
      }
    },
    restart: async () => {
      const entryPath = resolveDaemonEntryPath();
      const child = spawnDetached(entryPath, state.windowerHome);
      if (child.pid === undefined) {
        throw new Error("Failed to respawn daemon process (no pid)");
      }
      const client = await waitForDaemon(state.socketPath, state.spawnTimeoutMs);
      return makeHarness({ ...state, client, pid: child.pid });
    },
    teardown: async () => {
      try {
        await state.client.shutdown().catch(() => {});
      } finally {
        state.client.dispose();
        try {
          process.kill(state.pid, "SIGKILL");
        } catch {
          // Already dead — expected on the graceful-shutdown path.
        }
        await rm(state.windowerHome, { recursive: true, force: true });
      }
    },
  };
}

function spawnDetached(entryPath: string, windowerHome: string): ChildProcess {
  const child = spawn(process.execPath, [entryPath], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, WINDOWER_HOME: windowerHome },
  });
  child.unref();
  return child;
}

async function waitForDaemon(socketPath: string, timeoutMs: number): Promise<DaemonClient> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await connectToDaemon(socketPath);
    } catch (err) {
      lastError = err;
      await sleep(100);
    }
  }
  throw lastError ?? new Error(`Timed out waiting for daemon at "${socketPath}"`);
}

/** Whether a pid is still alive (`kill -0`). */
export async function isProcessAlive(pid: number): Promise<boolean> {
  try {
    await execFileAsync("kill", ["-0", String(pid)]);
    return true;
  } catch {
    return false;
  }
}
