import { DaemonError, FileLock, connectToDaemon, killDaemonAndSidecars, restartDaemon } from "@windower/core";
import { captureLockPath } from "@windower/engine";
import type { Command } from "commander";
import { printError, printResult } from "../output.js";

/**
 * `windower daemon status|stop|restart|kill` — explicit lifecycle control,
 * mostly for debugging. Per `contracts/cli.md`'s Daemon policy, `status`,
 * `stop`, and `restart` are `attach` mode: they act on a daemon that's
 * already listening and never spawn one to begin with (`connectToDaemon`/
 * `restartDaemon`, never `ensureDaemonRunning`/`withDaemon`). The daemon
 * itself now auto-starts only for `start`, `stop`/`cancel`, and
 * `operate --detach`/`operate abort` — it's no longer true that any other
 * command brings one up.
 *
 * `kill` is deliberately NOT `attach` mode (or any of the three policy
 * modes) — it never touches the socket at all, by design: it's the fallback
 * for exactly the case where the socket is unreachable or hung, so it reads
 * `daemon.json`/`sidecar-pids.json` directly and force-kills by OS pid. See
 * `killDaemonAndSidecars` in `packages/core/src/daemon/connect.ts`.
 */
export function registerDaemonCommand(program: Command): void {
  const daemon = program.command("daemon").description("Daemon lifecycle control");

  daemon
    .command("status")
    .description("Report whether the daemon is reachable (does not start it)")
    .option("--json", "output JSON")
    .action(async (opts: { json?: boolean }) => {
      const json = Boolean(opts.json);
      try {
        const client = await connectToDaemon();
        client.dispose();
        printResult(json, { running: true }, () => "daemon: running");
      } catch (err) {
        if (err instanceof DaemonError && err.code === "DAEMON_UNREACHABLE") {
          printResult(json, { running: false }, () => "daemon: not running");
          return;
        }
        process.exitCode = printError(json, err);
      }
    });

  daemon
    .command("stop")
    .description("Ask a running daemon to shut down")
    .option("--json", "output JSON")
    .action(async (opts: { json?: boolean }) => {
      const json = Boolean(opts.json);
      try {
        const client = await connectToDaemon();
        await client.shutdown();
        client.dispose();
        printResult(json, { stopped: true }, () => "daemon stopped");
      } catch (err) {
        if (err instanceof DaemonError && err.code === "DAEMON_UNREACHABLE") {
          printResult(json, { stopped: false }, () => "daemon: not running (nothing to stop)");
          return;
        }
        process.exitCode = printError(json, err);
      }
    });

  daemon
    .command("restart")
    .description("Stop the running daemon and start a fresh one")
    .option("--force", "skip the in-flight-work safety check and restart unconditionally")
    .option("--json", "output JSON")
    .action(async (opts: { force?: boolean; json?: boolean }) => {
      const json = Boolean(opts.json);
      try {
        const client = await restartDaemon({ force: Boolean(opts.force) });
        client.dispose();
        printResult(json, { restarted: true }, () => "daemon restarted");
      } catch (err) {
        if (err instanceof DaemonError && err.code === "DAEMON_UNREACHABLE") {
          printResult(json, { restarted: false }, () => "daemon: not running (nothing to restart)");
          return;
        }
        process.exitCode = printError(json, err);
      }
    });

  daemon
    .command("kill")
    .description(
      "Force-kill the daemon and its sidecar processes by OS pid — the fallback for when " +
        "the daemon is unreachable/hung and 'daemon stop' can't reach it over the socket",
    )
    .option("--json", "output JSON")
    .action(async (opts: { json?: boolean }) => {
      const json = Boolean(opts.json);
      try {
        const result = await killDaemonAndSidecars();
        await releaseStaleCaptureLock(result.daemonPid);

        const nothingToKill = !result.daemonKilled && result.sidecarPidsKilled.length === 0;
        printResult(
          json,
          {
            daemonKilled: result.daemonKilled,
            daemonPid: result.daemonPid,
            sidecarPidsKilled: result.sidecarPidsKilled,
          },
          () =>
            nothingToKill
              ? "daemon kill: nothing to kill"
              : [
                  result.daemonKilled ? `daemon (pid ${result.daemonPid}) killed` : undefined,
                  result.sidecarPidsKilled.length > 0
                    ? `sidecar(s) killed: ${result.sidecarPidsKilled.join(", ")}`
                    : undefined,
                ]
                  .filter(Boolean)
                  .join("; "),
        );
      } catch (err) {
        process.exitCode = printError(json, err);
      }
    });
}

/**
 * `capture.lock`'s recorded holder pid is always the process that spawned
 * the capture sidecar — the daemon itself (`screen-capture-lock.ts`'s
 * `CaptureLockPayload` doc). `FileLock.acquire()` already self-heals a stale
 * lock (steals it once it notices the holder pid is dead), so this isn't
 * required for correctness — but leaving a lock file around that still
 * claims a pid we just killed is exactly the kind of stray state `daemon
 * kill` exists to clean up, so clear it eagerly when it matches.
 */
async function releaseStaleCaptureLock(killedDaemonPid: number | undefined): Promise<void> {
  if (killedDaemonPid === undefined) return;
  const lock = new FileLock(captureLockPath());
  const holder = await lock.readHolder();
  if (holder && holder.pid === killedDaemonPid) {
    await lock.release();
  }
}
