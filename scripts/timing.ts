// Reading-speed timing (FR-CAP-01, FR-CAP-04): storyboard -> timing.json.
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {FPS, TRANSITION_FRAMES} from '../template/src/theme.js';
import type {Caption} from '../template/src/types.js';
import {EXIT} from './lib.js';

export const WORDS_PER_SECOND = 2.9;
export const PAD_S = 0.9;
export const MIN_SCENE_S = 4;
export const LEAD_MS = 200;
/** Total length bounds: outside 45-130 s is an error, outside 60-120 s a warning. */
export const HARD_RANGE_S = [45, 130] as const;
export const TARGET_RANGE_S = [60, 120] as const;
export const SCENE_SOFT_CAP_S = 20;

export interface TimingScene {
  id: string;
  startFrame: number;
  durationFrames: number;
  /** Transition INTO this scene; `none` means a hard cut with no overlap (the first scene has none). */
  transition: 'fade' | 'slide' | 'none';
  audio: string | null;
  captions: Caption[];
}

export interface Timing {
  version: 1;
  fps: number;
  mode: 'silent' | 'voiced';
  transitionFrames: number;
  scenes: TimingScene[];
  totalFrames: number;
}

interface TimedInput {
  id: string;
  narration: string;
  minDurationSec?: number;
  transition?: 'fade' | 'slide' | 'none';
}

/** Frames a scene overlaps its predecessor: `transitionFrames` for fade/slide, 0 for a hard cut. */
export function overlapFrames(
  transition: 'fade' | 'slide' | 'none' | undefined,
  transitionFrames = TRANSITION_FRAMES,
): number {
  return transition === 'none' ? 0 : transitionFrames;
}

export function wordsOf(narration: string): string[] {
  const t = narration.trim();
  return t ? t.split(/\s+/) : [];
}

/** Natural scene length in seconds: words / wps + pad, never below `minDurationSec` (default 4 s). */
export function sceneSeconds(scene: TimedInput, wps = WORDS_PER_SECOND): number {
  const n = wordsOf(scene.narration).length;
  return Math.max(n / wps + PAD_S, scene.minDurationSec ?? MIN_SCENE_S);
}

export function captionsFor(narration: string, wps = WORDS_PER_SECOND): Caption[] {
  const words = wordsOf(narration);
  const per = 1000 / wps;
  return words.map((text, i) => {
    const startMs = Math.round(LEAD_MS + i * per);
    const endMs = Math.round(LEAD_MS + (i + 1) * per);
    return {text, startMs, endMs, timestampMs: Math.round((startMs + endMs) / 2), confidence: null};
  });
}

export function computeTiming(scenes: TimedInput[], opts: {wps?: number} = {}): Timing {
  let cursor = 0;
  const out: TimingScene[] = scenes.map((s, i) => {
    const durationFrames = Math.round(sceneSeconds(s, opts.wps) * FPS);
    const transition = i === 0 ? 'none' : (s.transition ?? 'fade');
    const startFrame = i === 0 ? 0 : cursor - overlapFrames(transition);
    cursor = startFrame + durationFrames;
    return {
      id: s.id,
      startFrame,
      durationFrames,
      transition,
      audio: null,
      captions: captionsFor(s.narration, opts.wps),
    };
  });
  return {
    version: 1,
    fps: FPS,
    mode: 'silent',
    transitionFrames: TRANSITION_FRAMES,
    scenes: out,
    totalFrames: out.length ? cursor : 0,
  };
}

export interface RangeVerdict {
  level: 'ok' | 'warn' | 'error';
  message?: string;
}

/** Checks the total against 45-130 s (error) and 60-120 s (warning); names the scenes to trim. */
export function checkTotal(timing: Timing): RangeVerdict {
  const sec = timing.totalFrames / timing.fps;
  const longest = [...timing.scenes]
    .sort((a, b) => b.durationFrames - a.durationFrames)
    .slice(0, 3)
    .map((s) => `${s.id} (${(s.durationFrames / timing.fps).toFixed(1)} s)`)
    .join(', ');
  if (sec > HARD_RANGE_S[1])
    return {
      level: 'error',
      message: `total length ${sec.toFixed(1)} s is above ${HARD_RANGE_S[1]} s; trim narration in the longest scenes: ${longest}`,
    };
  if (sec < HARD_RANGE_S[0])
    return {
      level: 'error',
      message: `total length ${sec.toFixed(1)} s is below ${HARD_RANGE_S[0]} s; add narration or scenes (longest now: ${longest})`,
    };
  if (sec > TARGET_RANGE_S[1] || sec < TARGET_RANGE_S[0])
    return {
      level: 'warn',
      message: `total length ${sec.toFixed(1)} s is outside the ${TARGET_RANGE_S[0]}-${TARGET_RANGE_S[1]} s target`,
    };
  return {level: 'ok'};
}

function main(): void {
  const {values, positionals} = parseArgs({
    options: {synth: {type: 'string'}, json: {type: 'boolean'}, quiet: {type: 'boolean'}},
    allowPositionals: true,
  });
  const file = positionals[0];
  if (!file) {
    console.error('Usage: timing <storyboard.json> [--synth synth.json]');
    process.exit(EXIT.validation);
  }
  if (values.synth)
    console.error('--synth is not supported before phase 5; using reading-speed timing.');
  if (!existsSync(file)) {
    console.error(`storyboard not found: ${file}`);
    process.exit(EXIT.validation);
  }
  let sb: {scenes?: TimedInput[]};
  try {
    sb = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`${file} is not valid JSON: ${(e as Error).message}`);
    process.exit(EXIT.validation);
  }
  if (!Array.isArray(sb.scenes) || sb.scenes.some((s) => typeof s?.narration !== 'string')) {
    console.error(
      `${file}: every scene needs a string "narration"; run validate-storyboard first.`,
    );
    process.exit(EXIT.validation);
  }
  const timing = computeTiming(sb.scenes);
  const verdict = checkTotal(timing);
  if (verdict.level === 'error') {
    console.error(verdict.message);
    process.exit(EXIT.validation);
  }
  if (verdict.level === 'warn' && !values.quiet) console.error(`warning: ${verdict.message}`);
  const out = path.join(path.dirname(path.resolve(file)), 'timing.json');
  writeFileSync(out, JSON.stringify(timing, null, 2));
  if (values.json) console.log(JSON.stringify({out, totalFrames: timing.totalFrames}));
  else if (!values.quiet)
    console.error(
      `Wrote ${out} (${timing.scenes.length} scenes, ${(timing.totalFrames / timing.fps).toFixed(1)} s)`,
    );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
