// voices: `voices [--provider elevenlabs] [--json] [--search text]` lists selectable voices.
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {EXIT} from './lib.js';
import {filterVoices, listVoices, type VoiceInfo} from './tts/elevenlabs-voices.js';
import type {Env} from './tts/providers.js';
import {TtsError} from './tts/types.js';

export const VOICES_USAGE = 'Usage: voices [--provider elevenlabs] [--json] [--search text]';

const OPENAI_VOICES = [
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'fable',
  'nova',
  'onyx',
  'sage',
  'shimmer',
  'verse',
  'marin',
  'cedar',
];

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function formatTable(voices: VoiceInfo[]): string {
  const rows = voices.map((v) => [
    clip(v.name, 28),
    v.voiceId,
    v.category ?? '',
    clip((v.description ?? '').replace(/\s+/g, ' '), 50),
  ]);
  const head = ['NAME', 'ID', 'CATEGORY', 'DESCRIPTION'];
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (r: string[]) =>
    r
      .map((c, i) => c.padEnd(w[i]!))
      .join('  ')
      .trimEnd();
  return [line(head), ...rows.map(line)].join('\n');
}

export async function run(
  argv: string[],
  env: Env = process.env,
  fetchImpl: typeof fetch = fetch,
  io: {out: (s: string) => void; err: (s: string) => void} = {
    out: (s) => void process.stdout.write(s),
    err: (s) => void process.stderr.write(s),
  },
): Promise<number> {
  let values: {provider?: string; json?: boolean; search?: string};
  try {
    values = parseArgs({
      args: argv,
      options: {
        provider: {type: 'string', default: 'elevenlabs'},
        json: {type: 'boolean', default: false},
        search: {type: 'string'},
      },
    }).values;
  } catch (e) {
    io.err(`${(e as Error).message}\n${VOICES_USAGE}\n`);
    return EXIT.validation;
  }
  const provider = values.provider ?? 'elevenlabs';
  if (provider === 'openai') {
    io.err(
      `OpenAI has no voice-listing API. Known voices: ${OPENAI_VOICES.join(', ')}\n(set voice.voiceId in the spec)\n`,
    );
    return EXIT.validation;
  }
  if (provider === 'piper') {
    io.err('Piper voices are .onnx model files; point PIPER_MODEL at the one you want.\n');
    return EXIT.validation;
  }
  if (provider !== 'elevenlabs') {
    io.err(`Voice listing is not available for provider "${provider}". ${VOICES_USAGE}\n`);
    return EXIT.validation;
  }
  try {
    const voices = filterVoices(await listVoices(env, fetchImpl), values.search);
    io.err(`${formatTable(voices)}\n${voices.length} voice(s)\n`);
    if (values.json) io.out(`${JSON.stringify(voices, null, 2)}\n`);
    return EXIT.ok;
  } catch (e) {
    if (e instanceof TtsError) {
      io.err(`voices: ${e.message}\n`);
      return EXIT.provider;
    }
    throw e;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  run(process.argv.slice(2)).then((c) => process.exit(c));
