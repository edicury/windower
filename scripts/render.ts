// render: `render <run-dir>` renders the Explainer composition to out/video.mp4 plus captions.srt/.vtt
// (FR-RND-01, FR-RND-03, FR-RND-07, FR-RND-08). `render Hello` keeps the phase 0 smoke render.
import {existsSync, mkdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {UNAPPROVED_WARNING, approvalProblem} from './approval.js';
import {buildCues, toSrt, toVtt} from './captions.js';
import {resolveEngine} from './engine/index.js';
import type {Engine} from './engine/index.js';
import {EXIT, TEMPLATE, findFreePort, isPortFree, nodeMajor, propsProblem} from './lib.js';

export const RENDER_USAGE =
  'Usage: render <run-dir> [--still <sceneId>] [--out <dir>] [--port N] [--crf N] [--concurrency N] [--allow-unapproved] [--engine framekit]\n' +
  '       render Hello [--out <file>]';

interface PropsScene {
  id?: unknown;
  startFrame?: unknown;
  durationFrames?: unknown;
  captions?: unknown;
}

/** Deeper shape check than `propsProblem`: scenes need timing and captions to render and export. */
export function propsShapeProblem(runDir: string): string | undefined {
  const props = JSON.parse(readFileSync(path.join(runDir, 'props.json'), 'utf8')) as {
    scenes: PropsScene[];
    fps?: unknown;
  };
  for (const [i, s] of props.scenes.entries()) {
    const id = typeof s?.id === 'string' ? s.id : `scenes[${i}]`;
    if (typeof s?.durationFrames !== 'number' || typeof s?.startFrame !== 'number')
      return `props.json has the wrong shape: scene ${id} lacks durationFrames/startFrame (re-run prepare)`;
    if (!Array.isArray(s.captions))
      return `props.json has the wrong shape: scene ${id} lacks captions[] (re-run prepare)`;
  }
  return undefined;
}

function fail(code: number, message: string): never {
  console.error(message);
  process.exit(code);
}

function pickEngine(flag: string | undefined): Engine {
  try {
    return resolveEngine(flag);
  } catch (e) {
    return fail(EXIT.validation, (e as Error).message);
  }
}

async function pickPort(requested?: string): Promise<number> {
  if (requested) {
    const n = Number(requested);
    if (await isPortFree(n)) return n;
    const free = await findFreePort();
    console.error(`Port ${n} is in use; using ${free} instead.`);
    return free;
  }
  return findFreePort();
}

async function renderHello(engine: Engine, out: string | undefined, port: number): Promise<void> {
  const file = path.resolve(out ?? path.join(TEMPLATE, 'out', 'hello.mp4'));
  const r = engine.renderMedia({id: 'Hello', output: file, port});
  if (!r.ok) fail(EXIT.render, 'Render failed. Run `pnpm ve:doctor` to diagnose the environment.');
  console.error(`Wrote ${file}`);
}

async function main(): Promise<void> {
  const {values, positionals} = parseArgs({
    options: {
      port: {type: 'string'},
      out: {type: 'string'},
      still: {type: 'string'},
      crf: {type: 'string'},
      concurrency: {type: 'string'},
      'allow-unapproved': {type: 'boolean'},
      engine: {type: 'string'},
    },
    allowPositionals: true,
  });
  const target = positionals[0];
  if (!target) fail(EXIT.validation, RENDER_USAGE);

  if (nodeMajor() < 18)
    fail(EXIT.environment, `Node ${process.versions.node} is too old; need >= 18.`);
  const engine = pickEngine(values.engine);
  const missing = engine.precheck();
  if (missing) fail(EXIT.environment, missing);

  const port = await pickPort(values.port);
  if (target === 'Hello') return renderHello(engine, values.out, port);

  let runDir = path.resolve(target);
  if (existsSync(runDir) && statSync(runDir).isFile()) runDir = path.dirname(runDir);
  if (!existsSync(runDir)) fail(EXIT.validation, `run dir not found: ${runDir}`);

  const problem = propsProblem(runDir);
  if (problem)
    fail(
      EXIT.validation,
      `${problem}\nRun \`prepare\` on ${path.join(runDir, 'storyboard.json')} first.`,
    );
  const shape = propsShapeProblem(runDir);
  if (shape) fail(EXIT.validation, shape);

  const unapproved = approvalProblem(path.join(runDir, 'storyboard.json'));
  if (unapproved) {
    if (!values['allow-unapproved']) fail(EXIT.validation, unapproved);
    console.error(UNAPPROVED_WARNING);
  }

  const propsFile = path.join(runDir, 'props.json');
  const props = JSON.parse(readFileSync(propsFile, 'utf8')) as {
    fps: number;
    scenes: {id: string; startFrame: number; durationFrames: number; captions: never[]}[];
  };
  const outDir = path.resolve(values.out ?? path.join(runDir, 'out'));
  mkdirSync(outDir, {recursive: true});
  const extra = [
    ...(values.crf ? [`--crf=${values.crf}`] : []),
    ...(values.concurrency ? [`--concurrency=${values.concurrency}`] : []),
  ];

  if (values.still) {
    const scene = props.scenes.find((s) => s.id === values.still);
    if (!scene)
      fail(
        EXIT.validation,
        `no scene "${values.still}" in props.json; scenes: ${props.scenes.map((s) => s.id).join(', ')}`,
      );
    const frame = scene.startFrame + Math.floor(scene.durationFrames / 2);
    const file = path.join(outDir, `still-${scene.id}.png`);
    const r = engine.run([
      'still',
      'src/index.ts',
      'Explainer',
      file,
      `--props=${propsFile}`,
      `--frame=${frame}`,
      `--port=${port}`,
    ]);
    if (!r.ok)
      fail(
        EXIT.render,
        `Still render failed:\n${r.tail}\nRun \`pnpm ve:doctor\` to diagnose the environment.`,
      );
    console.error(`Wrote ${file} (frame ${frame})`);
    return;
  }

  const video = path.join(outDir, 'video.mp4');
  const r = engine.renderMedia({
    id: 'Explainer',
    output: video,
    propsFile,
    port,
    extraArgs: extra,
  });
  if (!r.ok)
    fail(
      EXIT.render,
      `Render failed:\n${r.tail}\nRun \`pnpm ve:doctor\` to diagnose the environment.`,
    );

  const cues = buildCues(props.scenes, props.fps);
  writeFileSync(path.join(outDir, 'captions.srt'), toSrt(cues));
  writeFileSync(path.join(outDir, 'captions.vtt'), toVtt(cues));
  console.error(`Wrote ${video}, captions.srt and captions.vtt in ${outDir}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
