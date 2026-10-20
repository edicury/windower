import {spawnSync} from 'node:child_process';
import {describe, expect, it} from 'vitest';
import {classifySource} from '../scripts/sources.js';

const nid = '0123456789abcdef0123456789abcdef';

describe('classifySource', () => {
  it.each([
    ['https://github.com/o/r/pull/12/', 'github-pr', 'o/r#12', 'https://github.com/o/r/pull/12'],
    [
      'https://github.com/o/r/pull/12/files?x=1#diff',
      'github-pr',
      'o/r#12',
      'https://github.com/o/r/pull/12/files',
    ],
    [
      'https://github.com/o/r/issues/7?q=1#c',
      'github-issue',
      'o/r#7',
      'https://github.com/o/r/issues/7',
    ],
    [
      'https://github.com/o/r/blob/main/src/a.ts#L1',
      'github-repo-file',
      'o/r:src/a.ts@main',
      'https://github.com/o/r/blob/main/src/a.ts',
    ],
    [
      `https://www.notion.so/acme/My-Page-Title-${nid}?pvs=4`,
      'notion',
      nid,
      `https://www.notion.so/acme/My-Page-Title-${nid}`,
    ],
    [
      'https://linear.app/acme/issue/abc-123/some-slug/',
      'linear',
      'ABC-123',
      'https://linear.app/acme/issue/abc-123/some-slug',
    ],
    [
      'https://acme.slack.com/archives/C01/p1700000000',
      'slack',
      'C01/p1700000000',
      'https://acme.slack.com/archives/C01/p1700000000',
    ],
    [
      'https://acme.atlassian.net/browse/PROJ-9',
      'jira',
      'PROJ-9',
      'https://acme.atlassian.net/browse/PROJ-9',
    ],
    [
      'https://acme.sentry.io/issues/4455/?project=1',
      'sentry',
      'acme/4455',
      'https://acme.sentry.io/issues/4455',
    ],
  ])('%s -> %s', (input, kind, id, citation) => {
    const c = classifySource(input);
    expect(c.kind).toBe(kind);
    expect(c.id).toBe(id);
    expect(c.citation).toBe(citation);
  });

  it('gives mcp hints', () => {
    expect(classifySource('https://github.com/o/r/pull/1').mcpHint).toBe('github');
    expect(classifySource('https://acme.atlassian.net/browse/A-1').mcpHint).toBe('atlassian');
    expect(classifySource('https://acme.atlassian.net/wiki/spaces/X').mcpHint).toBe('atlassian');
    expect(classifySource('https://sentry.io/organizations/acme/issues/5/').mcpHint).toBe('sentry');
    expect(classifySource('https://example.com/a/b/').kind).toBe('generic-url');
    expect(classifySource('https://docs.example.com/a').mcpHint).toBe('example');
  });

  it('handles bare ids', () => {
    expect(classifySource('123')).toMatchObject({
      kind: 'pr-number',
      citation: 'pr#123',
      mcpHint: 'github',
    });
    expect(classifySource('#45')).toMatchObject({kind: 'pr-number', citation: 'pr#45'});
    expect(classifySource('abc-123')).toMatchObject({kind: 'linear-id', id: 'ABC-123'});
    expect(classifySource(nid)).toMatchObject({kind: 'notion-id', id: nid, mcpHint: 'notion'});
    const uuid = '01234567-89ab-cdef-0123-456789abcdef';
    expect(classifySource(uuid)).toMatchObject({kind: 'notion-id', id: nid});
    expect(classifySource('o/r#9')).toMatchObject({kind: 'github-pr', id: 'o/r#9'});
  });

  it('flags unparseable input', () => {
    expect(classifySource('').kind).toBe('unknown');
    expect(classifySource('hello world').kind).toBe('unknown');
    expect(classifySource('http://').kind).toBe('unknown');
  });
});

describe('sources CLI', () => {
  const run = (...a: string[]) => spawnSync('pnpm', ['-s', 've:sources', ...a], {encoding: 'utf8'});
  it('prints JSON to stdout and exits 0', () => {
    const r = run('https://linear.app/a/issue/ENG-5', '--json');
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).id).toBe('ENG-5');
  });
  it('exits 2 on unparseable input', () => {
    expect(run('not a source').status).toBe(2);
  });
});
