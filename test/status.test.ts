import {mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {describe, expect, it} from 'vitest';
import {computeStatus, slugify, uniqueSlug, type RunFacts} from '../scripts/stages.js';
import {initRun, inspectRun} from '../scripts/status.js';

const repo = path.resolve('fixtures/repos/sample');
const sbRaw = JSON.parse(readFileSync('fixtures/storyboards/minimal.json', 'utf8'));

function touch(dir: string, name: string, content: string, t: number) {
  const f = path.join(dir, name);
  mkdirSync(path.dirname(f), {recursive: true});
  writeFileSync(f, content);
  utimesSync(f, t, t);
}
const states = (dir: string) => inspectRun(dir).stages.map((s) => `${s.stage}:${s.state}`);
const mk = () => mkdtempSync(path.join(os.tmpdir(), 've-status-'));
const storyboard = (approved: boolean) =>
  JSON.stringify({...sbRaw, repoRoot: repo, ...(approved ? {approved: true} : {})});

function fullRun(dir: string) {
  touch(dir, 'brief.md', '# brief', 100);
  touch(dir, 'storyboard.json', storyboard(true), 200);
  touch(dir, 'timing.json', '{}', 300);
  touch(dir, 'props.json', '{}', 400);
  touch(dir, 'out/video.mp4', 'v', 500);
  touch(dir, 'out/captions.srt', 's', 500);
  touch(dir, 'out/captions.vtt', 'v', 500);
}

describe('status', () => {
  it('fresh run: everything missing, next is brief', () => {
    const r = inspectRun(mk());
    expect(r.next).toBe('brief');
    expect(r.stages.every((s) => s.state === 'missing')).toBe(true);
    expect(r.complete).toBe(false);
  });

  it('partial: brief only, then valid unapproved storyboard', () => {
    const dir = mk();
    touch(dir, 'brief.md', '# b', 100);
    expect(inspectRun(dir).next).toBe('storyboard');
    touch(dir, 'storyboard.json', storyboard(false), 200);
    const r = inspectRun(dir);
    expect(states(dir).slice(0, 3)).toEqual(['brief:done', 'storyboard:done', 'approved:missing']);
    expect(r.next).toBe('approved');
  });

  it('invalid storyboard is stale and is the next stage', () => {
    const dir = mk();
    touch(dir, 'brief.md', '# b', 100);
    touch(dir, 'storyboard.json', '{"version":1}', 200);
    const r = inspectRun(dir);
    expect(r.next).toBe('storyboard');
    expect(r.stages[1]?.reason).toContain('invalid');
  });

  it('approved storyboard resumes at timing', () => {
    const dir = mk();
    touch(dir, 'brief.md', '# b', 100);
    touch(dir, 'storyboard.json', storyboard(true), 200);
    expect(inspectRun(dir).next).toBe('timing');
  });

  it('fully done run is complete', () => {
    const dir = mk();
    fullRun(dir);
    const r = inspectRun(dir);
    expect(r.complete).toBe(true);
    expect(r.next).toBeNull();
    expect(r.notes).toEqual([]);
  });

  it('storyboard edited after prepare: timing, props, video are stale; next is timing', () => {
    const dir = mk();
    fullRun(dir);
    touch(dir, 'storyboard.json', storyboard(true), 450);
    expect(states(dir)).toEqual([
      'brief:done',
      'storyboard:done',
      'approved:done',
      'timing:stale',
      'props:stale',
      'video:stale',
    ]);
    expect(inspectRun(dir).next).toBe('timing');
  });

  it('props regenerated after timing is the only stale link: video stale, next video', () => {
    const dir = mk();
    fullRun(dir);
    touch(dir, 'props.json', '{}', 600);
    const r = inspectRun(dir);
    expect(r.stages.at(-1)?.state).toBe('stale');
    expect(r.next).toBe('video');
  });

  it('brief newer than storyboard only adds a note and never invalidates', () => {
    const dir = mk();
    fullRun(dir);
    touch(dir, 'brief.md', '# edited', 250);
    const r = inspectRun(dir);
    expect(r.notes[0]).toContain('older than brief.md');
    expect(r.stages.find((s) => s.stage === 'storyboard')?.state).toBe('done');
    expect(r.stages.find((s) => s.stage === 'timing')?.state).toBe('done');
  });

  it('missing captions make the video stale', () => {
    const dir = mk();
    fullRun(dir);
    writeFileSync(path.join(dir, 'out/captions.vtt'), 'x');
    utimesSync(path.join(dir, 'out/captions.vtt'), 500, 500);
    const f: RunFacts = {mtime: {brief: 1, storyboard: 2, timing: 3, props: 4, video: 5}};
    expect(computeStatus({...f, storyboardValid: true, storyboardApproved: true}).next).toBe(
      'video',
    );
  });

  it('CLI --json is machine readable', () => {
    const dir = mk();
    fullRun(dir);
    const r = spawnSync('pnpm', ['exec', 'tsx', 'scripts/status.ts', dir, '--json'], {
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.complete).toBe(true);
    expect(j.stages).toHaveLength(6);
  });

  it('CLI: missing dir exits 1', () => {
    const r = spawnSync('pnpm', ['exec', 'tsx', 'scripts/status.ts', '/nonexistent-ve'], {
      encoding: 'utf8',
    });
    expect(r.status).toBe(1);
  });
});

describe('slug and init', () => {
  it('slugify derives kebab-case within 48 chars', () => {
    expect(slugify('How the Checkout Flow Works!')).toBe('how-the-checkout-flow-works');
    expect(slugify('Café  Über_thing')).toBe('cafe-uber-thing');
    expect(slugify('***')).toBe('video');
    const long = slugify('a'.repeat(30) + ' ' + 'b'.repeat(30));
    expect(long.length).toBeLessThanOrEqual(48);
    expect(long).toMatch(/^[a-z0-9-]{1,48}$/);
  });

  it('uniqueSlug handles collisions and stays within 48 chars', () => {
    expect(uniqueSlug('Auth Flow', ['auth-flow'])).toBe('auth-flow-2');
    expect(uniqueSlug('Auth Flow', ['auth-flow', 'auth-flow-2'])).toBe('auth-flow-3');
    const base = 'x'.repeat(48);
    const s = uniqueSlug(base, [base]);
    expect(s.length).toBeLessThanOrEqual(48);
    expect(s.endsWith('-2')).toBe(true);
  });

  it('status init --json emits defaultMode from .windower.json', () => {
    const root = mk();
    writeFileSync(path.join(root, '.windower.json'), JSON.stringify({defaultMode: 'deep'}));
    const r = spawnSync(
      'pnpm',
      ['exec', 'tsx', 'scripts/status.ts', 'init', 'Mode Tour', '--root', root, '--json'],
      {encoding: 'utf8', cwd: process.cwd()},
    );
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as {defaultMode?: string; defaultLengthSec?: number};
    expect(out.defaultMode).toBe('deep');
    expect(out.defaultLengthSec).toBeUndefined();
  });

  it('initRun creates the run dir and avoids collisions', () => {
    const root = mk();
    const a = initRun('Billing Tour', root);
    const b = initRun('Billing Tour', root);
    expect(a.slug).toBe('billing-tour');
    expect(b.slug).toBe('billing-tour-2');
    expect(a.dir).toBe(path.join(root, '.windower', 'billing-tour'));
    expect(inspectRun(a.dir).next).toBe('brief');
  });
});
