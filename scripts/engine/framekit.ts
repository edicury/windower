// framekit engine (FR-ADOPT-02, FR-CLI-16): programmatic API for bundle/select/still, the framekit CLI for media.
// The template is `template/`, which imports the framekit compat entries from the published `@windower/framekit` package.
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {LICENSE_NOTE, TEMPLATE, findShellExecutable, sharedShellDir} from '../lib.js';
import type {CheckResult} from '../lib.js';
import type {Engine, MediaOptions, RunResult, SelectOptions, StillOptions} from './types.js';

const INSTALL_HINT = 'Run `pnpm install` (it installs the published @windower/framekit package).';
const BROWSER_INSTALL = 'framekit browsers install';

/** Exit codes that retrying cannot fix: validation (2), environment (3), network (4). */
const NO_RETRY = new Set([2, 3, 4]);

/** Maps a framekit CLI exit code to windower's scheme (0 ok, 2 validation, 3 environment, 4 provider, 5 render). */
export function mapExitCode(code: number | null): number {
  if (code === 0) return 0;
  if (code === 2 || code === 3 || code === 4 || code === 5) return code;
  return code === null ? 1 : code === 1 ? 1 : 5;
}

/** Browser executable windower passes to framekit (B-2): the shared Headless Shell, when present. */
export function browserExecutable(): string | undefined {
  return findShellExecutable(sharedShellDir());
}

function cliBin(): string {
  const pkg = createRequire(import.meta.url).resolve('@windower/framekit/package.json');
  return path.join(path.dirname(pkg), 'dist', 'cli', 'bin.js');
}

/** Arguments with `--browser-executable` appended unless the caller set one. */
export function withBrowser(args: string[], exe = browserExecutable()): string[] {
  const set = args.some(
    (a) => a === '--browser-executable' || a.startsWith('--browser-executable='),
  );
  return exe && !set ? [...args, `--browser-executable=${exe}`] : args;
}

/** `--public-dir` appended for render/still: prepare stages narration audio in `template/public` (skipped when that directory does not exist yet). */
export function withPublicDir(args: string[], dir = path.join(TEMPLATE, 'public')): string[] {
  const media = args[0] === 'render' || args[0] === 'still';
  const set = args.some((a) => a === '--public-dir' || a.startsWith('--public-dir='));
  return media && !set && existsSync(dir) ? [...args, `--public-dir=${dir}`] : args;
}

function tailOf(stderr: string | null | undefined): string {
  return (stderr ?? '').trim().split('\n').slice(-12).join('\n');
}

/** Runs the framekit CLI; stdout is progress, stderr is kept for the tail. Retries once on a transient failure. */
export function runFramekit(args: string[]): RunResult {
  let tail = '';
  let exitCode = 1;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = spawnSync(process.execPath, [cliBin(), ...withPublicDir(withBrowser(args))], {
      cwd: TEMPLATE,
      stdio: ['ignore', 'inherit', 'pipe'],
      encoding: 'utf8',
    });
    if (r.stderr) process.stderr.write(r.stderr);
    if (r.status === 0) return {ok: true, tail: '', exitCode: 0};
    exitCode = mapExitCode(r.status);
    tail = tailOf(r.stderr) || (r.error ? r.error.message : `framekit exited with ${r.status}`);
    if (NO_RETRY.has(exitCode)) break;
    if (attempt === 1) console.error('Render failed; retrying once.');
  }
  return {ok: false, tail, exitCode};
}

function renderMedia(o: MediaOptions): RunResult {
  return runFramekit([
    'render',
    'src/index.ts',
    o.id,
    o.output,
    ...(o.propsFile ? [`--props=${o.propsFile}`] : []),
    `--port=${o.port}`,
    ...(o.extraArgs ?? []),
  ]);
}

function sessionOptions(o: {serveUrl: string; port: number}) {
  return {serveUrl: o.serveUrl, port: o.port, browserExecutable: browserExecutable() ?? null};
}

async function selectComposition(o: SelectOptions): Promise<unknown> {
  const {selectComposition: select} = await import('@windower/framekit/renderer');
  return select({...sessionOptions(o), id: o.id, inputProps: o.inputProps as never});
}

async function renderStill(o: StillOptions): Promise<void> {
  const {renderStill: still} = await import('@windower/framekit/renderer');
  await still({
    ...sessionOptions(o),
    composition: o.composition as never,
    output: o.output,
    frame: o.frame,
    inputProps: o.inputProps as never,
  });
}

interface DoctorCheck {
  key: string;
  status: string;
  detail?: string;
  fix?: string;
}

function parseDoctor(stdout: string): DoctorCheck[] {
  const parsed = JSON.parse(stdout) as {checks?: DoctorCheck[]};
  return parsed.checks ?? [];
}

function browserCheck(checks: DoctorCheck[]): CheckResult {
  const c = checks.find((x) => x.key === 'browser');
  const name = 'headless-shell';
  if (!c) return {id: 5, name, level: 'warn', message: 'framekit doctor reported no browser check'};
  if (c.status === 'pass')
    return {id: 5, name, level: 'pass', message: c.detail ?? 'browser found'};
  return {
    id: 5,
    name,
    level: c.status === 'fail' ? 'fail' : 'warn',
    message: c.detail ?? 'browser not found',
    fix: c.fix ?? `Run \`${BROWSER_INSTALL}\` (explicit download, one time).`,
  };
}

function doctorChecks(): CheckResult[] {
  try {
    const r = spawnSync(process.execPath, [cliBin(), ...withBrowser(['doctor', '--json'])], {
      cwd: TEMPLATE,
      encoding: 'utf8',
    });
    return [browserCheck(parseDoctor(r.stdout))];
  } catch (e) {
    return [
      {
        id: 5,
        name: 'headless-shell',
        level: 'fail',
        message: `framekit is not available: ${(e as Error).message.split('\n')[0]}`,
        fix: INSTALL_HINT,
      },
    ];
  }
}

function precheck(): string | undefined {
  if (!existsSync(path.join(TEMPLATE, 'src', 'index.ts')))
    return `template/ is missing. ${INSTALL_HINT}`;
  if (!existsSync(path.join(TEMPLATE, 'node_modules', '@windower', 'framekit')))
    return `Template dependencies are missing. ${INSTALL_HINT}`;
  return undefined;
}

export const framekitEngine: Engine = {
  name: 'framekit',
  licenseNote: LICENSE_NOTE,
  precheck,
  async bundle(entryPoint) {
    const {bundle} = await import('@windower/framekit/bundler/compat');
    return bundle({entryPoint, rootDir: TEMPLATE});
  },
  selectComposition,
  renderStill,
  renderMedia,
  run: runFramekit,
  doctorChecks,
};
