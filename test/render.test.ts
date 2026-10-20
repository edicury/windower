import {mkdtempSync, utimesSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {describe, expect, it} from 'vitest';

const render = (dir: string) =>
  spawnSync('pnpm', ['exec', 'tsx', 'scripts/render.ts', dir], {encoding: 'utf8'});
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 've-render-'));

describe('render checks props.json before rendering (FR-RND-08)', () => {
  it('missing props.json -> exit 2 saying missing', () => {
    const r = render(tmp());
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('props.json is missing');
  });

  it('wrong shape -> exit 2 saying wrong shape', () => {
    const dir = tmp();
    writeFileSync(path.join(dir, 'props.json'), '{"a":1}');
    const r = render(dir);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('wrong shape');
  });

  it('prototype-shaped scenes (no timing/captions) -> exit 2 wrong shape', () => {
    const dir = tmp();
    writeFileSync(path.join(dir, 'props.json'), '{"scenes":[{"id":"s01"}]}');
    const r = render(dir);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('wrong shape');
  });

  it('stale props.json -> exit 2 saying older', () => {
    const dir = tmp();
    const props = path.join(dir, 'props.json');
    writeFileSync(props, '{"scenes":[{"id":"s01"}]}');
    writeFileSync(path.join(dir, 'storyboard.json'), '{}');
    const old = new Date(Date.now() - 60_000);
    utimesSync(props, old, old);
    const r = render(dir);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('older than storyboard.json');
  });

  it('missing run dir -> exit 2', () => {
    const r = render(path.join(tmp(), 'nope'));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('run dir not found');
  });
});
