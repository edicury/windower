import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {EXIT, TEMPLATE, findFreePort, isPortFree} from './lib.js';

const {values, positionals} = parseArgs({
  options: {port: {type: 'string'}, out: {type: 'string'}},
  allowPositionals: true,
});

const composition = positionals[0] ?? 'Hello';
const out = path.resolve(
  values.out ?? path.join(TEMPLATE, 'out', `${composition.toLowerCase()}.mp4`),
);

let port: number;
if (values.port) {
  const requested = Number(values.port);
  if (await isPortFree(requested)) port = requested;
  else {
    port = await findFreePort();
    console.error(`Port ${requested} is in use; using ${port} instead.`);
  }
} else {
  port = await findFreePort();
}

const result = spawnSync(
  'pnpm',
  ['exec', 'remotion', 'render', 'src/index.ts', composition, out, `--port=${port}`],
  {cwd: TEMPLATE, stdio: 'inherit'},
);
if (result.status !== 0) {
  console.error('Render failed. Run `pnpm ve:doctor` to diagnose the environment.');
  process.exit(EXIT.render);
}
console.error(`Wrote ${out}`);
