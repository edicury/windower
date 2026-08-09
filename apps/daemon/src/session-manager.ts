import { randomUUID } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import {
  type AudioSettings,
  AudioSettingsSchema,
  type CaptureTarget,
  DaemonError,
  type DaemonMethodMap,
  type OutputManifest,
  type RecordingSession,
  type SidecarClient,
  SidecarError,
  type SpawnSidecarOptions,
  type VideoSettings,
  VideoSettingsSchema,
} from "@windower/core";
import { EventTimelineWriter } from "./event-timeline-writer.js";
import type { SessionStore } from "./session-store.js";

/** Placeholder until Phase 14 wires a real package-version read (manifest.json's `windowerVersion` field). */
const WINDOWER_VERSION = "0.1.0";

const DEFAULT_VIDEO_SETTINGS: VideoSettings = {
  fps: 30,
  codec: "h264",
  container: "mp4",
  quality: "high",
  showCursor: true,
};

const DEFAULT_AUDIO_SETTINGS: AudioSettings = {
  tracks: [],
  separateTracks: false,
};

/**
 * The minimal shape `SessionManager` needs from a spawned sidecar — matches
 * `@windower/core`'s real `SidecarProcess`, but kept as an interface so
 * tests can inject a handle backed by `createFakeSidecarPair` instead of a
 * real child process.
 */
export interface SidecarHandle {
  readonly client: SidecarClient;
  terminate(): Promise<void>;
}

export type SidecarFactory = (options: SpawnSidecarOptions) => SidecarHandle;

export interface SessionManagerOptions {
  store: SessionStore;
  spawnSidecar: SidecarFactory;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Identifies "the same recordable thing" for the concurrency policy (phase-6 task file). */
function targetKey(target: CaptureTarget): string {
  switch (target.kind) {
    case "display":
      return `display:${target.id}`;
    case "window":
      return `window:${target.id}`;
    case "region":
      return `region:${target.displayId}:${target.bounds.x},${target.bounds.y},${target.bounds.width},${target.bounds.height}`;
  }
}

function manifestPathFor(outputPath: string): string {
  const ext = extname(outputPath);
  return join(dirname(outputPath), `${basename(outputPath, ext)}.manifest.json`);
}

function eventsPathFor(outputPath: string): string {
  const ext = extname(outputPath);
  return join(dirname(outputPath), `${basename(outputPath, ext)}.events.json`);
}

function toDaemonError(err: unknown): DaemonError {
  if (err instanceof DaemonError) return err;
  if (err instanceof SidecarError) return new DaemonError(err.code, err.message);
  return new DaemonError("INTERNAL_ERROR", err instanceof Error ? err.message : String(err));
}

/**
 * Owns the `RecordingSession` state machine (`pending -> recording ->
 * stopping -> finalized|canceled|failed`, see data-model.md) and the
 * one-sidecar-process-per-active-session lifecycle. Persists every
 * transition via `SessionStore`.
 */
export class SessionManager {
  private readonly store: SessionStore;
  private readonly spawnSidecar: SidecarFactory;
  private readonly activeSidecars = new Map<string, SidecarHandle>();
  private readonly activeTargetKeys = new Map<string, string>();
  private readonly eventWriters = new Map<string, EventTimelineWriter>();
  private readonly eventCapabilities = new Map<string, { keystrokes: boolean }>();

  constructor(options: SessionManagerOptions) {
    this.store = options.store;
    this.spawnSidecar = options.spawnSidecar;
  }

  get activeSessionCount(): number {
    return this.activeSidecars.size;
  }

  /**
   * Scans loaded sessions for ones stuck in `recording`/`stopping` from a
   * previous (crashed) daemon instance and marks them `failed`. Call once at
   * startup, after `SessionStore.load()`.
   */
  async recoverCrashedSessions(): Promise<void> {
    for (const session of this.store.list()) {
      if (session.state === "recording" || session.state === "stopping") {
        await this.store.save({
          ...session,
          state: "failed",
          stoppedAt: nowIso(),
          error: {
            code: "INTERNAL_ERROR",
            message: "Daemon restarted while this session was active; marked failed.",
          },
        });
      }
    }
  }

  async startRecording(
    params: DaemonMethodMap["start_recording"]["params"],
  ): Promise<DaemonMethodMap["start_recording"]["result"]> {
    const target = await this.resolveTarget(params.target);
    const key = targetKey(target);
    if (this.activeTargetKeys.has(key)) {
      throw new DaemonError(
        "TARGET_ALREADY_RECORDING",
        `Target "${key}" already has an active recording`,
      );
    }

    const video = VideoSettingsSchema.parse({ ...DEFAULT_VIDEO_SETTINGS, ...params.video });
    const audio = AudioSettingsSchema.parse({ ...DEFAULT_AUDIO_SETTINGS, ...params.audio });

    const sessionId = randomUUID();
    let session: RecordingSession = {
      id: sessionId,
      state: "pending",
      target,
      video,
      audio,
      startedAt: nowIso(),
    };
    await this.store.save(session);
    this.activeTargetKeys.set(key, sessionId);

    const handle = this.spawnSidecar({
      onExit: (info) => {
        void this.handleSidecarExit(sessionId, info);
      },
    });

    const writer = new EventTimelineWriter(sessionId);
    this.eventWriters.set(sessionId, writer);

    try {
      const describeResult = await handle.client.describe();
      const requiredCapability =
        target.kind === "display"
          ? "capture.display"
          : target.kind === "window"
            ? "capture.window"
            : "capture.region";
      if (!describeResult.capabilities.includes(requiredCapability)) {
        throw new DaemonError(
          "UNSUPPORTED_CAPABILITY",
          `Sidecar does not advertise "${requiredCapability}"`,
        );
      }
      const eventCapabilities = {
        keystrokes: describeResult.capabilities.includes("eventTimeline.keyboard"),
      };
      this.eventCapabilities.set(sessionId, eventCapabilities);
      handle.client.on("event", (payload) => {
        void writer.append(payload.event);
      });
      await handle.client.startCapture({ sessionId, target, video, audio });
    } catch (err) {
      this.activeTargetKeys.delete(key);
      await handle.terminate().catch(() => {});
      await this.discardEventWriter(sessionId);
      const daemonErr = toDaemonError(err);
      session = {
        ...session,
        state: "failed",
        stoppedAt: nowIso(),
        error: { code: daemonErr.code, message: daemonErr.message },
      };
      await this.store.save(session);
      throw daemonErr;
    }

    this.activeSidecars.set(sessionId, handle);
    handle.client.once("captureEnded", (payload) => {
      void this.handleCaptureEnded(sessionId, payload.reason);
    });

    session = { ...session, state: "recording" };
    await this.store.save(session);
    return { sessionId };
  }

  async stopRecording(
    params: DaemonMethodMap["stop_recording"]["params"],
  ): Promise<DaemonMethodMap["stop_recording"]["result"]> {
    const session = this.requireSession(params.sessionId);
    const handle = this.activeSidecars.get(session.id);
    if (session.state !== "recording" || !handle) {
      throw new DaemonError(
        "INVALID_ARGS",
        `Session "${session.id}" is not recording (state: "${session.state}")`,
      );
    }

    await this.store.save({ ...session, state: "stopping" });

    let result: {
      outputFilePath: string;
      actualDurationMs: number;
      actualResolution: { width: number; height: number };
    };
    try {
      result = await handle.client.stopCapture({ sessionId: session.id });
    } catch (err) {
      await this.failSession(session.id, toDaemonError(err));
      throw err;
    } finally {
      await handle.terminate().catch(() => {});
      this.cleanupActive(session.id, session.target);
    }

    const outputPath = result.outputFilePath;
    const manifestPath = manifestPathFor(outputPath);
    const fileSize = await stat(outputPath)
      .then((s) => s.size)
      .catch(() => 0);

    const writer = this.eventWriters.get(session.id);
    const capabilities = this.eventCapabilities.get(session.id) ?? { keystrokes: false };
    let eventTimelinePath: string | undefined;
    if (writer) {
      const candidatePath = eventsPathFor(outputPath);
      try {
        await writer.finalize(candidatePath, capabilities);
        eventTimelinePath = candidatePath;
      } catch {
        // A bad/corrupt events file shouldn't fail an otherwise-successful
        // recording — log and continue without an eventTimelinePath.
      }
      this.eventWriters.delete(session.id);
      this.eventCapabilities.delete(session.id);
    }

    const manifest: OutputManifest = {
      windowerVersion: WINDOWER_VERSION,
      sessionId: session.id,
      target: session.target,
      video: {
        ...session.video,
        actualResolution: result.actualResolution,
        durationMs: result.actualDurationMs,
      },
      audio: {
        tracks: session.audio.tracks.map((track, index) => ({
          source: track.source,
          trackIndex: index,
        })),
      },
      createdAt: nowIso(),
      file: {
        path: outputPath,
        sizeBytes: fileSize,
        codec: session.video.codec,
        container: session.video.container,
      },
      ...(eventTimelinePath ? { eventTimelinePath } : {}),
    };
    await mkdir(dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    await this.store.save({
      ...session,
      state: "finalized",
      stoppedAt: nowIso(),
      outputPath,
      manifestPath,
      ...(eventTimelinePath ? { eventTimelinePath } : {}),
    });

    return {
      outputPath,
      manifestPath,
      manifest,
      ...(eventTimelinePath ? { eventTimelinePath } : {}),
    };
  }

  async cancelRecording(
    params: DaemonMethodMap["cancel_recording"]["params"],
  ): Promise<DaemonMethodMap["cancel_recording"]["result"]> {
    const session = this.requireSession(params.sessionId);
    if (
      session.state !== "pending" &&
      session.state !== "recording" &&
      session.state !== "stopping"
    ) {
      throw new DaemonError(
        "INVALID_ARGS",
        `Session "${session.id}" cannot be canceled from state "${session.state}"`,
      );
    }

    const handle = this.activeSidecars.get(session.id);
    if (handle) {
      await handle.client.cancelCapture({ sessionId: session.id }).catch(() => {});
      await handle.terminate().catch(() => {});
    }
    this.cleanupActive(session.id, session.target);
    await this.discardEventWriter(session.id);

    await this.store.save({ ...session, state: "canceled", stoppedAt: nowIso() });
    return { canceled: true };
  }

  getSession(
    params: DaemonMethodMap["get_session"]["params"],
  ): DaemonMethodMap["get_session"]["result"] {
    return this.requireSession(params.sessionId);
  }

  listSessions(
    params: DaemonMethodMap["list_sessions"]["params"],
  ): DaemonMethodMap["list_sessions"]["result"] {
    return { sessions: this.store.list(params.state) };
  }

  private async handleCaptureEnded(
    sessionId: string,
    reason: "target-closed" | "error",
  ): Promise<void> {
    const session = this.store.get(sessionId);
    if (!session || session.state !== "recording") return; // already stopped/canceled via the normal path
    const handle = this.activeSidecars.get(sessionId);
    this.cleanupActive(sessionId, session.target);
    await handle?.terminate().catch(() => {});
    await this.discardEventWriter(sessionId);
    await this.failSession(
      sessionId,
      new DaemonError("CAPTURE_FAILED", `Sidecar-initiated stop: ${reason}`),
    );
  }

  private async handleSidecarExit(
    sessionId: string,
    info: { code: number | null; signal: NodeJS.Signals | null },
  ): Promise<void> {
    const session = this.store.get(sessionId);
    if (!session || session.state !== "recording") return; // expected exit from our own terminate()
    this.cleanupActive(sessionId, session.target);
    await this.discardEventWriter(sessionId);
    await this.failSession(
      sessionId,
      new DaemonError(
        "CAPTURE_FAILED",
        `Sidecar process exited unexpectedly (code=${info.code}, signal=${info.signal})`,
      ),
    );
  }

  private async failSession(sessionId: string, err: DaemonError): Promise<void> {
    const session = this.store.get(sessionId);
    if (!session) return;
    await this.store.save({
      ...session,
      state: "failed",
      stoppedAt: nowIso(),
      error: { code: err.code, message: err.message },
    });
  }

  private cleanupActive(sessionId: string, target: CaptureTarget): void {
    this.activeSidecars.delete(sessionId);
    this.activeTargetKeys.delete(targetKey(target));
  }

  private async discardEventWriter(sessionId: string): Promise<void> {
    const writer = this.eventWriters.get(sessionId);
    this.eventWriters.delete(sessionId);
    this.eventCapabilities.delete(sessionId);
    if (writer) await writer.discard().catch(() => {});
  }

  private requireSession(sessionId: string): RecordingSession {
    const session = this.store.get(sessionId);
    if (!session) throw new DaemonError("SESSION_NOT_FOUND", `No session "${sessionId}"`);
    return session;
  }

  private async resolveTarget(
    target: DaemonMethodMap["start_recording"]["params"]["target"],
  ): Promise<CaptureTarget> {
    if ("kind" in target) return target;

    const handle = this.spawnSidecar({});
    try {
      const { targets } = await handle.client.enumerateTargets({});
      const found = targets.find((t) => "id" in t && t.id === target.targetId);
      if (!found) {
        throw new DaemonError("TARGET_NOT_FOUND", `No target with id "${target.targetId}"`);
      }
      return found;
    } finally {
      await handle.terminate().catch(() => {});
    }
  }
}
