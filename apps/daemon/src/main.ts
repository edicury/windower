import {
  addSidecarPid,
  daemonSocketPath,
  removeSidecarPid,
  spawnSidecar as coreSpawnSidecar,
  windowerHome,
} from "@windower/core";
import type { SidecarProcess, SpawnSidecarOptions } from "@windower/core";
import {
  CaptureLock,
  ControlEngine,
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
  /** The daemon's single control-surface owner — shared by `resize_window`, `performInput`, and the operator. */
  controlEngine: ControlEngine;
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
 * Wraps `@windower/core`'s `spawnSidecar` so every native sidecar this
 * daemon spawns (capture or control surface) gets its pid recorded in
 * `~/.windower/sidecar-pids.json` on spawn and removed on exit. A sidecar
 * pid otherwise only lives in this process's memory — `windower daemon
 * kill` runs in a fresh CLI process with none of that, so this file is the
 * only way it can find sidecars to force-kill alongside the daemon.
 * `main.ts` is the single place `spawnSidecar` is handed out to every engine
 * (`CaptureLock`, `ControlEngine`, `RecordingEngine`, `PassthroughService`,
 * `OperatorRunEngine`), so wrapping it once here covers all of them.
 */
function trackedSpawnSidecar(options: SpawnSidecarOptions = {}): SidecarProcess {
  const proc = coreSpawnSidecar({
    ...options,
    onExit: (info) => {
      if (proc.pid !== undefined) void removeSidecarPid(proc.pid);
      options.onExit?.(info);
    },
  });
  if (proc.pid !== undefined) void addSidecarPid(proc.pid);
  return proc;
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

  // Phase 21, `contracts/screen-capture-exclusivity.md` §"Enforcement, in two
  // tiers": ONE `CaptureLock` handed to every capture-surface consumer in this
  // process. That is what makes "the daemon owns exactly one capture sidecar
  // and never starts a second one" true *by construction* rather than by which
  // sidecar happens to get reused — `list_targets`, `check_permissions`, a
  // recording's `startCapture`, and the operator's proxied `captureFrame` all
  // resolve to the same in-process object (row 1 of the acquire-or-wait table:
  // no file I/O, no spawn, no arbitration between in-daemon callers).
  //
  // The daemon takes the lock file itself even though its own callers never
  // need it, so the invariant stays honest against daemon-free processes
  // (Phase 20's `LocalWindower`, `windower record` with no daemon).
  const captureLock = new CaptureLock({ spawnSidecar: trackedSpawnSidecar });

  // The control surface is an independent peer: a different binary, no
  // ScreenCaptureKit linkage, and therefore no capture lock — ever. Any number
  // of control processes may run concurrently with each other and with the
  // capture sidecar, and `performInput`/`resizeWindow` are never serialized
  // against a recording or a `captureFrame`.
  const controlEngine = new ControlEngine({
    spawnControl: trackedSpawnSidecar,
    // Without this, `SpawnSidecarOptions.surface` defaults to `"capture"` and
    // the "control" engine would spawn a second ScreenCaptureKit process.
    spawnOptions: { surface: "control" },
  });

  const sessionManager = new RecordingEngine({
    store,
    spawnSidecar: trackedSpawnSidecar,
    targetLock: new FileTargetLock(),
    captureLock,
    muxNarration,
    validateNarrationFile,
  });
  await sessionManager.recoverCrashedSessions();

  const passthrough = new PassthroughService(trackedSpawnSidecar, {
    capture: captureLock,
    control: controlEngine,
  });

  // Phase 19: operator runs replay from disk and crash-recover on the same
  // startup path as recording sessions — an in-flight run cannot survive the
  // death of the process that owned its loop.
  const operatorRunStore = new OperatorRunStore();
  await operatorRunStore.load();
  const operatorRunManager = new OperatorRunEngine({
    store: operatorRunStore,
    passthrough,
    spawnSidecar: trackedSpawnSidecar,
    // The same two peers everything else in the daemon uses: an operator
    // `captureFrame` during a live recording is row 1 (reuse this process's
    // capture sidecar), and its `performInput` goes to the shared control
    // process without touching the capture lock.
    capture: captureLock,
    control: controlEngine,
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
    controlEngine,
    stop: () => server.stop(),
    shutdown: async (mode) => {
      await server.shutdown(mode);
      // The control process is respawn-on-demand and holds no capture state,
      // so it has nothing to finalize — but it is still a child of this
      // process, and leaving it alive past teardown would orphan it.
      await controlEngine.shutdown();
    },
  };
}
