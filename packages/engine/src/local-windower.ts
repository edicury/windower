import {
  DAEMON_PROTOCOL_VERSION,
  type DaemonIdentity,
  type DaemonMethodMap,
  type WindowerBackend,
  packageVersion,
  spawnSidecar as realSpawnSidecar,
  windowerHome,
} from "@windower/core";
import { ControlEngine } from "./control-engine.js";
import { PassthroughService } from "./passthrough.js";
import { RecordingEngine, type SidecarFactory } from "./recording-engine.js";
import { CaptureLock } from "./screen-capture-lock.js";
import { SessionStore } from "./session-store.js";
import { FileTargetLock } from "./target-lock.js";

export interface LocalWindowerOptions {
  /** Injectable for tests — defaults to `@windower/core`'s real `spawnSidecar`. */
  spawnSidecar?: SidecarFactory;
}

/**
 * The daemon-free half of the `local` / `daemon` / `attach` routing decision
 * (`contracts/daemon-rpc.md` "Shared backend infrastructure",
 * `phase-20-daemon-optional.md`): implements `WindowerBackend` directly over
 * `@windower/engine`'s in-process pieces — no socket, no spawned daemon
 * process. Constructs and owns its own `RecordingEngine` and `SessionStore`,
 * scoped to this host process's lifetime (e.g. a single `record --duration`
 * CLI invocation, or one MCP tool call routed `local`).
 *
 * Deliberately thin: every method either delegates straight to
 * `RecordingEngine`/`PassthroughService`, or (for `hello`/`daemonInfo`/
 * `shutdown`) fabricates the trivial answer a same-process caller needs.
 * `recoverCrashedSessions()` is intentionally NOT called here — it marks
 * every `recording` record `failed` at startup, which is only safe for a
 * real daemon's own exclusive session store, per
 * `RecordingEngine.recoverCrashedSessions`'s doc; a daemon-free
 * `LocalWindower` sharing `~/.windower` with a concurrently-running daemon
 * must never do that.
 */
export class LocalWindower implements WindowerBackend {
  private readonly sessionStore: SessionStore;
  private readonly recordingEngine: RecordingEngine;
  private readonly passthrough: PassthroughService;
  private readonly startedAt = new Date().toISOString();
  private loaded: Promise<void> | undefined;

  constructor(options: LocalWindowerOptions = {}) {
    const spawnSidecar = options.spawnSidecar ?? realSpawnSidecar;
    this.sessionStore = new SessionStore();
    // Phase 21: ONE `CaptureLock` shared by the recording engine and the
    // passthrough ops, so a `list_targets` issued while this process's own
    // recording is live takes row 1 of the acquire-or-wait table (reuse the
    // capture sidecar this process already has — no file I/O, no spawn)
    // instead of contending with itself for the lock file.
    const captureLock = new CaptureLock({ spawnSidecar });
    // The control surface's peer of the same idea: ONE `ControlEngine` shared
    // by `resize_window` and any future control passthrough. It takes no
    // capture lock — control has no ScreenCaptureKit relationship — and
    // `surface: "control"` keeps it off the capture binary, whose spawn is
    // `SpawnSidecarOptions.surface`'s default.
    const controlEngine = new ControlEngine({
      spawnControl: spawnSidecar,
      spawnOptions: { surface: "control" },
    });
    this.recordingEngine = new RecordingEngine({
      store: this.sessionStore,
      spawnSidecar,
      targetLock: new FileTargetLock(),
      captureLock,
    });
    this.passthrough = new PassthroughService(spawnSidecar, {
      capture: captureLock,
      control: controlEngine,
    });
  }

  /** Loads the session store from disk exactly once, on first store-touching call. */
  private ensureLoaded(): Promise<void> {
    if (!this.loaded) {
      this.loaded = this.sessionStore.load().then(() => undefined);
    }
    return this.loaded;
  }

  /** This process's identity — not a listening daemon, so `socketPath` is empty. */
  private identity(): DaemonIdentity {
    return {
      pid: process.pid,
      version: packageVersion(import.meta.url),
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      startedAt: this.startedAt,
      socketPath: "",
      windowerHome: windowerHome(),
      execPath: process.execPath,
      entryPath: process.argv[1] ?? "",
    };
  }

  async hello(
    _params: DaemonMethodMap["hello"]["params"],
  ): Promise<DaemonMethodMap["hello"]["result"]> {
    return this.identity();
  }

  async daemonInfo(): Promise<DaemonMethodMap["daemon_info"]["result"]> {
    return this.identity();
  }

  async listTargets(
    params: DaemonMethodMap["list_targets"]["params"] = {},
  ): Promise<DaemonMethodMap["list_targets"]["result"]> {
    return this.passthrough.listTargets(params);
  }

  async checkPermissions(): Promise<DaemonMethodMap["check_permissions"]["result"]> {
    return this.passthrough.checkPermissions();
  }

  async requestPermission(
    params: DaemonMethodMap["request_permission"]["params"],
  ): Promise<DaemonMethodMap["request_permission"]["result"]> {
    return this.passthrough.requestPermission(params);
  }

  async resizeWindow(
    params: DaemonMethodMap["resize_window"]["params"],
  ): Promise<DaemonMethodMap["resize_window"]["result"]> {
    return this.passthrough.resizeWindow(params);
  }

  async startRecording(
    params: DaemonMethodMap["start_recording"]["params"],
  ): Promise<DaemonMethodMap["start_recording"]["result"]> {
    await this.ensureLoaded();
    return this.recordingEngine.startRecording(params);
  }

  async getSession(
    params: DaemonMethodMap["get_session"]["params"],
  ): Promise<DaemonMethodMap["get_session"]["result"]> {
    await this.ensureLoaded();
    return this.recordingEngine.getSession(params);
  }

  async stopRecording(
    params: DaemonMethodMap["stop_recording"]["params"],
  ): Promise<DaemonMethodMap["stop_recording"]["result"]> {
    await this.ensureLoaded();
    return this.recordingEngine.stopRecording(params);
  }

  async cancelRecording(
    params: DaemonMethodMap["cancel_recording"]["params"],
  ): Promise<DaemonMethodMap["cancel_recording"]["result"]> {
    await this.ensureLoaded();
    return this.recordingEngine.cancelRecording(params);
  }

  async listSessions(
    params: DaemonMethodMap["list_sessions"]["params"] = {},
  ): Promise<DaemonMethodMap["list_sessions"]["result"]> {
    await this.ensureLoaded();
    return this.recordingEngine.listSessions(params);
  }

  /**
   * No socket/process to shut down in local mode — present only for
   * `WindowerBackend` structural compatibility. `windower daemon stop` is
   * always `attach` mode (a real `DaemonClient`), never routed through
   * `LocalWindower`.
   */
  async shutdown(): Promise<DaemonMethodMap["shutdown"]["result"]> {
    return { shuttingDown: true };
  }
}
