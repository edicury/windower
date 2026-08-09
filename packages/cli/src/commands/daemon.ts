import { DaemonError, connectToDaemon } from "@windower/core";
import type { Command } from "commander";
import { printError, printResult } from "../output.js";

/**
 * `windower daemon status|stop` — explicit lifecycle control, mostly for
 * debugging (the daemon auto-starts on first use of any other command, per
 * CLAUDE.md). Both subcommands use `connectToDaemon` directly (never
 * `ensureDaemonRunning`/`withDaemon`) — they must not auto-spawn a daemon
 * just to report/stop one.
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
}
