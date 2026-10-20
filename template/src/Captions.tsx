import {AbsoluteFill, useCurrentFrame, useVideoConfig} from 'remotion';
import {theme} from './theme';
import type {Word} from './types';

const MAX_WORDS = 7;
const MAX_CHARS = 46;

const chunk = (words: Word[]): Word[][] => {
  const out: Word[][] = [];
  let cur: Word[] = [];
  let chars = 0;
  for (const w of words) {
    if (cur.length && (cur.length >= MAX_WORDS || chars + w.text.length + 1 > MAX_CHARS)) {
      out.push(cur); cur = []; chars = 0;
    }
    cur.push(w); chars += w.text.length + 1;
    if (/[.?!]$/.test(w.text)) { out.push(cur); cur = []; chars = 0; }
  }
  if (cur.length) out.push(cur);
  return out;
};

export const Captions = ({words}: {words: Word[]}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const ms = (frame / fps) * 1000;
  const groups = chunk(words);
  const group = groups.find((g) => ms < g[g.length - 1].endMs) ?? groups[groups.length - 1];
  if (!group || ms < group[0].startMs - 150) return null;
  return (
    <AbsoluteFill style={{justifyContent: 'flex-end', alignItems: 'center', paddingBottom: 56}}>
      <div style={{
        background: 'rgba(5,8,20,0.82)', padding: '14px 32px', borderRadius: 14,
        fontSize: 44, fontWeight: 600, letterSpacing: 0.2, maxWidth: 1600, textAlign: 'center',
        border: `1px solid ${theme.border}`,
      }}>
        {group.map((w, i) => (
          <span key={i} style={{color: ms >= w.startMs ? theme.text : theme.muted}}>
            {w.text}{i < group.length - 1 ? ' ' : ''}
          </span>
        ))}
      </div>
    </AbsoluteFill>
  );
};
