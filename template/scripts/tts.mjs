// ElevenLabs per-scene TTS with timestamps, cached by content hash. Key from env only.
import {readFileSync, writeFileSync, existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join, dirname} from 'node:path';

const VOICE = process.env.VE_VOICE_ID ?? 'EXAVITQu4vr4xnSDxMaL';
const MODEL = process.env.VE_TTS_MODEL ?? 'eleven_multilingual_v2';
const key = process.env.ELEVENLABS_API_KEY;
if (!key) { console.error('ELEVENLABS_API_KEY not set'); process.exit(2); }

const sbPath = process.argv[2];
const dir = dirname(sbPath);
const sb = JSON.parse(readFileSync(sbPath, 'utf8'));
const cacheDir = join(dir, 'audio');
import {mkdirSync, copyFileSync} from 'node:fs';
mkdirSync(cacheDir, {recursive: true});
mkdirSync('public/audio', {recursive: true});

let billed = 0, cached = 0;
const align = {};
for (let i = 0; i < sb.scenes.length; i++) {
  const s = sb.scenes[i];
  const h = createHash('sha256').update([VOICE, MODEL, s.narration].join('|')).digest('hex').slice(0, 16);
  const mp3 = join(cacheDir, `${h}.mp3`), js = join(cacheDir, `${h}.json`);
  if (!existsSync(js)) {
    const prev = sb.scenes[i - 1]?.narration, next = sb.scenes[i + 1]?.narration;
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE}/with-timestamps?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: {'xi-api-key': key, 'content-type': 'application/json'},
      body: JSON.stringify({text: s.narration, model_id: MODEL, ...(prev && {previous_text: prev}), ...(next && {next_text: next})}),
    });
    if (!res.ok) { console.error(`TTS failed for ${s.id}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`); process.exit(1); }
    const j = await res.json();
    writeFileSync(mp3, Buffer.from(j.audio_base64, 'base64'));
    writeFileSync(js, JSON.stringify(j.alignment));
    billed += s.narration.length;
  } else cached += s.narration.length;
  copyFileSync(mp3, `public/audio/${s.id}.mp3`);
  align[s.id] = JSON.parse(readFileSync(js, 'utf8'));
}
writeFileSync(join(dir, 'alignment.json'), JSON.stringify(align));
console.log(`voice=${VOICE} model=${MODEL} billedChars=${billed} cachedChars=${cached}`);
