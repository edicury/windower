// Word timings: proportional estimate (NullTts, estimated providers) and ElevenLabs alignment (contract §3).
import type {SynthResult} from './types.js';

export type Words = SynthResult['words'];

/** Spreads whitespace-separated words across `durationSec`, proportional to character length. */
export function estimateWords(text: string, durationSec: number): Words {
  const tokens = text.split(/\s+/).filter(Boolean);
  const total = tokens.reduce((n, t) => n + t.length, 0);
  if (!tokens.length || total === 0 || !(durationSec > 0)) return [];
  const totalMs = durationSec * 1000;
  let acc = 0;
  return tokens.map((t, i) => {
    const startMs = Math.round((acc / total) * totalMs);
    acc += t.length;
    const endMs =
      i === tokens.length - 1 ? Math.round(totalMs) : Math.round((acc / total) * totalMs);
    return {text: t, startMs, endMs};
  });
}

export interface Alignment {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}

/** Groups characters on whitespace; word start = first char start, end = last char end. */
export function wordsFromAlignment(a: Alignment): Words {
  const out: Words = [];
  let text = '';
  let start = 0;
  let end = 0;
  const flush = () => {
    if (text) out.push({text, startMs: Math.round(start * 1000), endMs: Math.round(end * 1000)});
    text = '';
  };
  a.characters.forEach((ch, i) => {
    if (/^\s+$/.test(ch)) {
      flush();
      return;
    }
    const s = a.character_start_times_seconds[i] ?? end;
    const e = a.character_end_times_seconds[i] ?? s;
    if (!text) start = s;
    text += ch;
    end = e;
  });
  flush();
  return out;
}
