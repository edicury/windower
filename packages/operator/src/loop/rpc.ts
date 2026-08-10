import type {
  LoopAbortParams,
  LoopPingResult,
  OperatorLoopChildMethod,
  OperatorLoopChildMethodMap,
} from "@windower/core";
import { OperatorError } from "../errors.js";

/**
 * The child half of contracts/operator-loop-protocol.md: JSON-RPC 2.0, one
 * object per line, over the process's own stdin/stdout. Identical framing to
 * contracts/sidecar-protocol.md — a second IPC shape would buy nothing.
 *
 * The channel is bidirectional. Each side numbers its own request ids and keeps
 * its own pending map, so a daemon `id: 1` and a child `id: 1` are unrelated.
 * Responses correlate by `id` alone; neither side may assume ordering.
 *
 * This module deliberately imports nothing that can reach a native binary. It
 * speaks to a stream pair it is handed, which is the whole point: the loop's
 * only route to the screen is a request outward.
 */

export interface LoopStreams {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}

export interface LoopPeerHandlers {
  /** `abort` push — the child tears down its model call immediately. */
  onAbort(params: LoopAbortParams): void;
  /** `ping` — liveness/wedge probe; pid liveness is not health. */
  onPing(): LoopPingResult;
  /** stdin EOF: the daemon is gone. Nobody left to `reportResult` to. */
  onEof(): void;
  onProtocolError?(message: string): void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
}

type JsonRpcId = number | string;

/** JSON-RPC error codes used on this channel; `data.code` carries the taxonomy. */
const METHOD_NOT_FOUND = -32601;

export class LoopRpcPeer {
  private readonly streams: LoopStreams;
  private readonly handlers: LoopPeerHandlers;
  private readonly pending = new Map<JsonRpcId, Pending>();
  private nextId = 1;
  private buffer = "";
  private closed = false;

  constructor(streams: LoopStreams, handlers: LoopPeerHandlers) {
    this.streams = streams;
    this.handlers = handlers;
    streams.input.setEncoding?.("utf8");
    streams.input.on("data", (chunk: string | Buffer) => this.onData(String(chunk)));
    streams.input.on("end", () => this.onEnd());
    streams.input.on("close", () => this.onEnd());
  }

  /** Sends a child → daemon request and resolves with its result. */
  request<M extends OperatorLoopChildMethod>(
    method: M,
    params: OperatorLoopChildMethodMap[M]["params"],
  ): Promise<OperatorLoopChildMethodMap[M]["result"]> {
    if (this.closed) {
      return Promise.reject(
        new OperatorError(
          "OPERATOR_LOOP_CHANNEL_CLOSED",
          `${method}: the daemon channel is closed.`,
        ),
      );
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.write({ jsonrpc: "2.0", id, method, params });
    }) as Promise<OperatorLoopChildMethodMap[M]["result"]>;
  }

  /** `log` is the one child → daemon notification. */
  notify(method: "log", params: unknown): void {
    if (this.closed) return;
    this.write({ jsonrpc: "2.0", method, params });
  }

  /** Rejects everything still in flight; used when the channel dies. */
  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, pending] of this.pending) {
      pending.reject(new OperatorError("OPERATOR_LOOP_CHANNEL_CLOSED", reason));
    }
    this.pending.clear();
  }

  private write(message: unknown): void {
    this.streams.output.write(`${JSON.stringify(message)}\n`);
  }

  private onEnd(): void {
    if (this.closed) return;
    this.close("The daemon closed the operator-loop channel.");
    this.handlers.onEof();
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length === 0) continue;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        this.handlers.onProtocolError?.(`Unparseable line from daemon: ${line.slice(0, 200)}`);
        continue;
      }
      // "A received message is a request if it has a `method` member, and a
      // response otherwise" — contracts/operator-loop-protocol.md §Transport.
      if (typeof message.method === "string") this.onInbound(message);
      else this.onResponse(message);
    }
  }

  private onInbound(message: Record<string, unknown>): void {
    const method = message.method as string;
    const id = message.id as JsonRpcId | undefined;
    if (method === "abort") {
      this.handlers.onAbort((message.params ?? { reason: "user" }) as LoopAbortParams);
      return;
    }
    if (method === "ping") {
      if (id !== undefined) this.write({ jsonrpc: "2.0", id, result: this.handlers.onPing() });
      return;
    }
    if (id !== undefined) {
      this.write({
        jsonrpc: "2.0",
        id,
        error: {
          code: METHOD_NOT_FOUND,
          message: `Unknown daemon → child method "${method}".`,
          data: { code: "LOOP_PROTOCOL_VIOLATION" },
        },
      });
    }
  }

  private onResponse(message: Record<string, unknown>): void {
    const id = message.id as JsonRpcId | undefined;
    if (id === undefined) return;
    const pending = this.pending.get(id);
    if (pending === undefined) return;
    this.pending.delete(id);
    const error = message.error as
      | { message?: string; data?: { code?: string } | null }
      | undefined;
    if (error !== undefined && error !== null) {
      // A routed error arrives verbatim, so the child cannot tell a proxied
      // call from a direct one — and `data.code` is what lets the loop classify
      // it as terminal or batch-aborting.
      pending.reject(
        new OperatorError(
          error.data?.code ?? "OPERATOR_LOOP_RPC_ERROR",
          error.message ?? "The daemon rejected the request.",
        ),
      );
      return;
    }
    pending.resolve(message.result);
  }
}
