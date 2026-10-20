// status: `status <run-dir> [--json]` reports each stage (missing|done|stale) and the next stage to run.
// `status init <slug-or-title> [--root <dir>]` creates .windower/<slug>/ (collision-safe) and prints the path.
import {existsSync, mkdirSync, readFileSync, readdirSync, statSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {EXIT} from './lib.js';
import {actionFor, computeStatus, uniqueSlug, type RunFacts, type RunStatus} from './stages.js';
import {formatIssue, validateFile} from './validate-storyboard.js';

export {slugify, uniqueSlug} from './stages.js';

export const STATUS_USAGE =
  'Usage: status <run-dir> [--json]\n       status init <slug-or-title> [--root <dir>] [--json]';

const mtimeOf = (p: string): number | undefined =>
  existsSync(p) ? statSync(p).mtimeMs : undefined;

export function gatherFacts(runDir: string): RunFacts {
  const f = (name: string) => path.join(runDir, name);
  const srt = mtimeOf(f('out/captions.srt'));
  const vtt = mtimeOf(f('out/captions.vtt'));
  const facts: RunFacts = {
    mtime: {
      brief: mtimeOf(f('brief.md')),
      storyboard: mtimeOf(f('storyboard.json')),
      timing: mtimeOf(f('timing.json')),
      props: mtimeOf(f('props.json')),
      video: mtimeOf(f('out/video.mp4')),
      captions: srt !== undefined && vtt !== undefined ? Math.min(srt, vtt) : undefined,
    },
  };
  if (facts.mtime.storyboard !== undefined) {
    const res = validateFile(f('storyboard.json'));
    facts.storyboardValid = res.errors.length === 0;
    facts.storyboardErrors = res.errors.map(formatIssue);
    try {
      const raw = JSON.parse(readFileSync(f('storyboard.json'), 'utf8')) as {approved?: unknown};
      facts.storyboardApproved = raw.approved === true;
    } catch {
      facts.storyboardApproved = false;
    }
  }
  return facts;
}

export interface StatusReport extends RunStatus {
  runDir: string;
  nextAction: string | null;
}

export function inspectRun(runDir: string): StatusReport {
  const dir = path.resolve(runDir);
  const s = computeStatus(gatherFacts(dir));
  return {runDir: dir, ...s, nextAction: s.next ? actionFor(s.next) : null};
}

/** Creates <root>/.windower/<slug>, picking a free slug on collision. */
export function initRun(nameOrTitle: string, root = process.cwd()): {slug: string; dir: string} {
  const base = path.join(path.resolve(root), '.windower');
  mkdirSync(base, {recursive: true});
  const existing = readdirSync(base, {withFileTypes: true})
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  const slug = uniqueSlug(nameOrTitle, existing);
  const dir = path.join(base, slug);
  mkdirSync(path.join(dir, 'out'), {recursive: true});
  return {slug, dir};
}

export function formatReport(r: StatusReport): string {
  const lines = [`Run: ${r.runDir}`];
  for (const s of r.stages)
    lines.push(
      `  ${s.state.padEnd(7)} ${s.stage.padEnd(10)} ${s.file}${s.reason ? `  (${s.reason})` : ''}`,
    );
  for (const n of r.notes) lines.push(`Note: ${n}`);
  lines.push(r.next ? `Next: ${r.next} - ${r.nextAction}` : 'Next: none (run complete)');
  return lines.join('\n');
}

function main(): void {
  const {values, positionals} = parseArgs({
    options: {json: {type: 'boolean'}, root: {type: 'string'}},
    allowPositionals: true,
  });
  const [first, second] = positionals;
  if (first === 'init') {
    if (!second) {
      console.error(STATUS_USAGE);
      process.exit(EXIT.error);
    }
    const r = initRun(second, values.root);
    console.log(values.json ? JSON.stringify(r) : r.dir);
    process.exit(EXIT.ok);
  }
  if (!first) {
    console.error(STATUS_USAGE);
    process.exit(EXIT.error);
  }
  if (!existsSync(first) || !statSync(first).isDirectory()) {
    console.error(`run directory not found: ${first}`);
    process.exit(EXIT.error);
  }
  const report = inspectRun(first);
  if (values.json) console.log(JSON.stringify(report, null, 2));
  else console.log(formatReport(report));
  process.exit(EXIT.ok);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
