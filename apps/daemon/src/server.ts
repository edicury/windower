import { chmod, mkdir, unlink } from "node:fs/promises";
import { type Server, type Socket, createServer } from "node:net";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import {
  DAEMON_METHOD_SCHEMAS,
  DAEMON_PROTOCOL_VERSION,
  DaemonError,
  type DaemonIdentity,
  DaemonJsonRpcLineSchema,
  type DaemonMethod,
  type DaemonMethodMap,
  SidecarError,
  classifyDaemonJsonRpcLine,
  clearDaemonState,
  isTerminalOperatorRunState,
  packageVersion,
  writeDaemonState,
} from "@windower/core";
import {
  type OperatorRunEngine,
  type PassthroughService,
  type RecordingEngine,
  type RequestContext,
  buildRequestContext,
} from "@windower/engine";
import { ZodError } from "zod";

/** Bounded drain window for a graceful `shutdown` before escalating to `immediate`. */
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 30_000;

export interface DaemonServerOptions {
  socketPath: string;
  idleTimeoutMs: number;
  /** Called once the daemon has been idle (zero active sessions/runs) for `idleTimeoutMs`. */
  onIdleShutdown: () => void;
  /** How often to check idle state. Default 10s; overridable so tests don't wait real minutes. */
  idleCheckIntervalMs?: number;
  /**
   * Called after a `shutdown` RPC's teardown (`DaemonServer.shutdown`, which
   * already closes the socket, unlinks the socket file, and clears
   * `daemon.json`) has fully completed. Defaults to a no-op — callers that
   * also want the *process* to exit (the real `bin.ts` entrypoint) should
   * pass a callback that does so, mirroring `onIdleShutdown`.
   */
  onShutdownRequest?: () => void;
  /**
   * Resolved `WINDOWER_HOME` this daemon is operating against — compared
   * against every `hello` request's own `windowerHome` (`contracts/daemon-rpc.md`
   * "windowerHome split-brain detection"). Also part of the identity
   * returned by `hello`/`daemon_info` and written to `daemon.json`.
   */
  windowerHome: string;
  /**
   * Resolved path of the daemon's entry module, for `hello`/`daemon_info`'s
   * `entryPath`. Defaults to `process.argv[1]` (what `node` was actually
   * invoked with), which is correct regardless of which module in this
   * process happens to construct `DaemonServer`.
   */
  entryPath?: string;
}

function toDaemonError(err: unknown): DaemonError {
  if (err instanceof DaemonError) return err;
  // `PassthroughService` (list_targets/check_permissions/request_permission/
  // resize_window) calls the sidecar directly and doesn't wrap errors itself
  // — unlike `RecordingEngine`, which converts `SidecarError` to `DaemonError`
  // internally before it ever reaches here. Without this branch a
  // passthrough-path `SidecarError` (e.g. RESIZE_UNSUPPORTED,
  // UNSUPPORTED_CAPABILITY, PERMISSION_DENIED) would fall through to
  // INTERNAL_ERROR below, losing the real taxonomy code before it reaches
  // the CLI/MCP layer.
  if (err instanceof SidecarError) return new DaemonError(err.code, err.message);
  if (err instanceof ZodError) return new DaemonError("INVALID_ARGS", err.message);
  return new DaemonError("INTERNAL_ERROR", err instanceof Error ? err.message : String(err));
}

/**
 * Unix-domain-socket JSON-RPC 2.0 server (`~/.windower/daemon.sock`, `0600`
 * perms) implementing contracts/mcp-tools.md's operations. Dispatches
 * session-lifecycle methods to `RecordingEngine` and the sidecar-passthrough
 * ones to `PassthroughService`.
 */
export class DaemonServer {
  private readonly sessionManager: RecordingEngine;
  private readonly passthrough: PassthroughService;
  private readonly operatorRunManager: OperatorRunEngine;
  private readonly options: DaemonServerOptions;
  private server: Server | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private idleSince: number | undefined;
  private startedAt: string | undefined;
  /** Per-connection state captured at `hello` — see `request-context.ts`. */
  private readonly connectionContexts = new WeakMap<Socket, RequestContext>();

  constructor(
    sessionManager: RecordingEngine,
    passthrough: PassthroughService,
    operatorRunManager: OperatorRunEngine,
    options: DaemonServerOptions,
  ) {
    this.sessionManager = sessionManager;
    this.passthrough = passthrough;
    this.operatorRunManager = operatorRunManager;
    this.options = options;
  }

  async start(): Promise<void> {
    await mkdir(dirname(this.options.socketPath), { recursive: true });
    // A stale socket file from a crashed daemon blocks `listen()`. Callers
    // (`ensureDaemonRunning`) already probe for a live daemon via `connect`
    // before spawning us, so any file here is safe to remove.
    await unlink(this.options.socketPath).catch(() => {});

    this.server = createServer((socket) => this.handleConnection(socket));
    await new Promise<void>((resolve, reject) => {
      const server = this.server;
      if (!server) return reject(new Error("server not initialized"));
      server.once("error", reject);
      server.listen(this.options.socketPath, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    await chmod(this.options.socketPath, 0o600);

    this.startedAt = new Date().toISOString();
    // Written after listen()/chmod() succeed, so a concurrent `doctor`/
    // `ensureDaemonRunning` never observes a daemon.json for a socket that
    // isn't actually accepting connections yet.
    await writeDaemonState(this.identity());

    this.idleSince = Date.now();
    this.idleTimer = setInterval(
      () => this.checkIdle(),
      this.options.idleCheckIntervalMs ?? 10_000,
    );
    this.idleTimer.unref();
  }

  /** This daemon's `hello`/`daemon_info` result — identical shape to `~/.windower/daemon.json`. */
  private identity(): DaemonIdentity {
    return {
      pid: process.pid,
      version: packageVersion(import.meta.url),
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      startedAt: this.startedAt ?? new Date().toISOString(),
      socketPath: this.options.socketPath,
      windowerHome: this.options.windowerHome,
      execPath: process.execPath,
      entryPath: this.options.entryPath ?? process.argv[1] ?? "",
    };
  }

  /** Closes the socket, unlinks the socket file, and clears `daemon.json`. Idempotent. */
  async stop(): Promise<void> {
    if (this.idleTimer) clearInterval(this.idleTimer);
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
    await unlink(this.options.socketPath).catch(() => {});
    await clearDaemonState().catch(() => {});
  }

  /**
   * `shutdown({mode})` RPC's actual teardown (`contracts/daemon-rpc.md`
   * "Graceful shutdown") — called from `dispatch`'s `shutdown` case after the
   * `{shuttingDown: true}` response has already been written to the
   * requesting client's socket, and from `bin.ts`'s SIGTERM/SIGINT handlers.
   *
   * `graceful` (default): stop accepting new connections, then abort every
   * active operator run (its own finalizer stops the run's recording
   * cleanly) and `stopRecording` every session still `recording` — so video,
   * manifest, and `.events.json` all land — before closing the socket.
   * Bounded to `GRACEFUL_SHUTDOWN_TIMEOUT_MS`; if the drain doesn't finish in
   * time, escalates to the `immediate` path instead of hanging.
   *
   * `immediate`: skip the drain and just tear everything down. Anything left
   * `recording` is picked up by the next daemon start's
   * `recoverCrashedSessions()`.
   */
  async shutdown(mode: "graceful" | "immediate" = "graceful"): Promise<void> {
    // Stop accepting new connections immediately in both modes — a client
    // that dials in mid-shutdown should see ECONNREFUSED, not a connection
    // that gets torn down moments later.
    if (this.server) await new Promise<void>((resolve) => this.server?.close(() => resolve()));

    if (mode === "graceful") {
      await this.drainGraceful();
    } else {
      this.killEverythingSync();
    }
    await this.stop();
  }

  /**
   * `contracts/operator-loop-protocol.md` §Shutdown, "Daemon graceful
   * shutdown": `abort({reason:"daemon-shutdown"})` to every live loop child
   * **first**, then the drain — and the two drains below run as **peers**,
   * concurrently and unordered with respect to each other. Live recordings are
   * finalized by the recording pass on its own; the loop's shutdown neither
   * triggers nor waits on the recording's, which is what keeps "the operator
   * never touches a recording" true even here.
   */
  private async drainGraceful(): Promise<void> {
    let timedOut = false;
    this.operatorRunManager.signalDaemonShutdown();

    const drainRuns = (async () => {
      const activeRuns = this.operatorRunManager
        .listOperatorRuns({})
        .runs.filter((run) => !isTerminalOperatorRunState(run.state));
      for (const run of activeRuns) {
        try {
          await this.operatorRunManager.abortOperatorRun({ runId: run.id });
          await this.operatorRunManager.whenSettled(run.id);
        } catch (err) {
          console.error(`[DaemonServer] graceful shutdown: aborting run ${run.id} failed:`, err);
        }
      }
    })();

    const drainRecordings = (async () => {
      const recording = this.sessionManager.listSessions({ state: "recording" }).sessions;
      for (const session of recording) {
        try {
          await this.sessionManager.stopRecording({ sessionId: session.id });
        } catch (err) {
          console.error(
            `[DaemonServer] graceful shutdown: stopping session ${session.id} failed:`,
            err,
          );
        }
      }
    })();

    const work = Promise.all([drainRuns, drainRecordings]).then(() => undefined);

    const timeout = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        timedOut = true;
        resolve();
      }, GRACEFUL_SHUTDOWN_TIMEOUT_MS);
      timer.unref();
    });

    await Promise.race([work, timeout]);
    if (timedOut) {
      console.error(
        "[DaemonServer] graceful shutdown exceeded its timeout — escalating to immediate",
      );
      this.killEverythingSync();
    }
  }

  /** Synchronous best-effort SIGKILL sweep — the `immediate` path and a timed-out `graceful` drain. */
  private killEverythingSync(): void {
    this.sessionManager.sigkillActiveSidecars();
    this.operatorRunManager.sigkillActiveSidecars();
  }

  private checkIdle(): void {
    // An operator run has no recording session — it is a peer capability that
    // records nothing (contracts/operator.md §Recording independence), so
    // counting only `activeSessionCount` would let idle-shutdown race an
    // in-flight run out from under itself (phase-20-daemon-optional.md
    // "checkIdle").
    const active = this.sessionManager.activeSessionCount + this.operatorRunManager.activeRunCount;
    if (active > 0) {
      this.idleSince = undefined;
      return;
    }
    if (this.idleSince === undefined) {
      this.idleSince = Date.now();
      return;
    }
    if (Date.now() - this.idleSince >= this.options.idleTimeoutMs) {
      this.options.onIdleShutdown();
    }
  }

  private handleConnection(socket: Socket): void {
    const rl = createInterface({ input: socket, terminal: false });
    rl.on("line", (line) => {
      void this.handleLine(socket, line);
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      this.connectionContexts.delete(socket);
    });
  }

  private async handleLine(socket: Socket, rawLine: string): Promise<void> {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }

    const validated = DaemonJsonRpcLineSchema.safeParse(parsed);
    if (!validated.success) return;
    const line = validated.data;
    if (classifyDaemonJsonRpcLine(line) !== "request") return;

    const id = line.id as string | number;
    const method = line.method as string;

    try {
      const result = await this.dispatch(socket, method, line.params);
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
    } catch (err) {
      const daemonErr = toDaemonError(err);
      socket.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: { code: -32000, message: daemonErr.message, data: { code: daemonErr.code } },
        })}\n`,
      );
    }
  }

  private async dispatch(socket: Socket, method: string, rawParams: unknown): Promise<unknown> {
    if (!(method in DAEMON_METHOD_SCHEMAS)) {
      throw new DaemonError("INVALID_ARGS", `Unknown method "${method}"`);
    }
    const daemonMethod = method as DaemonMethod;
    const schemas = DAEMON_METHOD_SCHEMAS[daemonMethod];
    const params = schemas.params.parse(rawParams);

    switch (daemonMethod) {
      case "hello": {
        const req = params as DaemonMethodMap["hello"]["params"];
        // contracts/daemon-rpc.md "windowerHome split-brain detection": a
        // CLI/daemon pair that resolved WINDOWER_HOME independently (e.g.
        // only one had the env var set) must never silently serve
        // sessions/output from the wrong home directory.
        if (req.windowerHome !== this.options.windowerHome) {
          throw new DaemonError(
            "DAEMON_VERSION_MISMATCH",
            `windowerHome mismatch: client resolved "${req.windowerHome}", ` +
              `daemon resolved "${this.options.windowerHome}"`,
          );
        }
        this.connectionContexts.set(socket, buildRequestContext(req));
        return schemas.result.parse(this.identity());
      }
      case "daemon_info":
        // Read-only probe — no handshake, no env snapshot, no windowerHome
        // check (contracts/daemon-rpc.md).
        return schemas.result.parse(this.identity());
      case "list_targets":
        return schemas.result.parse(
          await this.passthrough.listTargets(params as DaemonMethodMap["list_targets"]["params"]),
        );
      case "check_permissions":
        return schemas.result.parse(await this.passthrough.checkPermissions());
      case "request_permission":
        return schemas.result.parse(
          await this.passthrough.requestPermission(
            params as DaemonMethodMap["request_permission"]["params"],
          ),
        );
      case "resize_window":
        return schemas.result.parse(
          await this.passthrough.resizeWindow(params as DaemonMethodMap["resize_window"]["params"]),
        );
      case "start_recording":
        return schemas.result.parse(
          await this.sessionManager.startRecording(
            params as DaemonMethodMap["start_recording"]["params"],
          ),
        );
      case "get_session":
        return schemas.result.parse(
          this.sessionManager.getSession(params as DaemonMethodMap["get_session"]["params"]),
        );
      case "stop_recording":
        return schemas.result.parse(
          await this.sessionManager.stopRecording(
            params as DaemonMethodMap["stop_recording"]["params"],
          ),
        );
      case "cancel_recording":
        return schemas.result.parse(
          await this.sessionManager.cancelRecording(
            params as DaemonMethodMap["cancel_recording"]["params"],
          ),
        );
      case "list_sessions":
        return schemas.result.parse(
          this.sessionManager.listSessions(params as DaemonMethodMap["list_sessions"]["params"]),
        );
      case "run_operator":
        return schemas.result.parse(
          await this.operatorRunManager.runOperator(
            params as DaemonMethodMap["run_operator"]["params"],
            this.connectionContexts.get(socket),
          ),
        );
      case "get_operator_run":
        return schemas.result.parse(
          this.operatorRunManager.getOperatorRun(
            params as DaemonMethodMap["get_operator_run"]["params"],
          ),
        );
      case "abort_operator_run":
        return schemas.result.parse(
          await this.operatorRunManager.abortOperatorRun(
            params as DaemonMethodMap["abort_operator_run"]["params"],
          ),
        );
      case "list_operator_runs":
        return schemas.result.parse(
          this.operatorRunManager.listOperatorRuns(
            params as DaemonMethodMap["list_operator_runs"]["params"],
          ),
        );
      case "shutdown": {
        const { mode } = params as DaemonMethodMap["shutdown"]["params"];
        const result = schemas.result.parse({ shuttingDown: true });
        // Defer until after `handleLine` has written this response to the
        // requesting client's socket — tearing the server down synchronously
        // here would race the write.
        queueMicrotask(() => {
          void this.shutdown(mode ?? "graceful").then(() => {
            this.options.onShutdownRequest?.();
          });
        });
        return result;
      }
      default:
        throw new DaemonError("INVALID_ARGS", `Unhandled method "${method}"`);
    }
  }
}
