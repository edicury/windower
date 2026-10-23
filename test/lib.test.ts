import {mkdtempSync, writeFileSync, utimesSync} from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {
  codeSceneProblems,
  findFreePort,
  isPortFree,
  nodeMajor,
  propsProblem,
  renderEnvHint,
  stringifyError,
} from '../scripts/lib.js';

describe('ports', () => {
  it('detects an occupied port and finds a free one', async () => {
    const server = net.createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const {port} = server.address() as net.AddressInfo;
    expect(await isPortFree(port)).toBe(false);
    server.close();
    expect(await findFreePort()).toBeGreaterThan(0);
  });
});

describe('nodeMajor', () => {
  it('parses versions', () => expect(nodeMajor('24.19.0')).toBe(24));
});

describe('codeSceneProblems', () => {
  it('names the scene id for bad files and ranges', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 've-'));
    writeFileSync(path.join(dir, 'a.ts'), 'one\ntwo\nthree');
    const problems = codeSceneProblems({
      repoRoot: dir,
      scenes: [
        {id: 'ok', type: 'code', file: 'a.ts', startLine: 1, endLine: 3},
        {id: 'past-eof', type: 'code', file: 'a.ts', startLine: 2, endLine: 9},
        {id: 'missing', type: 'code', file: 'nope.ts', startLine: 1, endLine: 1},
      ],
    });
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('past-eof');
    expect(problems[1]).toContain('missing');
  });
  it('reports a missing repoRoot', () => {
    expect(codeSceneProblems({repoRoot: '/nonexistent', scenes: []})[0]).toContain('/nonexistent');
  });
});

describe('propsProblem', () => {
  it('rejects missing, wrong-shape and stale props', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 've-'));
    expect(propsProblem(dir)).toContain('missing');
    writeFileSync(path.join(dir, 'props.json'), '{"a":1}');
    expect(propsProblem(dir)).toContain('wrong shape');
    writeFileSync(path.join(dir, 'props.json'), '{"scenes":[{}]}');
    writeFileSync(path.join(dir, 'storyboard.json'), '{}');
    const old = new Date(Date.now() - 60_000);
    utimesSync(path.join(dir, 'props.json'), old, old);
    expect(propsProblem(dir)).toContain('older');
  });
});

describe('shared headless shell cache', () => {
  it('finds the executable in a nested browser cache directory', async () => {
    const {mkdirSync} = await import('node:fs');
    const {findShellExecutable} = await import('../scripts/lib.js');
    const dir = mkdtempSync(path.join(os.tmpdir(), 've-shell-'));
    const nested = path.join(dir, 'mac-arm64', 'chrome-headless-shell-mac-arm64');
    mkdirSync(nested, {recursive: true});
    expect(findShellExecutable(dir)).toBeUndefined();
    writeFileSync(path.join(nested, 'chrome-headless-shell'), '');
    expect(findShellExecutable(dir)).toBe(path.join(nested, 'chrome-headless-shell'));
  });
});

describe('stringifyError', () => {
  it('reads Error, string, message/code objects and falls back to JSON', () => {
    expect(stringifyError(new Error('boom'))).toBe('boom');
    expect(stringifyError('plain')).toBe('plain');
    expect(stringifyError({code: 'EPERM', message: 'listen denied'})).toBe('EPERM: listen denied');
    expect(stringifyError({a: 1})).toBe('{"a":1}');
    expect(stringifyError(undefined)).toBe('undefined');
    expect(stringifyError({a: 1})).not.toContain('[object Object]');
  });
});

describe('renderEnvHint', () => {
  it('hints on launch or listen failures only', () => {
    expect(renderEnvHint('listen EPERM: operation not permitted 127.0.0.1')).toContain('sandbox');
    expect(renderEnvHint('bootstrap_check_in: Permission denied (1100)')).toContain('Chrome');
    expect(renderEnvHint('props.json is missing')).toBeUndefined();
  });
});
