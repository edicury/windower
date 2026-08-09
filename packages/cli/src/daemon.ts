import { type DaemonClient, ensureDaemonRunning } from "@windower/core";
import { printError } from "./output.js";

/**
 * Every daemon-talking command's entrypoint: auto-starts/connects to the
 * daemon (per CLAUDE.md — "windower daemon auto-starts on first use of any
 * other command"), runs `fn` with the connected client, and on failure
 * (connection or any `DaemonError` `fn` lets escape) prints the error via
 * `printError` and sets `process.exitCode` instead of an uncaught stack
 * trace. Always disposes the client when done, success or failure.
 *
 * Commands that need to opt out of auto-spawn (`daemon status`, which must
 * only probe) should use `connectToDaemon` directly instead of this helper.
 */
export async function withDaemon(
  json: boolean,
  fn: (client: DaemonClient) => Promise<void>,
): Promise<void> {
  let client: DaemonClient | undefined;
  try {
    client = await ensureDaemonRunning();
    await fn(client);
  } catch (err) {
    process.exitCode = printError(json, err);
  } finally {
    client?.dispose();
  }
}
