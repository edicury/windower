import {readFileSync} from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {LIMITS, Storyboard} from '../template/src/schema.js';

const fixture = (name: string) =>
  JSON.parse(readFileSync(path.join('fixtures', 'storyboards', name), 'utf8'));

describe('Storyboard schema', () => {
  it('accepts the minimal fixture and applies defaults', () => {
    const sb = Storyboard.parse(fixture('minimal.json'));
    expect(sb.fps).toBe(30);
    expect(sb.size).toEqual({width: 1920, height: 1080});
    expect(sb.scenes[0]?.transition).toBe('fade');
  });

  it('rejects unknown fields (strict)', () => {
    const r = Storyboard.safeParse(fixture('invalid-unknown-field.json'));
    expect(r.success).toBe(false);
  });

  it('rejects an unknown scene type and a bad version', () => {
    expect(Storyboard.safeParse(fixture('invalid-unknown-type.json')).success).toBe(false);
    const v = Storyboard.safeParse(fixture('invalid-version.json'));
    expect(v.success).toBe(false);
    expect(JSON.stringify(v.error?.issues)).toContain('version 1');
  });

  it('rejects a scene without sources', () => {
    expect(Storyboard.safeParse(fixture('invalid-missing-sources.json')).success).toBe(false);
  });

  it('enforces title and bullets limits', () => {
    const sb = fixture('minimal.json');
    sb.scenes[0].headline = 'x'.repeat(LIMITS.titleHeadline + 1);
    sb.scenes[0].subtitle = 'x'.repeat(LIMITS.titleSubtitle + 1);
    sb.scenes[1].items = Array.from({length: 6}, () => 'item');
    const r = Storyboard.safeParse(sb);
    const msgs = r.error?.issues.map((i) => i.message).join('|') ?? '';
    expect(msgs).toContain('headline > 90');
    expect(msgs).toContain('subtitle > 80');
    expect(msgs).toContain('items > 5');
  });

  it('accepts a headline of exactly 90 chars', () => {
    const sb = fixture('minimal.json');
    sb.scenes[0].headline = 'x'.repeat(90);
    expect(Storyboard.safeParse(sb).success).toBe(true);
  });

  it('requires plain narration of 8-60 words', () => {
    const sb = fixture('minimal.json');
    sb.scenes[1].narration = 'too short';
    expect(Storyboard.safeParse(sb).success).toBe(false);
    sb.scenes[1].narration = Array.from({length: 61}, () => 'word').join(' ');
    expect(Storyboard.safeParse(sb).success).toBe(false);
    sb.scenes[1].narration = 'This has **markdown** markup in it which is not allowed here at all.';
    expect(Storyboard.safeParse(sb).success).toBe(false);
  });
});
