import { mkdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import type { OutputManifest, RecordingSession } from "@windower/core";

/**
 * `OutputManifest` construction + the temp→final output-file handoff,
 * extracted out of `RecordingEngine.stopRecording` (Phase 20's
 * `@windower/engine` extraction — see `phase-20-daemon-optional.md`, "Extract
 * `@windower/engine`") so it's independently testable and reusable by any
 * host (daemon, `record --duration`) that finishes a recording. Carries no
 * state of its own — a session/store/sidecar concern stays in
 * `RecordingEngine`.
 */

export function manifestPathFor(outputPath: string): string {
  const ext = extname(outputPath);
  return join(dirname(outputPath), `${basename(outputPath, ext)}.manifest.json`);
}

export function eventsPathFor(outputPath: string): string {
  const ext = extname(outputPath);
  return join(dirname(outputPath), `${basename(outputPath, ext)}.events.json`);
}

/**
 * The sidecar always writes to its own temp location (never told the final
 * output path — contracts/sidecar-protocol.md); moving it into the
 * configured output dir under the resolved filename is the engine's job.
 */
export async function finalizeOutputFile(tempPath: string, finalPath: string): Promise<void> {
  await rename(tempPath, finalPath);
}

export interface BuildManifestParams {
  windowerVersion: string;
  session: RecordingSession;
  outputPath: string;
  fileSizeBytes: number;
  actualResolution: { width: number; height: number };
  actualDurationMs: number;
  narration?: OutputManifest["narration"];
  eventTimelinePath?: string;
  operatorRunPath?: string;
  /** Defaults to `new Date().toISOString()` — injectable for tests. */
  createdAt?: string;
}

export function buildManifest(params: BuildManifestParams): OutputManifest {
  const {
    windowerVersion,
    session,
    outputPath,
    fileSizeBytes,
    actualResolution,
    actualDurationMs,
    narration,
    eventTimelinePath,
    operatorRunPath,
    createdAt,
  } = params;

  return {
    windowerVersion,
    sessionId: session.id,
    target: session.target,
    video: {
      ...session.video,
      actualResolution,
      durationMs: actualDurationMs,
    },
    audio: {
      tracks: session.audio.tracks.map((track, index) => ({
        source: track.source,
        trackIndex: index,
      })),
    },
    ...(narration ? { narration } : {}),
    createdAt: createdAt ?? new Date().toISOString(),
    file: {
      path: outputPath,
      sizeBytes: fileSizeBytes,
      codec: session.video.codec,
      container: session.video.container,
    },
    ...(eventTimelinePath ? { eventTimelinePath } : {}),
    ...(operatorRunPath ? { operatorRunPath } : {}),
  };
}

export async function writeManifest(manifestPath: string, manifest: OutputManifest): Promise<void> {
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}
