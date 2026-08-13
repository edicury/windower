import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import type { Duplex } from "node:stream";
import type { JsonRpcId } from "../protocol/jsonrpc.js";
import { DaemonError } from "./errors.js";
import { DaemonJsonRpcLineSchema, classifyDaemonJsonRpcLine } from "./jsonrpc.js";
import type { DaemonJsonRpcErrorObject } from "./jsonrpc.js";
import {
  DAEMON_METHOD_SCHEMAS,
  type DaemonErrorCode,
  type DaemonMethod,
  type DaemonMethodMap,
} from "./methods.js";

interface PendingCall {
  method: DaemonMethod;
  resolve: (result: unknown) => void;
  reject: (err: unknown) => void;
}

/**
 * Client for the daemon RPC protocol (`~/.windower/daemon.sock`, JSON-RPC
 * 2.0, newline-delimited — same framing style as `SidecarClient`). Used by
 * the CLI and MCP server; both are thin wrappers over this.
 */
export class DaemonClient {
  private readonly stream: Duplex;
  private readonly emitter = new EventEmitter();
  private readonly pending = new Map<JsonRpcId, PendingCall>();
  private nextId = 1;
  private disposed = false;

  constructor(stream: Duplex) {
    this.stream = stream;
    const rl = createInterface({ input: stream, terminal: false });
    rl.on("line", (line) => this.handleLine(line));
    // See SidecarClient's identical listener for why this is needed: an
    // abruptly torn-down transport (e.g. a socket that never fully
    // connected) can surface as an AbortError readline re-emits on this
    // Interface, which otherwise crashes the process as an unhandled
    // "error" event. The pending-request rejection already happens via
    // `stream`'s "close" handler below.
    rl.on("error", () => {});
    this.stream.once("close", () => {
      this.disposed = true;
      rl.close();
      this.rejectAllPending(new DaemonError("DAEMON_UNREACHABLE", "Daemon connection closed"));
    });
  }

  listTargets(
    params: DaemonMethodMap["list_targets"]["params"] = {},
  ): Promise<DaemonMethodMap["list_targets"]["result"]> {
    return this.call("list_targets", params);
  }

  checkPermissions(): Promise<DaemonMethodMap["check_permissions"]["result"]> {
    return this.call("check_permissions", {});
  }

  requestPermission(
    params: DaemonMethodMap["request_permission"]["params"],
  ): Promise<DaemonMethodMap["request_permission"]["result"]> {
    return this.call("request_permission", params);
  }

  resizeWindow(
    params: DaemonMethodMap["resize_window"]["params"],
  ): Promise<DaemonMethodMap["resize_window"]["result"]> {
    return this.call("resize_window", params);
  }

  startRecording(
    params: DaemonMethodMap["start_recording"]["params"],
  ): Promise<DaemonMethodMap["start_recording"]["result"]> {
    return this.call("start_recording", params);
  }

  getSession(
    params: DaemonMethodMap["get_session"]["params"],
  ): Promise<DaemonMethodMap["get_session"]["result"]> {
    return this.call("get_session", params);
  }

  stopRecording(
    params: DaemonMethodMap["stop_recording"]["params"],
  ): Promise<DaemonMethodMap["stop_recording"]["result"]> {
    return this.call("stop_recording", params);
  }

  cancelRecording(
    params: DaemonMethodMap["cancel_recording"]["params"],
  ): Promise<DaemonMethodMap["cancel_recording"]["result"]> {
    return this.call("cancel_recording", params);
  }

  listSessions(
    params: DaemonMethodMap["list_sessions"]["params"] = {},
  ): Promise<DaemonMethodMap["list_sessions"]["result"]> {
    return this.call("list_sessions", params);
  }

  /** Asks a running daemon to close its socket and exit. See methods.ts's `shutdown` note. */
  shutdown(
    params: DaemonMethodMap["shutdown"]["params"] = {},
  ): Promise<DaemonMethodMap["shutdown"]["result"]> {
    return this.call("shutdown", params);
  }

  /**
   * Phase 20 version handshake. Sent once per connection by
   * `ensureDaemonRunning` before any other RPC — see
   * `contracts/daemon-rpc.md`'s `hello`.
   */
  hello(params: DaemonMethodMap["hello"]["params"]): Promise<DaemonMethodMap["hello"]["result"]> {
    return this.call("hello", params);
  }

  /**
   * Read-only daemon identity probe — no handshake, no env snapshot, no
   * side effects. Used by `windower doctor`.
   */
  daemonInfo(): Promise<DaemonMethodMap["daemon_info"]["result"]> {
    return this.call("daemon_info", {});
  }

  /**
   * Whether this client's underlying transport has been closed (explicitly
   * via `dispose()`, or because the daemon process died / the socket
   * closed). Once true, every call rejects with `DAEMON_UNREACHABLE` and the
   * client can never recover — callers that memoize a `DaemonClient` (e.g.
   * the MCP server) should check this and reconnect rather than keep
   * returning a dead client.
   */
  get isDisposed(): boolean {
    return this.disposed;
  }

  /** Closes the underlying transport and rejects any in-flight calls. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.rejectAllPending(new DaemonError("DAEMON_UNREACHABLE", "DaemonClient disposed"));
    this.emitter.removeAllListeners();
    this.stream.destroy();
  }

  private async call<M extends DaemonMethod>(
    method: M,
    params: DaemonMethodMap[M]["params"],
  ): Promise<DaemonMethodMap[M]["result"]> {
    if (this.disposed) {
      throw new DaemonError("DAEMON_UNREACHABLE", "DaemonClient is disposed");
    }
    const id = this.nextId++;
    const schemas = DAEMON_METHOD_SCHEMAS[method];
    const parsedParams = schemas.params.parse(params);

    const resultPromise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
    });

    const line = JSON.stringify({ jsonrpc: "2.0", id, method, params: parsedParams });
    this.stream.write(`${line}\n`);

    const rawResult = await resultPromise;
    return schemas.result.parse(rawResult) as DaemonMethodMap[M]["result"];
  }

  private handleLine(rawLine: string): void {
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
    if (classifyDaemonJsonRpcLine(line) !== "response") return;
    this.handleResponse(line.id as JsonRpcId, line.result, line.error);
  }

  private handleResponse(
    id: JsonRpcId,
    result: unknown,
    error: DaemonJsonRpcErrorObject | undefined,
  ): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);

    if (error) {
      const code = (error.data?.code as DaemonErrorCode | undefined) ?? "INTERNAL_ERROR";
      entry.reject(new DaemonError(code, error.message));
      return;
    }
    entry.resolve(result);
  }

  private rejectAllPending(err: unknown): void {
    for (const entry of this.pending.values()) {
      entry.reject(err);
    }
    this.pending.clear();
  }
}
