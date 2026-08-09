import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { Duplex, PassThrough } from "node:stream";
import type { CaptureTarget } from "../schemas/capture-target.js";
import type { TimelineEvent } from "../schemas/event-timeline.js";
import type { PermissionReport } from "../schemas/permissions.js";
import type { SidecarErrorCode } from "./errors.js";
import { type JsonRpcId, JsonRpcLineSchema, classifyJsonRpcLine } from "./jsonrpc.js";
import {
  type Capability,
  type Platform,
  SIDECAR_METHOD_SCHEMAS,
  type SidecarMethod,
  type SidecarMethodMap,
  type SidecarNotificationMap,
} from "./methods.js";
import { SidecarClient } from "./sidecar-client.js";

/**
 * In-memory, TypeScript-only fake sidecar used purely to unit-test
 * `SidecarClient` (see contracts/sidecar-protocol.md). It implements the
 * exact same wire protocol a real native sidecar would (newline-delimited
 * JSON-RPC 2.0), but backed by in-memory state instead of a real capture
 * backend — no child process, no macOS APIs.
 */

/** Joins two one-directional PassThrough pipes into a single Duplex end. */
function pairedDuplex(incoming: PassThrough, outgoing: PassThrough): Duplex {
  const duplex = new Duplex({
    read() {
      // Data is pushed from the `incoming` listener below; nothing to
      // pull on demand here.
    },
    write(chunk, encoding, callback) {
      outgoing.write(chunk, encoding, callback);
    },
    final(callback) {
      outgoing.end();
      callback();
    },
  });
  incoming.on("data", (chunk: Buffer) => {
    if (!duplex.push(chunk)) {
      incoming.pause();
    }
  });
  duplex.on("drain", () => incoming.resume());
  incoming.on("end", () => duplex.push(null));
  return duplex;
}

/** Creates a connected pair of Duplex streams — one for each side of the wire. */
export function createInMemorySidecarChannel(): { daemonSide: Duplex; sidecarSide: Duplex } {
  const daemonToSidecar = new PassThrough();
  const sidecarToDaemon = new PassThrough();
  const daemonSide = pairedDuplex(sidecarToDaemon, daemonToSidecar);
  const sidecarSide = pairedDuplex(daemonToSidecar, sidecarToDaemon);
  return { daemonSide, sidecarSide };
}

export interface FakeSidecarOptions {
  platform?: Platform;
  version?: string;
  capabilities?: Capability[];
  targets?: CaptureTarget[];
  permissions?: Partial<PermissionReport>;
}

interface FakeSession {
  sessionId: string;
  target: CaptureTarget;
  startedAt: number;
}

const DEFAULT_CAPABILITIES: Capability[] = [
  "enumerate.displays",
  "enumerate.windows",
  "enumerate.apps",
  "window-control",
  "capture.display",
  "capture.window",
  "capture.region",
  "audio.system",
  "audio.microphone",
  "cursor.visible",
  "eventTimeline.cursor",
  "eventTimeline.mouse",
  "eventTimeline.keyboard",
];

export class FakeSidecar {
  private readonly stream: Duplex;
  private readonly platform: Platform;
  private readonly version: string;
  private readonly capabilities: Capability[];
  private readonly targets: CaptureTarget[];
  private readonly permissions: Partial<PermissionReport>;
  private readonly sessions = new Map<string, FakeSession>();

  constructor(stream: Duplex, options: FakeSidecarOptions = {}) {
    this.stream = stream;
    this.platform = options.platform ?? "macos";
    this.version = options.version ?? "0.0.0-fake";
    this.capabilities = options.capabilities ?? DEFAULT_CAPABILITIES;
    this.targets = options.targets ?? [];
    this.permissions = options.permissions ?? {
      screenRecording: "granted",
      accessibility: "granted",
      microphone: "granted",
      daemonRunning: true,
      sidecarAvailable: true,
    };

    const rl = createInterface({ input: stream, terminal: false });
    rl.on("line", (line) => this.handleLine(line));
  }

  /** Test hook: push an `event` notification as if it arrived during capture. */
  emitEvent(sessionId: string, event: TimelineEvent): void {
    this.sendNotification("event", { sessionId, event });
  }

  emitLog(payload: SidecarNotificationMap["log"]): void {
    this.sendNotification("log", payload);
  }

  emitCaptureEnded(sessionId: string, reason: "target-closed" | "error"): void {
    this.sessions.delete(sessionId);
    this.sendNotification("captureEnded", { sessionId, reason });
  }

  dispose(): void {
    this.stream.end();
  }

  private hasCapability(capability: Capability): boolean {
    return this.capabilities.includes(capability);
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

    const validated = JsonRpcLineSchema.safeParse(parsed);
    if (!validated.success) return;
    const line = validated.data;
    if (classifyJsonRpcLine(line) !== "request") return;

    const id = line.id as JsonRpcId;
    const method = line.method as string;

    if (!this.isKnownMethod(method)) {
      this.sendError(id, "UNSUPPORTED_CAPABILITY", `Unknown method "${method}"`);
      return;
    }

    try {
      const result = this.dispatch(method, line.params);
      this.sendResult(id, method, result);
    } catch (err) {
      if (err instanceof FakeSidecarError) {
        this.sendError(id, err.code, err.message);
        return;
      }
      this.sendError(id, "INTERNAL_ERROR", (err as Error).message);
    }
  }

  private isKnownMethod(method: string): method is SidecarMethod {
    return method in SIDECAR_METHOD_SCHEMAS;
  }

  private dispatch(method: SidecarMethod, rawParams: unknown): unknown {
    const params = SIDECAR_METHOD_SCHEMAS[method].params.parse(rawParams);
    switch (method) {
      case "describe":
        return this.describe();
      case "enumerateTargets":
        return this.enumerateTargets(params as SidecarMethodMap["enumerateTargets"]["params"]);
      case "getPermissions":
        return this.getPermissions();
      case "requestPermission":
        return this.requestPermission(params as SidecarMethodMap["requestPermission"]["params"]);
      case "resizeWindow":
        return this.resizeWindow(params as SidecarMethodMap["resizeWindow"]["params"]);
      case "startCapture":
        return this.startCapture(params as SidecarMethodMap["startCapture"]["params"]);
      case "stopCapture":
        return this.stopCapture(params as SidecarMethodMap["stopCapture"]["params"]);
      case "cancelCapture":
        return this.cancelCapture(params as SidecarMethodMap["cancelCapture"]["params"]);
      default:
        throw new FakeSidecarError("UNSUPPORTED_CAPABILITY", `Unhandled method "${method}"`);
    }
  }

  private describe(): SidecarMethodMap["describe"]["result"] {
    return { platform: this.platform, version: this.version, capabilities: this.capabilities };
  }

  private enumerateTargets(
    params: SidecarMethodMap["enumerateTargets"]["params"],
  ): SidecarMethodMap["enumerateTargets"]["result"] {
    const kinds = params.kinds;
    // `kinds` filters over ("display"|"window") only — "region" targets have no
    // independent ID (data-model.md) and only ever appear when `kinds` is omitted.
    const targets = kinds
      ? this.targets
          .filter((t) => t.kind === "display" || t.kind === "window")
          .filter((t) => kinds.includes(t.kind))
      : this.targets;
    return { targets };
  }

  private getPermissions(): SidecarMethodMap["getPermissions"]["result"] {
    return this.permissions;
  }

  private requestPermission(
    params: SidecarMethodMap["requestPermission"]["params"],
  ): SidecarMethodMap["requestPermission"]["result"] {
    const status = this.permissions[params.kind];
    return { status: status ?? "granted" };
  }

  private resizeWindow(
    params: SidecarMethodMap["resizeWindow"]["params"],
  ): SidecarMethodMap["resizeWindow"]["result"] {
    // window-control is gated on Accessibility (AX) permission on macOS —
    // see CLAUDE.md's units/permissions notes and contracts/sidecar-protocol.md.
    if (this.permissions.accessibility === "denied") {
      throw new FakeSidecarError("PERMISSION_DENIED", "Accessibility permission not granted");
    }
    if (!this.hasCapability("window-control")) {
      throw new FakeSidecarError("RESIZE_UNSUPPORTED", "Backend does not support window-control");
    }
    const target = this.targets.find((t) => "id" in t && t.id === params.targetId);
    if (!target) {
      throw new FakeSidecarError("TARGET_NOT_FOUND", `No target with id "${params.targetId}"`);
    }
    return { actualBounds: params.bounds, result: "success" };
  }

  private startCapture(
    params: SidecarMethodMap["startCapture"]["params"],
  ): SidecarMethodMap["startCapture"]["result"] {
    // Screen Recording permission gates any capture at all.
    if (this.permissions.screenRecording === "denied") {
      throw new FakeSidecarError("PERMISSION_DENIED", "Screen Recording permission not granted");
    }
    const requiredCapability =
      params.target.kind === "display"
        ? "capture.display"
        : params.target.kind === "window"
          ? "capture.window"
          : "capture.region";
    if (!this.hasCapability(requiredCapability)) {
      throw new FakeSidecarError(
        "UNSUPPORTED_CAPABILITY",
        `Backend does not support ${requiredCapability}`,
      );
    }
    // Microphone permission only matters if this capture actually requests
    // a microphone track — matches phase-5-audio.md's `AudioPermissionGate`
    // fail-fast-before-any-capture-resource behavior.
    const wantsMicrophone = params.audio.tracks.some(
      (track) => track.source === "microphone" && track.enabled,
    );
    if (wantsMicrophone && this.permissions.microphone === "denied") {
      throw new FakeSidecarError("PERMISSION_DENIED", "Microphone permission not granted");
    }
    this.sessions.set(params.sessionId, {
      sessionId: params.sessionId,
      target: params.target,
      startedAt: Date.now(),
    });
    return { started: true };
  }

  private stopCapture(
    params: SidecarMethodMap["stopCapture"]["params"],
  ): SidecarMethodMap["stopCapture"]["result"] {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw new FakeSidecarError("SESSION_NOT_FOUND", `No session "${params.sessionId}"`);
    }
    this.sessions.delete(params.sessionId);
    // Real sidecars always write a real file to their own temp location
    // (contracts/sidecar-protocol.md — the sidecar is never told an output
    // path) before returning `outputFilePath`; the fake mirrors that so the
    // daemon's real `rename()` into the configured output dir has something
    // real to move, instead of the daemon needing a test-only fallback.
    const outputFilePath = join(tmpdir(), "fake-sidecar", `${params.sessionId}.mov`);
    mkdirSync(dirname(outputFilePath), { recursive: true });
    writeFileSync(outputFilePath, "fake-mov-data");
    return {
      outputFilePath,
      actualDurationMs: Date.now() - session.startedAt,
      actualResolution: { width: 1920, height: 1080 },
    };
  }

  private cancelCapture(
    params: SidecarMethodMap["cancelCapture"]["params"],
  ): SidecarMethodMap["cancelCapture"]["result"] {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw new FakeSidecarError("SESSION_NOT_FOUND", `No session "${params.sessionId}"`);
    }
    this.sessions.delete(params.sessionId);
    return { canceled: true };
  }

  private sendResult(id: JsonRpcId, method: SidecarMethod, result: unknown): void {
    const validated = SIDECAR_METHOD_SCHEMAS[method].result.parse(result);
    this.write({ jsonrpc: "2.0", id, result: validated });
  }

  private sendError(id: JsonRpcId, code: SidecarErrorCode, message: string): void {
    this.write({
      jsonrpc: "2.0",
      id,
      error: { code: -32000, message, data: { code } },
    });
  }

  private sendNotification<N extends keyof SidecarNotificationMap>(
    method: N,
    params: SidecarNotificationMap[N],
  ): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private write(message: unknown): void {
    this.stream.write(`${JSON.stringify(message)}\n`);
  }
}

class FakeSidecarError extends Error {
  constructor(
    readonly code: SidecarErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "FakeSidecarError";
  }
}

/** Convenience: wires a SidecarClient to a fresh in-memory FakeSidecar. */
export function createFakeSidecarPair(options: FakeSidecarOptions = {}): {
  client: SidecarClient;
  sidecar: FakeSidecar;
  dispose: () => void;
} {
  const { daemonSide, sidecarSide } = createInMemorySidecarChannel();
  const sidecar = new FakeSidecar(sidecarSide, options);
  const client = new SidecarClient(daemonSide);
  return {
    client,
    sidecar,
    dispose: () => {
      client.dispose();
      sidecar.dispose();
    },
  };
}
