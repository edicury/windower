import {describe, expect, it} from 'vitest';
import {
  captionsFor,
  checkTotal,
  computeTiming,
  sceneSeconds,
  type Timing,
} from '../scripts/timing.js';

const words = (n: number) => Array.from({length: n}, (_, i) => `w${i}`).join(' ');

describe('reading-speed timing', () => {
  it('uses words / 2.9 + 0.9 s, floored at 4 s', () => {
    expect(sceneSeconds({id: 's01', narration: words(29)})).toBeCloseTo(10.9, 5);
    expect(sceneSeconds({id: 's01', narration: words(8)})).toBe(4);
    expect(sceneSeconds({id: 's01', narration: words(8), minDurationSec: 9})).toBe(9);
  });

  it('subtracts the 12-frame transition overlap from the total', () => {
    const t = computeTiming([
      {id: 's01', narration: words(29)},
      {id: 's02', narration: words(29)},
      {id: 's03', narration: words(29)},
    ]);
    const d = Math.round(10.9 * 30);
    expect(t.scenes.map((s) => s.durationFrames)).toEqual([d, d, d]);
    expect(t.scenes.map((s) => s.startFrame)).toEqual([0, d - 12, 2 * (d - 12)]);
    expect(t.totalFrames).toBe(3 * d - 2 * 12);
    expect(t.mode).toBe('silent');
    expect(t.scenes[0]?.audio).toBeNull();
  });

  it('applies per-scene transitions: none is a hard cut with no overlap', () => {
    const t = computeTiming([
      {id: 's01', narration: words(29)},
      {id: 's02', narration: words(29), transition: 'slide'},
      {id: 's03', narration: words(29), transition: 'none'},
      {id: 's04', narration: words(29), transition: 'fade'},
    ]);
    const d = Math.round(10.9 * 30);
    expect(t.scenes.map((s) => s.transition)).toEqual(['none', 'slide', 'none', 'fade']);
    expect(t.scenes.map((s) => s.startFrame)).toEqual([0, d - 12, 2 * d - 12, 3 * d - 24]);
    expect(t.totalFrames).toBe(4 * d - 24);
    // captions stay scene-relative, so a scene's audio/captions offset is its startFrame.
    expect(t.scenes[2]?.startFrame).toBe((t.scenes[1]?.startFrame ?? 0) + d);
  });

  it('produces word captions with Caption fields starting after a 200 ms lead', () => {
    const c = captionsFor('one two three');
    expect(c).toHaveLength(3);
    expect(c[0]).toMatchObject({text: 'one', startMs: 200, confidence: null});
    expect(c[0]?.endMs).toBe(c[1]?.startMs);
    expect(c[2]?.endMs).toBeCloseTo(200 + (3 * 1000) / 2.9, -1);
  });

  const timingOf = (sec: number): Timing => ({
    version: 1,
    fps: 30,
    mode: 'silent',
    transitionFrames: 12,
    scenes: [
      {
        id: 's01',
        startFrame: 0,
        durationFrames: sec * 30,
        transition: 'none',
        audio: null,
        captions: [],
      },
    ],
    totalFrames: sec * 30,
  });

  it('errors outside 45-130 s and warns outside 60-120 s', () => {
    expect(checkTotal(timingOf(44)).level).toBe('error');
    expect(checkTotal(timingOf(131)).level).toBe('error');
    expect(checkTotal(timingOf(50)).level).toBe('warn');
    expect(checkTotal(timingOf(125)).level).toBe('warn');
    expect(checkTotal(timingOf(90)).level).toBe('ok');
    expect(checkTotal(timingOf(131)).message).toContain('s01');
  });
});
