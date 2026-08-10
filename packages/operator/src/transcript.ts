import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { OperatorRun } from "@windower/core";
import { OperatorRunSchema } from "@windower/core";
import type { Redactor } from "./redaction.js";

/**
 * Transcript writer — operator-owned storage, per contracts/operator.md
 * §Transcript format: `~/.windower/operator-runs/<runId>/transcript.json`, with
 * observation frames in a sibling directory. It is deliberately **not** written
 * next to a video file, because locating one would require the operator to know
 * a recording exists and to look it up — both prohibited. An orchestrator that
 * wants the two artifacts side by side copies or links them itself, from the
 * two paths it already holds.
 *
 * Two deliberate choices:
 *
 * 1. **Incremental.** The transcript is rewritten after every step (atomic
 *    tmp + rename), mirroring the daemon's persist-on-every-transition rule —
 *    a crashed or killed run still leaves a usable partial transcript.
 * 2. **Frames by reference.** Observation frames are written into the run
 *    directory's `frames/`, named by their content hash, and the step records
 *    only carry the relative ref. Base64 is never inlined, so the JSON stays
 *    small and diffable.
 *
 * Where `contracts/operator.md` and `data-model.md` disagree on field names
 * (`runId`/`observation.screenshotRef` vs `id`/`observationRef`), the core Zod
 * schemas win — the hash is carried inside the ref's filename instead.
 */

const FRAMES_DIR = "frames";

/**
 * `~/.windower/operator-runs/<runId>/frames/`, a plain subdirectory of the
 * run's own directory.
 *
 * This deliberately derives nothing from the transcript's *filename*. The
 * previous `<stem>.operator.frames` scheme was a holdover from when the
 * transcript lived next to a video file — a layout that only made sense if the
 * operator knew a recording existed, which `contracts/operator.md`
 * §Transcript format prohibits.
 */
export function framesDirFor(transcriptPath: string): string {
  return join(dirname(transcriptPath), FRAMES_DIR);
}

export function hashFrame(imageBase64: string): string {
  return createHash("sha256").update(imageBase64, "base64").digest("hex");
}

export interface TranscriptWriter {
  /** Persists a frame and returns the ref to record in `OperatorStep`. */
  writeFrame(imageBase64: string, format: "png" | "jpeg"): Promise<string>;
  /** Redacts, validates, and atomically rewrites the transcript. */
  write(run: OperatorRun): Promise<void>;
}

/**
 * No-op writer for a run with no `transcriptPath` — the loop child, which
 * writes nothing to disk because the daemon owns all persistence
 * (contracts/operator-loop-protocol.md §Persistence).
 */
export function createNullTranscriptWriter(): TranscriptWriter {
  let counter = 0;
  return {
    async writeFrame(imageBase64) {
      counter += 1;
      return `memory:${counter}:${hashFrame(imageBase64).slice(0, 16)}`;
    },
    async write() {},
  };
}

export function createTranscriptWriter(
  transcriptPath: string,
  redactor: Redactor,
): TranscriptWriter {
  const framesDir = framesDirFor(transcriptPath);
  const framesDirName = basename(framesDir);
  let framesDirReady: Promise<void> | undefined;

  async function ensureFramesDir(): Promise<void> {
    framesDirReady ??= mkdir(framesDir, { recursive: true }).then(() => undefined);
    await framesDirReady;
  }

  return {
    async writeFrame(imageBase64, format) {
      await ensureFramesDir();
      const hash = hashFrame(imageBase64);
      const filename = `${hash.slice(0, 16)}.${format === "jpeg" ? "jpg" : "png"}`;
      await writeFile(join(framesDir, filename), Buffer.from(imageBase64, "base64"));
      return `${framesDirName}/${filename}`;
    },

    async write(run) {
      // Last write barrier: redact, *then* validate, *then* persist.
      const redacted = OperatorRunSchema.parse(redactor.redact(run));
      const tmp = `${transcriptPath}.tmp`;
      await mkdir(dirname(transcriptPath), { recursive: true });
      await writeFile(tmp, `${JSON.stringify(redacted, null, 2)}\n`, "utf8");
      await rename(tmp, transcriptPath);
    },
  };
}
