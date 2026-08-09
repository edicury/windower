import { daemonSocketPath, spawnSidecar } from "@windower/core";
import { loadDaemonConfig } from "./config.js";
import { PassthroughService } from "./passthrough.js";
import { DaemonServer } from "./server.js";
import { SessionManager } from "./session-manager.js";
import { SessionStore } from "./session-store.js";

export interface RunningDaemon {
  server: DaemonServer;
  sessionManager: SessionManager;
  /** Closes the socket server and unlinks the socket file. Does not exit the process. */
  stop: () => Promise<void>;
}

export interface RunDaemonOptions {
  /** Called once the daemon has been idle for the configured timeout, after the socket is closed. Defaults to `process.exit(0)`. */
  onIdleShutdown?: () => void;
}

/**
 * Wires up and starts the daemon: loads config, replays persisted session
 * state (crash-recovering anything stuck `recording`/`stopping`), and starts
 * listening on the unix socket. Does not install SIGTERM/SIGINT handlers
 * itself — `bin.ts` (the real entrypoint) owns those — but idle shutdown
 * does terminate the process by default, since "idle" means the daemon
 * itself should exit, not just stop accepting connections.
 */
export async function runDaemon(options: RunDaemonOptions = {}): Promise<RunningDaemon> {
  const config = await loadDaemonConfig();

  const store = new SessionStore();
  await store.load();

  const sessionManager = new SessionManager({ store, spawnSidecar });
  await sessionManager.recoverCrashedSessions();

  const passthrough = new PassthroughService(spawnSidecar);

  const server = new DaemonServer(sessionManager, passthrough, {
    socketPath: daemonSocketPath(),
    idleTimeoutMs: config.daemonIdleTimeoutMs,
    onIdleShutdown: () => {
      void server.stop().then(options.onIdleShutdown ?? (() => process.exit(0)));
    },
  });
  await server.start();

  return { server, sessionManager, stop: () => server.stop() };
}
