// storyboard.json -> props.json (+ captions.srt/.vtt): reading-speed timing, Shiki highlighting.
import {readFileSync, writeFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {codeToTokens} from 'shiki';
import {existsSync} from 'node:fs';

const FPS = 30, TRANS = 12, PAD_S = 0.9, MIN_S = 4;
const sbPath = process.argv[2];
const dir = dirname(sbPath);
const sb = JSON.parse(readFileSync(sbPath, 'utf8'));
const wps = sb.wordsPerSecond ?? 2.9;
const alignPath = join(dir, 'alignment.json');
const alignAll = existsSync(alignPath) && process.env.VE_SILENT !== '1' ? JSON.parse(readFileSync(alignPath, 'utf8')) : null;

const out = [];
for (const s of sb.scenes) {
  const toks = s.narration.trim().split(/\s+/);
  const al = alignAll?.[s.id];
  let durS, words;
  if (al) {
    // chars -> words using character-level timestamps
    words = []; let cur = '', st = 0, en = 0;
    al.characters.forEach((ch, i) => {
      if (/\s/.test(ch)) { if (cur) { words.push({text: cur, startMs: Math.round(st * 1000), endMs: Math.round(en * 1000)}); cur = ''; } return; }
      if (!cur) st = al.character_start_times_seconds[i];
      cur += ch; en = al.character_end_times_seconds[i];
    });
    if (cur) words.push({text: cur, startMs: Math.round(st * 1000), endMs: Math.round(en * 1000)});
    durS = Math.max(MIN_S, al.character_end_times_seconds.at(-1) + 0.7);
  } else {
    const secs = toks.length / wps;
    durS = Math.max(MIN_S, secs + PAD_S);
    let t = 200; const per = (secs * 1000) / toks.length;
    words = toks.map((text) => { const w = {text, startMs: Math.round(t), endMs: Math.round(t + per)}; t += per; return w; });
  }
  const scene = {...s, durationFrames: Math.round(durS * FPS), words, audio: al ? `audio/${s.id}.mp3` : null};
  if (s.type === 'code') {
    const src = readFileSync(join(sb.repoRoot, s.file), 'utf8').split('\n').slice(s.startLine - 1, s.endLine);
    const {tokens} = await codeToTokens(src.join('\n'), {lang: 'ts', theme: 'github-dark'});
    scene.lines = tokens.map((line, i) => ({n: s.startLine + i, tokens: line.map((tk) => ({c: tk.content, color: tk.color}))}));
  }
  out.push(scene);
}
writeFileSync(join(dir, 'props.json'), JSON.stringify({title: sb.title, scenes: out}, null, 2));

const ts = (ms, sep) => {
  const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
  const m = String(Math.floor(ms / 60000) % 60).padStart(2, '0');
  const sec = String(Math.floor(ms / 1000) % 60).padStart(2, '0');
  return `${h}:${m}:${sec}${sep}${String(Math.round(ms % 1000)).padStart(3, '0')}`;
};
let cues = [], origin = 0;
out.forEach((sc, i) => {
  const base = origin * (1000 / FPS);
  // group into sentence-ish cues of <=7 words
  let cur = [];
  const flush = () => {
    if (!cur.length) return;
    cues.push({a: base + cur[0].startMs, b: base + cur[cur.length - 1].endMs, text: cur.map((w) => w.text).join(' ')});
    cur = [];
  };
  for (const w of sc.words) { cur.push(w); if (cur.length >= 7 || /[.?!]$/.test(w.text)) flush(); }
  flush();
  origin += sc.durationFrames - (i < out.length - 1 ? TRANS : 0);
});
writeFileSync(join(dir, 'captions.srt'), cues.map((c, i) => `${i + 1}\n${ts(c.a, ',')} --> ${ts(c.b, ',')}\n${c.text}\n`).join('\n'));
writeFileSync(join(dir, 'captions.vtt'), 'WEBVTT\n\n' + cues.map((c) => `${ts(c.a, '.')} --> ${ts(c.b, '.')}\n${c.text}\n`).join('\n'));
const total = (origin) / FPS;
console.log(`scenes=${out.length} duration=${total.toFixed(1)}s cues=${cues.length}`);
