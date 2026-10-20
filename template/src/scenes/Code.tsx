import {AbsoluteFill, interpolate, useCurrentFrame} from 'remotion';
import {theme} from '../theme';
import type {CodeScene} from '../types';

export const Code = ({scene}: {scene: CodeScene}) => {
  const f = useCurrentFrame();
  const enter = interpolate(f, [0, 16], [0, 1], {extrapolateRight: 'clamp'});
  const n = scene.focus.length;
  const usable = Math.max(1, scene.durationFrames - 40);
  const idx = Math.min(n - 1, Math.floor(Math.max(0, f - 20) / (usable / n)));
  const [fa, fb] = scene.focus[idx] ?? [scene.startLine, scene.endLine];
  const maxLen = Math.max(...scene.lines.map((l) => l.tokens.reduce((a, t) => a + t.c.length, 0)));
  const fs = Math.max(24, Math.min(30, Math.floor(1560 / (maxLen * 0.6))));
  const rowH = Math.min(52, Math.floor(620 / scene.lines.length));
  return (
    <AbsoluteFill style={{padding: '70px 120px 0', opacity: enter}}>
      <div style={{fontSize: 60, fontWeight: 800, marginBottom: 12}}>{scene.title}</div>
      <div style={{fontFamily: theme.mono, fontSize: 28, color: theme.muted, marginBottom: 24}}>
        {scene.file}:{scene.startLine}-{scene.endLine}
      </div>
      <div style={{background: theme.panel, border: `1px solid ${theme.border}`, borderRadius: 18, padding: '22px 0', fontFamily: theme.mono, fontSize: fs}}>
        {scene.lines.map((l) => {
          const on = l.n >= fa && l.n <= fb;
          return (
            <div key={l.n} style={{display: 'flex', height: rowH, alignItems: 'center', opacity: on ? 1 : 0.5,
              background: on ? 'rgba(110,168,255,0.14)' : 'transparent', borderLeft: `6px solid ${on ? theme.accent : 'transparent'}`}}>
              <span style={{width: 90, flexShrink: 0, textAlign: 'right', paddingRight: 28, color: theme.muted}}>{l.n}</span>
              <span style={{whiteSpace: 'pre'}}>
                {l.tokens.map((t, i) => <span key={i} style={{color: t.color}}>{t.c}</span>)}
              </span>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
