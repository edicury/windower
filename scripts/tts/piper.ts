// Piper local TTS provider (contract §1.1). timing "estimated"; nothing leaves the machine.
// Verified 2026-10-20 (web):
//  - rhasspy/piper is archived (2025-10-06); development moved to OHF-Voice/piper1-gpl. Its CLI doc shows
//    `python3 -m piper -m <voice> -f out.wav -- 'text'` and `python3 -m piper.download_voices <voice>`.
//  - The classic CLI (`echo text | piper --model <voice>.onnx --output_file out.wav`) is what this uses.
//    [?] I could not confirm that piper1-gpl still reads stdin or accepts --model/--output_file; the
//    binary and flags are therefore configurable: PIPER_BIN (default "piper"), PIPER_ARGS_STYLE=short
//    switches to -m/-f.
//  - [?] the model location is not a Piper convention: it comes from PIPER_MODEL (path to the .onnx; the
//    .onnx.json sits beside it), or from a voice id that ends in ".onnx".
// Duration is read from the WAV header Piper writes. The cached file keeps cache.ts's ".mp3" name but
// holds WAV data; ffmpeg and browsers sniff content, not the extension.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {cacheKey, readCache, writeCache} from './cache.js';
import {defaultRunner, wavDurationSec, type Runner} from './openai.js';
import {registerProvider, type Env} from './providers.js';
import {TtsError, type TtsProvider} from './types.js';
import {estimateWords} from './words.js';

const TAIL_SEC = 0.7;
const MIN_SEC = 4;
const HINT =
  'install Piper (pip install piper-tts, or a release from github.com/OHF-Voice/piper1-gpl), download a voice (python3 -m piper.download_voices en_US-lessac-medium) and set PIPER_MODEL to its .onnx path';

export interface PiperDeps {
  run?: Runner;
  fileExists?: (p: string) => boolean;
  readFile?: (p: string) => Uint8Array;
  tmpDir?: () => string;
}

export function createPiper(env: Env, deps: PiperDeps = {}): TtsProvider {
  const run = deps.run ?? defaultRunner;
  const exists = deps.fileExists ?? ((p: string) => fs.existsSync(p));
  const readFile = deps.readFile ?? ((p: string) => fs.readFileSync(p));
  const bin = env.PIPER_BIN?.trim() || 'piper';

  return {
    name: 'piper',
    timing: 'estimated',
    estimate(scenes) {
      const characters = scenes.reduce((n, s) => n + s.text.length, 0);
      return {characters, provider: 'piper', note: 'local synthesis, nothing billed or sent'};
    },
    async synthesize(req) {
      const model = env.PIPER_MODEL?.trim() || (req.voiceId.endsWith('.onnx') ? req.voiceId : '');
      if (!model || !exists(model))
        throw new TtsError(
          `Piper voice model ${model ? `not found at ${model}` : 'not configured'}; ${HINT}`,
          {code: 'unavailable', retryable: false},
        );
      const dir = req.audioDir ?? path.join(os.tmpdir(), 'windower-tts');
      const ck = cacheKey({
        provider: 'piper',
        voiceId: model,
        modelId: req.modelId,
        outputFormat: 'wav',
        text: req.text,
      });
      const hit = readCache(dir, ck);
      if (hit) return hit;

      const tmp = path.join(
        deps.tmpDir ? deps.tmpDir() : os.tmpdir(),
        `windower-piper-${process.pid}-${ck.slice(0, 12)}.wav`,
      );
      const args =
        env.PIPER_ARGS_STYLE === 'short'
          ? ['-m', model, '-f', tmp]
          : ['--model', model, '--output_file', tmp];
      let r;
      try {
        r = await run(bin, args, req.text);
      } catch {
        throw new TtsError(`Piper binary "${bin}" not found; ${HINT}`, {
          code: 'unavailable',
          retryable: false,
        });
      }
      if (r.code !== 0)
        throw new TtsError(`piper exited with code ${r.code}: ${r.stderr.trim().slice(0, 300)}`, {
          code: 'unavailable',
          retryable: false,
        });
      let audio: Uint8Array;
      try {
        audio = readFile(tmp);
      } catch {
        throw new TtsError(`piper produced no output file; ${HINT}`, {
          code: 'unavailable',
          retryable: false,
        });
      } finally {
        fs.rmSync(tmp, {force: true});
      }
      const len = wavDurationSec(audio);
      if (len === null)
        throw new TtsError('piper output is not a readable WAV file', {
          code: 'unavailable',
          retryable: false,
        });
      const durationSec = Math.max(len + TAIL_SEC, MIN_SEC);
      const words = estimateWords(req.text, durationSec);
      return writeCache(dir, ck, {durationSec, words}, audio);
    },
  };
}

registerProvider('piper', (env) => createPiper(env));
