import type {Caption} from './types';

export const MAX_CAPTION_WORDS = 7;
export const MAX_CAPTION_CHARS = 46;

/** Groups word captions into on-screen cues; the burned-in overlay and SRT/VTT export share this. */
export const chunkCaptions = (words: Caption[]): Caption[][] => {
  const out: Caption[][] = [];
  let cur: Caption[] = [];
  let chars = 0;
  for (const w of words) {
    if (cur.length && (cur.length >= MAX_CAPTION_WORDS || chars + w.text.length + 1 > MAX_CAPTION_CHARS)) {
      out.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(w);
    chars += w.text.length + 1;
    if (/[.?!]$/.test(w.text)) {
      out.push(cur);
      cur = [];
      chars = 0;
    }
  }
  if (cur.length) out.push(cur);
  return out;
};
