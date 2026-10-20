import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import type {Runner} from '../scripts/tts/openai.js';
import {createPiper} from '../scripts/tts/piper.js';
import {getProvider} from '../scripts/tts/providers.js';
import type {SynthRequest, TtsError} from '../scripts/tts/types.js';

const tmp: string[] = [];
const mkdir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-piper-'));
  tmp.push(d);
  return d;
};
afterEach(() => {
  for (const d of tmp.splice(0)) fs.rmSync(d, {recursive: true, force: true});
});

function wav(seconds: number): Buffer {
  const rate = 22050 * 2;
  const data = Buffer.alloc(rate * seconds);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(22050, 24);
  h.writeUInt32LE(rate, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

const req = (dir: string, over: Partial<SynthRequest> = {}): SynthRequest => ({
  sceneId: 's1',
  text: 'local words only',
  voiceId: 'en_US-lessac-medium',
  modelId: 'piper',
  outputFormat: 'wav',
  audioDir: dir,
  ...over,
});

describe('piper provider', () => {
  it('registers itself and is estimated', () => {
    const p = getProvider('piper', {});
    expect(p.name).toBe('piper');
    expect(p.timing).toBe('estimated');
    expect(p.estimate([{id: 'a', text: 'abcd'}]).characters).toBe(4);
  });

  it('runs piper with text on stdin and reads the wav length', async () => {
    const seen: {cmd: string; args: string[]; input: unknown}[] = [];
    const run: Runner = async (cmd, args, input) => {
      seen.push({cmd, args, input});
      return {code: 0, stdout: Buffer.alloc(0), stderr: ''};
    };
    const p = createPiper(
      {PIPER_MODEL: '/m/v.onnx'},
      {run, fileExists: () => true, readFile: () => wav(6)},
    );
    const r = await p.synthesize(req(mkdir()));
    expect(seen[0]?.cmd).toBe('piper');
    expect(seen[0]?.args.slice(0, 3)).toEqual(['--model', '/m/v.onnx', '--output_file']);
    expect(seen[0]?.input).toBe('local words only');
    expect(r.durationSec).toBeCloseTo(6.7, 5);
    expect(r.words).toHaveLength(3);
    expect(r.cached).toBe(false);
    expect(fs.existsSync(r.audioPath as string)).toBe(true);
  });

  it('floors at 4 s, honours PIPER_BIN, and caches', async () => {
    let n = 0;
    const run: Runner = async (cmd) => {
      n++;
      expect(cmd).toBe('/opt/piper');
      return {code: 0, stdout: Buffer.alloc(0), stderr: ''};
    };
    const p = createPiper(
      {PIPER_MODEL: '/m/v.onnx', PIPER_BIN: '/opt/piper'},
      {run, fileExists: () => true, readFile: () => wav(1)},
    );
    const dir = mkdir();
    expect((await p.synthesize(req(dir))).durationSec).toBe(4);
    expect((await p.synthesize(req(dir))).cached).toBe(true);
    expect(n).toBe(1);
  });

  it('is unavailable without a model or when the file is missing', async () => {
    const p = createPiper({}, {fileExists: () => true});
    const e1 = await p.synthesize(req(mkdir())).then(
      () => {
        throw new Error('expected rejection');
      },
      (x: unknown) => x as TtsError,
    );
    expect(e1.code).toBe('unavailable');
    expect(e1.message).toContain('PIPER_MODEL');
    const q = createPiper({PIPER_MODEL: '/nope.onnx'}, {fileExists: () => false});
    const e2 = await q.synthesize(req(mkdir())).then(
      () => {
        throw new Error('expected rejection');
      },
      (x: unknown) => x as TtsError,
    );
    expect(e2.code).toBe('unavailable');
  });

  it('is unavailable when the binary is missing or fails', async () => {
    const missing: Runner = async () => {
      throw Object.assign(new Error('spawn piper ENOENT'), {code: 'ENOENT'});
    };
    const env = {PIPER_MODEL: '/m/v.onnx'};
    const e1 = await createPiper(env, {run: missing, fileExists: () => true})
      .synthesize(req(mkdir()))
      .then(
        () => {
          throw new Error('expected rejection');
        },
        (x: unknown) => x as TtsError,
      );
    expect(e1.code).toBe('unavailable');
    expect(e1.message).toContain('install');
    const failing: Runner = async () => ({code: 1, stdout: Buffer.alloc(0), stderr: 'bad model'});
    const e2 = await createPiper(env, {run: failing, fileExists: () => true})
      .synthesize(req(mkdir()))
      .then(
        () => {
          throw new Error('expected rejection');
        },
        (x: unknown) => x as TtsError,
      );
    expect(e2.code).toBe('unavailable');
    expect(e2.message).toContain('bad model');
  });
});
