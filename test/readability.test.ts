import {readFileSync, readdirSync} from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {validateFile} from '../scripts/validate-storyboard.js';
import {CODE_FONT_FLOOR, FONT_FLOOR, SAFE} from '../template/src/theme.js';

const scenesDir = path.join('template', 'src', 'scenes');

describe('readability floor (FR-SCN-09, 2.D.3)', () => {
  it('uses a 28 px floor for scene text and 24 px for code', () => {
    expect(FONT_FLOOR).toBe(28);
    expect(CODE_FONT_FLOOR).toBe(24);
    expect(SAFE.contentBottom).toBe(940);
  });

  it('no scene component hard-codes a font size below the floor', () => {
    for (const f of readdirSync(scenesDir).filter((n) => n.endsWith('.tsx'))) {
      const src = readFileSync(path.join(scenesDir, f), 'utf8');
      for (const m of src.matchAll(/fontSize:\s*(\d+)/g))
        expect(Number(m[1]), `${f} fontSize ${m[1]}`).toBeGreaterThanOrEqual(FONT_FLOOR);
    }
  });

  it('the code scene shrinks only down to the code floor', () => {
    expect(readFileSync(path.join(scenesDir, 'Code.tsx'), 'utf8')).toContain('CODE_FONT_FLOOR');
  });

  it('at-limit fixtures and all-scenes validate with no errors (only length warnings)', () => {
    for (const f of [
      'all-scenes',
      'code-at-limit',
      'code-diff',
      'architecture-at-limit',
      'architecture-small',
      'sequence-at-limit',
      'timeline',
      'outro',
      'bullets-at-limit',
    ]) {
      const r = validateFile(path.join('fixtures', 'storyboards', `${f}.json`));
      expect(r.errors, f).toEqual([]);
    }
  });

  it('all-scenes totals at most 120 s and 60 s or more', () => {
    const r = validateFile(path.join('fixtures', 'storyboards', 'all-scenes.json'));
    expect(r.warnings.filter((w) => w.rule === 'R5')).toEqual([]);
  });
});
