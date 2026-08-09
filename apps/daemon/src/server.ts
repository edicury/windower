import { chmod, mkdir, unlink } from "node:fs/promises";
import { type Server, type Socket, createServer } from "node:net";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import {
  DAEMON_METHOD_SCHEMAS,
  DaemonError,
  DaemonJsonRpcLineSchema,
  type DaemonMethod,
  type DaemonMethodMap,
  classifyDaemonJsonRpcLine,
} from "@windower/core";
import { ZodError } from "zod";
import type { PassthroughService } from "./passthrough.js";
import type { SessionManager } from "./session-manager.js";

export interface DaemonServerOptions {
  socketPath: string;
  idleTimeoutMs: number;
  /** Called once the daemon has been idle (zero active sessions) for `idleTimeoutMs`. */
  onIdleShutdown: () => void;
  /** How often to check idle state. Default 10s; overridable so tests don't wait real minutes. */
  idleCheckIntervalMs?: number;
  /**
   * Called when a client invokes the `shutdown` RPC method, after the
   * success response has already been written to that client's socket.
   * Defaults to `stop()` alone (closes the socket, unlinks the file) if not
   * given — callers that also want the process to exit (the real `bin.ts`
   * entrypoint) should pass a callback that does so, mirroring
   * `onIdleShutdown`.
   */
  onShutdownRequest?: () => void;
}

function toDaemonError(err: unknown): DaemonError {
  if (err instanceof DaemonError) return err;
  if (err instanceof ZodError) return new DaemonError("INVALID_ARGS", err.message);
  return new DaemonError("INTERNAL_ERROR", err instanceof Error ? err.message : String(err));
}

/**
 * Unix-domain-socket JSON-RPC 2.0 server (`~/.windower/daemon.sock`, `0600`
 * perms) implementing contracts/mcp-tools.md's operations. Dispatches
 * session-lifecycle methods to `SessionManager` and the sidecar-passthrough
 * ones to `PassthroughService`.
 */
export class DaemonServer {
  private readonly sessionManager: SessionManager;
  private readonly passthrough: PassthroughService;
  private readonly options: DaemonServerOptions;
  private server: Server | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private idleSince: number | undefined;

  constructor(
    sessionManager: SessionManager,
    passthrough: PassthroughService,
    options: DaemonServerOptions,
  ) {
    this.sessionManager = sessionManager;
    this.passthrough = passthrough;
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

    this.idleSince = Date.now();
    this.idleTimer = setInterval(
      () => this.checkIdle(),
      this.options.idleCheckIntervalMs ?? 10_000,
    );
    this.idleTimer.unref();
  }

  async stop(): Promise<void> {
    if (this.idleTimer) clearInterval(this.idleTimer);
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
    await unlink(this.options.socketPath).catch(() => {});
  }

  private checkIdle(): void {
    if (this.sessionManager.activeSessionCount > 0) {
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
      const result = await this.dispatch(method, line.params);
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

  private async dispatch(method: string, rawParams: unknown): Promise<unknown> {
    if (!(method in DAEMON_METHOD_SCHEMAS)) {
      throw new DaemonError("INVALID_ARGS", `Unknown method "${method}"`);
    }
    const daemonMethod = method as DaemonMethod;
    const schemas = DAEMON_METHOD_SCHEMAS[daemonMethod];
    const params = schemas.params.parse(rawParams);

    switch (daemonMethod) {
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
      case "shutdown": {
        const result = schemas.result.parse({ shuttingDown: true });
        // Defer until after `handleLine` has written this response to the
        // requesting client's socket — tearing the server down synchronously
        // here would race the write.
        queueMicrotask(() => {
          const onShutdownRequest = this.options.onShutdownRequest ?? (() => void this.stop());
          onShutdownRequest();
        });
        return result;
      }
      default:
        throw new DaemonError("INVALID_ARGS", `Unhandled method "${method}"`);
    }
  }
}
