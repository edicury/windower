import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import {
  type AudioSettings,
  AudioSettingsSchema,
  type CaptureTarget,
  DaemonError,
  type DaemonMethodMap,
  EXPECTED_SIDECAR_VERSION,
  type OutputManifest,
  type RecordingSession,
  type SidecarClient,
  SidecarError,
  type SpawnSidecarOptions,
  type VideoSettings,
  VideoSettingsSchema,
  packageVersion,
  readConfig,
} from "@windower/core";
import { EventTimelineWriter } from "./event-timeline-writer.js";
import {
  buildManifest,
  eventsPathFor,
  finalizeOutputFile,
  manifestPathFor,
  writeManifest,
} from "./manifest.js";
import {
  ensureWritableOutputDir,
  resolveFilenameTemplate,
  resolveUniqueOutputPath,
} from "./output-resolver.js";
import type { SessionStore } from "./session-store.js";

/**
 * Type-only references to `@windower/engine-narration`'s exports —
 * `typeof import(...)` is erased at compile time, so this does NOT trigger
 * a runtime import (and thus never resolves that package's `ffmpeg-static`
 * dependency) just by this file being loaded. `@windower/engine-narration`
 * is declared only as a `devDependency` below (see `package.json`), used
 * solely for these type queries — this package has NO runtime dependency
 * on it or on `ffmpeg-static`. `RecordingEngine` never imports the real
 * `muxNarration`/`validateNarrationFile` itself; callers that need
 * narration muxing (`apps/daemon`, the only host that runs narration-muxed
 * recordings — see `apps/daemon/src/main.ts`) import
 * `@windower/engine-narration` themselves and inject the real
 * implementations via `RecordingEngineOptions`. This is what keeps
 * `@windower/mcp-server` (which depends on `@windower/engine` for
 * `LocalWindower` but never mux/validates narration) from resolving the
 * ~70MB `ffmpeg-static` binary at all — see `index.ts`'s top-of-file
 * comment.
 */
type MuxNarrationFn = typeof import("@windower/engine-narration").muxNarration;
type ValidateNarrationFileFn = typeof import("@windower/engine-narration").validateNarrationFile;

/** This package's own version, read from its `package.json` — used for `OutputManifest.windowerVersion`. */
const WINDOWER_VERSION = packageVersion(import.meta.url);

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
 * The minimal shape `RecordingEngine` needs from a spawned sidecar — matches
 * `@windower/core`'s real `SidecarProcess`, but kept as an interface so
 * tests can inject a handle backed by `createFakeSidecarPair` instead of a
 * real child process.
 */
export interface SidecarHandle {
  readonly client: SidecarClient;
  terminate(): Promise<void>;
  /**
   * OS process id, when known — real sidecars (`SidecarProcess`) expose this;
   * fake ones in tests may leave it `undefined`. Used only by the
   * `process.on("exit")` synchronous SIGKILL sweep (`sigkillActiveSidecars`
   * below, `bin.ts`) — everything else goes through `terminate()`.
   */
  readonly pid?: number;
}

export type SidecarFactory = (options: SpawnSidecarOptions) => SidecarHandle;

/**
 * Cross-process guard against two recordings capturing the same target
 * simultaneously (`phase-20-daemon-optional.md` "Cross-process safety").
 * `RecordingEngine` depends only on this seam, not a concrete
 * implementation, so the real file-lock-backed `TargetLock`
 * (`packages/engine/src/target-lock.ts`, `~/.windower/locks/target-<sha1(targetKey)>.lock`
 * holding `{sessionId, pid, startedAt, targetKey}`, stale-stolen when the
 * owner pid is dead) can be dropped in as `RecordingEngineOptions.targetLock`
 * without touching this file again. Defaults to `InMemoryTargetLock`, an
 * in-process-only guard equivalent to the `activeTargetKeys` map this
 * replaces — sufficient for a single `RecordingEngine` instance (e.g. tests,
 * or a `record --duration` CLI process that never shares a target with
 * another process), but not a substitute for the real cross-process lock a
 * daemon needs.
 */
export interface TargetLockOwner {
  sessionId: string;
  pid: number;
  startedAt: string;
}

/** Thrown by `TargetLock.acquire` when another owner already holds `targetKey`. */
export class TargetLockConflictError extends Error {
  readonly owner: TargetLockOwner;

  constructor(owner: TargetLockOwner) {
    super(
      `Target already has an active recording (owned by session "${owner.sessionId}", pid ${owner.pid})`,
    );
    this.name = "TargetLockConflictError";
    this.owner = owner;
  }
}

export interface TargetLock {
  /** Throws `TargetLockConflictError` if `targetKey` is already held by a different owner. */
  acquire(targetKey: string, owner: TargetLockOwner): Promise<void>;
  release(targetKey: string): Promise<void>;
}

/**
 * Default `TargetLock` — a same-process `Map`, functionally identical to the
 * `activeTargetKeys` guard this replaces. Real cross-process protection
 * requires the file-lock-backed `TargetLock` from `target-lock.ts`.
 */
export class InMemoryTargetLock implements TargetLock {
  private readonly held = new Map<string, TargetLockOwner>();

  async acquire(targetKey: string, owner: TargetLockOwner): Promise<void> {
    const existing = this.held.get(targetKey);
    if (existing) throw new TargetLockConflictError(existing);
    this.held.set(targetKey, owner);
  }

  async release(targetKey: string): Promise<void> {
    this.held.delete(targetKey);
  }
}

export interface RecordingEngineOptions {
  store: SessionStore;
  spawnSidecar: SidecarFactory;
  /**
   * Injectable — tests pass a fake; `apps/daemon` (`main.ts`) passes the
   * real `@windower/engine-narration` implementation. Deliberately has NO
   * default: this package must never import `@windower/engine-narration`
   * (or its `ffmpeg-static` dependency) at runtime — see `MuxNarrationFn`'s
   * doc comment above. A caller that omits this and then requests
   * `stopRecording` with a `narration` param gets a clear `INTERNAL_ERROR`
   * (`requireValidateNarrationFile` below) instead of a real mux happening.
   */
  validateNarrationFile?: ValidateNarrationFileFn;
  /**
   * Injectable — tests pass a fake; `apps/daemon` (`main.ts`) passes the
   * real `@windower/engine-narration` implementation. Deliberately has NO
   * default — see `validateNarrationFile`'s doc comment above.
   */
  muxNarration?: MuxNarrationFn;
  /** Injectable — defaults to `InMemoryTargetLock`. A daemon should pass the real file-lock-backed `TargetLock`. */
  targetLock?: TargetLock;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Approximates this process's start time — `process.uptime()` (seconds since
 * start) subtracted from wall-clock now. Used only for `RecordingSession.owner.startedAt`
 * (data-model.md), which disambiguates a dead pid from a live unrelated
 * process that reused it; a session-creation timestamp wouldn't do that job
 * since it drifts from the actual process start on a long-lived daemon.
 */
function processStartedAtIso(): string {
  return new Date(Date.now() - process.uptime() * 1000).toISOString();
}

/** Identifies "the same recordable thing" for the concurrency policy (phase-6 task file). */
export function targetKey(target: CaptureTarget): string {
  switch (target.kind) {
    case "display":
      return `display:${target.id}`;
    case "window":
      return `window:${target.id}`;
    case "region":
      return `region:${target.displayId}:${target.bounds.x},${target.bounds.y},${target.bounds.width},${target.bounds.height}`;
  }
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
 *
 * One `RecordingEngine` instance per active host process — a long-lived
 * daemon and a short-lived `record --duration` CLI process each hold their
 * own instance for their own lifetime (`phase-20-daemon-optional.md`,
 * "Extract `@windower/engine`"). Its `activeSidecars`/`eventWriters`/
 * `plannedOutputPaths`/`operatorRunPaths` maps are per-instance and are not
 * shared cross-process — only the injected `TargetLock` is.
 */
export class RecordingEngine {
  private readonly store: SessionStore;
  private readonly spawnSidecar: SidecarFactory;
  private readonly validateNarrationFileFn: ValidateNarrationFileFn | undefined;
  private readonly muxNarrationFn: MuxNarrationFn | undefined;
  private readonly targetLock: TargetLock;
  private readonly activeSidecars = new Map<string, SidecarHandle>();
  private readonly eventWriters = new Map<string, EventTimelineWriter>();
  private readonly eventCapabilities = new Map<string, { keystrokes: boolean }>();
  /** Final destination (in the configured output dir) planned at `start`, moved to at `stop` — see output-resolver.ts. */
  private readonly plannedOutputPaths = new Map<string, string>();
  /** Phase 19: `<recording>.operator.json` for operator-driven sessions, surfaced as `OutputManifest.operatorRunPath`. */
  private readonly operatorRunPaths = new Map<string, string>();

  constructor(options: RecordingEngineOptions) {
    this.store = options.store;
    this.spawnSidecar = options.spawnSidecar;
    this.validateNarrationFileFn = options.validateNarrationFile;
    this.muxNarrationFn = options.muxNarration;
    this.targetLock = options.targetLock ?? new InMemoryTargetLock();
  }

  /**
   * Returns the injected `validateNarrationFile`, or throws `INTERNAL_ERROR`
   * if the host constructed this `RecordingEngine` without one — see
   * `RecordingEngineOptions.validateNarrationFile`'s doc comment. Only
   * reached when `stopRecording` is actually called with a `narration`
   * param, so hosts that never pass narration (e.g. `LocalWindower`,
   * `operate.ts`'s `RecordingEngine`) are unaffected by omitting it.
   */
  private requireValidateNarrationFile(): ValidateNarrationFileFn {
    if (!this.validateNarrationFileFn) {
      throw new DaemonError(
        "INTERNAL_ERROR",
        "This RecordingEngine was constructed without a validateNarrationFile implementation — narration muxing is unavailable in this process.",
      );
    }
    return this.validateNarrationFileFn;
  }

  /**
   * Returns the injected `muxNarration`, or throws `INTERNAL_ERROR` if the
   * host constructed this `RecordingEngine` without one — see
   * `RecordingEngineOptions.muxNarration`'s doc comment.
   */
  private requireMuxNarration(): MuxNarrationFn {
    if (!this.muxNarrationFn) {
      throw new DaemonError(
        "INTERNAL_ERROR",
        "This RecordingEngine was constructed without a muxNarration implementation — narration muxing is unavailable in this process.",
      );
    }
    return this.muxNarrationFn;
  }

  get activeSessionCount(): number {
    return this.activeSidecars.size;
  }

  /**
   * Best-effort, synchronous SIGKILL sweep over every active sidecar child
   * process — for `process.on("exit")` (`bin.ts`), which cannot await the
   * graceful SIGTERM-then-SIGKILL `terminate()` normally uses. Only reached
   * on a hard/unexpected process exit; the graceful shutdown path
   * (`DaemonServer.shutdown`) always calls `stopRecording`/`terminate()`
   * properly first, per `phase-20-daemon-optional.md` "Graceful shutdown".
   */
  sigkillActiveSidecars(): void {
    for (const handle of this.activeSidecars.values()) {
      if (handle.pid !== undefined) {
        try {
          process.kill(handle.pid, "SIGKILL");
        } catch {
          // Already dead — nothing to do.
        }
      }
    }
  }

  /**
   * The sidecar client owned by an active session. Phase 19's
   * `OperatorRunEngine` drives `performInput`/`captureFrame` through the very
   * same process that is recording, so synthesized input lands inside the
   * capture rather than in a second, unrelated sidecar.
   */
  getSidecarClient(sessionId: string): SidecarClient | undefined {
    return this.activeSidecars.get(sessionId)?.client;
  }

  /**
   * Where this session's video will land at `stop`. Phase 19 derives
   * `<recording>.operator.json` from it at run start, before the file exists.
   */
  getPlannedOutputPath(sessionId: string): string | undefined {
    return this.plannedOutputPaths.get(sessionId);
  }

  /**
   * Links an operator transcript into this session's `OutputManifest` as
   * `operatorRunPath` (contracts/operator.md §Transcript format). Recorded
   * here rather than passed to `stopRecording`, since `stop_recording`'s
   * params are frozen in contracts/mcp-tools.md.
   */
  setOperatorRunPath(sessionId: string, operatorRunPath: string): void {
    this.operatorRunPaths.set(sessionId, operatorRunPath);
  }

  /**
   * Scans loaded sessions for ones stuck in `recording`/`stopping` from a
   * previous (crashed) daemon instance and marks them `failed`. Call once at
   * startup, after `SessionStore.load()`. Daemon-only — see
   * `RecordingEngine`'s class doc and `phase-20-daemon-optional.md`: running
   * this from a daemon-free CLI would kill a concurrently-running daemon's
   * live recording.
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
    const sessionId = randomUUID();

    try {
      await this.targetLock.acquire(key, {
        sessionId,
        pid: process.pid,
        startedAt: nowIso(),
      });
    } catch (err) {
      if (err instanceof TargetLockConflictError) {
        throw new DaemonError("TARGET_ALREADY_RECORDING", err.message);
      }
      throw err;
    }

    try {
      return await this.startRecordingLocked(sessionId, target, key, params);
    } catch (err) {
      await this.targetLock.release(key);
      throw err;
    }
  }

  private async startRecordingLocked(
    sessionId: string,
    target: CaptureTarget,
    key: string,
    params: DaemonMethodMap["start_recording"]["params"],
  ): Promise<DaemonMethodMap["start_recording"]["result"]> {
    const config = await readConfig();
    const video = VideoSettingsSchema.parse({
      ...DEFAULT_VIDEO_SETTINGS,
      ...config.defaultVideo,
      ...params.video,
    });
    const audio = AudioSettingsSchema.parse({
      ...DEFAULT_AUDIO_SETTINGS,
      ...config.defaultAudio,
      ...params.audio,
    });

    // Pre-flight: resolve + validate the output location before any
    // session/sidecar state exists, so a bad outputDir fails immediately at
    // `start` (see phase-12 exit criteria) rather than after the recording
    // completes.
    const outputDir = params.outputDir ?? config.outputDir;
    await ensureWritableOutputDir(outputDir);
    const baseFilename = resolveFilenameTemplate(config.filenameTemplate, {
      target,
      sessionId,
      timestamp: new Date(),
    });
    const ext = `.${video.container}`;
    const plannedOutputPath = await resolveUniqueOutputPath(outputDir, baseFilename, ext);
    this.plannedOutputPaths.set(sessionId, plannedOutputPath);

    let session: RecordingSession = {
      id: sessionId,
      state: "pending",
      target,
      video,
      audio,
      startedAt: nowIso(),
      // Phase 20: stamps the creating process's identity — see
      // data-model.md §RecordingSession `owner`, whose `startedAt` is the
      // *owner process's* start time (not the session's), used to
      // disambiguate a dead pid from a live unrelated process that reused
      // it. `SessionStore.isOwnedByLiveProcess` is what the `attach`-mode
      // local `stop`/`cancel` fallback consumes this for.
      owner: { pid: process.pid, startedAt: processStartedAtIso() },
    };
    await this.store.save(session);

    const handle = this.spawnSidecar({
      onExit: (info) => {
        void this.handleSidecarExit(sessionId, info);
      },
      onStderrLine: (line) => {
        console.error(`[RecordingEngine] sidecar[${sessionId}] stderr: ${line}`);
      },
    });

    const writer = new EventTimelineWriter(sessionId);
    this.eventWriters.set(sessionId, writer);

    try {
      const describeResult = await handle.client.describe();
      if (describeResult.version !== EXPECTED_SIDECAR_VERSION) {
        console.warn(
          `[RecordingEngine] sidecar version mismatch: expected "${EXPECTED_SIDECAR_VERSION}", got "${describeResult.version}" — protocol errors may follow if the sidecar predates or postdates capabilities this daemon expects. Reinstall/rebuild the sidecar to match.`,
        );
      }
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
      handle.client.on("log", (payload) => {
        console.error(
          `[RecordingEngine] sidecar[${sessionId}] log (${payload.level}): ${payload.message}`,
        );
      });
      await handle.client.startCapture({ sessionId, target, video, audio });
    } catch (err) {
      await handle.terminate().catch(() => {});
      await this.discardEventWriter(sessionId);
      this.plannedOutputPaths.delete(sessionId);
      this.operatorRunPaths.delete(sessionId);
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

    const plannedOutputPath = this.plannedOutputPaths.get(session.id);
    if (!plannedOutputPath) {
      throw new DaemonError(
        "INTERNAL_ERROR",
        `No planned output path for session "${session.id}" — startRecording invariant violated`,
      );
    }

    if (params.narration) {
      // Fail fast, before touching capture state: an invalid narration file
      // must leave the session exactly as it was (still "recording"), not
      // half-stopped. See narration-mux.ts's top-of-file comment block.
      const validateNarrationFile = this.requireValidateNarrationFile();
      await validateNarrationFile(params.narration.filePath);
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
      await this.cleanupActive(session.id, session.target);
      this.plannedOutputPaths.delete(session.id);
    }

    try {
      await finalizeOutputFile(result.outputFilePath, plannedOutputPath);
    } catch (err) {
      const daemonErr = toDaemonError(err);
      await this.failSession(session.id, daemonErr);
      throw daemonErr;
    }

    const outputPath = plannedOutputPath;
    const manifestPath = manifestPathFor(outputPath);
    const operatorRunPath = this.operatorRunPaths.get(session.id);
    this.operatorRunPaths.delete(session.id);

    const writer = this.eventWriters.get(session.id);
    const capabilities = this.eventCapabilities.get(session.id) ?? { keystrokes: false };
    let eventTimelinePath: string | undefined;
    if (writer) {
      const candidatePath = eventsPathFor(outputPath);
      try {
        await writer.finalize(candidatePath, capabilities);
        eventTimelinePath = candidatePath;
      } catch (err) {
        // A bad/corrupt events file shouldn't fail an otherwise-successful
        // recording — logged below and continue without an eventTimelinePath.
        console.error(
          `[RecordingEngine] event timeline finalize failed for session ${session.id}:`,
          err,
        );
      }
      this.eventWriters.delete(session.id);
      this.eventCapabilities.delete(session.id);
    }

    let narration: OutputManifest["narration"];
    if (params.narration) {
      try {
        const muxNarration = this.requireMuxNarration();
        await muxNarration({
          videoPath: outputPath,
          narrationFilePath: params.narration.filePath,
          offsetMs: params.narration.offsetMs,
          videoDurationMs: result.actualDurationMs,
        });
        narration = {
          filePath: params.narration.filePath,
          offsetMs: params.narration.offsetMs,
          trackIndex: session.audio.tracks.length,
        };
      } catch (err) {
        // Mux failure must not fail an otherwise-successful recording — the
        // base video is already finalized on disk. Logged below, then
        // continue without populating manifest.narration, matching the same
        // swallow pattern used above for writer.finalize() failures.
        console.error(`[RecordingEngine] narration mux failed for session ${session.id}:`, err);
      }
    }

    // Stat'd after the (optional) narration mux, since a successful mux
    // rewrites `outputPath` in place and changes its size.
    const fileSize = await stat(outputPath)
      .then((s) => s.size)
      .catch(() => 0);

    const manifest = buildManifest({
      windowerVersion: WINDOWER_VERSION,
      session,
      outputPath,
      fileSizeBytes: fileSize,
      actualResolution: result.actualResolution,
      actualDurationMs: result.actualDurationMs,
      narration,
      eventTimelinePath,
      operatorRunPath,
    });
    await writeManifest(manifestPath, manifest);

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
    await this.cleanupActive(session.id, session.target);
    await this.discardEventWriter(session.id);
    this.plannedOutputPaths.delete(session.id);
    this.operatorRunPaths.delete(session.id);

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
    await this.cleanupActive(sessionId, session.target);
    await handle?.terminate().catch(() => {});
    await this.discardEventWriter(sessionId);
    this.plannedOutputPaths.delete(sessionId);
    this.operatorRunPaths.delete(sessionId);
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
    await this.cleanupActive(sessionId, session.target);
    await this.discardEventWriter(sessionId);
    this.plannedOutputPaths.delete(sessionId);
    this.operatorRunPaths.delete(sessionId);
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

  private async cleanupActive(sessionId: string, target: CaptureTarget): Promise<void> {
    this.activeSidecars.delete(sessionId);
    await this.targetLock.release(targetKey(target));
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
