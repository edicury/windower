// Per-scene audio cache (contract §5): <key>.mp3 + <key>.json under the audio dir.
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {SynthResult} from './types.js';

export interface CacheKeyParts {
  provider: string;
  voiceId: string;
  modelId: string;
  outputFormat: string;
  voiceSettings?: unknown;
  text: string;
  previousText?: string;
  nextText?: string;
}

export function cacheKey(p: CacheKeyParts): string {
  return createHash('sha256')
    .update(
      [
        p.provider,
        p.voiceId,
        p.modelId,
        p.outputFormat,
        JSON.stringify(p.voiceSettings ?? {}),
        p.text,
        p.previousText ?? '',
        p.nextText ?? '',
      ].join('|'),
    )
    .digest('hex');
}

interface Stored {
  durationSec: number;
  words: SynthResult['words'];
  hasAudio: boolean;
}

export function readCache(dir: string, key: string): SynthResult | null {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, `${key}.json`), 'utf8')) as Stored;
    if (typeof meta.durationSec !== 'number' || !Array.isArray(meta.words)) return null;
    const mp3 = path.join(dir, `${key}.mp3`);
    if (meta.hasAudio && !fs.existsSync(mp3)) return null;
    return {
      audioPath: meta.hasAudio ? mp3 : null,
      durationSec: meta.durationSec,
      words: meta.words,
      cached: true,
    };
  } catch {
    return null;
  }
}

/** Writes audio (if any) then metadata; the json lands last so a partial write is never a hit. */
export function writeCache(
  dir: string,
  key: string,
  result: Pick<SynthResult, 'durationSec' | 'words'>,
  audioBytes?: Uint8Array,
): SynthResult {
  fs.mkdirSync(dir, {recursive: true});
  const mp3 = path.join(dir, `${key}.mp3`);
  if (audioBytes) fs.writeFileSync(mp3, audioBytes);
  const stored: Stored = {
    durationSec: result.durationSec,
    words: result.words,
    hasAudio: audioBytes !== undefined,
  };
  fs.writeFileSync(path.join(dir, `${key}.json`), JSON.stringify(stored, null, 2) + '\n');
  return {
    audioPath: audioBytes ? mp3 : null,
    durationSec: result.durationSec,
    words: result.words,
    cached: false,
  };
}
