// Fake secrets are assembled at runtime so this file holds no scannable literal.
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {isSecretFile, redactText, scanText, summarize} from '../scripts/redaction.js';
import {validateStoryboard} from '../scripts/validate-storyboard.js';

const ROOT = path.resolve(__dirname, '..');
const rep = (c: string, n: number) => c.repeat(n);
const aws = 'AK' + 'IA' + rep('Q', 16);
const sk = 'sk' + '-' + rep('a1', 15);
const ghp = 'gh' + 'p_' + rep('Z9', 18);
const jwt = ['ey' + 'J' + rep('h', 12), rep('p', 14), rep('s', 14)].join('.');
const pem = '-----' + 'BEGIN RSA PRIVATE' + ' KEY-----';
const pemEnd = '-----' + 'END RSA PRIVATE' + ' KEY-----';
const xi = 'xi-api' + '-key';
const email = 'jane.doe' + '@' + 'acme-corp.io';
const phone = '415' + '-555-' + '0137';
const rules = (t: string, o = {}) => scanText(t, o).map((f) => f.rule);

describe('scanText', () => {
  it.each([
    ['aws-key', `id = ${aws}`],
    ['sk-key', `OPENAI=${sk}`],
    ['github-token', `x ${ghp} y`],
    ['jwt', `Bearer ${jwt}`],
    [
      'private-key',
      `${pem}\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu\n${pemEnd}`,
    ],
    ['xi-api-key', `${xi}: ${rep('k9', 12)}`],
    ['secret-assign', `const password = "${rep('hunter', 2)}";`],
    ['secret-assign', `{"apiKey": "${rep('ab12', 5)}"}`],
    ['secret-assign', `client_secret: '${rep('q', 12)}'`],
    ['email', `contact ${email} please`],
    ['phone', `call ${phone}`],
    ['phone', `call +${'55'} 11 91234 ${'5678'} today`],
  ])('detects %s', (rule, text) => {
    expect(rules(text)).toContain(rule);
  });

  it('reports line, column and a masked preview that never contains the secret', () => {
    const f = scanText(`ok\nconst k = "${aws}"; // x\n`)[0]!;
    expect(f.line).toBe(2);
    expect(f.col).toBe(12);
    expect(f.preview).not.toContain(aws);
    expect(f.preview).not.toContain(aws.slice(6));
    const g = scanText(`password = "${rep('s3cret', 3)}"`)[0]!;
    expect(g.preview).not.toContain('s3cret');
    expect(g.preview).toContain('password');
  });

  it('masks every finding on the same line', () => {
    const fs = scanText(`${aws} ${email}`);
    expect(fs).toHaveLength(2);
    for (const f of fs) {
      expect(f.preview).not.toContain(aws.slice(5));
      expect(f.preview).not.toContain('jane.doe');
    }
  });

  it('allowPii skips emails and phone numbers but not secrets', () => {
    expect(rules(`${email} ${phone}`, {allowPii: true})).toEqual([]);
    expect(rules(`${email} ${aws}`, {allowPii: true})).toEqual(['aws-key']);
  });

  it('does not flag normal code, placeholders or version-like numbers', () => {
    const ok = [
      'const token = parseToken(input);',
      'const password = process.env.DB_PASSWORD;',
      'password: "${PASSWORD}"',
      'apiKey: "<your key here>"',
      "headers: {'xi-api-key': apiKey}",
      'const secretCount = 3;',
      'tokens.push("abc")',
      'const sk = require("x");',
      'AKIA[0-9A-Z]{16} is the shape of an AWS key id',
      'released 2026-10-20 at 1920x1080, 30 fps, v1.2.3, port 3000',
      'import {x} from "@remotion/bundler";',
      'mail noreply@anthropic.com or someone@example.com',
      '// 12345678901234567890',
    ].join('\n');
    expect(scanText(ok)).toEqual([]);
  });
});

describe('redactText and summarize', () => {
  it('replaces spans with the marker and lists kinds and counts only', () => {
    const src = `a=${aws}\nb=${aws}\nmail ${email}\nkeep this`;
    const r = redactText(src);
    expect(r.text).toBe('a=‹redacted›\nb=‹redacted›\nmail ‹redacted›\nkeep this');
    expect(summarize(r.findings)).toEqual([
      '2 x AWS access key id replaced with ‹redacted›',
      '1 x email address replaced with ‹redacted›',
    ]);
  });

  it('keeps the assignment name when redacting a literal value', () => {
    const r = redactText(`const password = "${rep('x9', 6)}";`);
    expect(r.text).toBe('const password = "‹redacted›";');
  });

  it('is idempotent', () => {
    const once = redactText(`${aws} ${email}`).text;
    expect(scanText(once)).toEqual([]);
  });
});

describe('isSecretFile', () => {
  it.each([
    '.env',
    '.env.local',
    'a/b/.env.production',
    'k.pem',
    'id_rsa',
    'x/id_ed25519.pub',
    'store.jks',
  ])('%s', (f) => expect(isSecretFile(f)).toBe(true));
  it.each(['src/env.ts', 'README.md', 'tokens.ts'])('%s is fine', (f) =>
    expect(isSecretFile(f)).toBe(false),
  );
});

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'out') continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|mjs|json|md|css)$/.test(name)) out.push(p);
  }
  return out;
}

describe('the repo itself', () => {
  it('scripts/ and template/src hold nothing the scanner flags', () => {
    const hits: string[] = [];
    for (const f of [...walk(path.join(ROOT, 'scripts')), ...walk(path.join(ROOT, 'template/src'))])
      for (const x of scanText(readFileSync(f, 'utf8')))
        hits.push(`${path.relative(ROOT, f)}:${x.line} ${x.rule} ${x.preview}`);
    expect(hits).toEqual([]);
  });

  it('skill docs and fixtures are clean too', () => {
    const hits: string[] = [];
    for (const d of ['skills', 'commands', 'fixtures', 'test'])
      for (const f of walk(path.join(ROOT, d)))
        for (const x of scanText(readFileSync(f, 'utf8')))
          hits.push(`${path.relative(ROOT, f)}:${x.line} ${x.rule} ${x.preview}`);
    expect(hits).toEqual([]);
  });
});

describe('R6 in validate-storyboard', () => {
  const sample = path.join(ROOT, 'fixtures/repos/sample');
  const base = JSON.parse(
    readFileSync(path.join(ROOT, 'fixtures/storyboards/all-scenes.json'), 'utf8'),
  ) as {scenes: Record<string, unknown>[]; repoRoot?: string};
  const clone = () => structuredClone(base);
  const r6 = (sb: unknown) =>
    validateStoryboard(sb, {
      repoRoot: sample,
      baseDir: path.join(ROOT, 'fixtures/storyboards'),
    }).errors.filter((e) => e.rule === 'R6');

  it('minimal fixture has no R6 findings', () => expect(r6(clone())).toEqual([]));

  it('flags a secret in narration, naming scene and field, without echoing it', () => {
    const sb = clone();
    const sc = sb.scenes[1]!;
    sc.narration = `${String(sc.narration)} The key is ${aws}.`;
    const errs = r6(sb);
    expect(errs).toHaveLength(1);
    expect(errs[0]!.sceneId).toBe(sc.id);
    expect(errs[0]!.path).toBe('narration');
    expect(errs[0]!.message).not.toContain(aws.slice(5));
  });

  it('flags PII in nested fields unless allowed', () => {
    const sb = clone();
    const sc = sb.scenes[0]!;
    sc.headline = `Ask ${email}`;
    expect(r6(sb).map((e) => e.path)).toContain('headline');
    const res = validateStoryboard(sb, {
      repoRoot: sample,
      baseDir: path.join(ROOT, 'fixtures/storyboards'),
      allowPii: true,
    });
    expect(res.errors.filter((e) => e.rule === 'R6')).toEqual([]);
  });

  it('fails a code scene whose verbatim snippet holds a secret, and a .env file', () => {
    const sb = clone();
    const code = sb.scenes.find((s) => s.type === 'code');
    if (!code) throw new Error('fixture has no code scene');
    code.code = `const token = "${rep('Zz9', 5)}";`;
    const errs = r6(sb).filter((e) => e.sceneId === code.id);
    expect(errs.some((e) => e.path === 'code' && /FR-SEC-02/.test(e.message))).toBe(true);
    code.file = '.env.local';
    expect(r6(sb).some((e) => e.path === 'file')).toBe(true);
  });
});

describe('redact CLI', () => {
  const run = (args: string[], input?: string) =>
    spawnSync('pnpm', ['--silent', 've:redact', ...args], {cwd: ROOT, encoding: 'utf8', input});

  it('exits 2 with masked output, then --fix redacts and lists exclusions', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'redact-'));
    const f = path.join(dir, 'brief.md');
    writeFileSync(f, `# Brief\nkey ${aws}\nmail ${email}\n`);
    const found = run([f]);
    expect(found.status).toBe(2);
    expect(found.stdout).toContain(`${f}:2:`);
    expect(found.stdout).toContain('aws-key');
    expect(found.stdout + found.stderr).not.toContain(aws.slice(6));
    const fixed = run([f, '--fix']);
    expect(fixed.status).toBe(0);
    expect(fixed.stdout).toContain('Excluded / redacted');
    expect(readFileSync(f, 'utf8')).toBe('# Brief\nkey ‹redacted›\nmail ‹redacted›\n');
    expect(run([f]).status).toBe(0);
  });

  it('--allow-pii, --json and --stdin', () => {
    const t = `mail ${email}`;
    expect(run(['--stdin'], t).status).toBe(2);
    expect(run(['--stdin', '--allow-pii'], t).status).toBe(0);
    const j = JSON.parse(run(['--stdin', '--json'], `k ${aws}`).stdout) as {
      clean: boolean;
      reports: {findings: {rule: string; preview: string}[]}[];
    };
    expect(j.clean).toBe(false);
    expect(j.reports[0]!.findings[0]!.rule).toBe('aws-key');
    expect(JSON.stringify(j)).not.toContain(aws.slice(6));
  });

  it('refuses .env files without reading them', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'redact-'));
    const f = path.join(dir, '.env.local');
    writeFileSync(f, `K=${aws}\n`);
    const r = run([f, '--json']);
    const j = JSON.parse(r.stdout) as {reports: {skipped?: string; findings: unknown[]}[]};
    expect(j.reports[0]!.skipped).toMatch(/refused/);
    expect(j.reports[0]!.findings).toEqual([]);
    expect(r.status).toBe(0);
    expect(readFileSync(f, 'utf8')).toContain(aws);
  });

  it('prints usage with no input', () => {
    const r = run([]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Usage: redact');
  });
});
