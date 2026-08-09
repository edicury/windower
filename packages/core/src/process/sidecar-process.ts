import { type ChildProcessByStdio, spawn } from "node:child_process";
import { Duplex } from "node:stream";
import type { Readable, Writable } from "node:stream";
import { SidecarClient } from "../protocol/sidecar-client.js";
import { resolveSidecarBinaryPath } from "./sidecar-path.js";

/** How long to wait after SIGTERM before escalating to SIGKILL. */
const DEFAULT_KILL_TIMEOUT_MS = 3000;

export interface SpawnSidecarOptions {
  /** Explicit binary path; defaults to `resolveSidecarBinaryPath()`. */
  binaryPath?: string;
  /** Args passed to the sidecar binary. Empty by default (contract defines none for MVP). */
  args?: string[];
  /** Forwarded to `child_process.spawn`'s `env`; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Called with each stderr line (free-form logs per the protocol, never parsed). */
  onStderrLine?: (line: string) => void;
  /** Called once if the child exits — whether cleanly or not. */
  onExit?: (info: { code: number | null; signal: NodeJS.Signals | null }) => void;
  /** Milliseconds to wait after SIGTERM before SIGKILL. Default 3000. */
  killTimeoutMs?: number;
}

/**
 * Wraps a spawned native sidecar child process: owns its stdio transport,
 * exposes a `SidecarClient` bound to that transport, and provides clean
 * termination (SIGTERM, escalating to SIGKILL) plus in-flight-request
 * rejection if the process dies unexpectedly.
 *
 * One instance per active `RecordingSession` per contracts/sidecar-protocol.md
 * ("Transport" — daemon owns the sidecar's lifecycle, spawned on
 * `startCapture`, terminated after `stopCapture`/`cancelCapture`). This class
 * is the low-level primitive Phase 6's daemon session lifecycle wires up to
 * that pattern; it does not itself know about sessions.
 */
export class SidecarProcess {
  readonly client: SidecarClient;
  private readonly child: ChildProcessByStdio<Writable, Readable, Readable>;
  private readonly transport: Duplex;
  private readonly killTimeoutMs: number;
  private exited = false;
  private killTimer: NodeJS.Timeout | undefined;
  /**
   * Resolves once the child has definitively stopped — via either "exit"
   * (the normal case) or "error" (e.g. `spawn()` failing on a nonexistent
   * binary path, which Node reports as "error" WITHOUT ever following up
   * with "exit"). `terminate()` awaits this instead of `child`'s "exit"
   * event directly, so a spawn failure doesn't hang it forever — this was a
   * real bug: `windower doctor` probing a bad `WINDOWER_SIDECAR_BINARY_PATH`
   * would spawn, get "error", and then hang indefinitely in its `finally {
   * await handle.terminate() }` cleanup, since `exited` was never set and
   * "exit" was never coming.
   */
  private readonly settled: Promise<void>;

  private constructor(
    child: ChildProcessByStdio<Writable, Readable, Readable>,
    options: SpawnSidecarOptions,
  ) {
    this.child = child;
    this.killTimeoutMs = options.killTimeoutMs ?? DEFAULT_KILL_TIMEOUT_MS;

    const transport = Duplex.from({ readable: child.stdout, writable: child.stdin });
    // Once the child exits we deliberately force-destroy this transport (see
    // the "exit" handler below) so SidecarClient's pending-request rejection
    // fires promptly. That can race with the underlying stdio pipes already
    // tearing down (child process gone) and surface as an AbortError from
    // the internal duplexify plumbing — harmless, but left unhandled it
    // would crash the process. We've already gotten what we need (the
    // pending-request rejection) by the time this fires, so swallow it.
    transport.on("error", () => {});
    this.transport = transport;
    this.client = new SidecarClient(transport);

    let stderrBuffer = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrBuffer += chunk;
      const lines = stderrBuffer.split("\n");
      stderrBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.length > 0) options.onStderrLine?.(line);
      }
    });

    let resolveSettled: () => void = () => {};
    this.settled = new Promise((resolve) => {
      resolveSettled = resolve;
    });

    child.once("exit", (code, signal) => {
      this.exited = true;
      if (this.killTimer) {
        clearTimeout(this.killTimer);
        this.killTimer = undefined;
      }
      options.onExit?.({ code, signal });
      // Force the transport closed so SidecarClient's own "close" handler
      // rejects any in-flight requests — don't rely on stdout's "end"/"close"
      // reliably propagating through the Duplex.from() wrapper.
      this.transport.destroy();
      resolveSettled();
    });

    child.once("error", (err) => {
      // A spawn-time failure (e.g. ENOENT on a bad binary path) — Node
      // reports this via "error" only, never "exit", so this must settle
      // the process on its own rather than waiting for an "exit" that will
      // never come (see `settled`'s doc).
      this.exited = true;
      if (this.killTimer) {
        clearTimeout(this.killTimer);
        this.killTimer = undefined;
      }
      options.onStderrLine?.(`sidecar process error: ${err.message}`);
      this.transport.destroy();
      resolveSettled();
    });
  }

  /** Spawns the sidecar binary and returns a `SidecarProcess` wrapping it. */
  static spawn(options: SpawnSidecarOptions = {}): SidecarProcess {
    const binaryPath = options.binaryPath ?? resolveSidecarBinaryPath();
    const child = spawn(binaryPath, options.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: options.env ?? process.env,
    }) as ChildProcessByStdio<Writable, Readable, Readable>;
    return new SidecarProcess(child, options);
  }

  /** The OS process id, or `undefined` if the child failed to spawn. */
  get pid(): number | undefined {
    return this.child.pid;
  }

  /** Whether the child process has already exited. */
  get hasExited(): boolean {
    return this.exited;
  }

  /**
   * Terminates the child process cleanly: SIGTERM first, escalating to
   * SIGKILL after `killTimeoutMs` if it hasn't exited by then. Resolves once
   * the process has actually exited. Also disposes the `SidecarClient`,
   * rejecting any in-flight requests.
   */
  async terminate(): Promise<void> {
    if (this.exited) {
      this.client.dispose();
      return;
    }

    this.child.kill("SIGTERM");
    this.killTimer = setTimeout(() => {
      if (!this.exited) {
        this.child.kill("SIGKILL");
      }
    }, this.killTimeoutMs);

    // `settled` resolves on either "exit" (normal case) or "error" (e.g. a
    // spawn-time ENOENT, which never follows up with "exit") — see its doc.
    await this.settled;
    this.client.dispose();
  }
}

/** Convenience functional wrapper around `SidecarProcess.spawn`. */
export function spawnSidecar(options: SpawnSidecarOptions = {}): SidecarProcess {
  return SidecarProcess.spawn(options);
}
