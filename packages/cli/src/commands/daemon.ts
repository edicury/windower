import { DaemonError, connectToDaemon, restartDaemon } from "@windower/core";
import type { Command } from "commander";
import { printError, printResult } from "../output.js";

/**
 * `windower daemon status|stop|restart` — explicit lifecycle control, mostly
 * for debugging. Per `contracts/cli.md`'s Daemon policy, all three
 * subcommands are `attach` mode: they act on a daemon that's already
 * listening and never spawn one to begin with (`connectToDaemon`/
 * `restartDaemon`, never `ensureDaemonRunning`/`withDaemon`). The daemon
 * itself now auto-starts only for `start`, `stop`/`cancel`, and
 * `operate --detach`/`operate abort` — it's no longer true that any other
 * command brings one up.
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
}
