// prepare: storyboard.json -> timing.json, props.json (+ Shiki-highlighted code), captions.srt/.vtt.
// Port of template/scripts/prepare.mjs with validation and error wrapping (FR-SB-08).
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {Storyboard} from '../template/src/schema.js';
import type {CodeLine, ExplainerProps, Scene} from '../template/src/types.js';
import {highlightCode} from './code-highlight.js';
import {buildCues, toSrt, toVtt} from './captions.js';
import {UNAPPROVED_WARNING, approvalProblem} from './approval.js';
import {EXIT, TEMPLATE} from './lib.js';
import {checkTotal, computeTiming, type Timing} from './timing.js';
import {readSynthFile, synthProblem, synthTimingOf} from './tts/synthfile.js';
import {formatIssue, validateFile} from './validate-storyboard.js';

export const PREPARE_USAGE =
  'Usage: prepare <storyboard.json> [--repo <root>] [--quiet] [--allow-unapproved]\n' +
  '  Writes timing.json, props.json, captions.srt and captions.vtt next to the storyboard.';

export class PrepareError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
  }
}

/** Highlights the scene's own code text; failures name the scene id. */
async function highlight(
  scene: Extract<Storyboard['scenes'][number], {type: 'code'}>,
): Promise<CodeLine[]> {
  try {
    return await highlightCode(scene);
  } catch (e) {
    throw new PrepareError(
      `scene ${scene.id}: cannot highlight ${scene.file} as "${scene.language}": ${(e as Error).message}`,
      EXIT.validation,
    );
  }
}

/** Copies each voiced scene's audio to <public>/audio/<id>.<ext> and removes stale files there. */
function stageAudio(destDir: string, timing: Timing, sources: Record<string, string>): void {
  const keep = new Set<string>();
  for (const t of timing.scenes) {
    const src = sources[t.id];
    if (!t.audio || !src) continue;
    keep.add(path.basename(t.audio));
  }
  if (existsSync(destDir))
    for (const f of readdirSync(destDir))
      if (!keep.has(f) && f !== '.gitkeep') rmSync(path.join(destDir, f), {force: true});
  if (!keep.size) return;
  mkdirSync(destDir, {recursive: true});
  for (const t of timing.scenes) {
    const src = sources[t.id];
    if (t.audio && src) copyFileSync(src, path.join(destDir, path.basename(t.audio)));
  }
}

export async function prepare(
  storyboardPath: string,
  opts: {
    repoRoot?: string;
    log?: (m: string) => void;
    allowUnapproved?: boolean;
    /** Remotion public dir that staticFile() resolves against (default template/public). */
    publicDir?: string;
  } = {},
): Promise<{timing: Timing; props: ExplainerProps; dir: string}> {
  const log = opts.log ?? (() => undefined);
  const file = path.resolve(storyboardPath);
  const dir = path.dirname(file);
  const result = validateFile(file, {repoRoot: opts.repoRoot});
  for (const w of result.warnings) log(formatIssue(w));
  if (result.errors.length) {
    throw new PrepareError(
      `${file} is invalid:\n` + result.errors.map((i) => `  ${formatIssue(i)}`).join('\n'),
      EXIT.validation,
    );
  }
  const unapproved = approvalProblem(file);
  if (unapproved) {
    if (!opts.allowUnapproved) throw new PrepareError(unapproved, EXIT.validation);
    log(UNAPPROVED_WARNING);
  }
  const sb = Storyboard.parse(JSON.parse(readFileSync(file, 'utf8')));

  // synth.json (ve:synth) makes the run voiced; without it timing is the reading-speed estimate.
  const synthFile = path.join(dir, 'synth.json');
  let synthTiming: ReturnType<typeof synthTimingOf> | undefined;
  const synthAudio: Record<string, string> = {};
  if (existsSync(synthFile)) {
    try {
      const synth = readSynthFile(synthFile);
      const bad = synthProblem(synth, sb.scenes);
      if (bad) throw new Error(bad);
      synthTiming = synthTimingOf(synth);
      for (const e of synth.scenes)
        if (e.audioPath) synthAudio[e.id] = path.resolve(dir, e.audioPath);
    } catch (e) {
      throw new PrepareError((e as Error).message, EXIT.validation);
    }
  }
  const timing = computeTiming(sb.scenes, synthTiming ? {synth: synthTiming} : {});
  const verdict = checkTotal(timing);
  if (verdict.level === 'error')
    throw new PrepareError(verdict.message ?? 'bad length', EXIT.validation);
  if (verdict.level === 'warn') log(`warning: ${verdict.message}`);

  const scenes: Scene[] = [];
  for (const [i, s] of sb.scenes.entries()) {
    const t = timing.scenes[i];
    if (!t) throw new PrepareError(`scene ${s.id}: no timing entry`, EXIT.error);
    const common = {
      ...s,
      durationFrames: t.durationFrames,
      startFrame: t.startFrame,
      captions: t.captions,
      audio: t.audio,
    };
    if (s.type === 'code') {
      const lines = await highlight(s);
      scenes.push({
        ...common,
        focus: s.focus ?? [],
        lines,
      } as unknown as Scene);
    } else {
      scenes.push(common as unknown as Scene);
    }
  }

  const audioDest = path.join(opts.publicDir ?? path.join(TEMPLATE, 'public'), 'audio');
  try {
    stageAudio(audioDest, timing, synthAudio);
  } catch (e) {
    throw new PrepareError(
      `cannot stage narration audio in ${audioDest}: ${(e as Error).message}`,
      EXIT.environment,
    );
  }

  const props: ExplainerProps = {
    title: sb.title,
    fps: timing.fps,
    transitionFrames: timing.transitionFrames,
    totalFrames: timing.totalFrames,
    burnIn: true,
    scenes,
  };
  try {
    writeFileSync(path.join(dir, 'timing.json'), JSON.stringify(timing, null, 2));
    writeFileSync(path.join(dir, 'props.json'), JSON.stringify(props, null, 2));
    const cues = buildCues(timing.scenes, timing.fps);
    writeFileSync(path.join(dir, 'captions.srt'), toSrt(cues));
    writeFileSync(path.join(dir, 'captions.vtt'), toVtt(cues));
  } catch (e) {
    throw new PrepareError(
      `cannot write outputs in ${dir}: ${(e as Error).message}`,
      EXIT.environment,
    );
  }
  return {timing, props, dir};
}

async function main(): Promise<void> {
  const {values, positionals} = parseArgs({
    options: {
      repo: {type: 'string'},
      quiet: {type: 'boolean'},
      'allow-unapproved': {type: 'boolean'},
    },
    allowPositionals: true,
  });
  const file = positionals[0];
  if (!file) {
    console.error(PREPARE_USAGE);
    process.exit(EXIT.validation);
  }
  try {
    const {timing, dir} = await prepare(file, {
      repoRoot: values.repo ? path.resolve(values.repo) : undefined,
      allowUnapproved: values['allow-unapproved'],
      log: (m) => console.error(m),
    });
    if (!values.quiet)
      console.error(
        `Wrote props.json, timing.json, captions.srt, captions.vtt in ${dir} (${timing.scenes.length} scenes, ${(timing.totalFrames / timing.fps).toFixed(1)} s)`,
      );
  } catch (e) {
    if (e instanceof PrepareError) {
      console.error(e.message);
      process.exit(e.exitCode);
    }
    console.error(`prepare failed unexpectedly: ${(e as Error).message}`);
    process.exit(EXIT.error);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
