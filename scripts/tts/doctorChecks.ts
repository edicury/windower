// Per-provider doctor checks (5.A.3). Pure: binaries/files/env are injected so tests need no machine setup.
import {existsSync} from 'node:fs';
import {PROVIDER_META, selectProvider, type Env, type SelectionSource} from './providers.js';

export interface ProviderCheck {
  name: string;
  level: 'pass' | 'warn' | 'fail';
  message: string;
  fix?: string;
}

export interface ProviderCheckDeps {
  env: Env;
  hasBinary: (name: string) => boolean;
  fileExists?: (p: string) => boolean;
}

/** Piper is configured by env: PIPER_BIN (default "piper") and PIPER_MODEL (path to the .onnx voice). */
export function providerChecks(
  opts: {flag?: string; noVoice?: boolean; config?: {provider?: string}},
  deps: ProviderCheckDeps,
): {id: string; source: SelectionSource; checks: ProviderCheck[]} {
  const {env} = deps;
  const fileExists = deps.fileExists ?? existsSync;
  const {id, source} = selectProvider({...opts, env});
  const meta = PROVIDER_META[id];
  const checks: ProviderCheck[] = [];
  const explicit = source === 'flag';
  if (!meta) {
    checks.push({
      name: 'provider',
      level: 'fail',
      message: `unknown provider "${id}" (source: ${source})`,
      fix: `Known: ${Object.keys(PROVIDER_META).join(', ')}.`,
    });
    return {id, source, checks};
  }
  checks.push({name: 'provider', level: 'pass', message: `${id} (source: ${source})`});
  if (meta.envVar) {
    const present = Boolean(env[meta.envVar]?.trim());
    if (present) checks.push({name: 'api-key', level: 'pass', message: `${meta.envVar} is set`});
    else
      checks.push({
        name: 'api-key',
        level: explicit ? 'fail' : 'warn',
        message: `${meta.envVar} is not set`,
        fix: `Export ${meta.envVar} in your shell (never in files), or render silent with --no-voice.`,
      });
  }
  if (id === 'piper') {
    const bin = env.PIPER_BIN?.trim() || 'piper';
    const level = explicit ? 'fail' : 'warn';
    if (!deps.hasBinary(bin))
      checks.push({
        name: 'piper-binary',
        level,
        message: `${bin} not found on PATH`,
        fix: 'Install Piper or set PIPER_BIN; or use --no-voice.',
      });
    else checks.push({name: 'piper-binary', level: 'pass', message: `${bin} found`});
    const model = env.PIPER_MODEL?.trim();
    if (!model || !fileExists(model))
      checks.push({
        name: 'piper-model',
        level,
        message: model ? `model not found: ${model}` : 'PIPER_MODEL is not set',
        fix: 'Download a Piper voice (.onnx) and set PIPER_MODEL to its path; or use --no-voice.',
      });
    else checks.push({name: 'piper-model', level: 'pass', message: `model present: ${model}`});
  }
  if (meta.voiced && meta.timing === 'estimated') {
    checks.push(
      deps.hasBinary('ffprobe')
        ? {name: 'ffprobe', level: 'pass', message: 'ffprobe available (audio duration)'}
        : {
            name: 'ffprobe',
            level: 'fail',
            message: `ffprobe not on PATH; ${id} audio duration cannot be measured`,
            fix: 'Install ffmpeg (macOS: brew install ffmpeg).',
          },
    );
  }
  checks.push({name: 'egress', level: 'pass', message: meta.egress});
  return {id, source, checks};
}
