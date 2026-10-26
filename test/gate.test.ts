import {cpSync, mkdtempSync, readFileSync, utimesSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {describe, expect, it} from 'vitest';
import {approvalProblem} from '../scripts/approval.js';
import {
  applyApproval,
  buildSummary,
  creditsProblem,
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
    expect(renderSummary(s)).toContain('target 70-90 s');
  });

  it('voiced provider discloses narration text only, with characters and no price', () => {
    const s = buildSummary(raw, validation, {provider: 'elevenlabs'});
    expect(s.disclosures[0]?.receives).toMatch(/^narration text only/);
    expect(s.costNote).toContain(`${s.narrationChars} characters`);
    expect(s.costNote).not.toMatch(/\$|USD/);
  });

  it('shows provider source, egress, approval note; piper has no cost', () => {
    const s = buildSummary(raw, validation, {provider: 'openai', providerSource: 'env'});
    const text = renderSummary(s);
    expect(s.providerSource).toBe('env');
    expect(text).toContain('chosen by env');
    expect(text).toContain('Egress: narration text is sent to OpenAI');
    expect(text).toContain('Nothing is sent to any service until you approve');
    const p = buildSummary(raw, validation, {provider: 'piper', providerSource: 'flag'});
    expect(p.costNote).toContain('no cost');
    expect(p.egress).toContain('nothing leaves');
  });

  it('reports the mode and its target in the summary', () => {
    expect(buildSummary(raw, validation).mode).toBe('normal');
    const quick = {...(raw as object), mode: 'quick'};
    const s = buildSummary(quick, validation);
    expect(s.mode).toBe('quick');
    expect(s.target).toEqual({minSec: 25, maxSec: 35});
    expect(renderSummary(s)).toContain('Mode: quick');
  });

  it('warns when voiced estimate x1.15 exceeds the mode target ceiling (90 s), never for silent', () => {
    const base = raw as {scenes: {narration?: string}[]};
    const mk = (n: number) => ({
      ...base,
      scenes: base.scenes.map((x) => ({...x, narration: Array(n).fill('word').join(' ')})),
    });
    const long = mk(31);
    const short = mk(10);
    expect(
      buildSummary(short, validation, {provider: 'elevenlabs'}).voicedLengthWarning,
    ).toBeUndefined();
    const s = buildSummary(long, validation, {provider: 'elevenlabs'});
    expect(s.totalSec).toBeGreaterThan(90 / 1.15);
    expect(s.totalSec).toBeLessThanOrEqual(90);
    expect(s.voicedLengthWarning).toContain('15% longer');
    expect(buildSummary(long, validation).voicedLengthWarning).toBeUndefined();
  });

  it('names MCP servers from the brief', () => {
    const brief =
      '## Sources consulted\n- code: used\n- Notion: used\n- Linear: absent\n\nsee [mcp:sentry issue]';
    expect(mcpServersFromBrief(brief)).toEqual(['notion', 'sentry']);
    expect(
      buildSummary(raw, validation, {briefText: brief}).disclosures.map((d) => d.service),
    ).toContain('MCP server "notion"');
  });

  it('discloses external sources: used servers, context URLs by host, skipped servers', () => {
    const brief = [
      '## Context (from tickets/docs)',
      '- C01 Ask. [url https://linear.app/x/issue/A-1] [url https://linear.app/x/issue/A-1]',
      '- C02 Doc. [url https://notion.so/p/1]',
      '## Sources consulted',
      '- code: used',
      '- mcp:linear: used',
      '## Excluded / redacted',
      '- mcp:sentry: unavailable',
      '',
    ].join('\n');
    expect(mcpServersFromBrief(brief)).toEqual(['linear']);
    const s = buildSummary(raw, validation, {briefText: brief});
    expect(s.externalSources).toEqual([{server: 'linear', status: 'used'}]);
    expect(s.externalUrls).toEqual([
      {host: 'linear.app', urls: ['https://linear.app/x/issue/A-1']},
      {host: 'notion.so', urls: ['https://notion.so/p/1']},
    ]);
    expect(s.skippedServers).toEqual(['sentry']);
    const out = renderSummary(s);
    expect(out).toContain('mcp:linear: used');
    expect(out).toContain('linear.app: https://linear.app/x/issue/A-1');
    expect(out).toContain('mcp:sentry: unavailable, skipped');
    expect(renderSummary(buildSummary(raw, validation))).not.toContain('External sources');
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

describe('deep mode credits confirmation', () => {
  const deepSb = (sb: Record<string, unknown>) => {
    const scenes = sb.scenes as Record<string, unknown>[];
    const mid = scenes[1] as {id: string};
    const extra = Array.from({length: 4}, (_, i) => ({...mid, id: `x${i}`}));
    const all = [...scenes.slice(0, -1), ...extra, scenes[scenes.length - 1]] as {id: string}[];
    all.forEach((x, i) => (x.id = `s${String(i + 1).padStart(2, '0')}`));
    sb.scenes = all;
    sb.mode = 'deep';
  };
  const raw = (() => {
    const sb = JSON.parse(fixture('minimal')) as Record<string, unknown>;
    deepSb(sb);
    return sb;
  })();
  const validation = validateStoryboard(raw, {repoRoot: REPO});

  it('the deep fixture itself is valid', () => {
    expect(validation.errors).toEqual([]);
  });

  it('voiced deep summary carries a prominent credits disclosure and requires confirmation', () => {
    const s = buildSummary(raw, validation, {provider: 'elevenlabs'});
    expect(s.mode).toBe('deep');
    expect(s.requiresCreditsConfirmation).toBe(true);
    expect(s.creditsDisclosure).toContain('CREDITS WARNING');
    expect(s.creditsDisclosure).toContain(`${s.narrationChars} characters`);
    expect(s.creditsDisclosure).toContain(`${s.narrationWords} words`);
    expect(s.creditsDisclosure).toContain('ElevenLabs bills credits per character');
    expect(renderSummary(s)).toContain('--confirm-credits');
    expect(creditsProblem(s, undefined)).toContain('--confirm-credits');
    expect(creditsProblem(s, true)).toBeUndefined();
  });

  it('silent, local and non-deep voiced runs need no confirmation', () => {
    expect(buildSummary(raw, validation).requiresCreditsConfirmation).toBe(false);
    expect(buildSummary(raw, validation, {provider: 'piper'}).requiresCreditsConfirmation).toBe(
      false,
    );
    const normal = JSON.parse(fixture('minimal')) as unknown;
    const s = buildSummary(normal, validateStoryboard(normal, {repoRoot: REPO}), {
      provider: 'elevenlabs',
    });
    expect(s.requiresCreditsConfirmation).toBe(false);
    expect(s.creditsDisclosure).toBeUndefined();
  });

  it('CLI: voiced deep --approve fails without --confirm-credits, passes with it; silent needs none', () => {
    const dir = runDir('minimal', deepSb);
    const no = tsx(['scripts/gate.ts', dir, '--approve', '--provider', 'elevenlabs']);
    expect(no.status).toBe(2);
    expect(no.stderr).toContain('--confirm-credits');
    expect(JSON.parse(readFileSync(path.join(dir, 'storyboard.json'), 'utf8')).approved).not.toBe(
      true,
    );
    const yes = tsx([
      'scripts/gate.ts',
      dir,
      '--approve',
      '--provider',
      'elevenlabs',
      '--confirm-credits',
    ]);
    expect(yes.status, yes.stderr).toBe(0);
    expect(JSON.parse(readFileSync(path.join(dir, 'storyboard.json'), 'utf8')).approved).toBe(true);
    const silent = runDir('minimal', deepSb);
    const s = tsx(['scripts/gate.ts', silent, '--approve', '--no-voice']);
    expect(s.status, s.stderr).toBe(0);
  });
});
