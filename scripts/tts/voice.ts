// One place that decides which voice and model a run uses: flag > .windower.json > provider default.
import {PROVIDER_META} from './providers.js';

export type ValueSource = 'flag' | 'config' | 'default';

export interface ResolvedVoice {
  voiceId: string;
  modelId: string;
  voiceSource: ValueSource;
  modelSource: ValueSource;
}

export function resolveVoice(opts: {
  flags?: {voice?: string; model?: string};
  config?: {voice?: string; model?: string};
  provider: string;
}): ResolvedVoice {
  const meta = PROVIDER_META[opts.provider];
  const pick = (flag: string | undefined, cfg: string | undefined, dflt: string | undefined) =>
    flag
      ? {value: flag, source: 'flag' as const}
      : cfg
        ? {value: cfg, source: 'config' as const}
        : {value: dflt ?? 'default', source: 'default' as const};
  const v = pick(opts.flags?.voice, opts.config?.voice, meta?.defaultVoice);
  const m = pick(opts.flags?.model, opts.config?.model, meta?.defaultModel);
  return {voiceId: v.value, modelId: m.value, voiceSource: v.source, modelSource: m.source};
}

/** Returns an error message when a --voice/--model value is empty or contains whitespace. */
export function voiceFlagProblem(
  name: 'voice' | 'model',
  value: string | undefined,
): string | null {
  if (value === undefined) return null;
  if (value === '' || /\s/.test(value))
    return `--${name} must be a non-empty id without whitespace (got ${JSON.stringify(value)})`;
  return null;
}
