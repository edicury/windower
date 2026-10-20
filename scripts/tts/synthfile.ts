// <run>/synth.json: the ve:synth result consumed by timing and prepare.
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import type {SynthResult} from './types.js';

export interface SynthSceneEntry {
  id: string;
  /** Path relative to the run dir (absolute if outside it); null for silent scenes. */
  audioPath: string | null;
  durationSec: number;
  words: SynthResult['words'];
  cached: boolean;
  /** sha256 of the narration the audio was made from; detects edits after synth. */
  textHash: string;
  /** True when --fallback-silent replaced a failed scene with reading-speed timing. */
  fallback?: boolean;
}

export interface SynthFile {
  version: 1;
  provider: string;
  scenes: SynthSceneEntry[];
}

export const textHash = (text: string): string => createHash('sha256').update(text).digest('hex');

export function readSynthFile(file: string): SynthFile {
  let raw: SynthFile;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8')) as SynthFile;
  } catch (e) {
    throw new Error(`cannot read ${file}: ${(e as Error).message}`);
  }
  if (raw?.version !== 1 || !Array.isArray(raw.scenes))
    throw new Error(`${file} is not a version 1 synth file; rerun ve:synth`);
  return raw;
}

/** Message when synth.json does not match the storyboard (missing scene or edited narration). */
export function synthProblem(
  synth: SynthFile,
  scenes: {id: string; narration: string}[],
): string | undefined {
  for (const s of scenes) {
    const e = synth.scenes.find((x) => x.id === s.id);
    if (!e) return `synth.json has no entry for scene ${s.id}; rerun \`pnpm ve:synth\`.`;
    if (e.textHash !== textHash(s.narration))
      return `scene ${s.id}: narration changed since synth.json was written; rerun \`pnpm ve:synth\`.`;
  }
  return undefined;
}

/** Entries keyed by scene id with the composition path `audio/<id>.<ext>` for voiced scenes. */
export function synthTimingOf(synth: SynthFile) {
  const out: Record<
    string,
    {durationSec: number; audio: string | null; words: SynthResult['words']}
  > = {};
  for (const e of synth.scenes)
    out[e.id] = {
      durationSec: e.durationSec,
      audio: e.audioPath ? `audio/${e.id}${path.extname(e.audioPath) || '.mp3'}` : null,
      words: e.words,
    };
  return out;
}
