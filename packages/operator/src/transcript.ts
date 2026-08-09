import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { OperatorRun } from "@windower/core";
import { OperatorRunSchema } from "@windower/core";
import type { Redactor } from "./redaction.js";

/**
 * Transcript writer — `<recording>.operator.json` next to the video file, per
 * contracts/operator.md §Transcript format and the repo convention that
 * manifest/timeline files live beside the video rather than in a DB.
 *
 * Two deliberate choices:
 *
 * 1. **Incremental.** The transcript is rewritten after every step (atomic
 *    tmp + rename), mirroring the daemon's persist-on-every-transition rule —
 *    a crashed or killed run still leaves a usable partial transcript.
 * 2. **Frames by reference.** Observation frames are written as sibling files
 *    in `<recording>.operator.frames/` named by their content hash, and the
 *    step records only carry the relative ref. Base64 is never inlined, so the
 *    JSON stays small and diffable.
 *
 * Where `contracts/operator.md` and `data-model.md` disagree on field names
 * (`runId`/`observation.screenshotRef` vs `id`/`observationRef`), the core Zod
 * schemas win — the hash is carried inside the ref's filename instead.
 */

const FRAMES_SUFFIX = ".operator.frames";
const TRANSCRIPT_SUFFIX = ".operator.json";

export function framesDirFor(transcriptPath: string): string {
  const dir = dirname(transcriptPath);
  const base = basename(transcriptPath);
  const stem = base.endsWith(TRANSCRIPT_SUFFIX)
    ? base.slice(0, -TRANSCRIPT_SUFFIX.length)
    : base.replace(/\.json$/, "");
  return join(dir, `${stem}${FRAMES_SUFFIX}`);
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

/** No-op writer used when a run has no `transcriptPath` (e.g. `--no-record`). */
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
