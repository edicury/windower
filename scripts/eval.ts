// eval: `eval <run-dir> [--repo <root>] [--json] [--factcheck <file>]` scores a finished run against the
// T5 rubric (deterministic parts). Exit 0 pass, 2 fail. Also writes <run>/eval-factcheck.md for the
// human spot-check; `--factcheck` scores a filled sheet (>= 4/5 supported).
import {spawnSync} from 'node:child_process';
import {existsSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {lintBrief} from './brief.js';
import {EXIT} from './lib.js';
import {redactText, scanText} from './redaction.js';
import {isMode, profileOf} from '../template/src/modes.js';
import {checkTotal, computeTiming, type Timing} from './timing.js';
import {formatIssue, validateStoryboard} from './validate-storyboard.js';

export const EVAL_USAGE = 'Usage: eval <run-dir> [--repo <root>] [--json] [--factcheck <file>]';
export const FACTCHECK_SAMPLE = 5;
export const FACTCHECK_PASS = 4;

export interface CheckResult {
  id: string;
  title: string;
  pass: boolean;
  details: string[];
}

export interface EvalReport {
  runDir: string;
  pass: boolean;
  checks: CheckResult[];
  factcheckSheet?: string;
}

type Loose = Record<string, unknown>;
interface SceneLike {
  id?: string;
  type?: string;
  narration?: string;
  file?: string;
  startLine?: number;
  code?: string;
  sources?: {kind?: string; ref?: string}[];
}

const readLines = (file: string): string[] => {
  const lines = readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
};

function under(root: string, rel: string): string | undefined {
  const full = path.resolve(root, rel);
  const r = path.relative(root, full);
  return r.startsWith('..') || path.isAbsolute(r) ? undefined : full;
}

const parseRef = (ref: string): {file: string; a: number; b: number} | undefined => {
  const m = /^(.+?):(\d+)(?:-(\d+))?$/.exec(ref);
  return m ? {file: m[1]!, a: Number(m[2]), b: Number(m[3] ?? m[2])} : undefined;
};

/** Deterministic PRNG (mulberry32) seeded from a string. */
function seeded(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pickClaims(scenes: SceneLike[], slug: string, n = FACTCHECK_SAMPLE): SceneLike[] {
  const pool = scenes.filter(
    (s) =>
      s.narration &&
      s.sources?.some((x) => x.kind === 'file' && x.ref && parseRef(x.ref)) &&
      s.type !== 'title' &&
      s.type !== 'outro',
  );
  const rnd = seeded(slug);
  const arr = [...pool];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  const picked = new Set(arr.slice(0, n));
  return pool.filter((s) => picked.has(s)); // keep storyboard order
}

export function buildFactcheckSheet(
  scenes: SceneLike[],
  slug: string,
  repoRoot: string | undefined,
): string {
  const picks = pickClaims(scenes, slug);
  const out: string[] = [
    `# Fact check: ${slug}`,
    '',
    `Check each scene's narration against the cited code. Fill the table: write yes or no in "Supported?". Pass needs at least ${FACTCHECK_PASS} of ${FACTCHECK_SAMPLE} yes.`,
    '',
  ];
  picks.forEach((s, i) => {
    out.push(`## ${i + 1}. Scene ${s.id}`, '', `Narration: ${s.narration}`, '');
    for (const src of s.sources ?? []) {
      const r = src.kind === 'file' && src.ref ? parseRef(src.ref) : undefined;
      if (!r) continue;
      out.push(`Cited: ${src.ref}`, '');
      const full = repoRoot ? under(repoRoot, r.file) : undefined;
      if (!full || !existsSync(full)) {
        out.push('(file not found)', '');
        continue;
      }
      const lines = readLines(full);
      const end = Math.min(r.b, r.a + 14, lines.length);
      const body = lines
        .slice(r.a - 1, end)
        .map((l, k) => `${String(r.a + k).padStart(4)}  ${l}`)
        .join('\n');
      out.push('```', redactText(body).text, '```', '');
    }
  });
  out.push(
    '## Reviewer table',
    '',
    '| # | Scene | Supported? (yes/no) | Notes |',
    '|---|---|---|---|',
  );
  picks.forEach((s, i) => out.push(`| ${i + 1} | ${s.id} |  |  |`));
  out.push('');
  return out.join('\n');
}

/** Scores a filled sheet; needs >= 80% yes (4 of 5) and every row answered. */
export function scoreFactcheck(text: string): CheckResult {
  const rows = [...text.matchAll(/^\|\s*(\d+)\s*\|\s*([^|\s]+)\s*\|\s*([^|]*?)\s*\|/gm)];
  const answered = rows.filter((m) => /^(yes|no)$/i.test(m[3]!.trim()));
  const yes = answered.filter((m) => /^yes$/i.test(m[3]!.trim())).length;
  const total = rows.length;
  const need = Math.ceil((FACTCHECK_PASS / FACTCHECK_SAMPLE) * Math.max(total, 1));
  const details = [`${yes}/${total} claims supported (need ${need})`];
  if (!total) details.push('no reviewer table rows found');
  else if (answered.length < total) details.push(`${total - answered.length} row(s) unanswered`);
  return {
    id: 'factcheck',
    title: 'fact check spot-check',
    pass: total > 0 && answered.length === total && yes >= need,
    details,
  };
}

function probeDuration(file: string): number | undefined {
  const r = spawnSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
    {encoding: 'utf8'},
  );
  if (r.error || r.status !== 0) return undefined;
  const v = Number(r.stdout.trim());
  return Number.isFinite(v) ? v : undefined;
}

export interface EvalOptions {
  repo?: string;
  factcheckFile?: string;
  writeSheet?: boolean;
}

export function evalRun(runDirIn: string, opts: EvalOptions = {}): EvalReport {
  const runDir = path.resolve(runDirIn);
  const checks: CheckResult[] = [];
  const add = (id: string, title: string, details: string[]) =>
    checks.push({id, title, pass: details.length === 0, details});
  const slug = path.basename(runDir);

  const briefFile = path.join(runDir, 'brief.md');
  const sbFile = path.join(runDir, 'storyboard.json');
  const briefText = existsSync(briefFile) ? readFileSync(briefFile, 'utf8') : undefined;
  let sbText: string | undefined;
  let sb: Loose | undefined;
  try {
    sbText = readFileSync(sbFile, 'utf8');
    sb = JSON.parse(sbText) as Loose;
  } catch (e) {
    sb = undefined;
    add('storyboard', 'storyboard validates with the brief', [
      `cannot read storyboard.json: ${(e as Error).message}`,
    ]);
  }

  // (a) brief lint
  add(
    'brief',
    'brief lints clean',
    briefText === undefined
      ? ['brief.md not found']
      : lintBrief(briefText).map((f) => `${f.line ? `line ${f.line}: ` : ''}${f.message}`),
  );

  if (!sb) {
    return {runDir, pass: false, checks};
  }

  const baseDir = runDir;
  const repoRaw = opts.repo ?? (typeof sb.repoRoot === 'string' ? sb.repoRoot : undefined);
  const repoRoot = repoRaw ? path.resolve(opts.repo ? process.cwd() : baseDir, repoRaw) : undefined;
  const scenes = (Array.isArray(sb.scenes) ? sb.scenes : []) as SceneLike[];

  // (b) storyboard validates
  const res = validateStoryboard(sb, {baseDir, repoRoot: repoRoot, briefText});
  add('storyboard', 'storyboard validates with the brief', res.errors.map(formatIssue));

  // (c) citations resolve, code snippets verbatim
  const cite: string[] = [];
  if (!repoRoot || !existsSync(repoRoot)) cite.push(`repo root not found: ${repoRoot ?? '(none)'}`);
  else {
    for (const s of scenes) {
      const id = s.id ?? '?';
      for (const src of s.sources ?? []) {
        if (src.kind !== 'file') continue;
        const r = src.ref ? parseRef(src.ref) : undefined;
        if (!r) {
          cite.push(`${id}: bad file ref "${src.ref}"`);
          continue;
        }
        const full = under(repoRoot, r.file);
        if (!full || !existsSync(full) || !statSync(full).isFile()) {
          cite.push(`${id}: ${src.ref} - file not found`);
          continue;
        }
        const n = readLines(full).length;
        if (r.a < 1 || r.a > r.b || r.b > n)
          cite.push(`${id}: ${src.ref} - lines outside file (${n} lines)`);
      }
      if (s.type === 'code' && s.file && typeof s.code === 'string') {
        const full = under(repoRoot, s.file);
        if (!full || !existsSync(full)) {
          cite.push(`${id}: code file ${s.file} not found`);
          continue;
        }
        const have = readLines(full);
        const want = s.code.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
        const start = (s.startLine ?? 1) - 1;
        const got = have.slice(start, start + want.length);
        const bad = want.findIndex((l, k) => got[k] !== l);
        if (bad >= 0) cite.push(`${id}: code snippet differs from ${s.file}:${start + bad + 1}`);
      }
    }
  }
  add('citations', 'every source resolves and code snippets match the file', cite);

  // (d) redaction
  const red: string[] = [];
  for (const [name, text] of [
    ['brief.md', briefText],
    ['storyboard.json', sbText],
  ] as const) {
    if (text === undefined) continue;
    for (const f of scanText(text)) red.push(`${name}:${f.line}: ${f.label} - ${f.preview}`);
  }
  add('redaction', 'no unredacted secrets in brief or storyboard', red);

  // (e) duration
  const dur: string[] = [];
  let totalSec: number | undefined;
  const timingFile = path.join(runDir, 'timing.json');
  let timing: Timing | undefined;
  try {
    if (existsSync(timingFile)) timing = JSON.parse(readFileSync(timingFile, 'utf8')) as Timing;
  } catch {
    dur.push('timing.json is not valid JSON');
  }
  if (!timing && !dur.length) {
    try {
      timing = computeTiming(scenes as never);
    } catch (e) {
      dur.push(`cannot compute timing: ${(e as Error).message}`);
    }
  }
  const mode = isMode(sb.mode) ? sb.mode : undefined;
  const TARGET_RANGE_S = profileOf(mode).target;
  if (timing) {
    totalSec = timing.totalFrames / timing.fps;
    if (totalSec < TARGET_RANGE_S[0] || totalSec > TARGET_RANGE_S[1])
      dur.push(
        `total ${totalSec.toFixed(1)} s is outside ${TARGET_RANGE_S[0]}-${TARGET_RANGE_S[1]} s` +
          (checkTotal(timing, mode).message ? ` (${checkTotal(timing, mode).message})` : ''),
      );
  }
  add('duration', `total duration within ${TARGET_RANGE_S[0]}-${TARGET_RANGE_S[1]} s`, dur);

  // (f) approval gate
  const gate: string[] = [];
  if (sb.approved !== true) gate.push('approved is not true');
  if (
    typeof sb.approvedAt !== 'string' ||
    !sb.approvedAt ||
    Number.isNaN(Date.parse(sb.approvedAt))
  )
    gate.push('approvedAt missing or not a timestamp');
  add('approval', 'approval gate recorded before render', gate);

  // (g) video
  const video = path.join(runDir, 'out', 'video.mp4');
  if (existsSync(video)) {
    const vd: string[] = [];
    const d = probeDuration(video);
    if (d === undefined) vd.push('ffprobe could not read out/video.mp4');
    else if (totalSec !== undefined && Math.abs(d - totalSec) > 1)
      vd.push(`video is ${d.toFixed(2)} s, timing says ${totalSec.toFixed(2)} s (over 1 s apart)`);
    add('video', 'video duration matches timing within 1 s', vd);
  }

  // (h) fact check
  let factcheckSheet: string | undefined;
  if (opts.writeSheet !== false) {
    factcheckSheet = path.join(runDir, 'eval-factcheck.md');
    writeFileSync(factcheckSheet, buildFactcheckSheet(scenes, slug, repoRoot));
  }
  if (opts.factcheckFile) {
    try {
      checks.push(scoreFactcheck(readFileSync(opts.factcheckFile, 'utf8')));
    } catch {
      checks.push({
        id: 'factcheck',
        title: 'fact check spot-check',
        pass: false,
        details: [`cannot read ${opts.factcheckFile}`],
      });
    }
  }

  return {runDir, pass: checks.every((c) => c.pass), checks, factcheckSheet};
}

export function formatReport(r: EvalReport): string {
  const lines = [`eval ${r.runDir}`];
  for (const c of r.checks) {
    lines.push(`${c.pass ? 'PASS' : 'FAIL'}  ${c.title}`);
    for (const d of c.details) lines.push(`        ${d}`);
  }
  if (r.factcheckSheet) lines.push(`fact-check sheet: ${r.factcheckSheet}`);
  lines.push(r.pass ? 'RESULT: pass' : 'RESULT: fail');
  return lines.join('\n');
}

function main(): void {
  const {values, positionals} = parseArgs({
    options: {repo: {type: 'string'}, json: {type: 'boolean'}, factcheck: {type: 'string'}},
    allowPositionals: true,
  });
  const dir = positionals[0];
  if (!dir || !existsSync(dir)) {
    console.error(dir ? `run dir not found: ${dir}` : EVAL_USAGE);
    process.exit(EXIT.validation);
  }
  const report = evalRun(dir, {
    repo: values.repo,
    factcheckFile: values.factcheck ? path.resolve(values.factcheck) : undefined,
  });
  if (values.json) console.log(JSON.stringify(report, null, 2));
  else console.error(formatReport(report));
  process.exit(report.pass ? EXIT.ok : EXIT.validation);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
