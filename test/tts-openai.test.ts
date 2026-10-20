import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {createOpenAi, wavDurationSec, type Runner} from '../scripts/tts/openai.js';
import {getProvider} from '../scripts/tts/providers.js';
import {TtsError, type SynthRequest} from '../scripts/tts/types.js';

const tmp: string[] = [];
const mkdir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-openai-'));
  tmp.push(d);
  return d;
};
afterEach(() => {
  for (const d of tmp.splice(0)) fs.rmSync(d, {recursive: true, force: true});
});

const KEY = ['sk', 'test', '0123456789abcdefghij'].join('-');
const noSleep = {sleep: async () => undefined};

function wav(seconds: number): Uint8Array {
  const rate = 8000;
  const data = Buffer.alloc(rate * seconds);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate, 28);
  h.writeUInt16LE(1, 32);
  h.writeUInt16LE(8, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

const req = (dir: string, over: Partial<SynthRequest> = {}): SynthRequest => ({
  sceneId: 's1',
  text: 'hello brave new world',
  voiceId: 'alloy',
  modelId: 'gpt-4o-mini-tts',
  outputFormat: 'mp3',
  audioDir: dir,
  ...over,
});

const okFetch = (body: Uint8Array, calls: {url: string; init: RequestInit}[] = []) =>
  (async (url: string, init: RequestInit) => {
    calls.push({url, init});
    return new Response(Buffer.from(body), {status: 200});
  }) as unknown as typeof fetch;

describe('openai provider', () => {
  it('registers itself and is estimated', () => {
    const p = getProvider('openai', {OPENAI_API_KEY: KEY});
    expect(p.name).toBe('openai');
    expect(p.timing).toBe('estimated');
  });

  it('parses wav durations', () => {
    expect(wavDurationSec(wav(3))).toBeCloseTo(3, 5);
    expect(wavDurationSec(new Uint8Array(10))).toBeNull();
  });

  it('posts the speech request and measures mp3 with ffprobe', async () => {
    const calls: {url: string; init: RequestInit}[] = [];
    const run: Runner = async (cmd, args, input) => {
      expect(cmd).toBe('ffprobe');
      expect(args).toContain('pipe:0');
      expect(Buffer.isBuffer(input)).toBe(true);
      return {code: 0, stdout: Buffer.from('6.5\n'), stderr: ''};
    };
    const p = createOpenAi(
      {OPENAI_API_KEY: KEY},
      {fetch: okFetch(new Uint8Array([1, 2, 3]), calls), run},
    );
    const dir = mkdir();
    const r = await p.synthesize(req(dir));
    expect(calls[0]?.url).toBe('https://api.openai.com/v1/audio/speech');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({
      model: 'gpt-4o-mini-tts',
      input: 'hello brave new world',
      voice: 'alloy',
      response_format: 'mp3',
    });
    expect(r.durationSec).toBeCloseTo(7.2, 5);
    expect(r.cached).toBe(false);
    expect(r.words.map((w) => w.text)).toEqual(['hello', 'brave', 'new', 'world']);
    expect(r.words.at(-1)?.endMs).toBe(7200);
    expect(fs.existsSync(r.audioPath as string)).toBe(true);
  });

  it('uses the wav header (no ffprobe) and floors at 4 s', async () => {
    const run: Runner = async () => {
      throw new Error('should not run');
    };
    const p = createOpenAi({OPENAI_API_KEY: KEY}, {fetch: okFetch(wav(1)), run});
    const r = await p.synthesize(req(mkdir(), {outputFormat: 'wav'}));
    expect(r.durationSec).toBe(4);
  });

  it('serves the second call from cache without fetching', async () => {
    const dir = mkdir();
    let n = 0;
    const f = (async () => {
      n++;
      return new Response(Buffer.from(wav(5)));
    }) as unknown as typeof fetch;
    const p = createOpenAi({OPENAI_API_KEY: KEY}, {fetch: f});
    await p.synthesize(req(dir, {outputFormat: 'wav'}));
    const again = await p.synthesize(req(dir, {outputFormat: 'wav'}));
    expect(again.cached).toBe(true);
    expect(n).toBe(1);
  });

  it('retries 429 then succeeds', async () => {
    let n = 0;
    const f = (async () => {
      n++;
      return n < 3 ? new Response('slow down', {status: 429}) : new Response(Buffer.from(wav(5)));
    }) as unknown as typeof fetch;
    const p = createOpenAi({OPENAI_API_KEY: KEY}, {fetch: f, retry: noSleep});
    const r = await p.synthesize(req(mkdir(), {outputFormat: 'wav'}));
    expect(n).toBe(3);
    expect(r.durationSec).toBeCloseTo(5.7, 5);
  });

  it('maps 401 to auth with the key redacted', async () => {
    const f = (async () =>
      new Response(JSON.stringify({error: {message: `bad key ${KEY}`}}), {
        status: 401,
      })) as unknown as typeof fetch;
    const p = createOpenAi({OPENAI_API_KEY: KEY}, {fetch: f, retry: noSleep});
    const e = await p.synthesize(req(mkdir())).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(TtsError);
    expect((e as TtsError).code).toBe('auth');
    expect((e as TtsError).message).not.toContain(KEY);
  });

  it('maps network failures, missing key, oversize input and missing ffprobe', async () => {
    const boom = (async () => {
      throw new Error(`down ${KEY}`);
    }) as unknown as typeof fetch;
    const e1 = await createOpenAi({OPENAI_API_KEY: KEY}, {fetch: boom, retry: {delaysMs: []}})
      .synthesize(req(mkdir()))
      .then(
        () => {
          throw new Error('expected rejection');
        },
        (x: unknown) => x as TtsError,
      );
    expect(e1.code).toBe('network');
    expect(e1.message).not.toContain(KEY);

    const e2 = await createOpenAi({})
      .synthesize(req(mkdir()))
      .then(
        () => {
          throw new Error('expected rejection');
        },
        (x: unknown) => x as TtsError,
      );
    expect(e2.code).toBe('auth');

    const e3 = await createOpenAi({OPENAI_API_KEY: KEY})
      .synthesize(req(mkdir(), {text: 'a'.repeat(4097)}))
      .then(
        () => {
          throw new Error('expected rejection');
        },
        (x: unknown) => x as TtsError,
      );
    expect(e3.code).toBe('bad-request');

    const run: Runner = async () => {
      throw Object.assign(new Error('spawn ffprobe ENOENT'), {code: 'ENOENT'});
    };
    const e4 = await createOpenAi({OPENAI_API_KEY: KEY}, {fetch: okFetch(new Uint8Array([1])), run})
      .synthesize(req(mkdir()))
      .then(
        () => {
          throw new Error('expected rejection');
        },
        (x: unknown) => x as TtsError,
      );
    expect(e4.code).toBe('unavailable');
  });

  it('estimate counts characters without a network', () => {
    const p = createOpenAi({});
    expect(
      p.estimate([
        {id: 'a', text: 'abc'},
        {id: 'b', text: 'de'},
      ]).characters,
    ).toBe(5);
  });
});
