import {mkdtempSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {describe, expect, it} from 'vitest';
import {lintBrief} from '../scripts/brief.js';

const GOOD = `# Brief

## Facts

- F01 The module exports greet. — [file src/greeter.ts:6-22]
- F02 Merged in the PR. — [git pr#12]

## Context (from tickets/docs)

- C01 Ticket asks for onboarding. — [url https://linear.app/x/issue/ABC-1]

## Sources consulted

- code: used
- mcp:linear: used
`;
const rules = (t: string) => lintBrief(t).map((f) => f.rule);

describe('lintBrief', () => {
  it('accepts the template shape, including "- none" context', () => {
    expect(lintBrief(GOOD)).toEqual([]);
    expect(
      lintBrief(
        '## Facts\n\n- F01 x [file a.ts:1]\n\n## Context\n\n- none\n\n## Sources consulted\n- code: used',
      ),
    ).toEqual([]);
  });
  it('flags facts and context items without a citation', () => {
    const t = GOOD.replace(' — [file src/greeter.ts:6-22]', '');
    expect(lintBrief(t)).toMatchObject([{rule: 'missing-citation', id: 'F01'}]);
    expect(rules(GOOD.replace(' — [url https://linear.app/x/issue/ABC-1]', ''))).toEqual([
      'missing-citation',
    ]);
  });
  it('flags duplicate ids', () => {
    expect(rules(GOOD.replace('F02', 'F01'))).toEqual(['duplicate-id']);
  });
  it('flags context items citing no url', () => {
    expect(rules(GOOD.replace('[url https://linear.app/x/issue/ABC-1]', '[file a.md:1]'))).toEqual([
      'context-no-url',
    ]);
  });
  it('flags a missing Sources consulted section', () => {
    expect(rules(GOOD.replace('## Sources consulted', '## Other'))).toEqual(['no-sources-section']);
  });
});

describe('brief CLI', () => {
  const run = (args: string[]) =>
    spawnSync('pnpm', ['exec', 'tsx', 'scripts/brief.ts', ...args], {encoding: 'utf8'});
  it('exit 0 when clean, exit 2 with --json findings otherwise', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 've-brief-'));
    const good = path.join(dir, 'good.md');
    const bad = path.join(dir, 'bad.md');
    writeFileSync(good, GOOD);
    writeFileSync(bad, GOOD.replace(' — [file src/greeter.ts:6-22]', ''));
    expect(run([good]).status).toBe(0);
    const r = run([bad, '--json']);
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stdout).findings[0].rule).toBe('missing-citation');
    expect(run([]).status).toBe(2);
  });
});
