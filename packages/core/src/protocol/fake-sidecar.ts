import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { Duplex, PassThrough } from "node:stream";
import type { CaptureTarget } from "../schemas/capture-target.js";
import { TimelineEventSchema } from "../schemas/event-timeline.js";
import type { TimelineEvent } from "../schemas/event-timeline.js";
import {
  type InputAction,
  type InputActionKind,
  inputActionCoordinates,
} from "../schemas/input-action.js";
import type { PermissionReport } from "../schemas/permissions.js";
import type { Rect } from "../schemas/rect.js";
import type { UIElement } from "../schemas/ui-element.js";
import type { SidecarErrorCode } from "./errors.js";
import { type JsonRpcId, JsonRpcLineSchema, classifyJsonRpcLine } from "./jsonrpc.js";
import {
  type Capability,
  type Platform,
  SIDECAR_METHOD_SCHEMAS,
  type SidecarMethod,
  type SidecarMethodMap,
  type SidecarNotificationMap,
  requiredCapabilityForInputAction,
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
  /**
   * Phase 19: the fake "displays" `performInput` bounds-checks against. Any
   * coordinate outside every rect here yields `INPUT_OUT_OF_BOUNDS`.
   */
  displayBounds?: Rect[];
  /**
   * Phase 19: action kinds this backend advertises but cannot synthesize —
   * requesting one yields `INPUT_UNSUPPORTED`. (Distinct from dropping
   * `input.mouse`/`input.keyboard` from `capabilities`, which yields
   * `UNSUPPORTED_CAPABILITY`.)
   */
  unsupportedInputKinds?: InputActionKind[];
  /**
   * Phase 22: the fixture `enumerateElements` serves for a fresh walk (no
   * `refs`). Seeds the fake's first "generation" — see `setElements` to
   * simulate a subsequent walk (e.g. after the target window moved), which
   * is what exercises `AX_ELEMENT_STALE` recovery in tests.
   */
  elements?: UIElement[];
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
  "input.mouse",
  "input.keyboard",
  "screenshot",
  "ui.elements",
];

const DEFAULT_DISPLAY_BOUNDS: Rect[] = [{ x: 0, y: 0, width: 1920, height: 1080 }];

/**
 * A real, minimal 1x1 PNG — `captureFrame` must return something that actually
 * base64-decodes to a valid image so consumers (and the operator loop's
 * vision pipeline) can be exercised end-to-end against the fake.
 */
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

export class FakeSidecar {
  private readonly stream: Duplex;
  private readonly platform: Platform;
  private readonly version: string;
  private readonly capabilities: Capability[];
  private readonly targets: CaptureTarget[];
  private readonly permissions: Partial<PermissionReport>;
  private readonly sessions = new Map<string, FakeSession>();
  private readonly displayBounds: Rect[];
  private readonly unsupportedInputKinds: Set<InputActionKind>;
  private readonly performedInputs: InputAction[] = [];
  private readonly capturedFrames: SidecarMethodMap["captureFrame"]["params"][] = [];
  /**
   * Phase 22 — `enumerateElements` fixture state. Mirrors the native backend's
   * "retain at most the two most recent generations" rule
   * (`ElementQuery.swift`): `elements`/`generation` are the current walk,
   * `previousElements`/`previousGeneration` the one before it. A `refs`
   * lookup against a ref that resolves in neither is `AX_ELEMENT_STALE`.
   */
  private elements: UIElement[];
  private generation: string;
  private previousElements: UIElement[] = [];
  private nextGeneration = 1;

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
    this.displayBounds = options.displayBounds ?? DEFAULT_DISPLAY_BOUNDS;
    this.unsupportedInputKinds = new Set(options.unsupportedInputKinds ?? []);
    this.elements = options.elements ?? [];
    this.generation = `gen-${this.nextGeneration++}`;

    const rl = createInterface({ input: stream, terminal: false });
    rl.on("line", (line) => this.handleLine(line));
  }

  /** Test hook: push an `event` notification as if it arrived during capture. */
  emitEvent(sessionId: string, event: TimelineEvent): void {
    // Parse so the `source` default ("user") is applied exactly as a real
    // sidecar's serialized event would be on the daemon side.
    this.sendNotification("event", { sessionId, event: TimelineEventSchema.parse(event) });
  }

  /**
   * Test hook: every `InputAction` this sidecar has performed, in order.
   * Actions from a call that threw are **not** recorded (the fake validates the
   * whole batch before performing any of it, same as a real backend's single
   * capability check per `performInput` call).
   */
  get performed(): readonly InputAction[] {
    return this.performedInputs;
  }

  /** Test hook: every `captureFrame` request this sidecar has served, in order. */
  get frameCaptures(): readonly SidecarMethodMap["captureFrame"]["params"][] {
    return this.capturedFrames;
  }

  /** Test hook: drop recorded `performInput`/`captureFrame` history. */
  clearRecordedCalls(): void {
    this.performedInputs.length = 0;
    this.capturedFrames.length = 0;
  }

  /**
   * Test hook (Phase 22): replaces the `enumerateElements` fixture, minting a
   * new generation and retaining the previous one — simulates a target window
   * moving/resizing/re-rendering between an observation and a later `refs`
   * re-resolve, which is what makes `AX_ELEMENT_STALE` recovery testable.
   */
  setElements(elements: UIElement[]): void {
    this.previousElements = this.elements;
    this.elements = elements;
    this.generation = `gen-${this.nextGeneration++}`;
  }

  /** Test hook: the current `enumerateElements` generation id. */
  get elementGeneration(): string {
    return this.generation;
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
      case "performInput":
        return this.performInput(params as SidecarMethodMap["performInput"]["params"]);
      case "captureFrame":
        return this.captureFrame(params as SidecarMethodMap["captureFrame"]["params"]);
      case "enumerateElements":
        return this.enumerateElements(params as SidecarMethodMap["enumerateElements"]["params"]);
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

  /**
   * `performInput` — validates the whole batch (permission → capability → kind
   * support → bounds) *before* performing any of it, so a rejected call is
   * atomic and leaves no partial input behind.
   */
  private performInput(
    params: SidecarMethodMap["performInput"]["params"],
  ): SidecarMethodMap["performInput"]["result"] {
    // CGEventPost-equivalents are gated on Accessibility on macOS; other
    // backends gate their own equivalent — the sidecar reports it through the
    // same `accessibility` field, so this stays platform-agnostic here.
    if (this.permissions.accessibility === "denied") {
      throw new FakeSidecarError("PERMISSION_DENIED", "Accessibility permission not granted");
    }
    if (params.sessionId !== undefined && !this.sessions.has(params.sessionId)) {
      throw new FakeSidecarError("SESSION_NOT_FOUND", `No session "${params.sessionId}"`);
    }

    for (const action of params.actions) {
      const capability = requiredCapabilityForInputAction(action.kind);
      if (capability && !this.hasCapability(capability)) {
        throw new FakeSidecarError(
          "UNSUPPORTED_CAPABILITY",
          `Backend does not support ${capability}`,
        );
      }
      if (this.unsupportedInputKinds.has(action.kind)) {
        throw new FakeSidecarError(
          "INPUT_UNSUPPORTED",
          `Backend cannot synthesize input kind "${action.kind}"`,
        );
      }
      for (const { x, y } of inputActionCoordinates(action)) {
        if (!this.isWithinAnyDisplay(x, y)) {
          throw new FakeSidecarError(
            "INPUT_OUT_OF_BOUNDS",
            `Coordinate (${x}, ${y}) is outside every known display`,
          );
        }
      }
    }

    this.performedInputs.push(...params.actions);
    return { performed: params.actions.length };
  }

  private isWithinAnyDisplay(x: number, y: number): boolean {
    return this.displayBounds.some(
      (b) => x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height,
    );
  }

  /**
   * `captureFrame` — returns a real (1x1) PNG so callers can base64-decode it.
   * Reported `width`/`height` follow the target's bounds, downscaled to
   * `maxWidth` when given, mirroring a real backend's contract; the pixel data
   * itself is deliberately trivial.
   */
  private captureFrame(
    params: SidecarMethodMap["captureFrame"]["params"],
  ): SidecarMethodMap["captureFrame"]["result"] {
    if (this.permissions.screenRecording === "denied") {
      throw new FakeSidecarError("PERMISSION_DENIED", "Screen Recording permission not granted");
    }
    if (!this.hasCapability("screenshot")) {
      throw new FakeSidecarError("UNSUPPORTED_CAPABILITY", "Backend does not support screenshot");
    }

    const { bounds } = params.target;
    const scale = params.target.kind === "display" ? params.target.scaleFactor : 1;
    let width = Math.max(1, Math.round(bounds.width));
    let height = Math.max(1, Math.round(bounds.height));
    if (params.maxWidth !== undefined && width > params.maxWidth) {
      const ratio = params.maxWidth / width;
      width = Math.max(1, Math.round(width * ratio));
      height = Math.max(1, Math.round(height * ratio));
    }

    this.capturedFrames.push(params);
    return { imageBase64: TINY_PNG_BASE64, width, height, scale };
  }

  /**
   * `enumerateElements` (Phase 22) — control-surface, capture-free. Serves
   * the injected fixture (`FakeSidecarOptions.elements` / `setElements`).
   * Gated on Accessibility, same as `performInput`/`resizeWindow`
   * (contracts/sidecar-protocol.md §Platform notes: same TCC grant,
   * no new permission kind).
   */
  private enumerateElements(
    params: SidecarMethodMap["enumerateElements"]["params"],
  ): SidecarMethodMap["enumerateElements"]["result"] {
    if (this.permissions.accessibility === "denied") {
      throw new FakeSidecarError("PERMISSION_DENIED", "Accessibility permission not granted");
    }
    if (!this.hasCapability("ui.elements")) {
      throw new FakeSidecarError("UNSUPPORTED_CAPABILITY", "Backend does not support ui.elements");
    }

    if (params.refs !== undefined) {
      const resolved: UIElement[] = [];
      for (const ref of params.refs) {
        const found =
          this.elements.find((e) => e.ref === ref) ??
          this.previousElements.find((e) => e.ref === ref);
        if (!found) {
          throw new FakeSidecarError(
            "AX_ELEMENT_STALE",
            `Element ref "${ref}" no longer resolves to a live element`,
          );
        }
        resolved.push(found);
      }
      return { elements: resolved, generation: this.generation, truncated: false };
    }

    const filter = params.filter ?? "interactable";
    let filtered =
      filter === "all"
        ? this.elements
        : this.elements.filter(
            (e) => (e.actions !== undefined && e.actions.length > 0) || Boolean(e.label),
          );

    const maxElements = params.maxElements ?? 200;
    let truncated = false;
    if (filtered.length > maxElements) {
      filtered = filtered.slice(0, maxElements);
      truncated = true;
    }

    return { elements: filtered, generation: this.generation, truncated };
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
