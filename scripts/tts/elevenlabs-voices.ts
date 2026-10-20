// ElevenLabs voice listing: GET /v1/voices. Key from ELEVENLABS_API_KEY only; never echoed.
import type {Env} from './providers.js';
import {mapHttpError, redactKey, withRetry, type RetryOptions} from './retry.js';
import {TtsError} from './types.js';

const URL_VOICES = 'https://api.elevenlabs.io/v1/voices';

export interface VoiceInfo {
  voiceId: string;
  name: string;
  category?: string;
  description?: string;
  labels?: Record<string, string>;
  previewUrl?: string;
}

interface RawVoice {
  voice_id?: string;
  name?: string;
  category?: string;
  description?: string | null;
  labels?: Record<string, string> | null;
  preview_url?: string | null;
}

export async function listVoices(
  env: Env,
  fetchImpl: typeof fetch = fetch,
  retry: RetryOptions = {},
): Promise<VoiceInfo[]> {
  const key = env.ELEVENLABS_API_KEY?.trim();
  if (!key)
    throw new TtsError(
      'ELEVENLABS_API_KEY is not set. Export it in your environment to list voices; or re-run with --no-voice-free (no voice listing needed) / --no-voice for a silent video.',
      {code: 'auth', retryable: false},
    );
  const call = async (): Promise<RawVoice[]> => {
    let res: globalThis.Response;
    try {
      res = await fetchImpl(URL_VOICES, {headers: {'xi-api-key': key}});
    } catch (e) {
      throw new TtsError(
        `network error reaching ElevenLabs: ${redactKey((e as Error).message ?? String(e), key)}`,
        {code: 'network', retryable: false},
      );
    }
    if (!res.ok)
      throw mapHttpError(
        res.status,
        await res.text().catch(() => ''),
        res.headers.get('retry-after'),
        key,
      );
    const j = (await res.json()) as {voices?: RawVoice[]};
    return Array.isArray(j.voices) ? j.voices : [];
  };
  const raw = await withRetry(call, retry);
  return raw
    .filter((v) => v.voice_id)
    .map((v) => ({
      voiceId: v.voice_id as string,
      name: v.name ?? '',
      ...(v.category ? {category: v.category} : {}),
      ...(v.description ? {description: v.description} : {}),
      ...(v.labels && Object.keys(v.labels).length ? {labels: v.labels} : {}),
      ...(v.preview_url ? {previewUrl: v.preview_url} : {}),
    }));
}

export function filterVoices(voices: VoiceInfo[], search?: string): VoiceInfo[] {
  const q = search?.trim().toLowerCase();
  if (!q) return voices;
  return voices.filter((v) =>
    [v.name, v.voiceId, v.category, v.description, ...Object.values(v.labels ?? {})]
      .filter(Boolean)
      .some((s) => (s as string).toLowerCase().includes(q)),
  );
}
