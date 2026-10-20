import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {
  CheckResult,
  ESBUILD_NOTE,
  EXIT,
  LICENSE_NOTE,
  TEMPLATE,
  codeSceneProblems,
  findDsStore,
  findFreePort,
  freeDiskGb,
  hasBinary,
  headlessShellCached,
  isPortFree,
  nodeMajor,
  propsProblem,
} from './lib.js';

const {values} = parseArgs({
  options: {
    voice: {type: 'boolean', default: false},
    'run-dir': {type: 'string'},
    port: {type: 'string', default: '3000'},
    json: {type: 'boolean', default: false},
    quiet: {type: 'boolean', default: false},
  },
});

async function runChecks(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const add = (
    id: number,
    name: string,
    level: CheckResult['level'],
    message: string,
    fix?: string,
  ) => results.push({id, name, level, message, fix});

  // 1 Node + engines
  const tpl = JSON.parse(readFileSync(path.join(TEMPLATE, 'package.json'), 'utf8'));
  const major = nodeMajor();
  if (major < 18)
    add(1, 'node', 'fail', `Node ${process.versions.node} is too old`, 'Install Node >= 18.');
  else if (!tpl.engines?.node)
    add(
      1,
      'node',
      'fail',
      'template/package.json has no "engines" field',
      'Add {"engines": {"node": ">=18"}}.',
    );
  else add(1, 'node', 'pass', `Node ${process.versions.node}`);

  // 2 ffmpeg / ffprobe
  const missing = ['ffmpeg', 'ffprobe'].filter((b) => !hasBinary(b));
  if (missing.length)
    add(
      2,
      'ffmpeg',
      'fail',
      `${missing.join(', ')} not on PATH`,
      'Install ffmpeg (macOS: brew install ffmpeg).',
    );
  else add(2, 'ffmpeg', 'pass', 'ffmpeg and ffprobe found');

  // 3 node_modules
  if (!existsSync(path.join(TEMPLATE, 'node_modules')))
    add(3, 'node_modules', 'fail', 'template/node_modules is missing', 'Run `pnpm install`.');
  else add(3, 'node_modules', 'pass', 'dependencies installed');

  // 4 render port
  const port = Number(values.port);
  if (await isPortFree(port)) add(4, 'port', 'pass', `port ${port} is free`);
  else {
    const alt = await findFreePort();
    add(
      4,
      'port',
      'warn',
      `port ${port} is in use`,
      `Pass --port ${alt}; the render wrapper picks a free port automatically.`,
    );
  }

  // 5 Headless Shell
  if (headlessShellCached()) add(5, 'headless-shell', 'pass', 'Remotion Headless Shell cached');
  else
    add(
      5,
      'headless-shell',
      'warn',
      'Headless Shell not cached',
      'The first render downloads ~171 MB (one time; later installs reuse ~/.cache/windower) and needs network.',
    );

  // 6, 7 run dir
  const runDir = values['run-dir'];
  if (runDir) {
    const sbPath = path.join(runDir, 'storyboard.json');
    if (!existsSync(sbPath))
      add(6, 'storyboard', 'fail', `${sbPath} not found`, 'Author the storyboard first.');
    else {
      try {
        const problems = codeSceneProblems(JSON.parse(readFileSync(sbPath, 'utf8')), runDir);
        if (problems.length)
          add(
            6,
            'storyboard',
            'fail',
            problems.join('; '),
            'Fix repoRoot or the code scene file/line ranges.',
          );
        else add(6, 'storyboard', 'pass', 'storyboard, repoRoot and code scenes are valid');
      } catch (e) {
        add(6, 'storyboard', 'fail', `storyboard.json does not parse: ${(e as Error).message}`);
      }
    }
    const pp = propsProblem(runDir);
    if (pp) add(7, 'props', 'fail', pp, 'Run prepare to regenerate props.json.');
    else add(7, 'props', 'pass', 'props.json is present and fresh');
  }

  // 8 voice
  if (values.voice) {
    const problems: string[] = [];
    if (!process.env.ELEVENLABS_API_KEY) problems.push('ELEVENLABS_API_KEY is not set');
    if (!existsSync(path.join(TEMPLATE, 'public', 'audio')))
      problems.push('template/public/audio is missing');
    if (problems.length)
      add(
        8,
        'voice',
        'fail',
        problems.join('; '),
        'Export ELEVENLABS_API_KEY and create template/public/audio.',
      );
    else add(8, 'voice', 'pass', 'ELEVENLABS_API_KEY is set; public/audio exists');
  }

  // 9 disk
  const gb = freeDiskGb(TEMPLATE);
  if (gb < 5)
    add(9, 'disk', 'warn', `${gb.toFixed(1)} GB free`, 'Free at least 5 GB before rendering.');
  else add(9, 'disk', 'pass', `${gb.toFixed(0)} GB free`);

  // 10 .DS_Store
  const stray = existsSync(TEMPLATE) ? findDsStore(TEMPLATE) : [];
  if (stray.length)
    add(
      10,
      'ds-store',
      'warn',
      `${stray.length} stray .DS_Store in template`,
      `Delete: ${stray.join(' ')}`,
    );
  else add(10, 'ds-store', 'pass', 'no stray .DS_Store');

  return results;
}

const results = await runChecks();
const failed = results.filter((r) => r.level === 'fail');

if (values.json) {
  console.log(JSON.stringify({results, notes: [LICENSE_NOTE, ESBUILD_NOTE]}, null, 2));
} else if (!values.quiet) {
  const icon = {pass: 'ok  ', warn: 'warn', fail: 'FAIL'};
  for (const r of results) {
    console.error(`[${icon[r.level]}] ${r.name}: ${r.message}`);
    if (r.level !== 'pass' && r.fix) console.error(`       -> ${r.fix}`);
  }
  console.error(`\nNote: ${LICENSE_NOTE}\nNote: ${ESBUILD_NOTE}`);
}
process.exit(failed.length ? EXIT.environment : EXIT.ok);
