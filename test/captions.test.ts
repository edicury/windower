import {describe, expect, it} from 'vitest';
import {buildCues, formatTimestamp, toSrt, toVtt} from '../scripts/captions.js';
import {captionsFor} from '../scripts/timing.js';

describe('caption export', () => {
  it('formats timestamps without millisecond rounding overflow', () => {
    expect(formatTimestamp(0, ',')).toBe('00:00:00,000');
    expect(formatTimestamp(3_661_999.6, '.')).toBe('01:01:02.000');
    expect(formatTimestamp(59_999, ',')).toBe('00:00:59,999');
  });

  const scenes = [
    {startFrame: 0, captions: captionsFor('One two three four five six seven eight nine ten.')},
    {startFrame: 90, captions: captionsFor('Second scene starts here.')},
  ];

  it('chunks words into cues and offsets by scene start frame', () => {
    const cues = buildCues(scenes, 30);
    expect(cues.length).toBeGreaterThanOrEqual(3);
    expect(cues[0]?.text.split(' ').length).toBeLessThanOrEqual(7);
    const last = cues[cues.length - 1];
    expect(last?.text).toBe('Second scene starts here.');
    expect(last?.startMs).toBe(3000 + 200);
  });

  it('never lets cues overlap', () => {
    const cues = buildCues(scenes, 30);
    cues.forEach((c, i) => {
      expect(c.endMs).toBeGreaterThan(c.startMs);
      const next = cues[i + 1];
      if (next) expect(c.endMs).toBeLessThanOrEqual(next.startMs);
    });
  });

  it('serializes SRT and VTT from the same cues', () => {
    const cues = buildCues(scenes, 30);
    const srt = toSrt(cues);
    const vtt = toVtt(cues);
    expect(srt.startsWith('1\n00:00:00,200 --> ')).toBe(true);
    expect(vtt.startsWith('WEBVTT\n\n00:00:00.200 --> ')).toBe(true);
    expect(srt.match(/-->/g)).toHaveLength(cues.length);
    expect(vtt.match(/-->/g)).toHaveLength(cues.length);
    expect(vtt).not.toContain(',');
  });
});
