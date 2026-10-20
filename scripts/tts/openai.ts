// OpenAI text-to-speech provider (contract §1.1). timing "estimated": words spread across audio length.
// Verified 2026-10-20 (OpenAI TTS guide + API reference via web search; the reference page itself returned 403):
//  - POST https://api.openai.com/v1/audio/speech, Authorization: Bearer $OPENAI_API_KEY, JSON body
//    {model, input, voice, response_format, instructions?}; response body is the raw audio bytes.
//  - input limit 4096 characters; models tts-1, tts-1-hd, gpt-4o-mini-tts (instructions only on the last).
//  - response_format: mp3 (default), opus, aac, flac, wav, pcm.
//  - voices: alloy, ash, ballad, coral, echo, fable, nova, onyx, sage, shimmer, verse, marin, cedar
//    [?] the guide cites both 11 and 13 built-ins and tts-1 supports a subset, so voice ids are not
//    validated here; the API rejects unknown ones (HTTP 400).
//  - [?] pricing is not verified: estimate() reports characters only.
// Duration: wav is read from its header; every other format is measured with ffprobe (a project
// requirement, see doctor.ts) over stdin.
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {cacheKey, readCache, writeCache} from './cache.js';
import {registerProvider, type Env} from './providers.js';
import {mapHttpError, redactKey, withRetry, type RetryOptions} from './retry.js';
import {TtsError, type TtsProvider} from './types.js';
import {estimateWords} from './words.js';

const TAIL_SEC = 0.7;
const MIN_SEC = 4;
export const OPENAI_MAX_INPUT_CHARS = 4096;
const ENDPOINT = 'https://api.openai.com/v1/audio/speech';

export interface RunResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
}
/** Runs a binary; rejects with an ENOENT-coded error when it is missing. */
export type Runner = (cmd: string, args: string[], input?: Buffer | string) => Promise<RunResult>;

export const defaultRunner: Runner = (cmd, args, input) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {stdio: ['pipe', 'pipe', 'pipe']});
    const out: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({code, stdout: Buffer.concat(out), stderr: err}));
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });

/** Duration in seconds from a PCM WAV header (RIFF, fmt + data chunks); null if unparseable. */
export function wavDurationSec(b: Uint8Array): number | null {
  const buf = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  if (
    buf.length < 44 ||
    buf.toString('ascii', 0, 4) !== 'RIFF' ||
    buf.toString('ascii', 8, 12) !== 'WAVE'
  )
    return null;
  let byteRate = 0;
  let pos = 12;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    let size = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ' && pos + 20 <= buf.length) byteRate = buf.readUInt32LE(pos + 16);
    if (id === 'data') {
      // streamed WAVs may carry 0 or 0xFFFFFFFF; fall back to the bytes present
      if (size === 0 || size === 0xffffffff || pos + 8 + size > buf.length)
        size = buf.length - pos - 8;
      return byteRate > 0 ? size / byteRate : null;
    }
    pos += 8 + size + (size % 2);
  }
  return null;
}

export interface OpenAiDeps {
  fetch?: typeof fetch;
  run?: Runner;
  retry?: RetryOptions;
}

export function createOpenAi(env: Env, deps: OpenAiDeps = {}): TtsProvider {
  const doFetch = deps.fetch ?? fetch;
  const run = deps.run ?? defaultRunner;

  async function measure(audio: Uint8Array, format: string): Promise<number> {
    if (format === 'wav') {
      const d = wavDurationSec(audio);
      if (d !== null) return d;
    }
    let r: RunResult;
    try {
      r = await run(
        'ffprobe',
        ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', '-i', 'pipe:0'],
        Buffer.from(audio),
      );
    } catch {
      throw new TtsError('ffprobe not found; install ffmpeg (macOS: brew install ffmpeg)', {
        code: 'unavailable',
        retryable: false,
      });
    }
    const d = Number.parseFloat(r.stdout.toString('utf8').trim());
    if (r.code !== 0 || !(d > 0))
      throw new TtsError('could not measure the duration of the OpenAI audio with ffprobe', {
        code: 'server',
        retryable: false,
      });
    return d;
  }

  return {
    name: 'openai',
    timing: 'estimated',
    estimate(scenes) {
      const characters = scenes.reduce((n, s) => n + s.text.length, 0);
      return {
        characters,
        provider: 'openai',
        note: 'narration text is sent to OpenAI; price not estimated',
      };
    },
    async synthesize(req) {
      const key = env.OPENAI_API_KEY?.trim();
      if (!key) throw new TtsError('OPENAI_API_KEY is not set', {code: 'auth', retryable: false});
      if (req.text.length > OPENAI_MAX_INPUT_CHARS)
        throw new TtsError(
          `scene narration is ${req.text.length} characters; OpenAI accepts at most ${OPENAI_MAX_INPUT_CHARS}`,
          {code: 'bad-request', retryable: false},
        );
      const dir = req.audioDir ?? path.join(os.tmpdir(), 'windower-tts');
      const ck = cacheKey({
        provider: 'openai',
        voiceId: req.voiceId,
        modelId: req.modelId,
        outputFormat: req.outputFormat,
        text: req.text,
      });
      const hit = readCache(dir, ck);
      if (hit) return hit;

      const audio = await withRetry(async () => {
        let res: Response;
        try {
          res = await doFetch(ENDPOINT, {
            method: 'POST',
            headers: {Authorization: `Bearer ${key}`, 'Content-Type': 'application/json'},
            body: JSON.stringify({
              model: req.modelId,
              input: req.text,
              voice: req.voiceId,
              response_format: req.outputFormat,
            }),
          });
        } catch (e) {
          throw new TtsError(`network error: ${redactKey((e as Error).message, key)}`, {
            code: 'network',
            retryable: true,
          });
        }
        if (!res.ok)
          throw mapHttpError(res.status, await res.text(), res.headers.get('retry-after'), key);
        return new Uint8Array(await res.arrayBuffer());
      }, deps.retry);

      const durationSec = Math.max((await measure(audio, req.outputFormat)) + TAIL_SEC, MIN_SEC);
      const words = estimateWords(req.text, durationSec);
      return writeCache(dir, ck, {durationSec, words}, audio);
    },
  };
}

registerProvider('openai', (env) => createOpenAi(env));
