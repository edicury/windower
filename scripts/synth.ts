// ve:synth <run-dir>: narration -> per-scene audio + word timings via the selected TtsProvider.
// Writes <run>/synth.json (consumed by timing/prepare) and <run>/audio/ (cache).
import {existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {approvalProblem} from './approval.js';
import {EXIT} from './lib.js';
import './tts/index.js';
import {cacheKey, readCache, writeCache} from './tts/cache.js';
import {loadConfig} from './tts/config.js';
import {resolveVoice, voiceFlagProblem} from './tts/voice.js';
import {NullTts} from './tts/null.js';
import {PROVIDER_META, getProvider, selectProvider, type Env} from './tts/providers.js';
import {redactKey} from './tts/retry.js';
import {textHash, type SynthFile, type SynthSceneEntry} from './tts/synthfile.js';
import {TtsError, type SynthResult} from './tts/types.js';

export const SYNTH_USAGE =
  'Usage: synth <run-dir> [--provider <id>] [--no-voice] [--fallback-silent]\n' +
  '             [--voice <id>] [--model <id>]\n' +
  '  Writes <run-dir>/synth.json and <run-dir>/audio/. Needs an approved storyboard.';

export class SynthError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
  }
}

export interface SynthOptions {
  provider?: string;
  voice?: string;
  model?: string;
  noVoice?: boolean;
  fallbackSilent?: boolean;
  env?: Env;
  log?: (m: string) => void;
}

export interface SynthSummary {
  provider: string;
  billedCharacters: number;
  cachedCharacters: number;
  file: SynthFile | null;
}

function secrets(env: Env): string[] {
  return Object.entries(env)
    .filter(([k, v]) => /key|secret|token/i.test(k) && v && v.length >= 8)
    .map(([, v]) => v as string);
}

function scrub(text: string, env: Env): string {
  let out = redactKey(text);
  for (const s of secrets(env)) out = redactKey(out, s);
  return out;
}

export async function synth(runDirArg: string, opts: SynthOptions = {}): Promise<SynthSummary> {
  for (const n of ['voice', 'model'] as const) {
    const p = voiceFlagProblem(n, opts[n]);
    if (p) throw new SynthError(p, EXIT.validation);
  }
  const env = opts.env ?? process.env;
  const log = opts.log ?? (() => undefined);
  const runDir = path.resolve(runDirArg);
  const sbFile = path.join(runDir, 'storyboard.json');
  const problem = approvalProblem(sbFile);
  if (problem) throw new SynthError(problem, EXIT.validation);
  const sb = JSON.parse(readFileSync(sbFile, 'utf8')) as {
    repoRoot?: string;
    scenes?: {id: string; narration: string}[];
  };
  if (!Array.isArray(sb.scenes) || sb.scenes.some((s) => typeof s?.narration !== 'string'))
    throw new SynthError(
      `${sbFile}: every scene needs a string "narration"; run validate first.`,
      EXIT.validation,
    );
  const repoRoot = path.resolve(runDir, sb.repoRoot ?? '.');
  let config;
  try {
    config = loadConfig(repoRoot);
  } catch (e) {
    throw new SynthError((e as Error).message, EXIT.validation);
  }
  const sel = selectProvider({flag: opts.provider, noVoice: opts.noVoice, config, env});
  const meta = PROVIDER_META[sel.id];
  const synthFile = path.join(runDir, 'synth.json');

  let provider;
  try {
    provider = getProvider(sel.id, env);
  } catch (e) {
    throw providerError(e, env);
  }
  log(`provider: ${sel.id} (${sel.source}); ${meta?.egress ?? 'see provider docs'}`);

  if (sel.id === 'null') {
    rmSync(synthFile, {force: true});
    log('silent narration: no synth.json written, timing uses reading speed.');
    return {provider: 'null', billedCharacters: 0, cachedCharacters: 0, file: null};
  }

  const audioDir = path.join(runDir, 'audio');
  mkdirSync(audioDir, {recursive: true});
  const {voiceId, modelId, voiceSource, modelSource} = resolveVoice({
    flags: {voice: opts.voice, model: opts.model},
    config,
    provider: sel.id,
  });
  log(`voice: ${voiceId} (${voiceSource}); model: ${modelId} (${modelSource})`);
  const outputFormat = meta?.outputFormat ?? 'mp3';
  const fallback = new NullTts();
  const entries: SynthSceneEntry[] = [];
  let billed = 0;
  let cachedChars = 0;

  for (const [i, s] of sb.scenes.entries()) {
    const req = {
      sceneId: s.id,
      text: s.narration,
      previousText: sb.scenes[i - 1]?.narration,
      nextText: sb.scenes[i + 1]?.narration,
      voiceId,
      modelId,
      outputFormat,
      audioDir,
    };
    const key = cacheKey({
      provider: provider.name,
      voiceId,
      modelId,
      outputFormat,
      text: req.text,
      previousText: req.previousText,
      nextText: req.nextText,
    });
    let res: SynthResult | null = readCache(audioDir, key);
    let fellBack = false;
    if (!res) {
      try {
        const r = await provider.synthesize(req);
        res = r.audioPath
          ? writeCache(audioDir, key, r, readFileSync(r.audioPath))
          : writeCache(audioDir, key, r);
        res = {...res, cached: r.cached};
      } catch (e) {
        if (opts.fallbackSilent) {
          log(`warning: scene ${s.id}: ${scrub((e as Error).message, env)}; using silent timing.`);
          res = await fallback.synthesize(req);
          fellBack = true;
        } else {
          throw providerError(e, env, s.id);
        }
      }
    }
    const chars = s.narration.length;
    if (!fellBack) {
      if (res.cached) cachedChars += chars;
      else billed += chars;
    }
    const rel = res.audioPath ? path.relative(runDir, res.audioPath) : null;
    entries.push({
      id: s.id,
      audioPath: rel,
      durationSec: res.durationSec,
      words: res.words,
      cached: res.cached,
      textHash: textHash(s.narration),
      ...(fellBack ? {fallback: true} : {}),
    });
  }
  const file: SynthFile = {version: 1, provider: sel.id, scenes: entries};
  writeFileSync(synthFile, JSON.stringify(file, null, 2));
  log(`billed ${billed} characters, cached ${cachedChars} characters`);
  return {provider: sel.id, billedCharacters: billed, cachedCharacters: cachedChars, file};
}

function providerError(e: unknown, env: Env, sceneId?: string): SynthError {
  const where = sceneId ? `scene ${sceneId}: ` : '';
  const msg = scrub((e as Error).message ?? String(e), env);
  if (e instanceof TtsError) {
    const hint =
      e.code === 'auth'
        ? 'The API key was rejected; check it, or rerun with --no-voice for silent narration.'
        : e.code === 'network'
          ? 'The provider is unreachable; rerun with --no-voice for silent narration, or retry later.'
          : e.code === 'unavailable'
            ? 'Pick an available provider with --provider, or use --no-voice.'
            : 'Completed scenes are cached, so a rerun resumes. --fallback-silent keeps going with silent timing for failed scenes.';
    return new SynthError(`${where}${msg}\n${hint}`, EXIT.provider);
  }
  return new SynthError(`${where}${msg}`, EXIT.error);
}

async function main(): Promise<void> {
  const {values, positionals} = parseArgs({
    options: {
      provider: {type: 'string'},
      voice: {type: 'string'},
      model: {type: 'string'},
      'no-voice': {type: 'boolean'},
      'fallback-silent': {type: 'boolean'},
    },
    allowPositionals: true,
  });
  const target = positionals[0];
  if (!target) {
    console.error(SYNTH_USAGE);
    process.exit(EXIT.validation);
  }
  let dir = path.resolve(target);
  if (existsSync(dir) && path.basename(dir) === 'storyboard.json') dir = path.dirname(dir);
  if (!existsSync(dir)) {
    console.error(`run dir not found: ${dir}`);
    process.exit(EXIT.validation);
  }
  try {
    await synth(dir, {
      provider: values.provider,
      voice: values.voice,
      model: values.model,
      noVoice: values['no-voice'],
      fallbackSilent: values['fallback-silent'],
      log: (m) => console.error(m),
    });
  } catch (e) {
    if (e instanceof SynthError) {
      console.error(e.message);
      process.exit(e.exitCode);
    }
    console.error(`synth failed unexpectedly: ${scrub((e as Error).message, process.env)}`);
    process.exit(EXIT.error);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
