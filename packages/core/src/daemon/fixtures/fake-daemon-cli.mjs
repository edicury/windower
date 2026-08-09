#!/usr/bin/env node
// Test-only fixture: a tiny standalone process that listens on
// `~/.windower/daemon.sock` (via `WINDOWER_HOME`, same env contract
// `apps/daemon`'s real bin.ts uses) and answers requests, used to exercise
// `ensureDaemonRunning`/`spawnDaemonDetached` against a REAL spawned OS
// process without needing the full `apps/daemon` build. Deliberately
// duplicates `paths.ts`'s tiny path-join logic rather than importing the
// package, to stay a dependency-free spawnable script like
// `process/fixtures/fake-sidecar-cli.mjs`. Supports an optional startup
// delay (env `FAKE_DAEMON_START_DELAY_MS`) so tests can exercise the
// connect-retry loop.

import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const home = process.env.WINDOWER_HOME ?? join(homedir(), ".windower");
const socketPath = join(home, "daemon.sock");
const delayMs = Number(process.env.FAKE_DAEMON_START_DELAY_MS ?? "0");

function listen() {
  const server = createServer((socket) => {
    const rl = createInterface({ input: socket, terminal: false });
    rl.on("line", (rawLine) => {
      let parsed;
      try {
        parsed = JSON.parse(rawLine.trim());
      } catch {
        return;
      }
      socket.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: parsed.id,
          result: {
            screenRecording: "not_determined",
            daemonRunning: true,
            sidecarAvailable: false,
          },
        })}\n`,
      );
    });
  });
  server.listen(socketPath, () => {
    process.stderr.write("fake-daemon-cli: listening\n");
  });
  process.on("SIGTERM", () => {
    server.close(() => process.exit(0));
  });
}

if (delayMs > 0) {
  setTimeout(listen, delayMs);
} else {
  listen();
}
