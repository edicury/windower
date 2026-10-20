import {
  rmSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {prepare} from '../scripts/prepare.js';
import {SynthError, synth} from '../scripts/synth.js';
import {computeTiming} from '../scripts/timing.js';
import {cacheKey} from '../scripts/tts/cache.js';
import {registerProvider} from '../scripts/tts/providers.js';
import {estimateWords} from '../scripts/tts/words.js';
import {TtsError, type SynthRequest, type TtsProvider} from '../scripts/tts/types.js';

const CANARY = ['canary', 'Z9f3a7c1d5e8b2a4f6071'].join('-');
const calls: SynthRequest[] = [];
let failWith: TtsError | null = null;

function fake(id: string, timing: 'word' | 'estimated'): TtsProvider {
  return {
    name: id,
    timing,
    estimate: (scenes) => ({
      characters: scenes.reduce((n, s) => n + s.text.length, 0),
      provider: id,
      note: 'fake',
    }),
    async synthesize(req) {
      calls.push(req);
      if (failWith) throw failWith;
      const durationSec = 8;
      const dir = req.audioDir ?? os.tmpdir();
      mkdirSync(dir, {recursive: true});
      const audioPath = path.join(dir, `raw-${id}-${req.sceneId}.mp3`);
      writeFileSync(audioPath, Buffer.from('ID3fake-audio'));
      // Deliberately overshoots the scene on estimated providers to exercise clamping.
      const words = estimateWords(req.text, timing === 'word' ? durationSec : durationSec + 3);
      return {audioPath, durationSec, words, cached: false};
    },
  };
}
registerProvider('fakeword', () => fake('fakeword', 'word'));
registerProvider('fakeest', () => fake('fakeest', 'estimated'));

const dirs: string[] = [];
function setup(): {run: string; pub: string} {
  const run = mkdtempSync(path.join(os.tmpdir(), 've-synth-'));
  const pub = mkdtempSync(path.join(os.tmpdir(), 've-pub-'));
  dirs.push(run, pub);
  const sb = JSON.parse(readFileSync('fixtures/storyboards/minimal.json', 'utf8'));
  sb.approved = true;
  sb.repoRoot = path.resolve('fixtures/repos/sample');
  writeFileSync(path.join(run, 'storyboard.json'), JSON.stringify(sb));
  return {run, pub};
}
function walk(d: string): string[] {
  return readdirSync(d).flatMap((f) => {
    const p = path.join(d, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

afterEach(() => {
  calls.length = 0;
  failWith = null;
  vi.restoreAllMocks();
});

describe('synth pipeline', () => {
  it('refuses an unapproved storyboard', async () => {
    const {run} = setup();
    const f = path.join(run, 'storyboard.json');
    const sb = JSON.parse(readFileSync(f, 'utf8'));
    sb.approved = false;
    writeFileSync(f, JSON.stringify(sb));
    await expect(synth(run, {provider: 'fakeword', env: {}})).rejects.toBeInstanceOf(SynthError);
    expect(calls).toHaveLength(0);
  });

  it('G5-2: second run makes zero provider calls and bills nothing', async () => {
    const {run} = setup();
    const a = await synth(run, {provider: 'fakeword', env: {}});
    const n = calls.length;
    expect(n).toBe(8);
    expect(a.billedCharacters).toBeGreaterThan(0);
    expect(calls[1]?.previousText).toBeDefined();
    expect(calls[0]?.previousText).toBeUndefined();
    const b = await synth(run, {provider: 'fakeword', env: {}});
    expect(calls.length).toBe(n);
    expect(b.billedCharacters).toBe(0);
    expect(b.cachedCharacters).toBe(a.billedCharacters);
    expect(b.file?.scenes.every((s) => s.cached)).toBe(true);
  });

  it('G5-5: switching provider changes the cache key and misses the cache', async () => {
    const base = {voiceId: 'v', modelId: 'm', outputFormat: 'mp3', text: 'hi'};
    expect(cacheKey({provider: 'a', ...base})).not.toBe(cacheKey({provider: 'b', ...base}));
    const {run} = setup();
    await synth(run, {provider: 'fakeword', env: {}});
    calls.length = 0;
    await synth(run, {provider: 'fakeest', env: {}});
    expect(calls).toHaveLength(8);
  });

  it('G5-5: an estimated provider yields captions inside the scene duration', async () => {
    const {run, pub} = setup();
    await synth(run, {provider: 'fakeest', env: {}});
    const {timing} = await prepare(path.join(run, 'storyboard.json'), {publicDir: pub});
    expect(timing.mode).toBe('voiced');
    for (const s of timing.scenes) {
      const durMs = (s.durationFrames / timing.fps) * 1000;
      expect(s.captions.length).toBeGreaterThan(0);
      for (const c of s.captions) {
        expect(c.endMs).toBeLessThanOrEqual(durMs);
        expect(c.startMs).toBeGreaterThanOrEqual(0);
        expect(c.confidence).toBeNull();
      }
    }
  });

  it('prepare stages audio into public/audio and removes stale files', async () => {
    const {run, pub} = setup();
    mkdirSync(path.join(pub, 'audio'));
    writeFileSync(path.join(pub, 'audio', 'stale.mp3'), 'x');
    await synth(run, {provider: 'fakeword', env: {}});
    const {timing} = await prepare(path.join(run, 'storyboard.json'), {publicDir: pub});
    const files = readdirSync(path.join(pub, 'audio')).sort();
    expect(files).not.toContain('stale.mp3');
    expect(files).toHaveLength(8);
    expect(timing.scenes[0]?.audio).toBe(`audio/${timing.scenes[0]?.id}.mp3`);
    expect(timing.scenes[0]?.durationFrames).toBe(8 * timing.fps);
  });

  it('prepare rejects a synth.json made from different narration', async () => {
    const {run, pub} = setup();
    await synth(run, {provider: 'fakeword', env: {}});
    const f = path.join(run, 'storyboard.json');
    const sb = JSON.parse(readFileSync(f, 'utf8'));
    sb.scenes[0].narration += ' extra words';
    writeFileSync(f, JSON.stringify(sb));
    await expect(prepare(f, {publicDir: pub})).rejects.toThrow(/narration changed/);
  });

  it('silent timing is unchanged without a synth entry (G5-4)', () => {
    const t = computeTiming([{id: 'a', narration: 'one two three four five six seven'}]);
    expect(t.mode).toBe('silent');
    expect(t.scenes[0]?.audio).toBeNull();
  });

  it('stops on auth failure with exit 4 and offers --no-voice; fallback-silent continues', async () => {
    const {run} = setup();
    failWith = new TtsError(`401 bad key ${CANARY}`, {code: 'auth', status: 401});
    const err = await synth(run, {provider: 'fakeword', env: {FAKE_API_KEY: CANARY}}).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(SynthError);
    expect(err.exitCode).toBe(4);
    expect(err.message).toContain('--no-voice');
    expect(err.message).not.toContain(CANARY);
    const r = await synth(run, {provider: 'fakeword', fallbackSilent: true, env: {}});
    expect(r.file?.scenes.every((s) => s.fallback && s.audioPath === null)).toBe(true);
  });

  it('G5-3: the key never reaches files, stdout or stderr', async () => {
    const {run, pub} = setup();
    const out: string[] = [];
    const cap = (...a: unknown[]) => void out.push(a.join(' '));
    vi.spyOn(console, 'log').mockImplementation(cap);
    vi.spyOn(console, 'error').mockImplementation(cap);
    vi.spyOn(process.stdout, 'write').mockImplementation((c) => (out.push(String(c)), true));
    vi.spyOn(process.stderr, 'write').mockImplementation((c) => (out.push(String(c)), true));
    const env = {FAKE_API_KEY: CANARY};
    await synth(run, {provider: 'fakeword', env, log: cap});
    await prepare(path.join(run, 'storyboard.json'), {publicDir: pub, log: cap});
    failWith = new TtsError(`boom ${CANARY}`, {code: 'server', status: 500, retryable: false});
    rmSync(path.join(run, 'audio'), {recursive: true, force: true});
    const e = await synth(run, {provider: 'fakeword', env, log: cap}).catch((x) => x);
    out.push(String(e.message));
    expect(out.join('\n')).not.toContain(CANARY);
    for (const f of [...walk(run), ...walk(pub)])
      expect(readFileSync(f).includes(CANARY), f).toBe(false);
  });
});
