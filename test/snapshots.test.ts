import {existsSync, mkdtempSync, readdirSync, readFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {PNG} from 'pngjs';
import {describe, expect, it} from 'vitest';
import {
  ALL_SCENES,
  SNAPSHOT_DIR,
  TOLERANCE,
  pixelDiff,
  runSnapshots,
  snapshotName,
} from '../scripts/snapshots.js';

const solid = (w: number, h: number, rgb: number): Buffer => {
  const p = new PNG({width: w, height: h});
  p.data.fill(rgb);
  for (let i = 3; i < p.data.length; i += 4) p.data[i] = 255;
  return PNG.sync.write(p);
};

describe('pixelDiff', () => {
  it('is 0 for identical images, 1 for different sizes, and counts changed pixels', () => {
    expect(pixelDiff(solid(10, 10, 20), solid(10, 10, 20))).toBe(0);
    expect(pixelDiff(solid(10, 10, 20), solid(11, 10, 20))).toBe(1);
    expect(pixelDiff(solid(10, 10, 20), solid(10, 10, 200))).toBe(1);
    // a delta under the per-pixel threshold is ignored (anti-aliasing noise)
    expect(pixelDiff(solid(10, 10, 20), solid(10, 10, 30))).toBe(0);
    expect(TOLERANCE).toBeLessThan(0.01);
  });
});

describe('scene still snapshots (T3, G2-2)', () => {
  const scenes = (
    JSON.parse(readFileSync(ALL_SCENES, 'utf8')) as {scenes: {id: string; type: string}[]}
  ).scenes;

  it('all-scenes covers every scene type and has a committed baseline per scene', () => {
    const types = new Set(scenes.map((s) => s.type));
    for (const t of ['title', 'bullets', 'code', 'architecture', 'sequence', 'timeline', 'outro'])
      expect(types.has(t), `scene type ${t}`).toBe(true);
    for (const s of scenes) expect(existsSync(path.join(SNAPSHOT_DIR, snapshotName(s)))).toBe(true);
    expect(readdirSync(SNAPSHOT_DIR).filter((f) => f.endsWith('.png'))).toHaveLength(scenes.length);
  });

  it('renders each scene still within tolerance of its baseline', async () => {
    const work = mkdtempSync(path.join(os.tmpdir(), 've-snap-'));
    const results = await runSnapshots(work);
    const bad = results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.diff}`);
    expect(bad, `snapshot mismatches (update with: pnpm ve:snapshots --update)`).toEqual([]);
    expect(results).toHaveLength(scenes.length);
  }, 300_000);
});
