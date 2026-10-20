// TtsProvider port (contracts/tts-provider.md §1). Shared by every provider and the pipeline.

export type SynthRequest = {
  sceneId: string;
  text: string;
  previousText?: string;
  nextText?: string;
  voiceId: string;
  modelId: string;
  outputFormat: string;
  /** Per-scene audio cache directory; when set, providers read and write the cache. */
  audioDir?: string;
  /** Provider voice settings (e.g. ElevenLabs stability, speed). */
  voiceSettings?: Record<string, unknown>;
};

export type SynthResult = {
  /** null for NullTts. */
  audioPath: string | null;
  durationSec: number;
  /** Real times if timing = "word"; otherwise estimated across the audio duration. */
  words: {text: string; startMs: number; endMs: number}[];
  cached: boolean;
};

export type CostEstimate = {characters: number; provider: string; note: string};

export interface TtsProvider {
  /** Registry id: "elevenlabs" | "openai" | "piper" | "null" | third-party. */
  readonly name: string;
  readonly timing: 'word' | 'estimated';
  /** No network. */
  estimate(scenes: {id: string; text: string}[]): CostEstimate;
  synthesize(req: SynthRequest): Promise<SynthResult>;
}

export type TtsErrorCode =
  'auth' | 'bad-request' | 'rate-limit' | 'server' | 'network' | 'unavailable';

export class TtsError extends Error {
  status?: number;
  retryable: boolean;
  code: TtsErrorCode;
  /** Server-requested wait before the next attempt (Retry-After). */
  retryAfterMs?: number;

  constructor(
    message: string,
    opts: {
      code: TtsErrorCode;
      status?: number;
      retryable?: boolean;
      retryAfterMs?: number;
    },
  ) {
    super(message);
    this.name = 'TtsError';
    this.code = opts.code;
    if (opts.status !== undefined) this.status = opts.status;
    this.retryable = opts.retryable ?? (opts.code === 'rate-limit' || opts.code === 'server');
    if (opts.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs;
  }
}

export interface ProviderMeta {
  id: string;
  /** Produces real narration audio (false only for null). */
  voiced: boolean;
  timing: 'word' | 'estimated';
  envVar?: string;
  defaultVoice: string;
  defaultModel: string;
  outputFormat: string;
  /** Data-egress statement (contract §1.1). */
  egress: string;
  /** A factory ships in this repo (flips as providers land). */
  implemented: boolean;
}
