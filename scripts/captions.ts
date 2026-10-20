// SRT / VTT export from the same Caption[] the burned-in overlay uses (FR-CAP-02, FR-CAP-03).
import {chunkCaptions} from '../template/src/captionChunks.js';
import type {Caption} from '../template/src/types.js';

export interface Cue {
  startMs: number;
  endMs: number;
  text: string;
}

export interface TimedScene {
  startFrame: number;
  captions: Caption[];
}

/** Scene-relative word captions -> absolute cues on the composition timeline. */
export function buildCues(scenes: TimedScene[], fps: number): Cue[] {
  const cues: Cue[] = [];
  for (const scene of scenes) {
    const offset = Math.round((scene.startFrame * 1000) / fps);
    for (const group of chunkCaptions(scene.captions)) {
      const first = group[0];
      const last = group[group.length - 1];
      if (!first || !last) continue;
      cues.push({
        startMs: offset + first.startMs,
        endMs: offset + last.endMs,
        text: group.map((w) => w.text).join(' '),
      });
    }
  }
  // Scenes overlap by the transition, so trim a cue that would run into the next one.
  cues.sort((a, b) => a.startMs - b.startMs);
  cues.forEach((c, i) => {
    const next = cues[i + 1];
    if (next && c.endMs > next.startMs) c.endMs = Math.max(c.startMs + 1, next.startMs);
  });
  return cues;
}

export function formatTimestamp(ms: number, sep: ',' | '.'): string {
  const total = Math.max(0, Math.round(ms));
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor(total / 60_000) % 60;
  const s = Math.floor(total / 1000) % 60;
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)}${sep}${p(total % 1000, 3)}`;
}

export function toSrt(cues: Cue[]): string {
  return cues
    .map(
      (c, i) =>
        `${i + 1}\n${formatTimestamp(c.startMs, ',')} --> ${formatTimestamp(c.endMs, ',')}\n${c.text}\n`,
    )
    .join('\n');
}

export function toVtt(cues: Cue[]): string {
  return (
    'WEBVTT\n\n' +
    cues
      .map(
        (c) =>
          `${formatTimestamp(c.startMs, '.')} --> ${formatTimestamp(c.endMs, '.')}\n${c.text}\n`,
      )
      .join('\n')
  );
}
