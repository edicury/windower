import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { findRepoRoot } from "../process/sidecar-path.js";
import { FileLock, LockHeldError } from "../fs/file-lock.js";
import { packageVersion } from "../version.js";

const require = createRequire(import.meta.url);
import { DaemonClient } from "./client.js";
import { DaemonError } from "./errors.js";
import { daemonSocketPath, windowerHome } from "./paths.js";
import { DAEMON_PROTOCOL_VERSION } from "./protocol.js";
import type { DaemonHelloEnv, DaemonHelloRequest, DaemonHelloResult } from "./protocol.js";
import { clearDaemonState, readDaemonState } from "./state-file.js";
import { clearSidecarPids, readSidecarPids } from "./sidecar-pids.js";
import { isTerminalOperatorRunState } from "../schemas/operator.js";

/** Env var override for the daemon entrypoint, mirrors `WINDOWER_SIDECAR_BINARY_PATH`. */
export const DAEMON_BIN_PATH_ENV = "WINDOWER_DAEMON_BIN_PATH";

/** Default `hello` client identity for callers that don't specify their own. */
const DEFAULT_CLIENT_NAME = "windower-client";

function thisModuleDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

/**
 * Resolves the path to the daemon's node entrypoint (`node <path>` spawns
 * it). Same resolution order as `resolveSidecarBinaryPath`:
 * 1. `WINDOWER_DAEMON_BIN_PATH` env override.
 * 2. The dev build output relative to the monorepo root (working inside the
 *    monorepo checkout).
 * 3. (Phase 14) The published `@windower/daemon` npm package, resolved via
 *    `require.resolve` — used when installed as a real npm package (e.g.
 *    `npm install -g @windower/cli`) where there is no monorepo checkout to
 *    walk up to.
 */
export function resolveDaemonEntryPath(): string {
  const override = process.env[DAEMON_BIN_PATH_ENV];
  if (override && override.trim().length > 0) return override;

  try {
    const repoRoot = findRepoRoot(thisModuleDir());
    const resolved = join(repoRoot, "apps/daemon/dist/bin.js");
    if (existsSync(resolved)) return resolved;
  } catch {
    // Not running inside a monorepo checkout — fall through to the
    // published package below.
  }

  return require.resolve("@windower/daemon/dist/bin.js");
}

type RawConnectResult = { client: DaemonClient } | { error: NodeJS.ErrnoException };

/**
 * Connects once, without throwing — used internally so lockfile/stale-socket
 * logic can inspect the raw `NodeJS.ErrnoException.code` (e.g. `ECONNREFUSED`
 * vs a transient error), which `DaemonError` doesn't preserve.
 */
function rawConnect(socketPath: string): Promise<RawConnectResult> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    socket.once("connect", () => {
      socket.removeAllListeners("error");
      resolve({ client: new DaemonClient(socket) });
    });
    socket.once("error", (err) => {
      resolve({ error: err as NodeJS.ErrnoException });
    });
  });
}

/** Connects to an already-running daemon; rejects with `DAEMON_UNREACHABLE` if none is listening. */
export async function connectToDaemon(
  socketPath: string = daemonSocketPath(),
): Promise<DaemonClient> {
  const res = await rawConnect(socketPath);
  if ("client" in res) return res.client;
  throw new DaemonError(
    "DAEMON_UNREACHABLE",
    `Could not connect to daemon at "${socketPath}": ${res.error.message}`,
  );
}

/** `connectToDaemon`, but resolves to `undefined` instead of throwing. */
async function tryConnect(socketPath: string): Promise<DaemonClient | undefined> {
  const res = await rawConnect(socketPath);
  return "client" in res ? res.client : undefined;
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

/** `process.kill(pid, 0)` throws `ESRCH` for a dead pid, `EPERM` for a live pid owned by another user — only `ESRCH` means "safe to steal". Mirrors `fs/file-lock.ts`'s private `isAlive`. */
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

export interface EnsureDaemonRunningOptions {
  socketPath?: string;
  entryPath?: string;
  /** Total time to wait for the freshly spawned daemon to accept connections. Default 5000ms. */
  spawnTimeoutMs?: number;
  /** `hello`'s `clientName`. Defaults to a generic `"windower-client"` — callers that care about `doctor`/log identity (CLI, MCP server) should pass their own. */
  clientName?: string;
  /** `hello`'s `clientVersion`. Defaults to `@windower/core`'s own package version. */
  clientVersion?: string;
  /** `hello`'s `cwd`. Defaults to `process.cwd()`. */
  cwd?: string;
  /** `hello`'s `windowerHome`. Defaults to `windowerHome()` (respects `WINDOWER_HOME`). Exposed for tests only — real callers should rely on the default so it always matches what `daemonSocketPath()` resolved against. */
  windowerHomeOverride?: string;
  /**
   * Scoped env snapshot for `hello` — OPT IN per call, never sent by
   * default. Per `contracts/daemon-rpc.md`'s `env` scoping rules: only the
   * model's configured API-key var plus any `env:`-sourced `SecretRef`s
   * explicitly named in the current command. Blocking `operate` (this
   * repo's default path) never populates this; only `operate --detach` and
   * MCP's `run_operator` do. Never logged.
   */
  env?: DaemonHelloEnv;
  /**
   * Test-only hook, invoked with the `ChildProcess` right after a spawn
   * happens (if one happens) — lets tests capture the pid for cleanup since
   * `ensureDaemonRunning`/`restartDaemon` only ever return the connected
   * `DaemonClient`, not the spawned process. Never used by real callers.
   */
  onSpawn?: (child: ChildProcess) => void;
}

interface SafetyCheck {
  safe: boolean;
  activeSessionIds: string[];
  activeRunIds: string[];
}

/**
 * `list_sessions({state:"recording"})` + `list_operator_runs` (filtered to
 * non-terminal states) — the safety check `contracts/daemon-rpc.md`
 * requires before an automatic version-mismatch restart or a `windower
 * daemon restart` (without `--force`).
 */
async function checkSafeToRestart(client: DaemonClient): Promise<SafetyCheck> {
  const [sessionsResult, runsResult] = await Promise.all([
    client.listSessions({ state: "recording" }),
    client.listOperatorRuns({}),
  ]);
  const activeSessionIds = sessionsResult.sessions.map((s) => s.id);
  const activeRunIds = runsResult.runs
    .filter((r) => !isTerminalOperatorRunState(r.state))
    .map((r) => r.id);
  return {
    safe: activeSessionIds.length === 0 && activeRunIds.length === 0,
    activeSessionIds,
    activeRunIds,
  };
}

function busyMessage(safety: SafetyCheck, context: string): string {
  const parts: string[] = [];
  if (safety.activeSessionIds.length > 0) {
    parts.push(`recording session(s) ${safety.activeSessionIds.join(", ")}`);
  }
  if (safety.activeRunIds.length > 0) {
    parts.push(`operator run(s) ${safety.activeRunIds.join(", ")}`);
  }
  const active = parts.join(" and ");
  return (
    `${context} — ${active} still active. Run "windower stop <id>" / ` +
    `"windower operate abort <runId>" to clear it and retry, or ` +
    `"windower daemon restart --force" to override.`
  );
}

function buildHelloParams(
  options: EnsureDaemonRunningOptions,
): DaemonHelloRequest & { windowerHome: string } {
  return {
    clientName: options.clientName ?? DEFAULT_CLIENT_NAME,
    clientVersion: options.clientVersion ?? packageVersion(import.meta.url),
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    windowerHome: options.windowerHomeOverride ?? windowerHome(),
    cwd: options.cwd ?? process.cwd(),
    env: options.env,
  };
}

/**
 * Best-effort graceful shutdown of `client`'s daemon, waiting (bounded) for
 * its socket to stop answering before returning — so a subsequent spawn
 * attempt doesn't race the old process's teardown. `client` is disposed by
 * this call regardless of outcome.
 */
async function gracefulShutdownAndWait(
  client: DaemonClient,
  socketPath: string,
  timeoutMs = 10_000,
): Promise<void> {
  try {
    await client.shutdown({ mode: "graceful" });
  } catch {
    // Best-effort — an old pre-Phase-20 daemon still has `shutdown` (it
    // predates the handshake), but if this fails for any reason we still
    // fall through to waiting for the socket to go away.
  }
  client.dispose();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await rawConnect(socketPath);
    if ("error" in res) return; // No longer reachable — treat as exited.
    res.client.dispose();
    await sleep(100);
  }
  // Timed out waiting for a clean exit — fall through. The subsequent
  // spawn's stale-socket handling only unlinks when the recorded pid is
  // actually dead, so a still-alive-but-stuck old daemon won't have its
  // live socket unlinked out from under it.
}

/**
 * Polls `socketPath` until it accepts a connection or `deadline` passes.
 * Used both for "I just spawned, wait for it to come up" and "someone else
 * is spawning, wait for their result" (spawn-lock contention).
 */
async function pollForSocket(socketPath: string, deadline: number): Promise<DaemonClient> {
  let lastError: unknown;
  while (Date.now() < deadline) {
    const res = await rawConnect(socketPath);
    if ("client" in res) return res.client;
    lastError = res.error;
    await sleep(100);
  }
  const suffix = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new DaemonError(
    "DAEMON_UNREACHABLE",
    `Timed out waiting for daemon socket at "${socketPath}"${suffix}`,
  );
}

/**
 * Unlinks a stale socket file, but ONLY when both hold: the pid recorded in
 * `daemon.json` is dead (or the state file is missing/unreadable), AND a
 * fresh connection attempt failed with `ECONNREFUSED` specifically — never
 * on a transient error (`EAGAIN`, a timeout, etc.), which could unlink a
 * socket a live daemon is still in the middle of binding.
 * `contracts/daemon-rpc.md` "Spawn lockfile".
 */
async function maybeUnlinkStaleSocket(socketPath: string): Promise<void> {
  if (!existsSync(socketPath)) return;

  const state = await readDaemonState();
  const pidDead = !state || !isPidAlive(state.pid);
  if (!pidDead) return; // A live, known daemon owns this socket — leave it alone.

  const res = await rawConnect(socketPath);
  if ("client" in res) {
    // It answered after all — daemon.json was stale/absent but the socket
    // itself is live. Don't unlink a socket that just worked.
    res.client.dispose();
    return;
  }
  if (res.error.code !== "ECONNREFUSED") return;

  try {
    unlinkSync(socketPath);
  } catch {
    // Another process may have already cleaned it up — ignore.
  }
}

/**
 * The spawn path, serialized by `~/.windower/daemon.lock` (`FileLock`) so
 * two concurrent invocations never both spawn a daemon or unlink each
 * other's live socket (`contracts/daemon-rpc.md` "Spawn lockfile"):
 *
 * - Acquire the lock. If another process already holds it, don't spawn —
 *   poll the socket instead until it comes up or the poll times out.
 * - Under the lock: re-check the socket (someone may have finished spawning
 *   between our first connect attempt and acquiring the lock), then
 *   conditionally unlink a stale socket, then spawn and poll.
 * - Release the lock once spawn+poll settles, success or failure.
 */
async function spawnAndConnect(
  socketPath: string,
  options: EnsureDaemonRunningOptions,
): Promise<DaemonClient> {
  const lockPath = join(dirname(socketPath), "daemon.lock");
  const lock = new FileLock(lockPath);
  const spawnTimeoutMs = options.spawnTimeoutMs ?? 5000;
  const deadline = Date.now() + spawnTimeoutMs;

  try {
    await lock.acquire({ pid: process.pid, acquiredAt: new Date().toISOString() });
  } catch (err) {
    if (err instanceof LockHeldError) {
      // Someone else is already spawning (or just spawned) — never spawn a
      // second daemon; just wait for their socket to come up.
      return await pollForSocket(socketPath, deadline);
    }
    throw err;
  }

  try {
    const already = await tryConnect(socketPath);
    if (already) return already;

    await maybeUnlinkStaleSocket(socketPath);

    const child = spawnDaemonDetached(options.entryPath);
    options.onSpawn?.(child);
    return await pollForSocket(socketPath, deadline);
  } finally {
    await lock.release();
  }
}

/**
 * `hello` → compare protocol versions → on match return `client`; on
 * mismatch (including "no `hello` method at all", the back-compat signal
 * for a pre-Phase-20 daemon), restart if safe, at most once
 * (`allowRestart` is `false` on the retry so this never loops). See
 * `contracts/daemon-rpc.md` "Version handshake semantics".
 */
async function handshake(
  client: DaemonClient,
  socketPath: string,
  options: EnsureDaemonRunningOptions,
  allowRestart: boolean,
): Promise<DaemonClient> {
  const helloParams = buildHelloParams(options);

  let result: DaemonHelloResult;
  try {
    result = await client.hello(helloParams);
  } catch {
    // Any error from `hello` itself — old daemon rejecting an unknown
    // method with INVALID_ARGS, or any other failure — is treated as
    // "protocol version 0" per contracts/daemon-rpc.md.
    return handleMismatch(client, socketPath, options, allowRestart, 0);
  }

  if (result.windowerHome !== helloParams.windowerHome) {
    client.dispose();
    throw new DaemonError(
      "DAEMON_VERSION_MISMATCH",
      `windowerHome disagreement: this client resolved "${helloParams.windowerHome}", the ` +
        `connected daemon resolved "${result.windowerHome}". This usually means WINDOWER_HOME ` +
        `is set differently across shells/processes — not something an automatic restart can ` +
        `fix; resolve the environment difference and retry.`,
    );
  }

  if (result.protocolVersion !== DAEMON_PROTOCOL_VERSION) {
    return handleMismatch(client, socketPath, options, allowRestart, result.protocolVersion);
  }

  return client;
}

async function handleMismatch(
  client: DaemonClient,
  socketPath: string,
  options: EnsureDaemonRunningOptions,
  allowRestart: boolean,
  daemonProtocolVersion: number,
): Promise<DaemonClient> {
  if (!allowRestart) {
    client.dispose();
    throw new DaemonError(
      "DAEMON_VERSION_MISMATCH",
      `Daemon protocol version ${daemonProtocolVersion} still does not match client version ` +
        `${DAEMON_PROTOCOL_VERSION} after one restart attempt. Run "windower daemon restart" ` +
        `(or check WINDOWER_DAEMON_BIN_PATH) to investigate.`,
    );
  }

  const safety = await checkSafeToRestart(client);
  if (!safety.safe) {
    client.dispose();
    throw new DaemonError(
      "DAEMON_BUSY",
      busyMessage(
        safety,
        `Daemon protocol version ${daemonProtocolVersion} does not match client version ` +
          `${DAEMON_PROTOCOL_VERSION}, but it cannot be auto-restarted`,
      ),
    );
  }

  await gracefulShutdownAndWait(client, socketPath);
  const fresh = await spawnAndConnect(socketPath, options);
  return handshake(fresh, socketPath, options, false);
}

/**
 * The auto-spawn helper CLI and MCP server call before any daemon RPC:
 * connects to the daemon if one is already listening (or spawns it,
 * serialized by the spawn lockfile, otherwise), then performs the `hello`
 * version handshake — auto-restarting once if the connected daemon's
 * protocol version doesn't match and nothing is in flight, or throwing
 * `DAEMON_BUSY`/`DAEMON_VERSION_MISMATCH` per `contracts/daemon-rpc.md`.
 */
export async function ensureDaemonRunning(
  options: EnsureDaemonRunningOptions = {},
): Promise<DaemonClient> {
  const socketPath = options.socketPath ?? daemonSocketPath();

  let client = await tryConnect(socketPath);
  if (!client) {
    client = await spawnAndConnect(socketPath, options);
  }

  return handshake(client, socketPath, options, true);
}

export interface RestartDaemonOptions extends EnsureDaemonRunningOptions {
  /** Skip the in-flight-work safety check and restart unconditionally, per `windower daemon restart --force`. */
  force?: boolean;
}

/**
 * `windower daemon restart` — `attach` mode per `contracts/cli.md`'s Daemon
 * policy: never spawns to find something to restart (throws
 * `DAEMON_UNREACHABLE` if nothing is listening). Otherwise: safety-checks
 * (unless `force`), gracefully shuts the existing daemon down, spawns a
 * fresh one (via the same spawn-lock path as `ensureDaemonRunning`), and
 * hands back a freshly handshaken client.
 */
export async function restartDaemon(options: RestartDaemonOptions = {}): Promise<DaemonClient> {
  const socketPath = options.socketPath ?? daemonSocketPath();
  const existing = await connectToDaemon(socketPath);

  if (!options.force) {
    const safety = await checkSafeToRestart(existing);
    if (!safety.safe) {
      existing.dispose();
      throw new DaemonError(
        "DAEMON_BUSY",
        busyMessage(safety, "Cannot restart the daemon"),
      );
    }
  }

  await gracefulShutdownAndWait(existing, socketPath);
  const fresh = await spawnAndConnect(socketPath, options);
  return handshake(fresh, socketPath, options, false);
}

/** Default bounded wait after SIGTERM before escalating to SIGKILL — mirrors `SidecarProcess`'s `DEFAULT_KILL_TIMEOUT_MS`. */
const DEFAULT_FORCE_KILL_TIMEOUT_MS = 3000;

/**
 * SIGTERM, then SIGKILL if `pid` is still alive after `timeoutMs`. Returns
 * whether `pid` was alive (and therefore signaled) to begin with — a dead or
 * already-reaped pid is a no-op, not an error, so callers can loop over a
 * pid list without special-casing "already gone."
 */
async function killPidWithEscalation(pid: number, timeoutMs: number): Promise<boolean> {
  if (!isPidAlive(pid)) return false;

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return false; // Raced with the process exiting on its own — nothing left to escalate.
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isPidAlive(pid)) {
    await sleep(100);
  }
  if (isPidAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Raced with exit between the liveness check and the signal — fine.
    }
  }
  return true;
}

export interface KillDaemonAndSidecarsResult {
  /** Whether a live daemon pid was found and signaled. `false` when nothing was running — this is the idempotent "nothing to kill" case, not an error. */
  daemonKilled: boolean;
  /** The daemon pid that was signaled, if any (from `daemon.json`, alive or not). */
  daemonPid: number | undefined;
  /** Sidecar pids (from `sidecar-pids.json`) that were found alive and signaled. */
  sidecarPidsKilled: number[];
}

export interface KillDaemonAndSidecarsOptions {
  /** Bounded wait after SIGTERM before escalating to SIGKILL, per pid. Default 3000ms. */
  killTimeoutMs?: number;
}

/**
 * `windower daemon kill`'s implementation — the force-kill fallback for when
 * `daemon stop`'s graceful RPC can't reach the daemon (unreachable socket,
 * hung process). Unlike every other function in this file, this deliberately
 * does NOT go through the socket at all: it reads `daemon.json` and
 * `sidecar-pids.json` directly and signals pids by OS pid, so it still works
 * when the socket is the very thing that's broken.
 *
 * Only ever targets the daemon process and the native sidecar children it
 * recorded in `sidecar-pids.json` (`packages/core/src/daemon/sidecar-pids.ts`)
 * — never `mcp-server` or any other Windower process, which have no presence
 * in either state file.
 *
 * Idempotent: no daemon.json / no live pid / no sidecar pids all collapse to
 * "nothing to kill", not an error — same convention as `daemon status`/`stop`
 * reporting `running: false` on an absent daemon rather than throwing.
 *
 * Order: sidecars first, then the daemon — so a daemon that's still alive and
 * watching its own children doesn't get a chance to respawn one out from
 * under us between the two kills. Both state files are cleared afterward
 * regardless of whether anything was actually alive to kill, since a stale
 * state file left behind by a crash is exactly the mess this command exists
 * to clean up.
 */
export async function killDaemonAndSidecars(
  options: KillDaemonAndSidecarsOptions = {},
): Promise<KillDaemonAndSidecarsResult> {
  const timeoutMs = options.killTimeoutMs ?? DEFAULT_FORCE_KILL_TIMEOUT_MS;

  const [state, sidecarPids] = await Promise.all([readDaemonState(), readSidecarPids()]);

  const sidecarPidsKilled: number[] = [];
  for (const pid of sidecarPids) {
    if (await killPidWithEscalation(pid, timeoutMs)) sidecarPidsKilled.push(pid);
  }

  const daemonPid = state?.pid;
  const daemonKilled = daemonPid !== undefined && (await killPidWithEscalation(daemonPid, timeoutMs));

  await Promise.all([clearDaemonState(), clearSidecarPids()]);

  return { daemonKilled, daemonPid, sidecarPidsKilled };
}
