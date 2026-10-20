import {readFileSync} from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {highlightCode} from '../scripts/code-highlight.js';
import {validateFile, validateStoryboard, type Issue} from '../scripts/validate-storyboard.js';
import {displayLines, parseDiff, splitCode} from '../template/src/codeLines.js';

const dir = path.join('fixtures', 'storyboards');
const load = (name: string) => JSON.parse(readFileSync(path.join(dir, name), 'utf8'));
const codeScene = (sb: {scenes: Record<string, unknown>[]}) =>
  sb.scenes[2] as Record<string, unknown>;
const errs = (sb: unknown): Issue[] => validateStoryboard(sb, {baseDir: dir}).errors;
const has = (list: Issue[], field: string, text?: string) =>
  list.some(
    (i) =>
      i.sceneId === 's03' &&
      i.path.startsWith(field) &&
      (text === undefined || i.message.includes(text)),
  );

describe('code scene fixtures', () => {
  it('code-at-limit.json is valid with 16 lines and a 100-char line', () => {
    const r = validateFile(path.join(dir, 'code-at-limit.json'));
    expect(r.errors).toEqual([]);
    const lines = splitCode(codeScene(load('code-at-limit.json')).code as string);
    expect(lines).toHaveLength(16);
    expect(Math.max(...lines.map((l) => l.length))).toBe(100);
  });
  it('code-diff.json is valid', () => {
    expect(validateFile(path.join(dir, 'code-diff.json')).errors).toEqual([]);
  });
});

describe('code scene limits and references', () => {
  it('rejects 17 lines', () => {
    const sb = load('code-at-limit.json');
    codeScene(sb).code = (codeScene(sb).code as string) + '\nextra';
    expect(has(errs(sb), 'code', 'lines > 16')).toBe(true);
  });
  it('rejects a 101-char line', () => {
    const sb = load('code-at-limit.json');
    const c = codeScene(sb);
    c.code = (c.code as string).replace(/^.*$/m, 'x'.repeat(101));
    expect(has(errs(sb), 'code', 'line length > 100')).toBe(true);
  });
  it('rejects code that is not verbatim from the file', () => {
    const sb = load('code-at-limit.json');
    const c = codeScene(sb);
    c.code = (c.code as string).replace('rows', 'ROWS');
    expect(has(errs(sb), 'code', 'differs from src/wide.ts')).toBe(true);
  });
  it('rejects a snippet that ends past the end of the file', () => {
    const sb = load('code-at-limit.json');
    codeScene(sb).startLine = 10;
    expect(has(errs(sb), 'code', 'past the end')).toBe(true);
  });
  it('rejects a focus outside the snippet and a bad at', () => {
    const sb = load('code-at-limit.json');
    codeScene(sb).focus = [{lines: [1, 3]}, {lines: [4, 5], at: 1.5}];
    const e = errs(sb);
    expect(has(e, 'focus[0].lines', 'outside the snippet')).toBe(true);
    expect(has(e, 'focus[1].at')).toBe(true);
  });
  it('rejects a missing file and an unknown language', () => {
    const sb = load('code-at-limit.json');
    codeScene(sb).language = 'klingon';
    expect(has(errs(sb), 'language', 'unknown language')).toBe(true);
    codeScene(sb).file = 'src/nope.ts';
    expect(has(errs(sb), 'file', 'file not found')).toBe(true);
  });
  it('rejects the old prototype shape (endLine, title)', () => {
    const sb = load('code-at-limit.json');
    Object.assign(codeScene(sb), {endLine: 5, title: 'x'});
    expect(has(errs(sb), 'type', 'unknown field')).toBe(true);
  });
  it('diff mode needs exactly one hunk and prefixed lines', () => {
    const sb = load('code-diff.json');
    const c = codeScene(sb);
    const orig = c.code as string;
    c.code = orig + '\n+another\n context\n-gone';
    expect(has(errs(sb), 'code', 'exactly 1 hunk')).toBe(true);
    c.code = orig + '\nnot prefixed';
    expect(has(errs(sb), 'code', 'must start with')).toBe(true);
  });
});

describe('codeLines helpers', () => {
  it('parses a diff', () => {
    const d = parseDiff([' a', '-b', '+c', ' d']);
    expect(d.hunks).toBe(1);
    expect(d.rows.map((r) => r.kind)).toEqual(['ctx', 'del', 'add', 'ctx']);
    expect(displayLines(' a\n-b\n+c', 'diff')).toEqual(['a', 'b', 'c']);
  });
});

describe('highlightCode', () => {
  it('returns one row per line with snippet numbers and tokens', async () => {
    const rows = await highlightCode({
      code: 'const a = 1;\nconst b = 2;',
      language: 'ts',
      startLine: 7,
    });
    expect(rows.map((r) => r.n)).toEqual([7, 8]);
    expect(rows[0]?.tokens.map((t) => t.c).join('')).toBe('const a = 1;');
  });
  it('strips diff prefixes and keeps the kind', async () => {
    const rows = await highlightCode({
      code: ' a\n-b\n+c',
      language: 'text',
      startLine: 1,
      mode: 'diff',
    });
    expect(rows.map((r) => r.kind)).toEqual(['ctx', 'del', 'add']);
    expect(rows[1]?.tokens.map((t) => t.c).join('')).toBe('b');
  });
});
