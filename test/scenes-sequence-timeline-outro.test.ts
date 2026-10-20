import {readFileSync} from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {validateFile, validateStoryboard, type Issue} from '../scripts/validate-storyboard.js';

const fx = (name: string) => path.join('fixtures', 'storyboards', name);
const load = (name: string) => JSON.parse(readFileSync(fx(name), 'utf8'));
const run = (sb: unknown) => validateStoryboard(sb, {baseDir: path.dirname(fx('x.json'))});
const has = (list: Issue[], sceneId: string, field: string, text?: string) =>
  list.some(
    (i) =>
      i.sceneId === sceneId &&
      i.path.startsWith(field) &&
      (text === undefined || i.message.includes(text)),
  );

describe('at-limit fixtures validate with no errors', () => {
  it.each(['sequence-at-limit.json', 'timeline.json', 'outro.json', 'bullets-at-limit.json'])(
    '%s',
    (f) => {
      expect(validateFile(fx(f)).errors).toEqual([]);
    },
  );
});

describe('sequence limits (FR-SB-07/08)', () => {
  const seq = (mut: (s: Record<string, unknown>) => void) => {
    const sb = load('sequence-at-limit.json');
    mut(sb.scenes[1]);
    return run(sb);
  };
  it('rejects more than 8 messages and more than 5 participants', () => {
    const r = seq((s) => {
      (s.messages as unknown[]).push({from: 0, to: 1, text: 'one more'});
      (s.participants as string[]).push('Sixth');
    });
    expect(has(r.errors, 's02', 'messages', '> 8')).toBe(true);
    expect(has(r.errors, 's02', 'participants', '> 5')).toBe(true);
  });
  it('rejects over-long text, note and participant name', () => {
    const r = seq((s) => {
      const m = (s.messages as Record<string, unknown>[])[0] as Record<string, unknown>;
      m.text = 'x'.repeat(41);
      m.note = 'y'.repeat(37);
      (s.participants as string[])[0] = 'z'.repeat(19);
    });
    expect(has(r.errors, 's02', 'messages[0].text')).toBe(true);
    expect(has(r.errors, 's02', 'messages[0].note')).toBe(true);
    expect(has(r.errors, 's02', 'participants[0]')).toBe(true);
  });
  it('rejects out-of-range from/to without crashing', () => {
    const r = seq((s) => {
      (s.messages as Record<string, unknown>[])[1] = {from: 1, to: 9, text: 'lost'};
    });
    expect(has(r.errors, 's02', 'messages[1].to', 'out of range')).toBe(true);
  });
  it('rejects a note on a message ending at the rightmost participant', () => {
    const r = seq((s) => {
      (s.messages as Record<string, unknown>[])[5] = {
        from: 3,
        to: 4,
        text: 'write',
        note: 'clipped',
      };
    });
    expect(has(r.errors, 's02', 'messages[5].note', 'rightmost')).toBe(true);
  });
});

describe('timeline and outro', () => {
  it('rejects timelines with fewer than 3 or more than 7 items, and long fields', () => {
    const sb = load('timeline.json');
    sb.scenes[1].items = sb.scenes[1].items.slice(0, 2);
    sb.scenes[2].items = [
      ...sb.scenes[1].items,
      ...sb.scenes[1].items,
      ...sb.scenes[1].items,
      ...sb.scenes[1].items,
    ];
    sb.scenes[2].items[0] = {label: 'l'.repeat(25), detail: 'd'.repeat(81), when: 'w'.repeat(21)};
    const r = run(sb);
    expect(has(r.errors, 's02', 'items', '< 3')).toBe(true);
    expect(has(r.errors, 's03', 'items', '> 7')).toBe(true);
    expect(has(r.errors, 's03', 'items[0].label')).toBe(true);
    expect(has(r.errors, 's03', 'items[0].detail')).toBe(true);
    expect(has(r.errors, 's03', 'items[0].when')).toBe(true);
  });
  it('rejects a vertical timeline', () => {
    const sb = load('timeline.json');
    sb.scenes[1].orientation = 'vertical';
    expect(has(run(sb).errors, 's02', 'orientation')).toBe(true);
  });
  it('allows an outro with no sources as the last scene, rejects more than 3 items', () => {
    const sb = load('outro.json');
    expect(run(sb).errors).toEqual([]);
    sb.scenes[2].items.push('fourth');
    expect(has(run(sb).errors, 's03', 'items', '> 3')).toBe(true);
  });
});

describe('bullets wrapped-line budget (FR-SCN-02)', () => {
  it('errors when the wrapped lines exceed 8', () => {
    const sb = load('bullets-at-limit.json');
    sb.scenes[1].items[3] = 'w'.repeat(110);
    expect(has(run(sb).errors, 's02', 'items', 'wrapped lines')).toBe(true);
  });
});
