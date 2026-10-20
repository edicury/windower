// Provider registry and selection (contract §1.1, §2). Concrete factories register themselves elsewhere.
import {NullTts} from './null.js';
import {TtsError, type ProviderMeta, type TtsProvider} from './types.js';

export const PROVIDER_META: Record<string, ProviderMeta> = {
  elevenlabs: {
    id: 'elevenlabs',
    voiced: true,
    timing: 'word',
    envVar: 'ELEVENLABS_API_KEY',
    defaultVoice: 'EXAVITQu4vr4xnSDxMaL',
    defaultModel: 'eleven_multilingual_v2',
    outputFormat: 'mp3_44100_128',
    egress: 'narration text is sent to ElevenLabs',
    implemented: false,
  },
  openai: {
    id: 'openai',
    voiced: true,
    timing: 'estimated',
    envVar: 'OPENAI_API_KEY',
    defaultVoice: 'alloy',
    defaultModel: 'gpt-4o-mini-tts',
    outputFormat: 'mp3',
    egress: 'narration text is sent to OpenAI',
    implemented: false,
  },
  piper: {
    id: 'piper',
    voiced: true,
    timing: 'estimated',
    defaultVoice: 'en_US-lessac-medium',
    defaultModel: 'piper',
    outputFormat: 'wav',
    egress: 'nothing leaves the machine',
    implemented: false,
  },
  null: {
    id: 'null',
    voiced: false,
    timing: 'estimated',
    defaultVoice: 'none',
    defaultModel: 'reading-speed',
    outputFormat: 'none',
    egress: 'nothing leaves the machine',
    implemented: true,
  },
};

export type Env = Record<string, string | undefined>;
export type ProviderFactory = (env: Env) => TtsProvider;

const factories = new Map<string, ProviderFactory>([['null', () => new NullTts()]]);

export function registerProvider(id: string, factory: ProviderFactory): void {
  factories.set(id, factory);
  const meta = PROVIDER_META[id];
  if (meta) meta.implemented = true;
}

export function getProvider(id: string, env: Env): TtsProvider {
  const f = factories.get(id);
  if (!f)
    throw new TtsError(`TTS provider "${id}" is not available (no implementation registered)`, {
      code: 'unavailable',
      retryable: false,
    });
  return f(env);
}

export type SelectionSource = 'flag' | 'no-voice' | 'config' | 'env' | 'default';

export function selectProvider(opts: {
  flag?: string;
  noVoice?: boolean;
  config?: {provider?: string};
  env: Env;
}): {id: string; source: SelectionSource} {
  if (opts.noVoice) return {id: 'null', source: 'no-voice'};
  if (opts.flag) return {id: opts.flag, source: 'flag'};
  if (opts.config?.provider) return {id: opts.config.provider, source: 'config'};
  for (const id of ['elevenlabs', 'openai']) {
    const v = opts.env[PROVIDER_META[id]?.envVar ?? ''];
    if (v && v.trim()) return {id, source: 'env'};
  }
  return {id: 'null', source: 'default'};
}
