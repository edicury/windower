// scripts/ve.sh is the sandbox fallback for pnpm ve:*; it must stay consistent with package.json.
import {accessSync, constants, readFileSync} from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

describe('scripts/ve.sh', () => {
  const sh = readFileSync(path.join(root, 'scripts/ve.sh'), 'utf8');

  it('is executable', () => {
    expect(() => accessSync(path.join(root, 'scripts/ve.sh'), constants.X_OK)).not.toThrow();
  });

  it('reads the mapping from package.json and uses a writable TMPDIR', () => {
    expect(sh).toContain('package.json');
    expect(sh).toContain('WINDOWER_TMPDIR');
    expect(sh).toContain('tsx/dist/esm/index.mjs');
  });

  it('every ve:* script has the plain "tsx scripts/<file>.ts" form the wrapper understands', () => {
    const names = Object.keys(pkg.scripts).filter((k) => k.startsWith('ve:'));
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) expect(pkg.scripts[n]).toMatch(/^tsx scripts\/[A-Za-z0-9._-]+\.ts$/);
  });
});
