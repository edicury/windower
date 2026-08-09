import { daemonSocketPath, spawnSidecar, windowerHome } from "@windower/core";
import {
  FileTargetLock,
  OperatorRunEngine,
  OperatorRunStore,
  PassthroughService,
  RecordingEngine,
  SessionStore,
} from "@windower/engine";
// `apps/daemon` is the one host that runs narration-muxed recordings, so it
// is (deliberately) the one place outside `@windower/engine-narration`
// itself that imports it — see `packages/engine/src/index.ts`'s top-of-file
// comment and `RecordingEngineOptions.muxNarration`'s doc comment for why
// `@windower/engine` itself never does.
import { muxNarration, validateNarrationFile } from "@windower/engine-narration";
import { loadDaemonConfig } from "./config.js";
import { DaemonServer } from "./server.js";

export interface RunningDaemon {
  server: DaemonServer;
  sessionManager: RecordingEngine;
  operatorRunManager: OperatorRunEngine;
  /** Closes the socket server and unlinks the socket file (and daemon.json). Does not exit the process. */
  stop: () => Promise<void>;
  /**
   * Drains in-flight work (`mode: "graceful"`, the default) or tears
   * everything down immediately, then closes the socket — `bin.ts`'s
   * SIGTERM/SIGINT handlers and the `shutdown` RPC both go through this.
   * Does not exit the process.
   */
  shutdown: (mode?: "graceful" | "immediate") => Promise<void>;
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

  const sessionManager = new RecordingEngine({
    store,
    spawnSidecar,
    targetLock: new FileTargetLock(),
    muxNarration,
    validateNarrationFile,
  });
  await sessionManager.recoverCrashedSessions();

  const passthrough = new PassthroughService(spawnSidecar);

  // Phase 19: operator runs replay from disk and crash-recover on the same
  // startup path as recording sessions — an in-flight run cannot survive the
  // death of the process that owned its loop.
  const operatorRunStore = new OperatorRunStore();
  await operatorRunStore.load();
  const operatorRunManager = new OperatorRunEngine({
    store: operatorRunStore,
    sessionManager,
    passthrough,
    spawnSidecar,
  });
  await operatorRunManager.recoverCrashedRuns();

  // Idle timeout and an explicit `windower daemon stop` RPC both mean the
  // same thing to the process: close the socket, then exit.
  const terminate = (): void => {
    void server.stop().then(options.onIdleShutdown ?? (() => process.exit(0)));
  };

  const server = new DaemonServer(sessionManager, passthrough, operatorRunManager, {
    socketPath: daemonSocketPath(),
    windowerHome: windowerHome(),
    idleTimeoutMs: config.daemonIdleTimeoutMs,
    onIdleShutdown: terminate,
    // `DaemonServer.shutdown()` already performs the full teardown (drain,
    // close socket, unlink socket + daemon.json) before this fires — by the
    // time it's called there's nothing left to do but exit the process.
    onShutdownRequest: () => process.exit(0),
  });
  await server.start();

  return {
    server,
    sessionManager,
    operatorRunManager,
    stop: () => server.stop(),
    shutdown: (mode) => server.shutdown(mode),
  };
}
