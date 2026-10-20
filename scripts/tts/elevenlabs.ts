// ElevenLabs provider: with-timestamps endpoint, word timing from alignment (contract §3, §5, §6).
import {cacheKey, readCache, writeCache} from './cache.js';
import {registerProvider, type Env} from './providers.js';
import {mapHttpError, redactKey, withRetry, type RetryOptions} from './retry.js';
import {
  TtsError,
  type CostEstimate,
  type SynthRequest,
  type SynthResult,
  type TtsProvider,
} from './types.js';
import {estimateWords, wordsFromAlignment, type Alignment} from './words.js';

const BASE = 'https://api.elevenlabs.io/v1/text-to-speech';
const TAIL_SEC = 0.7;
const MIN_SEC = 4;
const WORDS_PER_SECOND = 2.9;

interface Response {
  audio_base64?: string;
  alignment?: Alignment | null;
  normalized_alignment?: Alignment | null;
}

const usable = (a: Alignment | null | undefined): a is Alignment =>
  !!a && Array.isArray(a.characters) && a.characters.length > 0;

export function createElevenLabs(
  env: Env,
  fetchImpl: typeof fetch = fetch,
  retry: RetryOptions = {},
): TtsProvider {
  const apiKey = env.ELEVENLABS_API_KEY?.trim();

  async function call(req: SynthRequest, key: string): Promise<Response> {
    const url = `${BASE}/${encodeURIComponent(req.voiceId)}/with-timestamps?output_format=${encodeURIComponent(req.outputFormat)}`;
    const body = {
      text: req.text,
      model_id: req.modelId,
      ...(req.previousText ? {previous_text: req.previousText} : {}),
      ...(req.nextText ? {next_text: req.nextText} : {}),
      ...(req.voiceSettings ? {voice_settings: req.voiceSettings} : {}),
    };
    let res: globalThis.Response;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: {'xi-api-key': key, 'content-type': 'application/json'},
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new TtsError(
        `network error reaching ElevenLabs: ${redactKey((e as Error).message ?? String(e), key)}. Re-run with --no-voice to render without narration.`,
        {code: 'network', retryable: false},
      );
    }
    if (!res.ok) {
      throw mapHttpError(
        res.status,
        await res.text().catch(() => ''),
        res.headers.get('retry-after'),
        key,
      );
    }
    return (await res.json()) as Response;
  }

  return {
    name: 'elevenlabs',
    timing: 'word',

    estimate(scenes) {
      const characters = scenes.reduce((n, s) => n + s.text.length, 0);
      return {
        characters,
        provider: 'elevenlabs',
        note: 'ElevenLabs bills per character; the rate depends on your plan and model',
      } satisfies CostEstimate;
    },

    async synthesize(req): Promise<SynthResult> {
      const ck = cacheKey({
        provider: 'elevenlabs',
        voiceId: req.voiceId,
        modelId: req.modelId,
        outputFormat: req.outputFormat,
        voiceSettings: req.voiceSettings,
        text: req.text,
        previousText: req.previousText,
        nextText: req.nextText,
      });
      if (req.audioDir) {
        const hit = readCache(req.audioDir, ck);
        if (hit) return hit;
      }
      if (!apiKey)
        throw new TtsError(
          'ELEVENLABS_API_KEY is not set. Export it in your environment, or re-run with --no-voice for a silent video.',
          {code: 'auth', retryable: false},
        );
      const j = await withRetry(() => call(req, apiKey), retry);
      const align = usable(j.alignment)
        ? j.alignment
        : usable(j.normalized_alignment)
          ? j.normalized_alignment
          : null;
      if (!j.audio_base64)
        throw new TtsError('ElevenLabs response had no audio_base64', {
          code: 'server',
          retryable: false,
        });
      const audio = Buffer.from(j.audio_base64, 'base64');
      let durationSec: number;
      let words: SynthResult['words'];
      if (align) {
        const ends = align.character_end_times_seconds;
        durationSec = Math.max((ends[ends.length - 1] ?? 0) + TAIL_SEC, MIN_SEC);
        words = wordsFromAlignment(align);
      } else {
        console.warn(
          `elevenlabs: no alignment for scene ${req.sceneId}; using reading-speed word timing`,
        );
        const n = req.text.split(/\s+/).filter(Boolean).length;
        durationSec = Math.max(n / WORDS_PER_SECOND + 0.9, MIN_SEC);
        words = estimateWords(req.text, durationSec);
      }
      if (req.audioDir) return writeCache(req.audioDir, ck, {durationSec, words}, audio);
      return {audioPath: null, durationSec, words, cached: false};
    },
  };
}

registerProvider('elevenlabs', (env) => createElevenLabs(env));
