import { PassThrough } from "node:stream";
import type {
  LoopAbortParams,
  LoopReadyResult,
  OperatorLoopChildMethod,
  OperatorLoopChildMethodMap,
} from "@windower/core";
import { LOOP_PROTOCOL_VERSION } from "@windower/core";
import type { LoopChildExit, LoopChildFactory, LoopChildHandle } from "../operator-loop-host.js";

/**
 * A fake **loop child** for the daemon-side half of
 * `contracts/operator-loop-protocol.md` — the mirror image of
 * `packages/operator/src/test-helpers/fake-loop-daemon.ts`, and the same spirit
 * as `packages/core/src/protocol/fake-sidecar.ts` one layer down: an in-memory
 * peer that speaks the wire so `OperatorLoopHost` can be driven end to end with
 * no child process, no sidecar, and no native binary anywhere.
 *
 * It is deliberately dumb and fully scriptable — a test drives it into
 * sequences a well-behaved child would never produce (a forged step index, a
 * nested `beginStep`, an action outside a step), which is how the daemon's
 * guardrails are shown to be *unbypassable* rather than merely unchallenged.
 *
 * Note what this fake cannot express: there is no recording-shaped method,
 * param, or identifier on this wire to script.
 */

export interface FakeLoopChildOptions {
  /** Answer `ping`? A wedged child does not. */
  answerPings?: boolean;
  /** Version asserted in `ready`. Not a negotiation — a mismatch fails the run. */
  loopProtocolVersion?: number;
  pid?: number;
}

export class FakeLoopChild implements LoopChildHandle {
  readonly pid: number | undefined;
  readonly stdin: NodeJS.WritableStream;
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr: NodeJS.ReadableStream;
  readonly exited: Promise<LoopChildExit>;

  /** Every `abort` the daemon pushed, in order. */
  readonly aborts: LoopAbortParams[] = [];
  /** Signals the daemon sent, in order. */
  readonly signals: Array<"SIGTERM" | "SIGKILL"> = [];
  /** `ping`s received. */
  pings = 0;

  private readonly toDaemon = new PassThrough();
  private readonly fromDaemon = new PassThrough();
  private readonly stderrStream = new PassThrough();
  private readonly options: FakeLoopChildOptions;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (err: unknown) => void }
  >();
  private resolveExit!: (exit: LoopChildExit) => void;
  private buffer = "";
  private nextId = 1;
  private dead = false;

  constructor(options: FakeLoopChildOptions = {}) {
    this.options = options;
    this.pid = options.pid ?? 4242;
    this.stdin = this.fromDaemon;
    this.stdout = this.toDaemon;
    this.stderr = this.stderrStream;
    this.exited = new Promise<LoopChildExit>((resolve) => {
      this.resolveExit = resolve;
    });
    this.fromDaemon.setEncoding("utf8");
    this.fromDaemon.on("data", (chunk: string) => this.onData(chunk));
  }

  /** Sends a child → daemon request; resolves with the result or rejects with `{ code }`. */
  request<M extends OperatorLoopChildMethod>(
    method: M,
    params: OperatorLoopChildMethodMap[M]["params"],
  ): Promise<OperatorLoopChildMethodMap[M]["result"]> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  /** The handshake. `ready` must be the child's first message. */
  handshake(): Promise<LoopReadyResult> {
    return this.request("ready", {
      loopProtocolVersion: this.options.loopProtocolVersion ?? LOOP_PROTOCOL_VERSION,
      pid: this.pid ?? 0,
    });
  }

  /** `log` — the one child → daemon notification. */
  log(message: string, level: "debug" | "info" | "warn" | "error" = "info"): void {
    this.write({ jsonrpc: "2.0", method: "log", params: { level, message } });
  }

  /** Free-form stderr; never protocol data. */
  writeStderr(line: string): void {
    this.stderrStream.write(`${line}\n`);
  }

  /** The child dies. `kill -9`, a non-zero exit, or a clean `0` — the caller picks. */
  exit(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    if (this.dead) return;
    this.dead = true;
    for (const [, pending] of this.pending) pending.reject(new Error("child exited"));
    this.pending.clear();
    this.toDaemon.end();
    this.resolveExit({ code, signal });
  }

  kill(signal: "SIGTERM" | "SIGKILL"): void {
    this.signals.push(signal);
    if (signal === "SIGKILL") this.exit(null, "SIGKILL");
  }

  private write(message: unknown): void {
    if (this.dead) return;
    this.toDaemon.write(`${JSON.stringify(message)}\n`);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length === 0) continue;
      const message = JSON.parse(line) as {
        id?: number;
        method?: string;
        params?: unknown;
        result?: unknown;
        error?: { message?: string; data?: { code?: string } };
      };
      if (typeof message.method === "string") {
        if (message.method === "abort") {
          this.aborts.push(message.params as LoopAbortParams);
          continue;
        }
        if (message.method === "ping") {
          this.pings += 1;
          if (this.options.answerPings !== false && message.id !== undefined) {
            this.write({
              jsonrpc: "2.0",
              id: message.id,
              result: { pong: true, stepIndex: 0, uptimeMs: 0 },
            });
          }
          continue;
        }
        continue;
      }
      if (message.id === undefined) continue;
      const pending = this.pending.get(message.id);
      if (pending === undefined) continue;
      this.pending.delete(message.id);
      if (message.error) {
        // A routed error arrives verbatim; `data.code` is the taxonomy.
        pending.reject(
          Object.assign(new Error(message.error.message ?? "rejected"), {
            code: message.error.data?.code ?? "INTERNAL_ERROR",
          }),
        );
        continue;
      }
      pending.resolve(message.result);
    }
  }
}

/** A `LoopChildFactory` yielding one `FakeLoopChild`, plus a handle on it. */
export function createFakeLoopChildFactory(options: FakeLoopChildOptions = {}): {
  spawn: LoopChildFactory;
  child: FakeLoopChild;
} {
  const child = new FakeLoopChild(options);
  return { spawn: () => child, child };
}
