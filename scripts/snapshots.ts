// Scene still snapshots (T3, FR-RND-04): renders one PNG per scene of a prepared run at a fixed
// late-in-scene frame and compares it with committed baselines using a pixel-diff tolerance.
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {PNG} from 'pngjs';
import {EXIT, ROOT, TEMPLATE, findFreePort} from './lib.js';
import {prepare} from './prepare.js';

export const SNAPSHOT_DIR = path.join(ROOT, 'fixtures', 'snapshots');
export const ALL_SCENES = path.join(ROOT, 'fixtures', 'storyboards', 'all-scenes.json');
/** Share of pixels allowed to differ (per-pixel channel delta above PIXEL_DELTA). */
export const TOLERANCE = 0.005;
export const PIXEL_DELTA = 24;

interface SnapScene {
  id: string;
  type: string;
  startFrame: number;
  durationFrames: number;
}

/** Frame used per scene: 20 frames before the scene ends, after reveals and before the outgoing transition. */
export const snapshotFrame = (s: SnapScene): number => s.startFrame + s.durationFrames - 20;
export const snapshotName = (s: Pick<SnapScene, 'id' | 'type'>): string => `${s.id}-${s.type}.png`;

/** Fraction of pixels whose largest channel delta exceeds PIXEL_DELTA; 1 if sizes differ. */
export function pixelDiff(a: Buffer, b: Buffer): number {
  const pa = PNG.sync.read(a);
  const pb = PNG.sync.read(b);
  if (pa.width !== pb.width || pa.height !== pb.height) return 1;
  let bad = 0;
  for (let i = 0; i < pa.data.length; i += 4) {
    let d = 0;
    for (let c = 0; c < 3; c++)
      d = Math.max(d, Math.abs((pa.data[i + c] ?? 0) - (pb.data[i + c] ?? 0)));
    if (d > PIXEL_DELTA) bad++;
  }
  return bad / (pa.width * pa.height);
}

/** Renders every scene's snapshot frame into `outDir`; returns the scenes and the files written. */
export async function renderSnapshots(
  runDir: string,
  outDir: string,
): Promise<{scene: SnapScene; file: string}[]> {
  const {bundle} = await import('@remotion/bundler');
  const {renderStill, selectComposition} = await import('@remotion/renderer');
  const props = JSON.parse(readFileSync(path.join(runDir, 'props.json'), 'utf8')) as {
    scenes: SnapScene[];
  };
  const serveUrl = await bundle({entryPoint: path.join(TEMPLATE, 'src', 'index.ts')});
  const port = await findFreePort();
  const composition = await selectComposition({
    serveUrl,
    port,
    id: 'Explainer',
    inputProps: props as unknown as Record<string, unknown>,
  });
  mkdirSync(outDir, {recursive: true});
  const out: {scene: SnapScene; file: string}[] = [];
  for (const scene of props.scenes) {
    const file = path.join(outDir, snapshotName(scene));
    await renderStill({
      composition,
      serveUrl,
      port,
      output: file,
      frame: snapshotFrame(scene),
      inputProps: props as unknown as Record<string, unknown>,
    });
    out.push({scene, file});
  }
  return out;
}

export interface SnapshotResult {
  name: string;
  diff: number | null;
  ok: boolean;
}

/** Prepares all-scenes in `workDir`, renders stills, and compares (or with `update`, rewrites baselines). */
export async function runSnapshots(
  workDir: string,
  opts: {update?: boolean} = {},
): Promise<SnapshotResult[]> {
  mkdirSync(workDir, {recursive: true});
  const sb = path.join(workDir, 'storyboard.json');
  writeFileSync(sb, readFileSync(ALL_SCENES));
  await prepare(sb, {
    repoRoot: path.join(ROOT, 'fixtures', 'repos', 'sample'),
    allowUnapproved: true, // fixture storyboards are never approved
  });
  const shots = await renderSnapshots(workDir, path.join(workDir, 'out'));
  mkdirSync(SNAPSHOT_DIR, {recursive: true});
  return shots.map(({scene, file}) => {
    const name = snapshotName(scene);
    const base = path.join(SNAPSHOT_DIR, name);
    if (opts.update || !existsSync(base)) {
      writeFileSync(base, readFileSync(file));
      return {name, diff: opts.update ? 0 : null, ok: !!opts.update};
    }
    const diff = pixelDiff(readFileSync(base), readFileSync(file));
    return {name, diff, ok: diff <= TOLERANCE};
  });
}

async function main(): Promise<void> {
  const {values} = parseArgs({
    options: {update: {type: 'boolean'}, work: {type: 'string'}},
  });
  const work = path.resolve(values.work ?? path.join(ROOT, '.windower', 'snapshots'));
  const results = await runSnapshots(work, {update: values.update});
  for (const r of results)
    console.error(
      `${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.diff === null ? ' (no baseline)' : ` diff ${(r.diff * 100).toFixed(3)}%`}`,
    );
  if (values.update) console.error(`Baselines written to ${SNAPSHOT_DIR}`);
  process.exit(results.every((r) => r.ok) ? EXIT.ok : EXIT.validation);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
