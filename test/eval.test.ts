import {cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {buildFactcheckSheet, evalRun, pickClaims, scoreFactcheck} from '../scripts/eval';

const root = path.resolve(__dirname, '..');
const sample = path.join(root, 'fixtures/repos/sample');
const doc = (rel: string) => readFileSync(path.join(root, rel), 'utf8');
const block = (md: string, lang: string) =>
  new RegExp('```' + lang + '\\n([\\s\\S]*?)\\n```').exec(md)![1]!;

/** Builds a run dir from the worked example in the docs (a known-good storyboard + brief). */
function makeRun(mutate?: (sb: Sb, brief: string) => {sb?: Sb; brief?: string}) {
  const dir = path.join(mkdtempSync(path.join(os.tmpdir(), 've-eval-')), 'demo-run');
  mkdirSync(dir, {recursive: true});
  let sb = JSON.parse(block(doc('skills/windower/references/storyboard-authoring.md'), 'json'));
  let brief = block(doc('skills/windower/references/workflow.md'), 'markdown');
  sb.approved = true;
  sb.approvedAt = '2026-10-20T00:00:00.000Z';
  const m = mutate?.(sb, brief);
  if (m?.sb) sb = m.sb;
  if (m?.brief !== undefined) brief = m.brief;
  writeFileSync(path.join(dir, 'storyboard.json'), JSON.stringify(sb));
  writeFileSync(path.join(dir, 'brief.md'), brief);
  return dir;
}

type Sb = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const failed = (r: ReturnType<typeof evalRun>) => r.checks.filter((c) => !c.pass).map((c) => c.id);

describe('eval', () => {
  it('passes a good run and writes the fact-check sheet', () => {
    const dir = makeRun();
    const r = evalRun(dir, {repo: sample});
    expect(failed(r)).toEqual([]);
    expect(r.pass).toBe(true);
    const sheet = readFileSync(path.join(dir, 'eval-factcheck.md'), 'utf8');
    expect(sheet).toContain('## Reviewer table');
    expect(sheet).toMatch(/Narration: /);
  });

  it('fails an unapproved run', () => {
    const dir = makeRun((sb) => ({sb: {...sb, approved: false, approvedAt: undefined}}));
    expect(failed(evalRun(dir, {repo: sample}))).toEqual(['approval']);
  });

  it('fails a bad citation', () => {
    const dir = makeRun((sb) => {
      sb.scenes[1].sources = [{kind: 'file', ref: 'nope/missing.ts:1-2'}];
      return {sb};
    });
    expect(failed(evalRun(dir, {repo: sample}))).toContain('citations');
  });

  it('fails a code snippet that does not match the file', () => {
    const dir = makeRun((sb) => {
      const s = sb.scenes.find((x: {type: string; code: string}) => x.type === 'code');
      if (!s) throw new Error('example has no code scene');
      s.code = s.code + '\n// tampered';
      return {sb};
    });
    expect(failed(evalRun(dir, {repo: sample}))).toContain('citations');
  });

  it('fails a secret in the brief', () => {
    const dir = makeRun((_sb, brief) => ({
      brief: brief + `\nAWS key ${'AKI' + 'AIOSFODNN7EXAMPLE'} leaked\n`,
    }));
    expect(failed(evalRun(dir, {repo: sample}))).toContain('redaction');
  });

  it('fails a run that is too long', () => {
    const dir = makeRun((sb) => {
      const long = Array(400).fill('word').join(' ');
      sb.scenes[1].narration = long;
      return {sb};
    });
    expect(failed(evalRun(dir, {repo: sample}))).toContain('duration');
  });

  it('checks the duration against the storyboard mode, not a fixed 60-120 s', () => {
    const dir = makeRun((sb) => {
      sb.mode = 'quick';
      return {sb};
    });
    expect(failed(evalRun(dir, {repo: sample}))).toContain('duration');
  });

  it('picks claims deterministically by slug, skipping title and outro', () => {
    const scenes = Array.from({length: 9}, (_, i) => ({
      id: `s0${i}`,
      type: i === 0 ? 'title' : 'bullets',
      narration: 'x',
      sources: [{kind: 'file', ref: 'a.ts:1-2'}],
    }));
    const a = pickClaims(scenes, 'slug-a').map((s) => s.id);
    expect(a).toHaveLength(5);
    expect(a).toEqual(pickClaims(scenes, 'slug-a').map((s) => s.id));
    expect(a).not.toContain('s00');
    expect(buildFactcheckSheet(scenes, 'slug-a', undefined)).toContain('| 5 |');
  });

  it('scores a filled fact-check sheet at >= 4/5', () => {
    const row = (n: number, v: string) => `| ${n} | s0${n} | ${v} |  |`;
    const sheet = (v: string[]) => v.map((x, i) => row(i + 1, x)).join('\n');
    expect(scoreFactcheck(sheet(['yes', 'yes', 'yes', 'yes', 'no'])).pass).toBe(true);
    expect(scoreFactcheck(sheet(['yes', 'yes', 'yes', 'no', 'no'])).pass).toBe(false);
    expect(scoreFactcheck(sheet(['yes', 'yes', 'yes', 'yes', ''])).pass).toBe(false);
    expect(scoreFactcheck('no table').pass).toBe(false);
  });

  it('runs against a copied repo root given by --repo semantics', () => {
    const dir = makeRun();
    const repo = path.join(path.dirname(dir), 'repo-copy');
    cpSync(sample, repo, {recursive: true});
    expect(evalRun(dir, {repo}).pass).toBe(true);
  });
});
