import {cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {describe, expect, it} from 'vitest';
import {prepare, PrepareError} from '../scripts/prepare.js';

const tsx = (args: string[]) =>
  spawnSync('pnpm', ['exec', 'tsx', ...args], {encoding: 'utf8', cwd: process.cwd()});

describe('prepare', () => {
  it('writes timing, props and caption files for the minimal fixture', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 've-prep-'));
    cpSync('fixtures/storyboards/minimal.json', path.join(dir, 'storyboard.json'));
    const repo = path.resolve('fixtures/repos/sample');
    const {props, timing} = await prepare(path.join(dir, 'storyboard.json'), {repoRoot: repo});
    for (const f of ['props.json', 'timing.json', 'captions.srt', 'captions.vtt'])
      expect(existsSync(path.join(dir, f))).toBe(true);
    const onDisk = JSON.parse(readFileSync(path.join(dir, 'props.json'), 'utf8'));
    expect(onDisk.scenes).toHaveLength(8);
    expect(onDisk.totalFrames).toBe(timing.totalFrames);
    expect(props.scenes[1]?.captions.length).toBeGreaterThan(10);
  });

  it('rejects an invalid storyboard with exit code 2 semantics', async () => {
    const err = await prepare('fixtures/storyboards/stress-over-limit.json').catch((e) => e);
    expect(err).toBeInstanceOf(PrepareError);
    expect((err as PrepareError).exitCode).toBe(2);
    expect((err as PrepareError).message).toContain('scene s03');
  });

  it('CLI: no argument prints usage and exits 2', () => {
    const r = tsx(['scripts/prepare.ts']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Usage: prepare');
  });

  it('CLI: wrong repoRoot names the scene id and repoRoot, no stack trace, exit 2', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 've-prep-'));
    const sb = JSON.parse(readFileSync('fixtures/storyboards/stress-over-limit.json', 'utf8'));
    sb.repoRoot = '/nonexistent';
    writeFileSync(path.join(dir, 'storyboard.json'), JSON.stringify(sb));
    const r = tsx(['scripts/prepare.ts', path.join(dir, 'storyboard.json')]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('scene s03');
    expect(r.stderr).toContain('/nonexistent');
    expect(r.stderr).not.toContain('ENOENT');
    expect(r.stderr).not.toMatch(/\n\s+at /);
  });
});
