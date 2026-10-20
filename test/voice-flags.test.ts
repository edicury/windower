import {mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {afterEach, describe, expect, it} from 'vitest';
import {buildSummary, renderSummary} from '../scripts/gateSummary.js';
import {SynthError, synth} from '../scripts/synth.js';
import {registerProvider} from '../scripts/tts/providers.js';
import {resolveVoice, voiceFlagProblem} from '../scripts/tts/voice.js';
import {estimateWords} from '../scripts/tts/words.js';
import type {SynthRequest, TtsProvider} from '../scripts/tts/types.js';
import {validateStoryboard} from '../scripts/validate-storyboard.js';

const calls: SynthRequest[] = [];
const fake: TtsProvider = {
  name: 'fakevoice',
  timing: 'word',
  estimate: (scenes) => ({characters: scenes.length, provider: 'fakevoice', note: 'fake'}),
  async synthesize(req) {
    calls.push(req);
    const dir = req.audioDir ?? os.tmpdir();
    mkdirSync(dir, {recursive: true});
    const audioPath = path.join(dir, `raw-${req.sceneId}.mp3`);
    writeFileSync(audioPath, Buffer.from('ID3fake'));
    return {audioPath, durationSec: 8, words: estimateWords(req.text, 8), cached: false};
  },
};
registerProvider('fakevoice', () => fake);
afterEach(() => {
  calls.length = 0;
});

function setup(): string {
  const run = mkdtempSync(path.join(os.tmpdir(), 've-voice-'));
  const sb = JSON.parse(readFileSync('fixtures/storyboards/minimal.json', 'utf8'));
  sb.approved = true;
  sb.repoRoot = path.resolve('fixtures/repos/sample');
  writeFileSync(path.join(run, 'storyboard.json'), JSON.stringify(sb));
  return run;
}

describe('resolveVoice', () => {
  it('flag beats config beats default, per field', () => {
    expect(resolveVoice({provider: 'openai'})).toEqual({
      voiceId: 'alloy',
      modelId: 'gpt-4o-mini-tts',
      voiceSource: 'default',
      modelSource: 'default',
    });
    const cfg = {voice: 'cv', model: 'cm'};
    expect(resolveVoice({provider: 'openai', config: cfg})).toMatchObject({
      voiceId: 'cv',
      modelId: 'cm',
      voiceSource: 'config',
      modelSource: 'config',
    });
    expect(resolveVoice({provider: 'openai', config: cfg, flags: {voice: 'fv'}})).toEqual({
      voiceId: 'fv',
      modelId: 'cm',
      voiceSource: 'flag',
      modelSource: 'config',
    });
    expect(resolveVoice({provider: 'openai', flags: {model: 'fm'}})).toMatchObject({
      voiceSource: 'default',
      modelId: 'fm',
      modelSource: 'flag',
    });
  });

  it('rejects empty or whitespace values', () => {
    expect(voiceFlagProblem('voice', undefined)).toBeNull();
    expect(voiceFlagProblem('voice', 'alloy')).toBeNull();
    expect(voiceFlagProblem('voice', '')).toMatch(/--voice/);
    expect(voiceFlagProblem('model', 'a b')).toMatch(/--model/);
  });
});

describe('synth honours --voice/--model', () => {
  it('passes flag values to the provider and misses the cache when they change', async () => {
    const run = setup();
    await synth(run, {provider: 'fakevoice', env: {}, voice: 'v1', model: 'm1'});
    expect(calls).toHaveLength(8);
    expect(calls[0]).toMatchObject({voiceId: 'v1', modelId: 'm1'});
    calls.length = 0;
    await synth(run, {provider: 'fakevoice', env: {}, voice: 'v1', model: 'm1'});
    expect(calls).toHaveLength(0);
    await synth(run, {provider: 'fakevoice', env: {}, voice: 'v2', model: 'm1'});
    expect(calls).toHaveLength(8);
    expect(calls[0]?.voiceId).toBe('v2');
    calls.length = 0;
    await synth(run, {provider: 'fakevoice', env: {}, voice: 'v2', model: 'm2'});
    expect(calls).toHaveLength(8);
    expect(calls[0]?.modelId).toBe('m2');
  });

  it('rejects an invalid flag before any provider call', async () => {
    const run = setup();
    await expect(synth(run, {provider: 'fakevoice', env: {}, voice: 'a b'})).rejects.toBeInstanceOf(
      SynthError,
    );
    expect(calls).toHaveLength(0);
  });
});

describe('gate summary voice', () => {
  const raw = JSON.parse(readFileSync('fixtures/storyboards/minimal.json', 'utf8')) as unknown;
  const validation = validateStoryboard(raw, {repoRoot: path.resolve('fixtures/repos/sample')});

  it('shows voice, model and sources; null provider shows none', () => {
    const voice = resolveVoice({provider: 'openai', flags: {voice: 'nova'}});
    const s = buildSummary(raw, validation, {provider: 'openai', voice});
    expect(s.voice).toEqual(voice);
    expect(renderSummary(s)).toContain('Voice id: nova (flag); model: gpt-4o-mini-tts (default)');
    const n = buildSummary(raw, validation, {provider: 'null'});
    expect(n.voice).toBeNull();
    expect(renderSummary(n)).not.toContain('Voice id:');
  });

  it('gate CLI rejects a bad --voice with exit 2', () => {
    const run = setup();
    const r = spawnSync('pnpm', ['exec', 'tsx', 'scripts/gate.ts', run, '--voice', 'a b'], {
      encoding: 'utf8',
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--voice');
  });
});
