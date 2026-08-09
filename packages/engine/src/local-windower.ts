import {
  DAEMON_PROTOCOL_VERSION,
  type DaemonIdentity,
  type DaemonMethodMap,
  type WindowerBackend,
  packageVersion,
  spawnSidecar as realSpawnSidecar,
  windowerHome,
} from "@windower/core";
import { OperatorRunEngine } from "./operator-run-engine.js";
import { OperatorRunStore } from "./operator-run-store.js";
import { PassthroughService } from "./passthrough.js";
import { RecordingEngine, type SidecarFactory } from "./recording-engine.js";
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
 * process. Constructs and owns its own `RecordingEngine`, `OperatorRunEngine`,
 * `SessionStore`, and `OperatorRunStore`, scoped to this host process's
 * lifetime (e.g. a single `record --duration` CLI invocation, or one MCP
 * tool call routed `local`).
 *
 * Deliberately thin: every method either delegates straight to
 * `RecordingEngine`/`OperatorRunEngine`/`PassthroughService`, or (for
 * `hello`/`daemonInfo`/`shutdown`) fabricates the trivial answer a
 * same-process caller needs. `recoverCrashedSessions()`/`recoverCrashedRuns()`
 * are intentionally NOT called here — those mark every `recording`/`running`
 * record `failed` at startup, which is only safe for a real daemon's own
 * exclusive session store, per `RecordingEngine.recoverCrashedSessions`'s
 * doc; a daemon-free `LocalWindower` sharing `~/.windower` with a
 * concurrently-running daemon must never do that.
 */
export class LocalWindower implements WindowerBackend {
  private readonly sessionStore: SessionStore;
  private readonly operatorRunStore: OperatorRunStore;
  private readonly recordingEngine: RecordingEngine;
  private readonly passthrough: PassthroughService;
  private readonly operatorRunEngine: OperatorRunEngine;
  private readonly startedAt = new Date().toISOString();
  private loaded: Promise<void> | undefined;

  constructor(options: LocalWindowerOptions = {}) {
    const spawnSidecar = options.spawnSidecar ?? realSpawnSidecar;
    this.sessionStore = new SessionStore();
    this.operatorRunStore = new OperatorRunStore();
    this.recordingEngine = new RecordingEngine({
      store: this.sessionStore,
      spawnSidecar,
      targetLock: new FileTargetLock(),
    });
    this.passthrough = new PassthroughService(spawnSidecar);
    this.operatorRunEngine = new OperatorRunEngine({
      store: this.operatorRunStore,
      sessionManager: this.recordingEngine,
      passthrough: this.passthrough,
      spawnSidecar,
    });
  }

  /** Loads both stores from disk exactly once, on first store-touching call. */
  private ensureLoaded(): Promise<void> {
    if (!this.loaded) {
      this.loaded = Promise.all([this.sessionStore.load(), this.operatorRunStore.load()]).then(
        () => undefined,
      );
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

  async runOperator(
    params: DaemonMethodMap["run_operator"]["params"],
  ): Promise<DaemonMethodMap["run_operator"]["result"]> {
    await this.ensureLoaded();
    return this.operatorRunEngine.runOperator(params);
  }

  async getOperatorRun(
    params: DaemonMethodMap["get_operator_run"]["params"],
  ): Promise<DaemonMethodMap["get_operator_run"]["result"]> {
    await this.ensureLoaded();
    return this.operatorRunEngine.getOperatorRun(params);
  }

  async abortOperatorRun(
    params: DaemonMethodMap["abort_operator_run"]["params"],
  ): Promise<DaemonMethodMap["abort_operator_run"]["result"]> {
    await this.ensureLoaded();
    return this.operatorRunEngine.abortOperatorRun(params);
  }

  async listOperatorRuns(
    params: DaemonMethodMap["list_operator_runs"]["params"] = {},
  ): Promise<DaemonMethodMap["list_operator_runs"]["result"]> {
    await this.ensureLoaded();
    return this.operatorRunEngine.listOperatorRuns(params);
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
