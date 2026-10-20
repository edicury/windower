// Silent provider: no network, reading-speed duration, proportional word timing (contract §4).
import type {CostEstimate, SynthRequest, SynthResult, TtsProvider} from './types.js';
import {estimateWords} from './words.js';

export const WORDS_PER_SECOND = 2.9;

export class NullTts implements TtsProvider {
  readonly name = 'null';
  readonly timing = 'estimated' as const;

  estimate(scenes: {id: string; text: string}[]): CostEstimate {
    void scenes;
    return {characters: 0, provider: 'null', note: 'silent, 0 characters billed'};
  }

  async synthesize(req: SynthRequest): Promise<SynthResult> {
    const n = req.text.split(/\s+/).filter(Boolean).length;
    const durationSec = Math.max(n / WORDS_PER_SECOND + 0.9, 4);
    return {
      audioPath: null,
      durationSec,
      words: estimateWords(req.text, durationSec),
      cached: false,
    };
  }
}
