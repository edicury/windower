#!/usr/bin/env node
import { runDaemon } from "./main.js";

/**
 * Real process entrypoint — what `packages/core`'s `spawnDaemonDetached`
 * spawns via `node dist/bin.js`. Owns process lifecycle: exits non-zero on
 * startup failure, and handles SIGTERM/SIGINT for a clean shutdown (close
 * the socket, unlink the file) instead of leaving a stale socket behind.
 */
async function main(): Promise<void> {
  const daemon = await runDaemon();

  const shutdown = (): void => {
    void daemon.stop().then(() => process.exit(0));
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("windower daemon failed to start:", err);
  process.exit(1);
});
