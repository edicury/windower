// validate-storyboard: Zod schema + rules R1-R5 + per-scene limits (FR-SB-07) + referential checks
// (FR-SB-08). Every issue names the scene id and field. R6 (redaction) lands with phase 3.
import {existsSync, readFileSync, statSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import type {ZodIssue} from 'zod';
import {LIMITS, Storyboard} from '../template/src/schema.js';
import {EXIT} from './lib.js';
import {checkTotal, computeTiming, SCENE_SOFT_CAP_S} from './timing.js';

export interface Issue {
  severity: 'error' | 'warning';
  /** Scene id, or null for storyboard-level issues. */
  sceneId: string | null;
  /** Offending field, e.g. `items`, `edges[2].to`, `scenes`. */
  path: string;
  rule: string;
  message: string;
}

export interface ValidationResult {
  errors: Issue[];
  warnings: Issue[];
  estimatedSec?: number;
}

export interface ValidateOptions {
  /** Overrides storyboard.repoRoot. */
  repoRoot?: string;
  /** Directory a relative repoRoot is resolved against (the storyboard's directory). */
  baseDir?: string;
  /** Contents of brief.md; when given, every source ref must appear in it (R4). */
  briefText?: string;
}

type Loose = Record<string, unknown>;
const isObj = (v: unknown): v is Loose => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const int = (v: unknown): number | undefined => (Number.isInteger(v) ? (v as number) : undefined);

function fieldPath(p: PropertyKey[]): string {
  return p.reduce<string>((acc, seg) => {
    if (typeof seg === 'number') return `${acc}[${seg}]`;
    return acc ? `${acc}.${String(seg)}` : String(seg);
  }, '');
}

function mapZodIssue(issue: ZodIssue, scenes: unknown): Omit<Issue, 'severity'> {
  const p = issue.path;
  let sceneId: string | null = null;
  let rest: PropertyKey[] = p;
  if (p[0] === 'scenes' && typeof p[1] === 'number') {
    const sc = Array.isArray(scenes) ? scenes[p[1]] : undefined;
    sceneId = (isObj(sc) && str(sc.id)) || `scenes[${p[1]}]`;
    rest = p.slice(2);
  }
  let message = issue.message;
  let rule = 'schema';
  if (issue.code === 'invalid_union') {
    const t =
      sceneId && Array.isArray(scenes) && typeof p[1] === 'number'
        ? (scenes[p[1]] as Loose)?.type
        : undefined;
    message = `unknown scene type ${JSON.stringify(t)}; expected title, bullets, code, architecture or sequence`;
    rule = 'scene-type';
  } else if (issue.code === 'unrecognized_keys') {
    const keys = (issue as {keys?: string[]}).keys ?? [];
    message = `unknown field(s): ${keys.join(', ')}`;
    rule = 'unknown-field';
  } else if (issue.code === 'too_big' || issue.code === 'too_small') {
    rule = 'limit';
  } else if (issue.code === 'custom') {
    rule = 'limit';
  } else if (issue.code === 'invalid_type' && /received undefined/.test(issue.message)) {
    message = 'required field is missing';
    rule = 'required';
  }
  return {sceneId, path: fieldPath(rest) || (sceneId ? 'type' : '(root)'), rule, message};
}

export function resolveRepoRoot(raw: Loose, opts: ValidateOptions): string | undefined {
  const given = opts.repoRoot ?? str(raw.repoRoot);
  if (!given) return undefined;
  return path.resolve(opts.baseDir ?? process.cwd(), given);
}

function fileLines(file: string): string[] {
  const lines = readFileSync(file, 'utf8').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Resolves `rel` under `root`, refusing paths that escape it. */
function under(root: string, rel: string): string | undefined {
  const full = path.resolve(root, rel);
  const r = path.relative(root, full);
  return r.startsWith('..') || path.isAbsolute(r) ? undefined : full;
}

function checkSourceRef(
  root: string | undefined,
  ref: string,
  idx: number,
  err: (path: string, rule: string, message: string) => void,
): void {
  const field = `sources[${idx}].ref`;
  const m = /^(.+?):(\d+)(?:-(\d+))?$/.exec(ref);
  if (!m) {
    err(field, 'source-ref', `file ref must be path:line or path:start-end, got "${ref}"`);
    return;
  }
  if (!root || !existsSync(root)) return; // cannot resolve without a repo root
  const full = under(root, m[1] as string);
  if (!full || !existsSync(full) || !statSync(full).isFile()) {
    err(field, 'source-ref', `file not found under repoRoot ${root}: ${m[1]}`);
    return;
  }
  const a = Number(m[2]);
  const b = Number(m[3] ?? m[2]);
  const n = fileLines(full).length;
  if (a < 1 || a > b || b > n)
    err(field, 'source-ref', `line range ${a}-${b} is outside ${m[1]} (${n} lines)`);
}

export function validateStoryboard(raw: unknown, opts: ValidateOptions = {}): ValidationResult {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const push =
    (list: Issue[], severity: Issue['severity']) =>
    (sceneId: string | null, p: string, rule: string, message: string) =>
      list.push({severity, sceneId, path: p, rule, message});
  const addErr = push(errors, 'error');
  const addWarn = push(warnings, 'warning');

  if (!isObj(raw)) {
    addErr(null, '(root)', 'schema', 'storyboard must be a JSON object');
    return {errors, warnings};
  }

  // 1. Schema (types, limits, unknown fields, version).
  const parsed = Storyboard.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const m = mapZodIssue(issue, raw.scenes);
      errors.push({severity: 'error', ...m});
    }
  }

  // 2. Cross-scene rules and referential checks run on the raw data, so they report even when the
  //    schema already failed elsewhere.
  const scenes = Array.isArray(raw.scenes) ? raw.scenes : [];
  const root = resolveRepoRoot(raw, opts);
  const idOf = (s: Loose, i: number) => str(s.id) ?? `scenes[${i}]`;

  const seen = new Set<string>();
  let prevNum = -1;
  scenes.forEach((s, i) => {
    if (!isObj(s)) return;
    const id = idOf(s, i);
    const sid = str(s.id);
    if (sid) {
      const dup = seen.has(sid);
      if (dup) addErr(id, 'id', 'R1', `duplicate scene id ${sid}`);
      seen.add(sid);
      const m = /^s(\d{2})$/.exec(sid);
      if (m && !dup) {
        const n = Number(m[1]);
        if (n <= prevNum)
          addErr(
            id,
            'id',
            'R1',
            `scene ids must be ordered; ${sid} comes after s${String(prevNum).padStart(2, '0')}`,
          );
        prevNum = Math.max(prevNum, n);
      }
    }

    const isFirstTitle = i === 0 && s.type === 'title';
    const sources = s.sources;
    if (!isFirstTitle && Array.isArray(sources) && sources.length === 0)
      addErr(
        id,
        'sources',
        'R4',
        'sources is empty; every scene except the first title needs at least one source',
      );
    if (Array.isArray(sources)) {
      sources.forEach((src, k) => {
        if (!isObj(src)) return;
        const ref = str(src.ref);
        if (!ref) return;
        if (src.kind === 'file')
          checkSourceRef(root, ref, k, (p, rule, msg) => addErr(id, p, rule, msg));
        if (opts.briefText !== undefined && !opts.briefText.includes(ref))
          addErr(id, `sources[${k}].ref`, 'R4', `source "${ref}" does not appear in brief.md`);
      });
    }

    switch (s.type) {
      case 'code':
        checkCode(s, id, root, addErr);
        break;
      case 'architecture':
        checkArchitecture(s, id, addErr);
        break;
      case 'sequence':
        checkSequence(s, id, addErr);
        break;
      case 'bullets':
        if (Array.isArray(s.items)) {
          // ~68 chars fit per line at 46 px inside the 1560 px text column; budget is 8 wrapped lines.
          const lines = s.items.reduce<number>(
            (a, it) => a + Math.max(1, Math.ceil(String(it).length / 68)),
            0,
          );
          if (lines > 8)
            addWarn(
              id,
              'items',
              'layout',
              `about ${lines} wrapped lines; more than 8 may run under the captions bar`,
            );
        }
        break;
    }
  });

  // R2: first scene is a title; last is a title or bullets.
  const first = scenes[0];
  const last = scenes[scenes.length - 1];
  if (isObj(first) && first.type !== 'title')
    addErr(idOf(first, 0), 'type', 'R2', 'the first scene must be a title');
  if (isObj(last) && last.type !== 'title' && last.type !== 'bullets')
    addErr(
      idOf(last, scenes.length - 1),
      'type',
      'R2',
      'the last scene must be a title or bullets (recap)',
    );

  // 3. Duration (R5). Needs a valid storyboard so narration is trustworthy.
  let estimatedSec: number | undefined;
  if (parsed.success) {
    const timing = computeTiming(parsed.data.scenes);
    estimatedSec = timing.totalFrames / timing.fps;
    const verdict = checkTotal(timing);
    if (verdict.level === 'error') addErr(null, 'scenes', 'R5', verdict.message ?? '');
    else if (verdict.level === 'warn') addWarn(null, 'scenes', 'R5', verdict.message ?? '');
    for (const ts of timing.scenes) {
      const sec = ts.durationFrames / timing.fps;
      if (sec > SCENE_SOFT_CAP_S)
        addWarn(
          ts.id,
          'narration',
          'R5',
          `scene runs ${sec.toFixed(1)} s, above the ${SCENE_SOFT_CAP_S} s per-scene cap; shorten the narration`,
        );
    }
  }

  return {errors, warnings, estimatedSec};
}

type Add = (sceneId: string | null, p: string, rule: string, message: string) => void;

function checkCode(s: Loose, id: string, root: string | undefined, addErr: Add): void {
  const file = str(s.file);
  const a = int(s.startLine);
  const b = int(s.endLine);
  if (!root) {
    addErr(
      id,
      'file',
      'referential',
      'code scene needs a repoRoot (set it in the storyboard or pass --repo)',
    );
    return;
  }
  if (!existsSync(root)) {
    addErr(id, 'file', 'referential', `repoRoot does not exist: ${root}`);
    return;
  }
  if (!file) return;
  const full = under(root, file);
  if (!full || !existsSync(full) || !statSync(full).isFile()) {
    addErr(id, 'file', 'referential', `file not found under repoRoot ${root}: ${file}`);
    return;
  }
  if (a === undefined || b === undefined) return;
  const lines = fileLines(full);
  if (a > b) addErr(id, 'startLine', 'referential', `startLine ${a} > endLine ${b}`);
  else if (b > lines.length)
    addErr(
      id,
      'endLine',
      'referential',
      `endLine ${b} is past the end of ${file} (${lines.length} lines)`,
    );
  else {
    lines.slice(a - 1, b).forEach((line, k) => {
      if (line.length > LIMITS.codeLineChars)
        addErr(
          id,
          'file',
          'limit',
          `line length > ${LIMITS.codeLineChars}: line ${a + k} has ${line.length} chars`,
        );
    });
  }
  if (Array.isArray(s.focus)) {
    s.focus.forEach((f, k) => {
      if (!Array.isArray(f) || f.length !== 2) return;
      const [fa, fb] = f as number[];
      if (fa === undefined || fb === undefined) return;
      if (fa > fb || fa < a || fb > b)
        addErr(
          id,
          `focus[${k}]`,
          'referential',
          `focus range ${fa}-${fb} is outside the snippet ${a}-${b}`,
        );
    });
  }
}

function checkArchitecture(s: Loose, id: string, addErr: Add): void {
  const ids = new Set(
    (Array.isArray(s.nodes) ? s.nodes : [])
      .filter(isObj)
      .map((n) => str(n.id))
      .filter(Boolean),
  );
  (Array.isArray(s.edges) ? s.edges : []).forEach((e, k) => {
    if (!isObj(e)) return;
    for (const end of ['from', 'to'] as const) {
      const v = str(e[end]);
      if (v !== undefined && !ids.has(v))
        addErr(id, `edges[${k}].${end}`, 'referential', `edge ${end} "${v}" is not a node id`);
    }
  });
}

function checkSequence(s: Loose, id: string, addErr: Add): void {
  const n = Array.isArray(s.participants) ? s.participants.length : 0;
  (Array.isArray(s.messages) ? s.messages : []).forEach((m, k) => {
    if (!isObj(m)) return;
    for (const end of ['from', 'to'] as const) {
      const v = m[end];
      if (typeof v === 'number' && (!Number.isInteger(v) || v < 0 || v >= n))
        addErr(
          id,
          `messages[${k}].${end}`,
          'referential',
          `participant index ${v} is out of range (0-${n - 1})`,
        );
    }
  });
}

export function formatIssue(i: Issue): string {
  const where = i.sceneId ? `scene ${i.sceneId}` : 'storyboard';
  return `${i.severity === 'error' ? 'error' : 'warning'}: ${where} - ${i.path}: ${i.message} [${i.rule}]`;
}

/** Reads and validates a storyboard file. Returns issues plus the parsed JSON when readable. */
export function validateFile(file: string, opts: ValidateOptions = {}): ValidationResult {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    const message =
      code === 'ENOENT'
        ? `storyboard not found: ${file}`
        : `${file} is not valid JSON: ${(e as Error).message}`;
    return {
      errors: [{severity: 'error', sceneId: null, path: '(root)', rule: 'file', message}],
      warnings: [],
    };
  }
  return validateStoryboard(raw, {baseDir: path.dirname(path.resolve(file)), ...opts});
}

function main(): void {
  const {values, positionals} = parseArgs({
    options: {
      repo: {type: 'string'},
      brief: {type: 'string'},
      json: {type: 'boolean'},
      quiet: {type: 'boolean'},
    },
    allowPositionals: true,
  });
  const file = positionals[0];
  if (!file) {
    console.error(
      'Usage: validate-storyboard <storyboard.json> [--repo <root>] [--brief <brief.md>] [--json]',
    );
    process.exit(EXIT.validation);
  }
  let briefText: string | undefined;
  if (values.brief) {
    try {
      briefText = readFileSync(values.brief, 'utf8');
    } catch {
      console.error(`brief not found: ${values.brief}`);
      process.exit(EXIT.validation);
    }
  }
  const result = validateFile(file, {
    repoRoot: values.repo ? path.resolve(values.repo) : undefined,
    briefText,
  });
  const all = [...result.errors, ...result.warnings];
  if (values.json) console.log(JSON.stringify(all, null, 2));
  else if (!values.quiet) {
    for (const i of all) console.error(formatIssue(i));
    if (!all.length) console.error(`${file}: valid (${result.estimatedSec?.toFixed(1)} s)`);
  }
  process.exit(result.errors.length ? EXIT.validation : EXIT.ok);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
