import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import type { Duplex } from "node:stream";
import { SidecarError } from "./errors.js";
import {
  type JsonRpcErrorObject,
  type JsonRpcId,
  JsonRpcLineSchema,
  classifyJsonRpcLine,
} from "./jsonrpc.js";
import {
  SIDECAR_METHOD_SCHEMAS,
  SIDECAR_NOTIFICATIONS,
  SIDECAR_NOTIFICATION_SCHEMAS,
  type SidecarMethod,
  type SidecarMethodMap,
  type SidecarNotificationMap,
  type SidecarNotificationMethod,
} from "./methods.js";

interface PendingCall {
  method: SidecarMethod;
  resolve: (result: unknown) => void;
  reject: (err: unknown) => void;
}

type NotificationListener<N extends SidecarNotificationMethod> = (
  payload: SidecarNotificationMap[N],
) => void;

/**
 * Transport-agnostic client for the sidecar JSON-RPC protocol
 * (contracts/sidecar-protocol.md). Speaks newline-delimited JSON over any
 * Node `Duplex` — a real child process's stdio, or an in-memory
 * `PassThrough` pair in tests (see `fake-sidecar.ts`).
 *
 * This class plays the "daemon" role: it sends requests and receives
 * responses/notifications. It never has to know which OS's sidecar is on
 * the other end — see CLAUDE.md "protocol before platform".
 */
export class SidecarClient {
  private readonly stream: Duplex;
  private readonly emitter = new EventEmitter();
  private readonly pending = new Map<JsonRpcId, PendingCall>();
  private nextId = 1;
  private disposed = false;

  constructor(stream: Duplex) {
    this.stream = stream;
    const rl = createInterface({ input: stream, terminal: false });
    rl.on("line", (line) => this.handleLine(line));
    // A transport torn down abruptly (e.g. the child process's stdio never
    // came up at all — spawn() failed on a nonexistent binary path) can
    // surface as an internal duplex/AbortError that readline re-emits on
    // this Interface. `SidecarProcess` already swallows the equivalent
    // event on `transport` itself for the same reason (see its comment);
    // without a listener here too, readline's own EventEmitter throws an
    // unhandled "error" and crashes the whole process. The pending-request
    // rejection this client needs already happens via `stream`'s "close"
    // handler below, so this is purely to prevent the crash.
    rl.on("error", () => {});
    this.stream.once("close", () => {
      this.disposed = true;
      rl.close();
      this.rejectAllPending(new SidecarError("INTERNAL_ERROR", "Sidecar stream closed", -32000));
    });
  }

  /** Subscribe to an inbound notification (`event`, `log`, `captureEnded`). */
  on<N extends SidecarNotificationMethod>(
    notification: N,
    listener: NotificationListener<N>,
  ): this {
    this.emitter.on(notification, listener as (...args: unknown[]) => void);
    return this;
  }

  off<N extends SidecarNotificationMethod>(
    notification: N,
    listener: NotificationListener<N>,
  ): this {
    this.emitter.off(notification, listener as (...args: unknown[]) => void);
    return this;
  }

  once<N extends SidecarNotificationMethod>(
    notification: N,
    listener: NotificationListener<N>,
  ): this {
    this.emitter.once(notification, listener as (...args: unknown[]) => void);
    return this;
  }

  describe(): Promise<SidecarMethodMap["describe"]["result"]> {
    return this.call("describe", {});
  }

  enumerateTargets(
    params: SidecarMethodMap["enumerateTargets"]["params"] = {},
  ): Promise<SidecarMethodMap["enumerateTargets"]["result"]> {
    return this.call("enumerateTargets", params);
  }

  getPermissions(): Promise<SidecarMethodMap["getPermissions"]["result"]> {
    return this.call("getPermissions", {});
  }

  requestPermission(
    params: SidecarMethodMap["requestPermission"]["params"],
  ): Promise<SidecarMethodMap["requestPermission"]["result"]> {
    return this.call("requestPermission", params);
  }

  resizeWindow(
    params: SidecarMethodMap["resizeWindow"]["params"],
  ): Promise<SidecarMethodMap["resizeWindow"]["result"]> {
    return this.call("resizeWindow", params);
  }

  startCapture(
    params: SidecarMethodMap["startCapture"]["params"],
  ): Promise<SidecarMethodMap["startCapture"]["result"]> {
    return this.call("startCapture", params);
  }

  stopCapture(
    params: SidecarMethodMap["stopCapture"]["params"],
  ): Promise<SidecarMethodMap["stopCapture"]["result"]> {
    return this.call("stopCapture", params);
  }

  cancelCapture(
    params: SidecarMethodMap["cancelCapture"]["params"],
  ): Promise<SidecarMethodMap["cancelCapture"]["result"]> {
    return this.call("cancelCapture", params);
  }

  /**
   * Phase 19 — synthesizes a batch of input actions. Requires `input.mouse` /
   * `input.keyboard` per action `kind` (contracts/sidecar-protocol.md).
   */
  performInput(
    params: SidecarMethodMap["performInput"]["params"],
  ): Promise<SidecarMethodMap["performInput"]["result"]> {
    return this.call("performInput", params);
  }

  /** Phase 19 — one-shot screenshot of a target. Requires `screenshot`. */
  captureFrame(
    params: SidecarMethodMap["captureFrame"]["params"],
  ): Promise<SidecarMethodMap["captureFrame"]["result"]> {
    return this.call("captureFrame", params);
  }

  /** Closes the underlying transport and rejects any in-flight calls. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.rejectAllPending(new SidecarError("INTERNAL_ERROR", "SidecarClient disposed", -32000));
    this.emitter.removeAllListeners();
  }

  private async call<M extends SidecarMethod>(
    method: M,
    params: SidecarMethodMap[M]["params"],
  ): Promise<SidecarMethodMap[M]["result"]> {
    if (this.disposed) {
      throw new SidecarError("INTERNAL_ERROR", "SidecarClient is disposed", -32000);
    }
    const id = this.nextId++;
    const schemas = SIDECAR_METHOD_SCHEMAS[method];
    const parsedParams = schemas.params.parse(params);

    const resultPromise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
    });

    const line = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params: parsedParams,
    });
    this.stream.write(`${line}\n`);

    const rawResult = await resultPromise;
    return schemas.result.parse(rawResult) as SidecarMethodMap[M]["result"];
  }

  private handleLine(rawLine: string): void {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      this.emitter.emit("log", {
        level: "error",
        message: `Failed to parse sidecar line as JSON: ${(err as Error).message}`,
      } satisfies SidecarNotificationMap["log"]);
      return;
    }

    const validated = JsonRpcLineSchema.safeParse(parsed);
    if (!validated.success) {
      this.emitter.emit("log", {
        level: "error",
        message: `Received malformed JSON-RPC line: ${validated.error.message}`,
      } satisfies SidecarNotificationMap["log"]);
      return;
    }

    const line = validated.data;
    const kind = classifyJsonRpcLine(line);

    switch (kind) {
      case "response":
        this.handleResponse(line.id as JsonRpcId, line.result, line.error);
        return;
      case "notification":
        this.handleNotification(line.method as string, line.params);
        return;
      case "request":
        // This client only plays the daemon (caller) role; the sidecar
        // never sends us requests in the current protocol.
        this.emitter.emit("log", {
          level: "warn",
          message: `SidecarClient received an unexpected inbound request: ${line.method}`,
        } satisfies SidecarNotificationMap["log"]);
        return;
      default:
        this.emitter.emit("log", {
          level: "warn",
          message: "Received JSON-RPC line that is neither request, notification, nor response",
        } satisfies SidecarNotificationMap["log"]);
    }
  }

  private handleResponse(
    id: JsonRpcId,
    result: unknown,
    error: JsonRpcErrorObject | undefined,
  ): void {
    const entry = this.pending.get(id);
    if (!entry) {
      this.emitter.emit("log", {
        level: "warn",
        message: `Received response for unknown request id ${String(id)}`,
      } satisfies SidecarNotificationMap["log"]);
      return;
    }
    this.pending.delete(id);

    if (error) {
      const code = error.data?.code ?? "INTERNAL_ERROR";
      entry.reject(new SidecarError(code, error.message, error.code));
      return;
    }
    entry.resolve(result);
  }

  private handleNotification(method: string, params: unknown): void {
    if (!(SIDECAR_NOTIFICATIONS as readonly string[]).includes(method)) {
      this.emitter.emit("log", {
        level: "warn",
        message: `Received notification for unknown method ${method}`,
      } satisfies SidecarNotificationMap["log"]);
      return;
    }
    const notification = method as SidecarNotificationMethod;
    const schema = SIDECAR_NOTIFICATION_SCHEMAS[notification];
    const result = schema.safeParse(params);
    if (!result.success) {
      this.emitter.emit("log", {
        level: "error",
        message: `Notification "${method}" failed schema validation: ${result.error.message}`,
      } satisfies SidecarNotificationMap["log"]);
      return;
    }
    this.emitter.emit(notification, result.data);
  }

  private rejectAllPending(err: unknown): void {
    for (const entry of this.pending.values()) {
      entry.reject(err);
    }
    this.pending.clear();
  }
}
