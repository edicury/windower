import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findRepoRoot } from "../process/sidecar-path.js";
import { DaemonClient } from "./client.js";
import { DaemonError } from "./errors.js";
import { daemonSocketPath } from "./paths.js";

/** Env var override for the daemon entrypoint, mirrors `WINDOWER_SIDECAR_BINARY_PATH`. */
export const DAEMON_BIN_PATH_ENV = "WINDOWER_DAEMON_BIN_PATH";

function thisModuleDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

/**
 * Resolves the path to the daemon's node entrypoint (`node <path>` spawns
 * it). Same resolution order as `resolveSidecarBinaryPath`: an explicit env
 * override first (also Phase 14's packaging extension point), then the dev
 * build output relative to the monorepo root.
 */
export function resolveDaemonEntryPath(): string {
  const override = process.env[DAEMON_BIN_PATH_ENV];
  if (override && override.trim().length > 0) return override;

  const repoRoot = findRepoRoot(thisModuleDir());
  return join(repoRoot, "apps/daemon/dist/bin.js");
}

/** Connects to an already-running daemon; rejects with `DAEMON_UNREACHABLE` if none is listening. */
export function connectToDaemon(socketPath: string = daemonSocketPath()): Promise<DaemonClient> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.once("connect", () => {
      socket.removeAllListeners("error");
      resolve(new DaemonClient(socket));
    });
    socket.once("error", (err) => {
      reject(
        new DaemonError(
          "DAEMON_UNREACHABLE",
          `Could not connect to daemon at "${socketPath}": ${(err as Error).message}`,
        ),
      );
    });
  });
}

/** Spawns the daemon as a detached, unreferenced background process. */
export function spawnDaemonDetached(entryPath: string = resolveDaemonEntryPath()): ChildProcess {
  const child = spawn(process.execPath, [entryPath], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
  return child;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface EnsureDaemonRunningOptions {
  socketPath?: string;
  entryPath?: string;
  /** Total time to wait for the freshly spawned daemon to accept connections. Default 5000ms. */
  spawnTimeoutMs?: number;
}

/**
 * The auto-spawn helper CLI and MCP server call before any daemon RPC:
 * connects to the daemon if one is already listening, otherwise spawns it
 * detached and polls until it accepts a connection (or `spawnTimeoutMs`
 * elapses, at which point it throws `DAEMON_UNREACHABLE`).
 */
export async function ensureDaemonRunning(
  options: EnsureDaemonRunningOptions = {},
): Promise<DaemonClient> {
  const socketPath = options.socketPath ?? daemonSocketPath();
  try {
    return await connectToDaemon(socketPath);
  } catch {
    // No daemon listening — fall through to spawn. A stale socket file (from
    // a crashed daemon) would also fail the connect above; remove it so the
    // freshly spawned daemon isn't blocked from binding the same path.
    if (existsSync(socketPath)) {
      try {
        unlinkSync(socketPath);
      } catch {
        // Another process may have already cleaned it up — ignore.
      }
    }
  }

  spawnDaemonDetached(options.entryPath);

  const timeoutMs = options.spawnTimeoutMs ?? 5000;
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
  throw lastError ?? new DaemonError("DAEMON_UNREACHABLE", "Timed out waiting for daemon to start");
}
