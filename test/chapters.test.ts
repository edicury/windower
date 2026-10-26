/* eslint-disable @typescript-eslint/no-explicit-any */
import {mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {groupChapters, splitChapters} from '../scripts/chapters.js';
import {buildSummary, renderSummary} from '../scripts/gateSummary.js';
import {synth} from '../scripts/synth.js';
import {validateStoryboard} from '../scripts/validate-storyboard.js';
import {registerProvider} from '../scripts/tts/providers.js';
import {estimateWords} from '../scripts/tts/words.js';
import type {SynthRequest, TtsProvider} from '../scripts/tts/types.js';

const REPO = path.resolve('fixtures/repos/sample');
const minimal = () =>
  JSON.parse(readFileSync('fixtures/storyboards/minimal.json', 'utf8')) as Record<string, any>;

/** Deep storyboard: minimal with extra middle scenes (11 total), optional chapter labels per index. */
function deep(labels?: (string | undefined)[]): Record<string, any> {
  const sb = minimal();
  const scenes = sb.scenes as any[];
  const extra = Array.from({length: 4}, (_, i) => ({...scenes[1], id: `x${i}`}));
  const all = [...scenes.slice(0, -1), ...extra, scenes[scenes.length - 1]];
  all.forEach((x, i) => {
    x.id = `s${String(i + 1).padStart(2, '0')}`;
    if (labels?.[i]) x.chapter = labels[i];
  });
  sb.scenes = all;
  sb.mode = 'deep';
  return sb;
}
const LABELS = [
  'Intro',
  'Intro',
  'Flow',
  'Flow',
  'Flow',
  'Flow',
  'Flow',
  'Edge',
  'Edge',
  'Edge',
  'Edge',
  'Edge',
];

describe('chapter grouping', () => {
  it('groups consecutive labels and detects splits', () => {
    expect(groupChapters(['a', 'a', 'b', undefined, 'b']).map((g) => [g.label, g.indexes])).toEqual(
      [
        ['a', [0, 1]],
        ['b', [2]],
        ['b', [4]],
      ],
    );
    expect(splitChapters(['a', 'b', 'a'])).toEqual(['a']);
    expect(splitChapters(['a', 'a', 'b'])).toEqual([]);
  });
});

describe('chapter validation', () => {
  it('accepts contiguous chapters in deep mode without chapter issues', () => {
    const r = validateStoryboard(deep(LABELS), {repoRoot: REPO});
    expect(r.errors).toEqual([]);
    expect(r.warnings.filter((w) => w.rule === 'chapter')).toEqual([]);
  });
  it('errors when a chapter label reappears non-contiguously', () => {
    const l = [...LABELS];
    l[11] = 'Intro';
    const r = validateStoryboard(deep(l), {repoRoot: REPO});
    expect(r.errors.some((e) => e.rule === 'chapter' && e.message.includes('"Intro"'))).toBe(true);
  });
  it('rejects labels over 40 chars', () => {
    const r = validateStoryboard(deep(['x'.repeat(41)]), {repoRoot: REPO});
    expect(r.errors.some((e) => e.message.includes('chapter label'))).toBe(true);
  });
  it('warns (not errors) for chapters outside deep mode', () => {
    const sb = minimal();
    (sb.scenes as any[]).forEach((s, i) => (s.chapter = i < 4 ? 'A' : 'B'));
    const r = validateStoryboard(sb, {repoRoot: REPO});
    expect(r.errors).toEqual([]);
    expect(r.warnings.some((w) => w.rule === 'chapter' && w.message.includes('unusual'))).toBe(
      true,
    );
  });
  it('suggests chapters for deep videos over 150 s with none', () => {
    const sb = deep();
    const r = validateStoryboard(sb, {repoRoot: REPO});
    if ((r.estimatedSec ?? 0) > 150)
      expect(
        r.warnings.some((w) => w.rule === 'chapter' && w.message.includes('no chapters')),
      ).toBe(true);
    // Force a long video by inflating minDurationSec.
    for (const s of sb.scenes) s.minDurationSec = 20;
    const long = validateStoryboard(sb, {repoRoot: REPO});
    expect(long.estimatedSec).toBeGreaterThan(150);
    expect(
      long.warnings.some((w) => w.rule === 'chapter' && w.message.includes('no chapters')),
    ).toBe(true);
    for (const [i, s] of sb.scenes.entries()) s.chapter = i < 5 ? 'A' : 'B';
    expect(
      validateStoryboard(sb, {repoRoot: REPO}).warnings.some((w) =>
        w.message.includes('no chapters'),
      ),
    ).toBe(false);
  });
});

describe('chapter gate summary', () => {
  it('lists per-chapter rows and credit share', () => {
    const raw = deep(LABELS);
    const s = buildSummary(raw, validateStoryboard(raw, {repoRoot: REPO}), {
      provider: 'elevenlabs',
    });
    expect(s.chapters.map((c) => [c.label, c.scenes])).toEqual([
      ['Intro', 2],
      ['Flow', 5],
      ['Edge', 5],
    ]);
    expect(s.chapters.reduce((n, c) => n + c.narrationChars, 0)).toBe(s.narrationChars);
    expect(s.chapters.reduce((n, c) => n + c.creditShare, 0)).toBeCloseTo(1);
    expect(s.creditsDisclosure).toContain('Credit share by chapter: Intro');
    const text = renderSummary(s);
    expect(text).toContain('Chapters:');
    expect(text).toContain('Flow');
  });
  it('has no chapter output when none are set, and a frame-count note only over 150 s', () => {
    const raw = minimal();
    const s = buildSummary(raw, validateStoryboard(raw, {repoRoot: REPO}));
    expect(s.chapters).toEqual([]);
    expect(renderSummary(s)).not.toContain('Chapters:');
    expect(s.renderEstimate).toBeUndefined();
    const long = deep(LABELS);
    for (const sc of long.scenes) sc.minDurationSec = 20;
    const ls = buildSummary(long, validateStoryboard(long, {repoRoot: REPO}));
    expect(ls.renderEstimate).toMatch(/about \d+ frames at 30 fps/);
    expect(ls.renderEstimate).toContain('estimate');
  });
});

describe('synth cache across chapters', () => {
  const calls: SynthRequest[] = [];
  const provider: TtsProvider = {
    name: 'chapfake',
    timing: 'word',
    estimate: (scenes) => ({characters: scenes.length, provider: 'chapfake', note: 'fake'}),
    async synthesize(req) {
      calls.push(req);
      const dir = req.audioDir ?? os.tmpdir();
      mkdirSync(dir, {recursive: true});
      const audioPath = path.join(dir, `raw-${req.sceneId}.mp3`);
      writeFileSync(audioPath, Buffer.from('ID3x'));
      return {audioPath, durationSec: 5, words: estimateWords(req.text, 5), cached: false};
    },
  };
  registerProvider('chapfake', () => provider);
  afterEach(() => (calls.length = 0));

  it('editing one scene re-synthesizes only it and its two neighbors, never other chapters', async () => {
    const run = mkdtempSync(path.join(os.tmpdir(), 've-chap-'));
    const sb = deep(LABELS);
    sb.scenes.forEach((x: any, i: number) => (x.narration = `${x.narration} Variant ${i}.`));
    sb.approved = true;
    sb.repoRoot = REPO;
    const f = path.join(run, 'storyboard.json');
    writeFileSync(f, JSON.stringify(sb));
    await synth(run, {provider: 'chapfake', env: {}});
    expect(calls).toHaveLength(12);
    calls.length = 0;
    sb.scenes[4].narration = sb.scenes[4].narration + ' One more clause appears here now.'; // middle of Flow
    writeFileSync(f, JSON.stringify(sb));
    await synth(run, {provider: 'chapfake', env: {}});
    expect(calls.map((c) => c.sceneId).sort()).toEqual(['s04', 's05', 's06']);
  });
});
