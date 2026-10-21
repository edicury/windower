import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {
  CheckResult,
  ESBUILD_NOTE,
  EXIT,
  TEMPLATE,
  codeSceneProblems,
  findDsStore,
  findFreePort,
  freeDiskGb,
  hasBinary,
  isPortFree,
  nodeMajor,
  propsProblem,
} from './lib.js';
import {resolveEngine} from './engine/index.js';
import {loadConfig} from './tts/config.js';
import {providerChecks} from './tts/doctorChecks.js';

const {values} = parseArgs({
  options: {
    voice: {type: 'boolean', default: false},
    provider: {type: 'string'},
    'no-voice': {type: 'boolean', default: false},
    repo: {type: 'string'},
    'run-dir': {type: 'string'},
    port: {type: 'string', default: '3000'},
    json: {type: 'boolean', default: false},
    quiet: {type: 'boolean', default: false},
    engine: {type: 'string'},
  },
});

const engine = (() => {
  try {
    return resolveEngine(values.engine);
  } catch (e) {
    console.error((e as Error).message);
    return process.exit(EXIT.validation);
  }
})();

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

  // 5 engine checks (framekit browser path and version)
  for (const c of engine.doctorChecks()) add(c.id, c.name, c.level, c.message, c.fix);

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

  // 8 voice: per-provider checks. Run with --voice, --provider <id> or --no-voice.
  if (values.voice || values.provider || values['no-voice']) {
    let config: {provider?: string} = {};
    let root = values.repo;
    if (!root && values['run-dir']) {
      try {
        const sb = JSON.parse(
          readFileSync(path.join(values['run-dir'], 'storyboard.json'), 'utf8'),
        );
        if (typeof sb.repoRoot === 'string') root = path.resolve(values['run-dir'], sb.repoRoot);
      } catch {
        // no storyboard yet
      }
    }
    if (root) {
      try {
        config = loadConfig(path.resolve(root));
      } catch (e) {
        add(8, 'config', 'fail', (e as Error).message);
      }
    }
    const sel = providerChecks(
      {flag: values.provider, noVoice: values['no-voice'], config},
      {env: process.env, hasBinary},
    );
    for (const c of sel.checks) add(8, `voice:${c.name}`, c.level, c.message, c.fix);
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
  console.log(JSON.stringify({results, notes: [engine.licenseNote, ESBUILD_NOTE]}, null, 2));
} else if (!values.quiet) {
  const icon = {pass: 'ok  ', warn: 'warn', fail: 'FAIL'};
  for (const r of results) {
    console.error(`[${icon[r.level]}] ${r.name}: ${r.message}`);
    if (r.level !== 'pass' && r.fix) console.error(`       -> ${r.fix}`);
  }
  console.error(`\nNote: ${engine.licenseNote}\nNote: ${ESBUILD_NOTE}`);
}
process.exit(failed.length ? EXIT.environment : EXIT.ok);
