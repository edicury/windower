// gate: `gate <run-dir> [--json] [--provider <id>] [--no-voice]` prints the approval summary
// (FR-SB-04, FR-SEC-03); `--approve` records approval in storyboard.json iff validation has no errors.
import {existsSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {EXIT} from './lib.js';
import {resolveVoice, voiceFlagProblem} from './tts/voice.js';
import {loadConfig} from './tts/config.js';
import {selectProvider} from './tts/providers.js';
import {
  PROVIDERS,
  applyApproval,
  buildSummary,
  creditsProblem,
  renderSummary,
} from './gateSummary.js';
import {validateFile} from './validate-storyboard.js';

export const GATE_USAGE =
  'Usage: gate <run-dir> [--json] [--approve] [--provider <id>] [--no-voice] [--confirm-credits] [--voice <id>] [--model <id>] [--repo <root>]';

function main(): void {
  const {values, positionals} = parseArgs({
    options: {
      json: {type: 'boolean'},
      approve: {type: 'boolean'},
      'confirm-credits': {type: 'boolean'},
      provider: {type: 'string'},
      voice: {type: 'string'},
      model: {type: 'string'},
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
  for (const n of ['voice', 'model'] as const) {
    const p = voiceFlagProblem(n, values[n]);
    if (p) {
      console.error(p);
      process.exit(EXIT.validation);
    }
  }
  let runDir = path.resolve(target);
  if (existsSync(runDir) && statSync(runDir).isFile()) runDir = path.dirname(runDir);
  const file = path.join(runDir, 'storyboard.json');
  if (!existsSync(file)) {
    console.error(`storyboard not found: ${file}`);
    process.exit(EXIT.validation);
  }
  let sbRaw: {repoRoot?: unknown} = {};
  try {
    sbRaw = JSON.parse(readFileSync(file, 'utf8')) as {repoRoot?: unknown};
  } catch {
    // validation reports the parse error
  }
  const root = values.repo
    ? path.resolve(values.repo)
    : typeof sbRaw.repoRoot === 'string'
      ? path.resolve(runDir, sbRaw.repoRoot)
      : undefined;
  let config: {provider?: string; voice?: string; model?: string} = {};
  if (root) {
    try {
      config = loadConfig(root);
    } catch (e) {
      console.error((e as Error).message);
      process.exit(EXIT.validation);
    }
  }
  const {id: provider, source: providerSource} = selectProvider({
    flag: values.provider,
    noVoice: values['no-voice'],
    config,
    env: process.env,
  });
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
  const summary = buildSummary(raw, validation, {
    briefText,
    provider,
    providerSource,
    voice:
      provider === 'null'
        ? undefined
        : resolveVoice({flags: {voice: values.voice, model: values.model}, config, provider}),
  });

  if (values.approve) {
    if (!summary.valid) {
      console.error(renderSummary(summary));
      console.error('\nNot approved: fix the validation errors above first.');
      process.exit(EXIT.validation);
    }
    const credits = creditsProblem(summary, values['confirm-credits']);
    if (credits) {
      console.error(renderSummary(summary));
      console.error(`\nNot approved: ${credits}`);
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
