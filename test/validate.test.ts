/* eslint-disable @typescript-eslint/no-explicit-any */
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
  it('passes the minimal fixture with a 70-90 s estimate', () => {
    const r = validateFile(fx('minimal.json'));
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.estimatedSec).toBeGreaterThanOrEqual(70);
    expect(r.estimatedSec).toBeLessThanOrEqual(90);
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

  it('rejects a total outside the normal 55-110 s', () => {
    const r = validateFile(fx('invalid-too-short.json'));
    expect(has(r.errors, null, 'scenes', 'below 55 s')).toBe(true);
  });

  it('warns (not errors) when the total is 55-70 s or 90-110 s (G1-2)', () => {
    const sb = JSON.parse(readFileSync(fx('minimal.json'), 'utf8'));
    const words = Array.from({length: 22}, (_, i) => `word${i}`).join(' ');
    for (const s of sb.scenes.slice(1, 7)) s.narration = words;
    const r = validateStoryboard(sb, {baseDir: path.dirname(fx('minimal.json'))});
    expect(r.errors).toEqual([]);
    expect(r.estimatedSec).toBeLessThan(70);
    expect(r.estimatedSec).toBeGreaterThanOrEqual(55);
    expect(r.warnings.some((w) => w.rule === 'R5' && w.message.includes('target'))).toBe(true);
  });

  describe('modes', () => {
    const base = () => JSON.parse(readFileSync(fx('minimal.json'), 'utf8')) as Record<string, any>;
    const dir = path.dirname(fx('minimal.json'));
    const words = (n: number) => Array.from({length: n}, (_, i) => `word${i}`).join(' ');

    it('absent mode is normal: 6-10 scenes required', () => {
      const sb = base();
      sb.scenes = sb.scenes.slice(0, 4).concat(sb.scenes.slice(-1));
      const r = validateStoryboard(sb, {baseDir: dir});
      expect(has(r.errors, null, 'scenes', 'normal mode needs 6-10 scenes, found 5')).toBe(true);
    });

    it('quick accepts 3-5 scenes of 20-45 s and rejects 6', () => {
      const sb = base();
      sb.mode = 'quick';
      sb.scenes = sb.scenes.slice(0, 3);
      for (const s of sb.scenes) s.narration = words(24);
      const ok = validateStoryboard(sb, {baseDir: dir});
      expect(ok.errors).toEqual([]);
      sb.scenes = base().scenes.slice(0, 6);
      for (const s of sb.scenes) s.narration = words(10);
      const r = validateStoryboard(sb, {baseDir: dir});
      expect(has(r.errors, null, 'scenes', 'quick mode needs 3-5 scenes, found 6')).toBe(true);
    });

    it('quick warns on a scene above its 10 s cap, normal uses 20 s', () => {
      const sb = base();
      sb.mode = 'quick';
      sb.scenes = sb.scenes.slice(0, 3);
      for (const s of sb.scenes) s.narration = words(24);
      sb.scenes[1].narration = words(40);
      const r = validateStoryboard(sb, {baseDir: dir});
      expect(
        r.warnings.some((w) => w.sceneId === 's02' && w.message.includes('10 s per-scene cap')),
      ).toBe(true);
    });

    it('quick may start without a title scene; other modes may not; last-scene rule stays', () => {
      const mk = (mode?: string) => {
        const sb = base();
        if (mode) sb.mode = mode;
        sb.scenes = sb.scenes.slice(1, 4); // bullets/code... first, ends mid-deck
        sb.scenes.push(base().scenes.at(-1));
        return sb;
      };
      const q = validateStoryboard(mk('quick'), {baseDir: dir});
      expect(q.errors.some((e) => e.message.includes('first scene must be a title'))).toBe(false);
      const n = validateStoryboard(mk(), {baseDir: dir});
      expect(n.errors.some((e) => e.message.includes('first scene must be a title'))).toBe(true);
      const bad = mk('quick');
      bad.scenes[bad.scenes.length - 1] = {...base().scenes[1], type: 'timeline'}; // not title/bullets/outro
      expect(
        validateStoryboard(bad, {baseDir: dir}).errors.some((e) =>
          e.message.includes('last scene must be'),
        ),
      ).toBe(true);
    });

    it('rejects an unknown mode', () => {
      const sb = base();
      sb.mode = 'turbo';
      expect(validateStoryboard(sb, {baseDir: dir}).errors.length).toBeGreaterThan(0);
    });
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
    expect(has(r.errors, 's03', 'code', 'lines > 16')).toBe(true);
    expect(has(r.errors, 's03', 'code', 'line length > 100')).toBe(true);
  });
  it('rejects an edge to an unknown node id', () => {
    expect(has(r.errors, 's04', 'edges[1].to', 'ghost')).toBe(true);
  });
  it('rejects a sequence index out of range', () => {
    expect(has(r.errors, 's05', 'messages[1].to', 'out of range')).toBe(true);
  });
  it('explains that a sequence self-message is unsupported', () => {
    const sb = JSON.parse(readFileSync(fx('sequence-at-limit.json'), 'utf8')) as {
      scenes: {type: string; messages?: {from: number; to: number}[]}[];
    };
    const seq = sb.scenes.find((x) => x.type === 'sequence' && x.messages);
    seq!.messages![0]!.to = seq!.messages![0]!.from;
    const r = validateStoryboard(sb);
    expect(
      r.errors.some(
        (i) => i.path.endsWith('.to') && /self-message.*unsupported.*note/.test(i.message),
      ),
    ).toBe(true);
  });
  it('rejects a snippet past EOF and a focus outside the snippet', () => {
    expect(has(r.errors, 's06', 'code', 'past the end')).toBe(true);
    expect(has(r.errors, 's07', 'focus[0]', 'outside the snippet')).toBe(true);
  });
  it('rejects 15 nodes / 20 edges (nodes > 9, edges > 12)', () => {
    expect(has(r.errors, 's09', 'nodes', 'nodes > 9')).toBe(true);
    expect(has(r.errors, 's09', 'edges', 'edges > 12')).toBe(true);
  });
  it('rejects the over-limit sequence (messages > 8, text > 40, note > 36, rightmost note)', () => {
    expect(has(r.errors, 's10', 'messages', 'messages > 8')).toBe(true);
    expect(has(r.errors, 's10', 'messages[0].text', 'text > 40')).toBe(true);
    expect(has(r.errors, 's10', 'messages[0].note', 'note > 36')).toBe(true);
    expect(has(r.errors, 's10', 'messages[3].note', 'rightmost')).toBe(true);
  });
  it('rejects an over-limit timeline and outro', () => {
    expect(has(r.errors, 's11', 'items', 'items > 7')).toBe(true);
    expect(has(r.errors, 's11', 'items[0].detail', 'detail > 80')).toBe(true);
    expect(has(r.errors, 's12', 'headline', 'headline > 90')).toBe(true);
    expect(has(r.errors, 's12', 'items', 'items > 3')).toBe(true);
  });
  it('rejects the six over-wrapped bullets with a split suggestion', () => {
    expect(has(r.errors, 's02', 'items', 'wrapped lines')).toBe(true);
    expect(has(r.errors, 's02', 'items', 'split the scene')).toBe(true);
  });
  it('every error names a scene id or is storyboard-level', () => {
    for (const e of r.errors) expect(e.path).not.toBe('');
  });
});

describe('product name casing', () => {
  const base = JSON.parse(readFileSync(fx('minimal.json'), 'utf8'));
  const withNarration = (text: string) => {
    const sb = structuredClone(base);
    sb.scenes[1].narration = text;
    return validateStoryboard(sb, {});
  };

  it('warns (not errors) on a capitalised Windower in narration', () => {
    const r = withNarration('Windower turns a slice of code into a short video for new teammates.');
    expect(r.warnings.some((w) => w.rule === 'name-case' && w.sceneId === base.scenes[1].id)).toBe(
      true,
    );
    expect(r.errors.some((e) => e.rule === 'name-case')).toBe(false);
  });

  it('accepts lowercase windower', () => {
    const r = withNarration('windower turns a slice of code into a short video for new teammates.');
    expect(r.warnings.some((w) => w.rule === 'name-case')).toBe(false);
  });
});
