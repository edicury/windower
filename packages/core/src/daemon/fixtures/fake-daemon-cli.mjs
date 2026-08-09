#!/usr/bin/env node
// Test-only fixture: a tiny standalone process that listens on
// `~/.windower/daemon.sock` (via `WINDOWER_HOME`, same env contract
// `apps/daemon`'s real bin.ts uses) and answers requests, used to exercise
// `ensureDaemonRunning`/`spawnDaemonDetached`/`restartDaemon` against a REAL
// spawned OS process without needing the full `apps/daemon` build.
// Deliberately duplicates `paths.ts`'s tiny path-join logic and hand-writes
// minimal-but-schema-valid `RecordingSession`/`OperatorRun` payloads rather
// than importing the package, to stay a dependency-free spawnable script
// like `process/fixtures/fake-sidecar-cli.mjs`.
//
// Behavior is controlled entirely by env vars so `connect.test.ts` can drive
// every handshake scenario (version match, mismatch+safe-restart,
// mismatch+busy, back-compat "no hello method", stale-socket unlink) against
// a real child process rather than a mock:
//
//   FAKE_DAEMON_START_DELAY_MS     delay before `listen()` (default 0)
//   FAKE_DAEMON_NO_HELLO=1         reject `hello`/`daemon_info` with
//                                  INVALID_ARGS, simulating a pre-Phase-20
//                                  daemon that has never heard of `hello`
//   FAKE_DAEMON_PROTOCOL_VERSION   `hello`/`daemon_info`'s `protocolVersion`
//                                  (default: 1, i.e. matches a real client)
//   FAKE_DAEMON_WINDOWER_HOME      overrides the `windowerHome` echoed back
//                                  in `hello` (default: this process's own
//                                  `WINDOWER_HOME`, i.e. agrees with the client)
//   FAKE_DAEMON_ACTIVE_SESSION_IDS comma-separated ids returned by
//                                  `list_sessions({state:"recording"})`
//   FAKE_DAEMON_ACTIVE_RUN_IDS     comma-separated ids returned by
//                                  `list_operator_runs` (state: "running")
//   FAKE_DAEMON_WRITE_STATE=0      skip writing `daemon.json` on listen
//                                  (so stale-socket detection sees "no
//                                  recorded pid")
//   FAKE_DAEMON_STATE_PID          pid to record in `daemon.json` instead of
//                                  this process's own (e.g. a known-dead pid,
//                                  to exercise the stale-socket-unlink path)
//   FAKE_DAEMON_SHUTDOWN_DELAY_MS  delay between answering `shutdown` and
//                                  actually closing the socket (default 20)

import { createServer } from "node:net";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const home = process.env.WINDOWER_HOME ?? join(homedir(), ".windower");
const socketPath = join(home, "daemon.sock");
const statePath = join(home, "daemon.json");
const delayMs = Number(process.env.FAKE_DAEMON_START_DELAY_MS ?? "0");
const shutdownDelayMs = Number(process.env.FAKE_DAEMON_SHUTDOWN_DELAY_MS ?? "20");

const hasHello = process.env.FAKE_DAEMON_NO_HELLO !== "1";
const protocolVersion = Number(process.env.FAKE_DAEMON_PROTOCOL_VERSION ?? "1");
const windowerHomeEcho = process.env.FAKE_DAEMON_WINDOWER_HOME ?? home;
const activeSessionIds = (process.env.FAKE_DAEMON_ACTIVE_SESSION_IDS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const activeRunIds = (process.env.FAKE_DAEMON_ACTIVE_RUN_IDS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const writeState = process.env.FAKE_DAEMON_WRITE_STATE !== "0";
const statePid = Number(process.env.FAKE_DAEMON_STATE_PID ?? String(process.pid));

const identity = {
  pid: process.pid,
  version: "0.0.0-fake",
  protocolVersion,
  startedAt: new Date().toISOString(),
  socketPath,
  windowerHome: windowerHomeEcho,
  execPath: process.execPath,
  entryPath: new URL(import.meta.url).pathname,
};

function fakeSession(id) {
  return {
    id,
    state: "recording",
    target: {
      kind: "display",
      id: "display:0",
      name: "Fake Display",
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      isPrimary: true,
      scaleFactor: 1,
    },
    video: { fps: 30, codec: "h264", container: "mp4", quality: "high", showCursor: true },
    audio: { tracks: [], separateTracks: false },
    startedAt: new Date().toISOString(),
  };
}

function fakeRun(id) {
  return {
    id,
    state: "running",
    task: "fake task",
    model: { provider: "anthropic", model: "claude-sonnet-5" },
    steps: [],
    startedAt: new Date().toISOString(),
  };
}

function write(socket, message) {
  socket.write(`${JSON.stringify(message)}\n`);
}

function respond(socket, id, result) {
  write(socket, { jsonrpc: "2.0", id, result });
}

function respondError(socket, id, code, message) {
  write(socket, { jsonrpc: "2.0", id, error: { code: -32000, message, data: { code } } });
}

function listen() {
  const server = createServer((socket) => {
    const rl = createInterface({ input: socket, terminal: false });
    rl.on("line", (rawLine) => {
      const trimmed = rawLine.trim();
      if (trimmed.length === 0) return;
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return;
      }
      const { id, method } = parsed;

      switch (method) {
        case "hello":
        case "daemon_info": {
          if (!hasHello) {
            respondError(socket, id, "INVALID_ARGS", `Unknown method "${method}"`);
            return;
          }
          respond(socket, id, identity);
          return;
        }
        case "list_sessions": {
          respond(socket, id, { sessions: activeSessionIds.map(fakeSession) });
          return;
        }
        case "list_operator_runs": {
          respond(socket, id, { runs: activeRunIds.map(fakeRun) });
          return;
        }
        case "shutdown": {
          respond(socket, id, { shuttingDown: true });
          setTimeout(() => {
            server.close(() => {
              try {
                unlinkSync(socketPath);
              } catch {
                // already gone
              }
              try {
                unlinkSync(statePath);
              } catch {
                // already gone
              }
              process.exit(0);
            });
          }, shutdownDelayMs);
          return;
        }
        default: {
          respondError(socket, id, "INVALID_ARGS", `Unknown method "${method}"`);
        }
      }
    });
  });

  server.listen(socketPath, () => {
    if (writeState) {
      try {
        writeFileSync(statePath, `${JSON.stringify({ ...identity, pid: statePid }, null, 2)}\n`);
      } catch {
        // best-effort — tests that don't need daemon.json don't fail on this
      }
    } else if (existsSync(statePath)) {
      try {
        unlinkSync(statePath);
      } catch {
        // ignore
      }
    }
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
