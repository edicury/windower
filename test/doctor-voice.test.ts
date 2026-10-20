import {describe, expect, it} from 'vitest';
import {providerChecks} from '../scripts/tts/doctorChecks.js';

const deps = (env: Record<string, string>, bins: string[] = ['ffprobe'], files: string[] = []) => ({
  env,
  hasBinary: (b: string) => bins.includes(b),
  fileExists: (p: string) => files.includes(p),
});

describe('providerChecks', () => {
  it('auto-detects from env, reports presence without the value', () => {
    const r = providerChecks({}, deps({ELEVENLABS_API_KEY: ['sk', 'secret', '123'].join('-')}));
    expect(r).toMatchObject({id: 'elevenlabs', source: 'env'});
    expect(JSON.stringify(r)).not.toContain('sk-secret-123');
    expect(r.checks.find((c) => c.name === 'api-key')?.level).toBe('pass');
    expect(r.checks.find((c) => c.name === 'egress')?.message).toContain('ElevenLabs');
  });

  it('missing key is a warning unless the provider was requested', () => {
    const cfg = providerChecks({config: {provider: 'openai'}}, deps({}));
    expect(cfg.checks.find((c) => c.name === 'api-key')).toMatchObject({level: 'warn'});
    expect(cfg.checks.find((c) => c.name === 'api-key')?.fix).toContain('--no-voice');
    const flag = providerChecks({flag: 'openai'}, deps({}));
    expect(flag.checks.find((c) => c.name === 'api-key')?.level).toBe('fail');
  });

  it('estimated providers need ffprobe', () => {
    const r = providerChecks({flag: 'openai'}, deps({OPENAI_API_KEY: 'x'}, []));
    expect(r.checks.find((c) => c.name === 'ffprobe')?.level).toBe('fail');
  });

  it('piper checks binary and model, egress is none', () => {
    const bad = providerChecks({flag: 'piper'}, deps({}, ['ffprobe']));
    expect(bad.checks.filter((c) => c.level === 'fail').map((c) => c.name)).toEqual([
      'piper-binary',
      'piper-model',
    ]);
    const ok = providerChecks(
      {flag: 'piper'},
      deps({PIPER_MODEL: '/m.onnx'}, ['ffprobe', 'piper'], ['/m.onnx']),
    );
    expect(ok.checks.every((c) => c.level === 'pass')).toBe(true);
    expect(ok.checks.find((c) => c.name === 'egress')?.message).toContain('nothing leaves');
  });

  it('--no-voice selects null', () => {
    const r = providerChecks({noVoice: true}, deps({ELEVENLABS_API_KEY: 'k'}));
    expect(r).toMatchObject({id: 'null', source: 'no-voice'});
  });
});
