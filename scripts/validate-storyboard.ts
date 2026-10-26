// validate-storyboard: Zod schema + rules R1-R5 + per-scene limits (FR-SB-07) + referential checks
// (FR-SB-08), R6 redaction (FR-SEC). Every issue names the scene id and field.
import {existsSync, readFileSync, statSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import type {ZodIssue} from 'zod';
import {LIMITS, Storyboard} from '../template/src/schema.js';
import {splitCode} from '../template/src/codeLines.js';
import {isKnownLanguage} from './code-highlight.js';
import {
  H_LABEL_CHARS,
  H_LABEL_W,
  MAX_H_LABEL_LINES,
  adjacent,
  hLabelLines,
  layoutGrid,
} from '../template/src/scenes/architectureLayout.js';
import {EXIT} from './lib.js';
import {isSecretFile, scanText} from './redaction.js';
import {checkTotal, computeTiming} from './timing.js';
import {CHAPTER_HINT_S, splitChapters} from './chapters.js';
import {profileOf} from '../template/src/modes.js';

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
  /** Do not flag emails and phone numbers (R6). */
  allowPii?: boolean;
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
    message = `unknown scene type ${JSON.stringify(t)}; expected title, bullets, code, architecture, sequence, timeline or outro`;
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

    const isFirstTitle = (i === 0 && s.type === 'title') || s.type === 'outro'; // outro may cite nothing (FR-SB-02)
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

    checkRedaction(s, id, opts.allowPii, addErr);

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
            (a, it) => a + Math.max(1, Math.ceil(String(it).length / LIMITS.bulletsCharsPerLine)),
            0,
          );
          if (lines > LIMITS.bulletsWrappedLines)
            addErr(
              id,
              'items',
              'limit',
              `about ${lines} wrapped lines; at most ${LIMITS.bulletsWrappedLines} fit above the captions bar (shorten items or split the scene)`,
            );
        }
        break;
    }
  });

  // R2: first scene is a title; last is a title or bullets.
  const first = scenes[0];
  const last = scenes[scenes.length - 1];
  const quick = raw.mode === 'quick'; // quick mode may open straight on content (no title scene)
  if (isObj(first) && first.type !== 'title' && !quick)
    addErr(idOf(first, 0), 'type', 'R2', 'the first scene must be a title');
  if (isObj(last) && last.type !== 'title' && last.type !== 'bullets' && last.type !== 'outro')
    addErr(
      idOf(last, scenes.length - 1),
      'type',
      'R2',
      'the last scene must be a title, bullets (recap) or outro',
    );

  // 3. Duration (R5). Needs a valid storyboard so narration is trustworthy.
  let estimatedSec: number | undefined;
  if (parsed.success) {
    const timing = computeTiming(parsed.data.scenes);
    estimatedSec = timing.totalFrames / timing.fps;
    const profile = profileOf(parsed.data.mode);
    const n = parsed.data.scenes.length;
    if (n < profile.scenes.min || n > profile.scenes.max)
      addErr(
        null,
        'scenes',
        'R5',
        `${profile.id} mode needs ${profile.scenes.min}-${profile.scenes.max} scenes, found ${n}`,
      );
    const verdict = checkTotal(timing, parsed.data.mode);
    if (verdict.level === 'error') addErr(null, 'scenes', 'R5', verdict.message ?? '');
    else if (verdict.level === 'warn') addWarn(null, 'scenes', 'R5', verdict.message ?? '');
    const labels = parsed.data.scenes.map((sc) => sc.chapter);
    for (const l of splitChapters(labels))
      addErr(
        null,
        'scenes',
        'chapter',
        `chapter "${l}" reappears after another chapter; scenes of one chapter must be contiguous`,
      );
    const hasChapters = labels.some(Boolean);
    if (hasChapters && profile.id !== 'deep')
      addWarn(
        null,
        'scenes',
        'chapter',
        `chapters are meant for deep videos; this is ${profile.id} mode (allowed, but unusual)`,
      );
    if (!hasChapters && profile.id === 'deep' && estimatedSec > CHAPTER_HINT_S)
      addWarn(
        null,
        'scenes',
        'chapter',
        `deep video of ~${estimatedSec.toFixed(0)} s has no chapters; consider grouping scenes with a "chapter" label`,
      );
    for (const ts of timing.scenes) {
      const sec = ts.durationFrames / timing.fps;
      if (sec > profile.sceneCapS)
        addWarn(
          ts.id,
          'narration',
          'R5',
          `scene runs ${sec.toFixed(1)} s, above the ${profile.sceneCapS} s per-scene cap; shorten the narration`,
        );
    }
  }

  warnProductNameCase(raw, addWarn);
  return {errors, warnings, estimatedSec};
}

const NAME_FIELDS = ['title', 'headline', 'narration'];

/** Style lint: the product name is always lowercase `windower` in titles, headlines and narration. */
function warnProductNameCase(
  raw: Record<string, unknown>,
  addWarn: (sceneId: string | null, p: string, rule: string, message: string) => number,
): void {
  const check = (sceneId: string | null, field: string, v: unknown) => {
    if (typeof v === 'string' && /\bWindower\b/.test(v))
      addWarn(sceneId, field, 'name-case', 'write the product name lowercase: "windower"');
  };
  check(null, 'title', raw.title);
  if (!Array.isArray(raw.scenes)) return;
  for (const sc of raw.scenes) {
    if (!isObj(sc)) continue;
    const id = typeof sc.id === 'string' ? sc.id : null;
    for (const f of NAME_FIELDS) check(id, f, sc[f]);
  }
}

/** Joins an object path for messages, e.g. `items[1]`. */
function joinPath(base: string, seg: string | number): string {
  return typeof seg === 'number' ? `${base}[${seg}]` : base ? `${base}.${seg}` : seg;
}

/** R6: no string field of a scene may match a redaction pattern (FR-SEC-01); code snippets are verbatim, so a match there means the file region itself holds a secret (FR-SEC-02). */
function checkRedaction(s: Loose, id: string, allowPii: boolean | undefined, addErr: Add): void {
  const walk = (v: unknown, p: string): void => {
    if (typeof v === 'string') {
      const seen = new Set<string>();
      for (const f of scanText(v, {allowPii})) {
        if (seen.has(f.rule)) continue;
        seen.add(f.rule);
        const where = s.type === 'code' && p === 'code' ? `line ${f.line} of the snippet: ` : '';
        const hint =
          s.type === 'code' && p === 'code'
            ? 'a code scene quotes the file verbatim, so choose lines without the secret or a different file (FR-SEC-02)'
            : 'remove or replace it with a description (FR-SEC-01)';
        addErr(id, p, 'R6', `${where}looks like a ${f.label} (${f.preview}); ${hint}`);
      }
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, joinPath(p, i)));
    else if (isObj(v)) for (const [k, x] of Object.entries(v)) walk(x, joinPath(p, k));
  };
  walk(s, '');
  if (s.type === 'code' && typeof s.file === 'string' && isSecretFile(s.file))
    addErr(
      id,
      'file',
      'R6',
      `${s.file} is a secret-bearing file type (.env*, keys, keystores); never quote it in a code scene (FR-SEC-02)`,
    );
}

type Add = (sceneId: string | null, p: string, rule: string, message: string) => void;

function checkCode(s: Loose, id: string, root: string | undefined, addErr: Add): void {
  const file = str(s.file);
  const start = int(s.startLine);
  const code = str(s.code);
  const lang = str(s.language);
  if (lang && !isKnownLanguage(lang))
    addErr(
      id,
      'language',
      'referential',
      `unknown language "${lang}" (use a Shiki language id or "text")`,
    );
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
  if (start === undefined || start < 1 || code === undefined) return;
  const diff = s.mode === 'diff';
  const snippet = splitCode(code);
  const fileText = fileLines(full);
  // Lines of the new side: every row in plain mode, context and added rows in diff mode.
  const count = diff ? snippet.filter((l) => !l.startsWith('-')).length : snippet.length;
  const end = start + count - 1;
  if (end > fileText.length) {
    addErr(
      id,
      'code',
      'referential',
      `snippet lines ${start}-${end} end past the end of ${file} (${fileText.length} lines)`,
    );
    return;
  }
  if (diff) return; // diff snippets are not verbatim (testing: validator compares unless mode is diff)
  let shown = 0;
  snippet.forEach((line, k) => {
    if (shown >= 3) return; // first few mismatches are enough to fix the snippet
    const want = fileText[start - 1 + k];
    if (line !== want) {
      shown += 1;
      addErr(
        id,
        'code',
        'verbatim',
        `line ${k + 1} differs from ${file}:${start + k}: expected ${JSON.stringify(want)}, got ${JSON.stringify(line)}`,
      );
    }
  });
}

function checkArchitecture(s: Loose, id: string, addErr: Add): void {
  const nodes = Array.isArray(s.nodes) ? s.nodes : [];
  const edges = Array.isArray(s.edges) ? s.edges : [];
  const order: string[] = [];
  const ids = new Set<string>();
  nodes.forEach((n, k) => {
    if (!isObj(n)) return;
    const nid = str(n.id);
    if (nid === undefined) return;
    if (ids.has(nid)) addErr(id, `nodes[${k}].id`, 'referential', `duplicate node id "${nid}"`);
    else {
      ids.add(nid);
      order.push(nid);
    }
  });
  // Grid placement follows node order (row-major), so adjacency is decided by the layout helper.
  const placed = layoutGrid(order);
  const pairs = new Set<string>();
  edges.forEach((e, k) => {
    if (!isObj(e)) return;
    let known = true;
    for (const end of ['from', 'to'] as const) {
      const v = str(e[end]);
      if (v !== undefined && !ids.has(v)) {
        known = false;
        addErr(id, `edges[${k}].${end}`, 'referential', `edge ${end} "${v}" is not a node id`);
      }
    }
    const from = str(e.from);
    const to = str(e.to);
    if (!known || from === undefined || to === undefined) return;
    if (from === to) {
      addErr(id, `edges[${k}]`, 'layout', `edge from "${from}" to itself is not allowed`);
      return;
    }
    pairs.add([from, to].sort().join('\u0000'));
    const a = placed.get(from);
    const b = placed.get(to);
    if (a && b && !adjacent(a, b))
      addErr(
        id,
        `edges[${k}]`,
        'layout',
        `edge "${from}" -> "${to}" joins non-adjacent grid nodes (${from} is at row ${a.row + 1}, col ${a.col + 1}; ${to} at row ${b.row + 1}, col ${b.col + 1}); only neighbouring nodes can be linked, reorder nodes or route through an intermediate node`,
      );
    const label = str(e.label);
    if (label && a && b && a.row === b.row && hLabelLines(label).length > MAX_H_LABEL_LINES)
      addErr(
        id,
        `edges[${k}].label`,
        'limit',
        `label "${label}" needs more than ${MAX_H_LABEL_LINES} lines in the ${H_LABEL_W} px gap; shorten it or use words under ${H_LABEL_CHARS} chars`,
      );
  });
  (Array.isArray(s.flow) ? s.flow : []).forEach((fl, k) => {
    if (!isObj(fl) || !Array.isArray(fl.path)) return;
    const path = fl.path;
    path.forEach((nid, j) => {
      if (typeof nid === 'string' && !ids.has(nid))
        addErr(id, `flow[${k}].path[${j}]`, 'referential', `flow node "${nid}" is not a node id`);
    });
    for (let j = 0; j + 1 < path.length; j++) {
      const x = path[j];
      const y = path[j + 1];
      if (typeof x !== 'string' || typeof y !== 'string' || !ids.has(x) || !ids.has(y)) continue;
      if (!pairs.has([x, y].sort().join('\u0000')))
        addErr(
          id,
          `flow[${k}].path[${j + 1}]`,
          'referential',
          `flow step "${x}" -> "${y}" has no edge between those nodes`,
        );
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
    const from = m.from;
    const to = m.to;
    if (typeof from === 'number' && typeof to === 'number') {
      if (from === to)
        addErr(
          id,
          `messages[${k}].to`,
          'layout',
          'a message from a participant to itself (self-message) is unsupported; use a separate participant for the second step, or a note step (a note on another message) instead',
        );
      else if (typeof m.note === 'string' && Math.max(from, to) === n - 1)
        addErr(
          id,
          `messages[${k}].note`,
          'layout',
          'no note on a message that ends at the rightmost participant (it would clip at the frame edge)',
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
      'allow-pii': {type: 'boolean'},
      json: {type: 'boolean'},
      quiet: {type: 'boolean'},
    },
    allowPositionals: true,
  });
  const file = positionals[0];
  if (!file) {
    console.error(
      'Usage: validate-storyboard <storyboard.json> [--repo <root>] [--brief <brief.md>] [--allow-pii] [--json]',
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
    allowPii: values['allow-pii'],
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
