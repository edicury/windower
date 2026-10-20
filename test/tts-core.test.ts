import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {PROVIDERS} from '../scripts/gateSummary.js';
import {cacheKey, readCache, writeCache} from '../scripts/tts/cache.js';
import {loadConfig} from '../scripts/tts/config.js';
import {NullTts} from '../scripts/tts/null.js';
import {
  PROVIDER_META,
  getProvider,
  registerProvider,
  selectProvider,
} from '../scripts/tts/providers.js';
import {mapHttpError, parseRetryAfter, redactKey, withRetry} from '../scripts/tts/retry.js';
import {TtsError} from '../scripts/tts/types.js';
import {estimateWords, wordsFromAlignment} from '../scripts/tts/words.js';

const tmp: string[] = [];
const mkdir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-core-'));
  tmp.push(d);
  return d;
};
afterEach(() => {
  for (const d of tmp.splice(0)) fs.rmSync(d, {recursive: true, force: true});
});

describe('words', () => {
  it('spreads words proportionally to length across the duration', () => {
    const w = estimateWords('aa bbbbbb cc', 10);
    expect(w.map((x) => x.text)).toEqual(['aa', 'bbbbbb', 'cc']);
    expect(w[0]).toEqual({text: 'aa', startMs: 0, endMs: 2000});
    expect(w[1]).toEqual({text: 'bbbbbb', startMs: 2000, endMs: 8000});
    expect(w[2]?.endMs).toBe(10000);
  });
  it('handles empty text and zero duration', () => {
    expect(estimateWords('   ', 5)).toEqual([]);
    expect(estimateWords('hi', 0)).toEqual([]);
  });
  it('groups alignment characters on whitespace', () => {
    const chars = 'Hi you'.split('');
    const starts = [0, 0.1, 0.2, 0.3, 0.4, 0.5];
    const ends = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6];
    expect(
      wordsFromAlignment({
        characters: chars,
        character_start_times_seconds: starts,
        character_end_times_seconds: ends,
      }),
    ).toEqual([
      {text: 'Hi', startMs: 0, endMs: 200},
      {text: 'you', startMs: 300, endMs: 600},
    ]);
  });
  it('ignores leading/trailing/multiple whitespace', () => {
    const chars = ' a  b '.split('');
    const t = chars.map((_, i) => i / 10);
    const w = wordsFromAlignment({
      characters: chars,
      character_start_times_seconds: t,
      character_end_times_seconds: t.map((x) => x + 0.1),
    });
    expect(w.map((x) => x.text)).toEqual(['a', 'b']);
  });
});

describe('NullTts', () => {
  const p = new NullTts();
  const req = (text: string) => ({
    sceneId: 's01',
    text,
    voiceId: 'v',
    modelId: 'm',
    outputFormat: 'mp3',
  });
  it('is silent with reading-speed duration', async () => {
    const long = Array.from({length: 29}, () => 'w').join(' ');
    const r = await p.synthesize(req(long));
    expect(r.audioPath).toBeNull();
    expect(r.cached).toBe(false);
    expect(r.durationSec).toBeCloseTo(10.9, 5);
    expect(r.words).toHaveLength(29);
    expect(r.words.at(-1)?.endMs).toBe(Math.round(r.durationSec * 1000));
    expect((await p.synthesize(req('short one'))).durationSec).toBe(4);
    expect(p.timing).toBe('estimated');
  });
  it('estimates 0 characters', () => {
    expect(p.estimate([{id: 'a', text: 'hello'}]).characters).toBe(0);
  });
});

describe('cache', () => {
  const base = {
    provider: 'elevenlabs',
    voiceId: 'v',
    modelId: 'm',
    outputFormat: 'mp3_44100_128',
    text: 't',
  };
  it('key changes with every input', () => {
    const k = cacheKey(base);
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(cacheKey({...base})).toBe(k);
    for (const patch of [
      {provider: 'openai'},
      {voiceId: 'x'},
      {modelId: 'x'},
      {outputFormat: 'x'},
      {voiceSettings: {stability: 0.5}},
      {text: 'u'},
      {previousText: 'p'},
      {nextText: 'n'},
    ])
      expect(cacheKey({...base, ...patch})).not.toBe(k);
  });
  it('round-trips audio and metadata', () => {
    const dir = path.join(mkdir(), 'audio');
    expect(readCache(dir, 'k')).toBeNull();
    const words = [{text: 'a', startMs: 0, endMs: 100}];
    const w = writeCache(dir, 'k', {durationSec: 4, words}, new Uint8Array([1, 2, 3]));
    expect(w.cached).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'k.mp3'))).toEqual(Buffer.from([1, 2, 3]));
    const r = readCache(dir, 'k');
    expect(r).toEqual({audioPath: path.join(dir, 'k.mp3'), durationSec: 4, words, cached: true});
  });
  it('supports audio-less entries and misses when mp3 vanished or json corrupt', () => {
    const dir = mkdir();
    writeCache(dir, 'n', {durationSec: 4, words: []});
    expect(readCache(dir, 'n')?.audioPath).toBeNull();
    writeCache(dir, 'a', {durationSec: 4, words: []}, new Uint8Array([1]));
    fs.rmSync(path.join(dir, 'a.mp3'));
    expect(readCache(dir, 'a')).toBeNull();
    fs.writeFileSync(path.join(dir, 'c.json'), '{nope');
    expect(readCache(dir, 'c')).toBeNull();
  });
});

describe('retry and error mapping', () => {
  const rl = () => new TtsError('x', {code: 'rate-limit'});
  it('retries retryable errors with the backoff delays then succeeds', async () => {
    const slept: number[] = [];
    let n = 0;
    const r = await withRetry(
      async () => {
        if (++n < 4) throw rl();
        return 'ok';
      },
      {sleep: async (ms) => void slept.push(ms)},
    );
    expect(r).toBe('ok');
    expect(slept).toEqual([1000, 3000, 9000]);
  });
  it('throws the last error after exhaustion', async () => {
    let n = 0;
    await expect(
      withRetry(
        async () => {
          n++;
          throw rl();
        },
        {sleep: async () => {}},
      ),
    ).rejects.toMatchObject({code: 'rate-limit'});
    expect(n).toBe(4);
  });
  it('does not retry non-retryable or foreign errors', async () => {
    let n = 0;
    await expect(
      withRetry(
        async () => {
          n++;
          throw mapHttpError(401, '');
        },
        {sleep: async () => {}},
      ),
    ).rejects.toMatchObject({code: 'auth'});
    await expect(
      withRetry(
        async () => {
          n++;
          throw new Error('boom');
        },
        {sleep: async () => {}},
      ),
    ).rejects.toThrow('boom');
    expect(n).toBe(2);
  });
  it('honours retryAfterMs', async () => {
    const slept: number[] = [];
    let n = 0;
    await withRetry(
      async () => {
        if (++n < 2) throw mapHttpError(429, '', '7');
      },
      {sleep: async (ms) => void slept.push(ms)},
    );
    expect(slept).toEqual([7000]);
  });
  it('maps statuses per contract section 6', () => {
    expect(mapHttpError(401, '').code).toBe('auth');
    expect(mapHttpError(403, '').retryable).toBe(false);
    expect(mapHttpError(422, '{"detail":{"message":"bad voice"}}')).toMatchObject({
      code: 'bad-request',
      retryable: false,
    });
    expect(mapHttpError(422, '{"detail":{"message":"bad voice"}}').message).toContain('bad voice');
    expect(mapHttpError(400, '').code).toBe('bad-request');
    expect(mapHttpError(429, '', '2')).toMatchObject({code: 'rate-limit', retryAfterMs: 2000});
    expect(mapHttpError(503, '')).toMatchObject({code: 'server', retryable: true, status: 503});
  });
  it('parses Retry-After seconds and dates', () => {
    expect(parseRetryAfter('3')).toBe(3000);
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter('nonsense')).toBeUndefined();
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:05 GMT', now)).toBe(5000);
  });
  it('never leaks the key in messages', () => {
    const key = 'xi_secret_VALUE_1234567890';
    const e = mapHttpError(401, `{"detail":"bad key ${key} sent"}`, null, key);
    expect(e.message).not.toContain(key);
    expect(redactKey(`a ${key} b ${key}`, key)).toBe('a [redacted] b [redacted]');
    const fake = ['sk', 'abcdefghijklmnopqrstuv'].join('-');
    expect(redactKey(`token ${fake}`)).not.toContain(fake);
  });
});

describe('providers registry', () => {
  it('declares the contract table', () => {
    expect(Object.keys(PROVIDER_META).sort()).toEqual(['elevenlabs', 'null', 'openai', 'piper']);
    expect(PROVIDER_META.elevenlabs).toMatchObject({
      timing: 'word',
      envVar: 'ELEVENLABS_API_KEY',
      defaultModel: 'eleven_multilingual_v2',
      outputFormat: 'mp3_44100_128',
    });
    expect(PROVIDER_META.piper?.egress).toContain('nothing');
  });
  it('returns NullTts and errors clearly for unregistered ids', () => {
    expect(getProvider('null', {}).name).toBe('null');
    try {
      getProvider('nope-xyz', {});
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(TtsError);
      expect((e as TtsError).code).toBe('unavailable');
    }
  });
  it('uses registered factories with env', () => {
    registerProvider('third-party-test', (env) => {
      const p = new NullTts();
      return Object.assign(Object.create(p) as NullTts, {name: env.X ?? 'tp'});
    });
    expect(getProvider('third-party-test', {X: 'hello'}).name).toBe('hello');
  });
  it('selects: flag > config > env > null; noVoice forces null', () => {
    const env = {ELEVENLABS_API_KEY: 'a', OPENAI_API_KEY: 'b'};
    expect(selectProvider({flag: 'piper', config: {provider: 'openai'}, env})).toEqual({
      id: 'piper',
      source: 'flag',
    });
    expect(selectProvider({config: {provider: 'openai'}, env})).toEqual({
      id: 'openai',
      source: 'config',
    });
    expect(selectProvider({env})).toEqual({id: 'elevenlabs', source: 'env'});
    expect(selectProvider({env: {OPENAI_API_KEY: 'b'}})).toEqual({id: 'openai', source: 'env'});
    expect(selectProvider({env: {ELEVENLABS_API_KEY: ' '}})).toEqual({
      id: 'null',
      source: 'default',
    });
    expect(selectProvider({env: {}})).toEqual({id: 'null', source: 'default'});
    expect(selectProvider({flag: 'elevenlabs', noVoice: true, env})).toEqual({
      id: 'null',
      source: 'no-voice',
    });
  });
  it('gateSummary PROVIDERS derives from the registry', () => {
    expect(Object.keys(PROVIDERS).sort()).toEqual(Object.keys(PROVIDER_META).sort());
    expect(PROVIDERS.elevenlabs?.voiced).toBe(true);
    expect(PROVIDERS.piper?.voiced).toBe(false);
    expect(PROVIDERS.null?.implemented).toBe(true);
  });
});

describe('config', () => {
  const write = (obj: unknown) => {
    const d = mkdir();
    fs.writeFileSync(
      path.join(d, '.windower.json'),
      typeof obj === 'string' ? obj : JSON.stringify(obj),
    );
    return d;
  };
  it('returns {} when absent', () => {
    expect(loadConfig(mkdir())).toEqual({});
  });
  it('reads known fields', () => {
    expect(
      loadConfig(
        write({provider: 'piper', providers: ['./x.js'], voice: 'v', model: 'm', other: 1}),
      ),
    ).toEqual({provider: 'piper', providers: ['./x.js'], voice: 'v', model: 'm'});
  });
  it('rejects key-like fields, nested too', () => {
    expect(() => loadConfig(write({apiKey: 'x'}))).toThrow(/secret/);
    expect(() => loadConfig(write({provider: 'openai', elevenlabs: {api_key: 'x'}}))).toThrow(
      /elevenlabs\.api_key/,
    );
    expect(() => loadConfig(write({ELEVENLABS_API_KEY: 'x'}))).toThrow();
  });
  it('rejects bad JSON and bad types', () => {
    expect(() => loadConfig(write('{nope'))).toThrow(/valid JSON/);
    expect(() => loadConfig(write({provider: 3}))).toThrow(/provider/);
    expect(() => loadConfig(write({providers: 'x'}))).toThrow(/providers/);
    expect(() => loadConfig(write('[]'))).toThrow(/object/);
  });
});
