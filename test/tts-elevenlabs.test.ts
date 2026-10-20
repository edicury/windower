import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createElevenLabs} from '../scripts/tts/elevenlabs.js';
import {TtsError, type SynthRequest} from '../scripts/tts/types.js';

const KEY = 'sk_test_secretsecretsecret1234';
const tmp: string[] = [];
const mkdir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-el-'));
  tmp.push(d);
  return d;
};
afterEach(() => {
  for (const d of tmp.splice(0)) fs.rmSync(d, {recursive: true, force: true});
  vi.restoreAllMocks();
});

const alignment = {
  characters: 'Hi you'.split(''),
  character_start_times_seconds: [0, 0.1, 0.2, 0.3, 0.4, 0.5],
  character_end_times_seconds: [0.1, 0.2, 0.3, 0.4, 0.5, 6],
};
const ok = (body: object = {audio_base64: Buffer.from('mp3').toString('base64'), alignment}) =>
  new Response(JSON.stringify(body), {status: 200});
const req = (audioDir?: string): SynthRequest => ({
  sceneId: 's01',
  text: 'Hi you',
  previousText: 'before',
  nextText: 'after',
  voiceId: 'voice1',
  modelId: 'eleven_multilingual_v2',
  outputFormat: 'mp3_44100_128',
  ...(audioDir ? {audioDir} : {}),
});
const make = (f: ReturnType<typeof vi.fn>, env = {ELEVENLABS_API_KEY: KEY}) => {
  const sleeps: number[] = [];
  const p = createElevenLabs(env, f as unknown as typeof fetch, {
    sleep: async (ms) => void sleeps.push(ms),
  });
  return {p, sleeps};
};

describe('elevenlabs', () => {
  it('estimates characters without network', () => {
    const f = vi.fn();
    const e = make(f).p.estimate([
      {id: 'a', text: 'abc'},
      {id: 'b', text: 'de'},
    ]);
    expect(e.characters).toBe(5);
    expect(e.note).toMatch(/per character/);
    expect(f).not.toHaveBeenCalled();
  });

  it('synthesizes, caches, and sends the right request', async () => {
    const dir = mkdir();
    const f = vi.fn(async () => ok());
    const {p} = make(f);
    const r = await p.synthesize(req(dir));
    expect(r.cached).toBe(false);
    expect(r.durationSec).toBeCloseTo(6.7);
    expect(r.words.map((w) => w.text)).toEqual(['Hi', 'you']);
    expect(fs.readFileSync(r.audioPath!, 'utf8')).toBe('mp3');
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      'https://api.elevenlabs.io/v1/text-to-speech/voice1/with-timestamps?output_format=mp3_44100_128',
    );
    expect((init.headers as Record<string, string>)['xi-api-key']).toBe(KEY);
    expect(JSON.parse(init.body as string)).toEqual({
      text: 'Hi you',
      model_id: 'eleven_multilingual_v2',
      previous_text: 'before',
      next_text: 'after',
    });
    const again = await p.synthesize(req(dir));
    expect(again.cached).toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('minimum duration is 4 s', async () => {
    const short = {...alignment, character_end_times_seconds: [0.1, 0.1, 0.1, 0.1, 0.1, 0.5]};
    const f = vi.fn(async () => ok({audio_base64: 'AA==', alignment: short}));
    expect((await make(f).p.synthesize(req())).durationSec).toBe(4);
  });

  it('401 maps to auth, no retry, key not leaked', async () => {
    const f = vi.fn(async () => new Response(`bad key ${KEY}`, {status: 401}));
    const {p} = make(f);
    const err = await p.synthesize(req()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TtsError);
    expect((err as TtsError).code).toBe('auth');
    expect((err as TtsError).message).not.toContain(KEY);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('retries 429 honouring Retry-After then succeeds', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(new Response('slow', {status: 429, headers: {'retry-after': '2'}}))
      .mockResolvedValueOnce(ok());
    const {p, sleeps} = make(f);
    const r = await p.synthesize(req());
    expect(r.words).toHaveLength(2);
    expect(sleeps).toEqual([2000]);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('exhausts retries on 5xx', async () => {
    const f = vi.fn(async () => new Response(`boom ${KEY}`, {status: 503}));
    const {p, sleeps} = make(f);
    const err = (await p.synthesize(req()).catch((e: unknown) => e)) as TtsError;
    expect(err.code).toBe('server');
    expect(err.message).not.toContain(KEY);
    expect(f).toHaveBeenCalledTimes(4);
    expect(sleeps).toEqual([1000, 3000, 9000]);
  });

  it('network failure maps to network and suggests --no-voice', async () => {
    const f = vi.fn(async () => {
      throw new Error(`ECONNREFUSED ${KEY}`);
    });
    const err = (await make(f)
      .p.synthesize(req())
      .catch((e: unknown) => e)) as TtsError;
    expect(err.code).toBe('network');
    expect(err.message).toContain('--no-voice');
    expect(err.message).not.toContain(KEY);
  });

  it('falls back to normalized_alignment, then to reading-speed', async () => {
    const f1 = vi.fn(async () =>
      ok({audio_base64: 'AA==', alignment: null, normalized_alignment: alignment}),
    );
    expect((await make(f1).p.synthesize(req())).durationSec).toBeCloseTo(6.7);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f2 = vi.fn(async () =>
      ok({audio_base64: 'AA==', alignment: null, normalized_alignment: null}),
    );
    const r = await make(f2).p.synthesize(req());
    expect(r.durationSec).toBe(4);
    expect(r.words.map((w) => w.text)).toEqual(['Hi', 'you']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).not.toContain(KEY);
  });

  it('missing key is an actionable auth error without fetching', async () => {
    const f = vi.fn();
    const err = (await make(f, {} as never)
      .p.synthesize(req())
      .catch((e: unknown) => e)) as TtsError;
    expect(err.code).toBe('auth');
    expect(err.message).toContain('--no-voice');
    expect(f).not.toHaveBeenCalled();
  });
});
