import {describe, expect, it, vi} from 'vitest';
import {listVoices} from '../scripts/tts/elevenlabs-voices.js';
import {run} from '../scripts/voices.js';
import {TtsError} from '../scripts/tts/types.js';

const KEY = 'sk_test_secretsecretsecret1234';
const body = {
  voices: [
    {
      voice_id: 'v1',
      name: 'Rachel',
      category: 'premade',
      description: 'calm narrator',
      labels: {accent: 'american'},
      preview_url: 'https://x/p.mp3',
    },
    {voice_id: 'v2', name: 'Adam', category: 'premade', description: null},
  ],
};
const fx = (res: Response) => vi.fn(async () => res) as unknown as typeof fetch;
const io = () => {
  const o: string[] = [];
  const e: string[] = [];
  return {o, e, io: {out: (s: string) => void o.push(s), err: (s: string) => void e.push(s)}};
};
const nosleep = {sleep: async () => {}};

describe('voices', () => {
  it('lists and maps voices with the key header', async () => {
    const f = fx(new Response(JSON.stringify(body)));
    const v = await listVoices({ELEVENLABS_API_KEY: KEY}, f, nosleep);
    expect(v).toEqual([
      {
        voiceId: 'v1',
        name: 'Rachel',
        category: 'premade',
        description: 'calm narrator',
        labels: {accent: 'american'},
        previewUrl: 'https://x/p.mp3',
      },
      {voiceId: 'v2', name: 'Adam', category: 'premade'},
    ]);
    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe('https://api.elevenlabs.io/v1/voices');
    expect((init.headers as Record<string, string>)['xi-api-key']).toBe(KEY);
  });

  it('filters with --search and emits JSON on stdout', async () => {
    const t = io();
    const code = await run(
      ['--json', '--search', 'rach'],
      {ELEVENLABS_API_KEY: KEY},
      fx(new Response(JSON.stringify(body))),
      t.io,
    );
    expect(code).toBe(0);
    const j = JSON.parse(t.o.join('')) as {voiceId: string}[];
    expect(j.map((x) => x.voiceId)).toEqual(['v1']);
    expect(t.e.join('')).toMatch(/Rachel/);
  });

  it('401 -> exit 4 with redacted message', async () => {
    const t = io();
    const code = await run(
      [],
      {ELEVENLABS_API_KEY: KEY},
      fx(new Response(JSON.stringify({detail: `bad ${KEY}`}), {status: 401})),
      t.io,
    );
    expect(code).toBe(4);
    expect(t.e.join('')).toMatch(/invalid/);
    expect(t.e.join('') + t.o.join('')).not.toContain(KEY);
  });

  it('missing key -> auth TtsError, no fetch', async () => {
    const f = vi.fn();
    await expect(listVoices({}, f as unknown as typeof fetch)).rejects.toMatchObject({
      code: 'auth',
    });
    await expect(listVoices({}, f as unknown as typeof fetch)).rejects.toBeInstanceOf(TtsError);
    await expect(listVoices({}, f as unknown as typeof fetch)).rejects.toThrow(/--no-voice/);
    expect(f).not.toHaveBeenCalled();
  });

  it('unsupported providers exit 2; key never printed', async () => {
    for (const p of ['openai', 'piper', 'nope']) {
      const t = io();
      expect(
        await run(
          ['--provider', p],
          {ELEVENLABS_API_KEY: KEY},
          vi.fn() as unknown as typeof fetch,
          t.io,
        ),
      ).toBe(2);
      expect(t.e.join('')).not.toContain(KEY);
    }
  });
});
