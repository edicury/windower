// gate: `gate <run-dir> [--json] [--provider <id>] [--no-voice]` prints the approval summary
// (FR-SB-04, FR-SEC-03); `--approve` records approval in storyboard.json iff validation has no errors.
import {existsSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {EXIT} from './lib.js';
import {PROVIDERS, applyApproval, buildSummary, renderSummary} from './gateSummary.js';
import {validateFile} from './validate-storyboard.js';

export const GATE_USAGE =
  'Usage: gate <run-dir> [--json] [--approve] [--provider <id>] [--no-voice] [--repo <root>]';

function main(): void {
  const {values, positionals} = parseArgs({
    options: {
      json: {type: 'boolean'},
      approve: {type: 'boolean'},
      provider: {type: 'string'},
      'no-voice': {type: 'boolean'},
      repo: {type: 'string'},
    },
    allowPositionals: true,
  });
  const target = positionals[0];
  if (!target) {
    console.error(GATE_USAGE);
    process.exit(EXIT.validation);
  }
  let runDir = path.resolve(target);
  if (existsSync(runDir) && statSync(runDir).isFile()) runDir = path.dirname(runDir);
  const file = path.join(runDir, 'storyboard.json');
  if (!existsSync(file)) {
    console.error(`storyboard not found: ${file}`);
    process.exit(EXIT.validation);
  }
  const provider = values['no-voice'] ? 'null' : (values.provider ?? 'null');
  if (!PROVIDERS[provider]) {
    console.error(`unknown provider "${provider}"; known: ${Object.keys(PROVIDERS).join(', ')}`);
    process.exit(EXIT.validation);
  }
  const briefFile = path.join(runDir, 'brief.md');
  const briefText = existsSync(briefFile) ? readFileSync(briefFile, 'utf8') : undefined;

  const validation = validateFile(file, {
    repoRoot: values.repo ? path.resolve(values.repo) : undefined,
    briefText,
  });
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    raw = undefined;
  }
  const summary = buildSummary(raw, validation, {briefText, provider});

  if (values.approve) {
    if (!summary.valid) {
      console.error(renderSummary(summary));
      console.error('\nNot approved: fix the validation errors above first.');
      process.exit(EXIT.validation);
    }
    writeFileSync(file, applyApproval(readFileSync(file, 'utf8'), new Date().toISOString()));
    summary.approved = true;
  }
  if (values.json) console.log(JSON.stringify(summary, null, 2));
  else {
    console.error(renderSummary(summary));
    if (values.approve) console.error(`\nApproved: ${file}`);
    else if (summary.valid) console.error(`\nTo approve, run: pnpm ve:gate ${target} --approve`);
  }
  process.exit(summary.valid ? EXIT.ok : EXIT.validation);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
