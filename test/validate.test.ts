import {readFileSync} from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {validateFile, validateStoryboard, type Issue} from '../scripts/validate-storyboard.js';

const fx = (name: string) => path.join('fixtures', 'storyboards', name);
const has = (list: Issue[], sceneId: string | null, field: string, text?: string) =>
  list.some(
    (i) =>
      i.sceneId === sceneId &&
      i.path.startsWith(field) &&
      (text === undefined || i.message.includes(text)),
  );

describe('validate-storyboard', () => {
  it('passes the minimal fixture with a 60-120 s estimate', () => {
    const r = validateFile(fx('minimal.json'));
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.estimatedSec).toBeGreaterThanOrEqual(60);
    expect(r.estimatedSec).toBeLessThanOrEqual(120);
  });

  it.each([
    ['invalid-missing-sources.json', 's03', 'sources'],
    ['invalid-empty-sources.json', 's04', 'sources'],
    ['invalid-unknown-type.json', 's03', 'type'],
    ['invalid-duplicate-id.json', 's02', 'id'],
    ['invalid-first-scene.json', 's01', 'type'],
    ['invalid-narration-short.json', 's02', 'narration'],
    ['invalid-source-file.json', 's03', 'sources[0].ref'],
    ['invalid-unknown-field.json', 's02', 'type'],
  ])('%s is rejected naming scene %s field %s', (file, sceneId, field) => {
    const r = validateFile(fx(file));
    expect(has(r.errors, sceneId, field)).toBe(true);
  });

  it('rejects a bad version at the storyboard level', () => {
    const r = validateFile(fx('invalid-version.json'));
    expect(has(r.errors, null, 'version')).toBe(true);
  });

  it('rejects a total outside 45-130 s', () => {
    const r = validateFile(fx('invalid-too-short.json'));
    expect(has(r.errors, null, 'scenes', 'below 45 s')).toBe(true);
  });

  it('warns (not errors) when the total is 45-60 s or 120-130 s (G1-2)', () => {
    const sb = JSON.parse(readFileSync(fx('minimal.json'), 'utf8'));
    const fifteen = Array.from({length: 15}, (_, i) => `word${i}`).join(' ');
    for (const s of sb.scenes.slice(1, 7)) s.narration = fifteen;
    const r = validateStoryboard(sb, {baseDir: path.dirname(fx('minimal.json'))});
    expect(r.errors).toEqual([]);
    expect(r.estimatedSec).toBeLessThan(60);
    expect(r.warnings.some((w) => w.rule === 'R5' && w.message.includes('target'))).toBe(true);
  });

  it('reports a missing file and bad JSON distinctly', () => {
    expect(validateFile('nope.json').errors[0]?.message).toContain('not found');
    expect(validateFile('package.json', {}).errors.length).toBeGreaterThan(0);
  });

  it('requires a repoRoot for code scenes and names a wrong one', () => {
    const r = validateFile(fx('stress-over-limit.json'), {repoRoot: '/nonexistent'});
    expect(has(r.errors, 's03', 'file', '/nonexistent')).toBe(true);
  });

  it('requires source refs to appear in the brief when one is given', () => {
    const r = validateFile(fx('minimal.json'), {briefText: '# Brief\nsrc/greeter.ts:6-18'});
    expect(has(r.errors, 's03', 'sources[0].ref', 'brief.md')).toBe(true);
    expect(has(r.errors, 's02', 'sources[0].ref')).toBe(false);
  });
});

describe('stress-over-limit fixture (testing.md 2.1, phase 1 rows)', () => {
  const r = validateFile(fx('stress-over-limit.json'));
  it('rejects the 93-char title headline', () => {
    expect(has(r.errors, 's01', 'headline', 'headline > 90')).toBe(true);
  });
  it('rejects 6 bullets of ~125 chars', () => {
    expect(has(r.errors, 's02', 'items', 'items > 5')).toBe(true);
    expect(has(r.errors, 's02', 'items[0]', 'item length > 110')).toBe(true);
  });
  it('rejects the 40-line code scene with a 186-char line', () => {
    expect(has(r.errors, 's03', 'endLine', 'lines > 16')).toBe(true);
    expect(has(r.errors, 's03', 'file', 'line length > 100')).toBe(true);
  });
  it('rejects an edge to an unknown node id', () => {
    expect(has(r.errors, 's04', 'edges[1].to', 'ghost')).toBe(true);
  });
  it('rejects a sequence index out of range', () => {
    expect(has(r.errors, 's05', 'messages[1].to', 'out of range')).toBe(true);
  });
  it('rejects endLine past EOF and startLine > endLine', () => {
    expect(has(r.errors, 's06', 'endLine', 'past the end')).toBe(true);
    expect(has(r.errors, 's07', 'startLine', '>')).toBe(true);
  });
  it('every error names a scene id or is storyboard-level', () => {
    for (const e of r.errors) expect(e.path).not.toBe('');
  });
});
