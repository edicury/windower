import {
  DaemonError,
  type SidecarClient,
  SidecarError,
  type SpawnSidecarOptions,
} from "@windower/core";
import type { SidecarFactory, SidecarHandle } from "./recording-engine.js";

/**
 * `ControlEngine` — a peer of `RecordingEngine`, and deliberately much
 * simpler: no session, no manifest, no lifecycle state machine. It is a thin
 * owner of the one long-lived-or-on-demand control-surface process
 * (`windower-control-macos`) and its client, used by `resizeWindow` calls.
 *
 * **It never takes the capture lock.** The control surface implements only
 * `describe`/`resizeWindow`, backed by `AXUIElement*` +
 * `CGWindowListCopyWindowInfo` — none of
 * which touch ScreenCaptureKit, `replayd`, or any shared capture state
 * (`contracts/screen-capture-exclusivity.md` §What never takes this lock).
 * Consequences, all intentional:
 *
 * - Any number of control processes may run concurrently, with each other and
 *   with the capture sidecar.
 * - `resizeWindow` is never serialized against a recording or an
 *   `enumerateTargets`.
 * - A wedged or `kill -9`'d control surface cannot affect the capture sidecar,
 *   the lock, or an in-progress recording — the process is respawned on the
 *   next call, and only the call that was in flight fails.
 *
 * Code that takes `capture.lock` before spawning a control process is a bug:
 * it reintroduces exactly the coupling Phase 21 exists to delete.
 *
 * Per CLAUDE.md, nothing here branches on a platform string: which binary the
 * injected `spawnControl` factory resolves is the host's decision, and every
 * capability question is answered by `describe().capabilities`.
 */
export interface ControlEngineOptions {
  /**
   * Spawns the control-surface process (`windower-control-macos`). Injected
   * rather than resolved here so tests can pass a fake and hosts own binary
   * resolution — the same seam `RecordingEngineOptions.spawnSidecar` uses.
   */
  spawnControl: SidecarFactory;
  /** Spawn options forwarded to every (re)spawn — `env`, `binaryPath`, etc. `onExit`/`onStderrLine` are supplied internally. */
  spawnOptions?: Omit<SpawnSidecarOptions, "onExit" | "onStderrLine">;
  /** Logging seam; defaults to `console.error`. */
  onLog?: (message: string) => void;
}

interface ActiveControlProcess {
  handle: SidecarHandle;
  capabilities: readonly string[];
  /** Set from the spawn's `onExit` callback — the next call respawns instead of writing into a dead pipe. */
  exited: boolean;
  exitInfo?: { code: number | null; signal: NodeJS.Signals | null };
}

export class ControlEngine {
  private readonly spawnControl: SidecarFactory;
  private readonly spawnOptions: Omit<SpawnSidecarOptions, "onExit" | "onStderrLine">;
  private readonly log: (message: string) => void;
  private active: ActiveControlProcess | undefined;
  /** In-flight `ensureProcess()` — concurrent first calls must not spawn two processes. */
  private starting: Promise<ActiveControlProcess> | undefined;

  constructor(options: ControlEngineOptions) {
    this.spawnControl = options.spawnControl;
    this.spawnOptions = options.spawnOptions ?? {};
    this.log = options.onLog ?? ((message) => console.error(`[ControlEngine] ${message}`));
  }

  /** Whether a control process is currently alive (i.e. spawned and not yet observed exiting). */
  get isRunning(): boolean {
    return this.active !== undefined && !this.active.exited;
  }

  /** The control process's pid, when the factory exposes one. */
  get pid(): number | undefined {
    return this.active?.handle.pid;
  }

  /** `describe().capabilities` for the control surface, cached for the process's lifetime. */
  async capabilities(): Promise<readonly string[]> {
    const active = await this.ensureProcess();
    return active.capabilities;
  }

  /** The live control client — spawning the process on demand. */
  async client(): Promise<SidecarClient> {
    const active = await this.ensureProcess();
    return active.handle.client;
  }

  async describe(): Promise<Awaited<ReturnType<SidecarClient["describe"]>>> {
    return this.call((client) => client.describe());
  }

  async resizeWindow(
    params: Parameters<SidecarClient["resizeWindow"]>[0],
  ): Promise<Awaited<ReturnType<SidecarClient["resizeWindow"]>>> {
    return this.call((client) => client.resizeWindow(params));
  }

  /**
   * Throws `UNSUPPORTED_CAPABILITY` unless the control surface advertises
   * `capability`. Capability strings, never a platform check — CLAUDE.md.
   */
  async requireCapability(capability: string): Promise<void> {
    const capabilities = await this.capabilities();
    if (!capabilities.includes(capability)) {
      throw new DaemonError(
        "UNSUPPORTED_CAPABILITY",
        `Control surface does not advertise "${capability}"`,
      );
    }
  }

  /** Terminates the control process, if any. Idempotent; safe on a process that already died. */
  async shutdown(): Promise<void> {
    const active = this.active;
    this.active = undefined;
    this.starting = undefined;
    if (active) await active.handle.terminate().catch(() => {});
  }

  /**
   * Best-effort synchronous SIGKILL for `process.on("exit")` handlers, which
   * cannot await the graceful `terminate()` — mirrors
   * `RecordingEngine.sigkillActiveSidecars`.
   */
  sigkillActiveProcess(): void {
    const pid = this.active?.handle.pid;
    if (pid === undefined) return;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already dead — nothing to do.
    }
  }

  // ---- internals ----

  /**
   * Runs one control-surface RPC. A process that already died is replaced
   * *before* the call (restart-on-demand). A process that dies *during* the
   * call is not silently retried — replaying a half-delivered request is
   * worse than a clear error — so the failure surfaces as `INTERNAL_ERROR`
   * naming the exit, and the next call gets a fresh process.
   */
  private async call<T>(fn: (client: SidecarClient) => Promise<T>): Promise<T> {
    const active = await this.ensureProcess();
    try {
      return await fn(active.handle.client);
    } catch (err) {
      if (active.exited || isTransportFailure(err)) {
        this.discard(active);
        throw new DaemonError(
          "INTERNAL_ERROR",
          `Control surface process exited during the call (${describeExit(active.exitInfo)}); the recording and capture sidecar are unaffected. Retry to spawn a fresh control process.`,
        );
      }
      if (err instanceof SidecarError) throw new DaemonError(err.code, err.message);
      throw err;
    }
  }

  private async ensureProcess(): Promise<ActiveControlProcess> {
    const active = this.active;
    if (active && !active.exited) return active;
    if (active?.exited) this.discard(active);
    if (this.starting) return this.starting;

    const starting = this.spawnAndDescribe();
    this.starting = starting;
    try {
      const spawned = await starting;
      this.active = spawned;
      return spawned;
    } finally {
      if (this.starting === starting) this.starting = undefined;
    }
  }

  private async spawnAndDescribe(): Promise<ActiveControlProcess> {
    const record: ActiveControlProcess = {
      // Reassigned immediately below — the `onExit` closure needs `record` to
      // exist before `spawnControl` returns, since a spawn that fails outright
      // (bad binary path) fires `onExit` synchronously-ish.
      handle: undefined as unknown as SidecarHandle,
      capabilities: [],
      exited: false,
    };
    record.handle = this.spawnControl({
      ...this.spawnOptions,
      onExit: (info) => {
        record.exited = true;
        record.exitInfo = info;
        if (this.active === record) this.active = undefined;
        this.log(`control surface process exited (${describeExit(info)})`);
      },
      onStderrLine: (line) => {
        this.log(`control surface stderr: ${line}`);
      },
    });

    try {
      const described = await record.handle.client.describe();
      record.capabilities = described.capabilities as readonly string[];
    } catch (err) {
      await record.handle.terminate().catch(() => {});
      record.exited = true;
      throw new DaemonError(
        "INTERNAL_ERROR",
        `Control surface process failed to start: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return record;
  }

  private discard(active: ActiveControlProcess): void {
    if (this.active === active) this.active = undefined;
    void active.handle.terminate().catch(() => {});
  }
}

function describeExit(info?: { code: number | null; signal: NodeJS.Signals | null }): string {
  if (!info) return "transport closed";
  return `code=${info.code}, signal=${info.signal}`;
}

/** A dead transport, as surfaced by `SidecarClient` when its stream closes mid-request. */
function isTransportFailure(err: unknown): boolean {
  if (err instanceof SidecarError) {
    return err.code === "INTERNAL_ERROR" && /stream closed|disposed/i.test(err.message);
  }
  if (err instanceof Error && "code" in err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPIPE" || code === "ECONNRESET" || code === "ERR_STREAM_DESTROYED";
  }
  return false;
}
