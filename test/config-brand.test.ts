import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {loadConfig, loadConfigWithWarnings} from '../scripts/tts/config.js';
import {contrastRatio} from '../template/src/brand.js';
import {prepare, PrepareError} from '../scripts/prepare.js';

const repo = (cfg: unknown, files: Record<string, string | Buffer> = {}) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 've-cfg-'));
  fs.writeFileSync(path.join(d, '.windower.json'), JSON.stringify(cfg));
  for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(d, n), c);
  return d;
};
const brand = {primary: '#0A84FF', background: '#0B0D12'};

describe('.windower.json brand + defaultLengthSec', () => {
  it('accepts a full brand and normalizes colors', () => {
    const d = repo(
      {
        brand: {...brand, accent: '#fff', text: '#eeeeee', font: 'Open Sans-2', logo: 'l.svg'},
        defaultLengthSec: 90,
      },
      {'l.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>'},
    );
    const c = loadConfig(d);
    expect(c.brand).toMatchObject({primary: '#0a84ff', background: '#0b0d12', font: 'Open Sans-2'});
    expect(c.brand?.logoFile).toBe(path.join(d, 'l.svg'));
    expect(c.defaultLengthSec).toBe(90);
  });
  it.each([
    [{brand: {...brand, primary: 'blue'}}, /brand\.primary/],
    [{brand: {background: '#000'}}, /brand\.primary" is required/],
    [{brand: {...brand, text: '#12345'}}, /brand\.text/],
    [{brand: {...brand, font: 'x; } body{'}}, /brand\.font/],
    [{brand: {...brand, font: 'Evil</style>'}}, /brand\.font/],
    [{brand: {...brand, logo: 'missing.svg'}}, /brand\.logo" file not found/],
    [{brand: {...brand, logo: 'l.gif'}}, /brand\.logo" must be an \.svg or \.png/],
    [{brand: 'red'}, /"brand" must be an object/],
    [{defaultLengthSec: 30}, /defaultLengthSec/],
    [{defaultLengthSec: 300}, /defaultLengthSec/],
    [{defaultLengthSec: '90'}, /defaultLengthSec/],
  ])('rejects %j with the field path', (cfg, re) => {
    expect(() => loadConfig(repo(cfg))).toThrow(re);
  });
  it('defaults logoPosition to unset and accepts every corner', () => {
    expect(loadConfig(repo({brand})).brand?.logoPosition).toBeUndefined();
    for (const p of ['top-left', 'top-right', 'bottom-left', 'bottom-right'])
      expect(loadConfig(repo({brand: {...brand, logoPosition: p}})).brand?.logoPosition).toBe(p);
  });
  it('rejects an invalid logoPosition', () => {
    expect(() => loadConfig(repo({brand: {...brand, logoPosition: 'middle'}}))).toThrow(
      /brand\.logoPosition/,
    );
  });
  it('rejects an oversized logo', () => {
    const d = repo({brand: {...brand, logo: 'big.png'}}, {'big.png': Buffer.alloc(300 * 1024)});
    expect(() => loadConfig(d)).toThrow(/brand\.logo.*limit/);
  });
  it('warns on unknown keys, top-level and in brand', () => {
    const {warnings} = loadConfigWithWarnings(repo({brand: {...brand, shade: 1}, wat: true}));
    expect(warnings).toEqual([
      '.windower.json: unknown key "wat" ignored',
      '.windower.json: unknown key "brand.shade" ignored',
    ]);
  });
  it('computes WCAG contrast', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0);
    expect(contrastRatio('#777777', '#808080')).toBeLessThan(4.5);
  });
});

describe('prepare threads brand into props.json', () => {
  const run = async (cfg: unknown | null, files: Record<string, string> = {}) => {
    const d = repo(cfg ?? {}, files);
    if (cfg === null) fs.rmSync(path.join(d, '.windower.json'));
    fs.cpSync('fixtures/repos/sample/src', path.join(d, 'src'), {recursive: true});
    const w = fs.mkdtempSync(path.join(os.tmpdir(), 've-brand-'));
    fs.cpSync('fixtures/storyboards/minimal.json', path.join(w, 'storyboard.json'));
    const logs: string[] = [];
    const out = await prepare(path.join(w, 'storyboard.json'), {
      repoRoot: d,
      allowUnapproved: true,
      publicDir: path.join(w, 'public'),
      log: (m) => logs.push(m),
    }).catch((e) => e as Error);
    return {out, logs, w};
  };
  it('no config -> no brand key', async () => {
    const {w} = await run(null);
    expect(JSON.parse(fs.readFileSync(path.join(w, 'props.json'), 'utf8'))).not.toHaveProperty(
      'brand',
    );
  });
  it('embeds colors, font and logo data URI', async () => {
    const {w} = await run(
      {brand: {...brand, logo: 'l.svg', font: 'Georgia'}},
      {'l.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>'},
    );
    const props = JSON.parse(fs.readFileSync(path.join(w, 'props.json'), 'utf8'));
    expect(props.brand).toMatchObject({primary: '#0a84ff', background: '#0b0d12', font: 'Georgia'});
    expect(props.brand.logo).toMatch(/^data:image\/svg\+xml;base64,/);
  });
  it('warns on low text/background contrast', async () => {
    const {logs} = await run({brand: {primary: '#ff0000', background: '#ffffff', text: '#cccccc'}});
    expect(logs.join('\n')).toMatch(/contrast is 1\.\d:1/);
  });
  it('invalid config -> PrepareError exit 2', async () => {
    const {out} = await run({brand: {primary: 'x', background: '#000'}});
    expect(out).toBeInstanceOf(PrepareError);
    expect((out as PrepareError).exitCode).toBe(2);
    expect((out as PrepareError).message).toContain('brand.primary');
  });
});
