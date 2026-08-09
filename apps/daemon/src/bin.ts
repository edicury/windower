#!/usr/bin/env node
import { runDaemon } from "./main.js";

/**
 * Real process entrypoint — what `packages/core`'s `spawnDaemonDetached`
 * spawns via `node dist/bin.js`. Owns process lifecycle: exits non-zero on
 * startup failure, and handles SIGTERM/SIGINT via the graceful `shutdown`
 * path (`contracts/daemon-rpc.md` "Graceful shutdown") — draining in-flight
 * operator runs and finalizing any recording still in progress — instead of
 * just closing the socket and leaving capture processes orphaned.
 */
async function main(): Promise<void> {
  const daemon = await runDaemon();

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return; // once(), but a second signal mid-drain must not re-enter
    shuttingDown = true;
    void daemon.shutdown("graceful").then(() => process.exit(0));
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  // Best-effort synchronous sweep for a hard/unexpected exit (e.g. this
  // process itself receiving SIGKILL, or an uncaught exception bypassing the
  // handlers above) — `process.on("exit")` cannot await async work, so this
  // is SIGKILL only, never the graceful SIGTERM-then-SIGKILL `terminate()`
  // uses. The normal graceful/immediate `shutdown()` paths above already
  // clean up properly before this would ever run.
  process.on("exit", () => {
    daemon.sessionManager.sigkillActiveSidecars();
    daemon.operatorRunManager.sigkillActiveSidecars();
  });
}

main().catch((err) => {
  console.error("windower daemon failed to start:", err);
  process.exit(1);
});
