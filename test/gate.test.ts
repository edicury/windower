import {cpSync, mkdtempSync, readFileSync, utimesSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {describe, expect, it} from 'vitest';
import {approvalProblem} from '../scripts/approval.js';
import {
  applyApproval,
  buildSummary,
  mcpServersFromBrief,
  renderSummary,
} from '../scripts/gateSummary.js';
import {prepare} from '../scripts/prepare.js';
import {validateStoryboard} from '../scripts/validate-storyboard.js';

const tsx = (args: string[]) =>
  spawnSync('pnpm', ['exec', 'tsx', ...args], {encoding: 'utf8', cwd: process.cwd()});
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 've-gate-'));
const REPO = path.resolve('fixtures/repos/sample');
const fixture = (name: string) => readFileSync(`fixtures/storyboards/${name}.json`, 'utf8');
function runDir(name: string, patch: (sb: Record<string, unknown>) => void = () => undefined) {
  const dir = tmp();
  const sb = JSON.parse(fixture(name)) as Record<string, unknown>;
  sb.repoRoot = REPO;
  patch(sb);
  writeFileSync(path.join(dir, 'storyboard.json'), JSON.stringify(sb, null, 2) + '\n');
  return dir;
}

describe('buildSummary', () => {
  const raw = JSON.parse(fixture('minimal')) as unknown;
  const validation = validateStoryboard(raw, {repoRoot: REPO});

  it('lists scenes, length, citations and silent cost note', () => {
    const s = buildSummary(raw, validation);
    expect(s.scenes.length).toBe(8);
    expect(s.scenes[0]?.title).toBeTruthy();
    expect(s.totalSec).toBeGreaterThan(30);
    expect(s.sourceRefs).toBeGreaterThan(0);
    expect(s.narrationChars).toBeGreaterThan(100);
    expect(s.costNote).toBe('silent, 0 characters billed (provider: null)');
    expect(s.disclosures[0]?.service).toContain('none');
    expect(renderSummary(s)).toContain('target 60-120 s');
  });

  it('voiced provider discloses narration text only, with characters and no price', () => {
    const s = buildSummary(raw, validation, {provider: 'elevenlabs'});
    expect(s.disclosures[0]?.receives).toMatch(/^narration text only/);
    expect(s.costNote).toContain(`${s.narrationChars} characters`);
    expect(s.costNote).not.toMatch(/\$|USD/);
  });

  it('names MCP servers from the brief', () => {
    const brief =
      '## Sources consulted\n- code: used\n- Notion: used\n- Linear: absent\n\nsee [mcp:sentry issue]';
    expect(mcpServersFromBrief(brief)).toEqual(['notion', 'sentry']);
    expect(
      buildSummary(raw, validation, {briefText: brief}).disclosures.map((d) => d.service),
    ).toContain('MCP server "notion"');
  });
});

describe('applyApproval', () => {
  it('sets approved/approvedAt preserving order, indent and other fields', () => {
    const text = '{\n    "version": 1,\n    "approved": false,\n    "scenes": [1]\n}\n';
    const out = applyApproval(text, '2026-01-01T00:00:00.000Z');
    expect(out).toBe(
      '{\n    "version": 1,\n    "approved": true,\n    "approvedAt": "2026-01-01T00:00:00.000Z",\n    "scenes": [\n        1\n    ]\n}\n',
    );
  });
  it('inserts approved when absent and replaces a stale approvedAt', () => {
    const out = JSON.parse(
      applyApproval('{"a":1,"approvedAt":"old","scenes":[]}', 'now'),
    ) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(['a', 'approved', 'approvedAt', 'scenes']);
    expect(out.approvedAt).toBe('now');
  });
});

describe('gate CLI', () => {
  it('no argument prints usage, exit 2', () => {
    const r = tsx(['scripts/gate.ts']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Usage: gate');
  });

  it('--json prints the summary on stdout without approving', () => {
    const dir = runDir('minimal');
    const r = tsx(['scripts/gate.ts', dir, '--json']);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout) as {valid: boolean; approved: boolean; scenes: unknown[]};
    expect(out.valid).toBe(true);
    expect(out.approved).toBe(false);
    expect(JSON.parse(readFileSync(path.join(dir, 'storyboard.json'), 'utf8')).approved).not.toBe(
      true,
    );
  });

  it('--approve writes approved + approvedAt and keeps the file valid', () => {
    const dir = runDir('minimal');
    const r = tsx(['scripts/gate.ts', dir, '--approve']);
    expect(r.status).toBe(0);
    const sb = JSON.parse(readFileSync(path.join(dir, 'storyboard.json'), 'utf8'));
    expect(sb.approved).toBe(true);
    expect(Date.parse(sb.approvedAt)).not.toBeNaN();
    expect(approvalProblem(path.join(dir, 'storyboard.json'))).toBeUndefined();
    expect(tsx(['scripts/validate-storyboard.ts', path.join(dir, 'storyboard.json')]).status).toBe(
      0,
    );
  });

  it('--approve refuses an invalid storyboard, exit 2, file untouched', () => {
    const dir = tmp();
    cpSync('fixtures/storyboards/invalid-duplicate-id.json', path.join(dir, 'storyboard.json'));
    const before = readFileSync(path.join(dir, 'storyboard.json'), 'utf8');
    const r = tsx(['scripts/gate.ts', dir, '--approve']);
    expect(r.status).toBe(2);
    expect(readFileSync(path.join(dir, 'storyboard.json'), 'utf8')).toBe(before);
  });
});

describe('unapproved storyboards are refused (P3)', () => {
  it('prepare API and CLI exit 2 pointing to ve:gate; escape hatch warns', async () => {
    const dir = runDir('minimal');
    const file = path.join(dir, 'storyboard.json');
    const err = await prepare(file).catch((e) => e);
    expect(err.exitCode).toBe(2);
    expect(err.message).toContain('ve:gate');
    const cli = tsx(['scripts/prepare.ts', file]);
    expect(cli.status).toBe(2);
    expect(cli.stderr).toContain('ve:gate');
    const ok = tsx(['scripts/prepare.ts', file, '--allow-unapproved']);
    expect(ok.status).toBe(0);
    expect(ok.stderr).toContain('--allow-unapproved');
  });

  it('prepare succeeds once approved', () => {
    const dir = runDir('minimal', (sb) => {
      sb.approved = true;
    });
    const r = tsx(['scripts/prepare.ts', path.join(dir, 'storyboard.json')]);
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain('allow-unapproved');
  });

  it('render exits 2 pointing to ve:gate when approved !== true', () => {
    const dir = runDir('minimal');
    expect(
      tsx(['scripts/prepare.ts', path.join(dir, 'storyboard.json'), '--allow-unapproved']).status,
    ).toBe(0);
    const now = new Date();
    utimesSync(path.join(dir, 'props.json'), now, now);
    const r = tsx(['scripts/render.ts', dir]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('ve:gate');
  });
});
