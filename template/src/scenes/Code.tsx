import {AbsoluteFill, Easing, interpolate, useCurrentFrame} from '@windower/framekit/core/compat';
import {CODE_FONT_FLOOR, SAFE, theme} from '../theme';
import type {CodeScene} from '../types';

// Layout budget (1080p). Everything ends above SAFE.contentBottom (940):
// header 60..104, panel from 120, rows of >= 36 px (16 rows = 576 + 32 padding = 608 -> ends 728),
// caption below the panel (<= 2 lines of 36 px).
const PANEL_TOP = 120;
const PANEL_PAD = 16;
const ROW_MIN = 36;
const ROW_MAX = 52;
const ROW_BUDGET = 620;
const PANEL_W = 1920 - 2 * SAFE.x;
const GUTTER = 90;
const MARKER = 44;
const CHAR_W = 0.602; // advance width of the monospace stack, in em
const FONT_MAX = 30;
const FOCUS_FRAMES = 14;
const ZOOM = 0.025;

const MARK = {add: '+', del: '-', ctx: ''} as const;

export const Code = ({scene}: {scene: CodeScene}) => {
  const f = useCurrentFrame();
  const enter = interpolate(f, [0, 16], [0, 1], {extrapolateRight: 'clamp'});
  const diff = scene.mode === 'diff';
  const rows = scene.lines;
  const n = Math.max(1, rows.length);

  // Row height never below 36 px; font shrinks to the 24 px floor to fit the longest line.
  const rowH = Math.max(ROW_MIN, Math.min(ROW_MAX, Math.floor(ROW_BUDGET / n)));
  const maxLen = Math.max(1, ...rows.map((l) => l.tokens.reduce((a, t) => a + t.c.length, 0)));
  const textW = PANEL_W - GUTTER - (diff ? MARKER : 0) - 32;
  const fs = Math.max(CODE_FONT_FLOOR, Math.min(FONT_MAX, Math.floor(textW / (maxLen * CHAR_W))));

  // Focus steps: step i starts at focus[i].at (fraction of the scene), default spread over 15%..90%.
  const total = Math.max(1, scene.durationFrames);
  const steps = scene.focus.map((fc, i) => ({
    a: fc.lines[0],
    b: fc.lines[1],
    start: Math.round((fc.at ?? 0.15 + (0.75 * i) / scene.focus.length) * total),
  }));
  steps.sort((x, y) => x.start - y.start);
  let idx = -1;
  steps.forEach((st, i) => {
    if (f >= st.start) idx = i;
  });
  const ease = Easing.inOut(Easing.cubic);
  const t = idx < 0 ? 0 : ease(interpolate(f - (steps[idx]?.start ?? 0), [0, FOCUS_FRAMES], [0, 1], {extrapolateRight: 'clamp'}));
  const cur = idx >= 0 ? steps[idx] : undefined;
  const prev = idx >= 1 ? steps[idx - 1] : undefined;
  const inRange = (st: {a: number; b: number} | undefined, k: number) => (st ? k >= st.a && k <= st.b : true);
  // Weight of a row's emphasis: blend of the previous focus (fading out) and the current one (fading in).
  const weight = (k: number) => {
    if (!cur) return 1;
    const was = prev ? (inRange(prev, k) ? 1 : 0) : 1; // before the first focus everything is "on"
    return was * (1 - t) + (inRange(cur, k) ? 1 : 0) * t;
  };
  const center = (st: {a: number; b: number} | undefined) =>
    st ? ((st.a + st.b) / 2 - scene.startLine + 0.5) * rowH + PANEL_PAD : (n * rowH) / 2 + PANEL_PAD;
  const zoomOn = !!cur && (cur.a > scene.startLine || cur.b < scene.startLine + n - 1);
  const oy = center(prev) * (1 - t) + center(cur) * t;
  const scale = 1 + (zoomOn ? ZOOM * t : 0);

  const panelH = n * rowH + 2 * PANEL_PAD;
  const lastLine = scene.startLine + n - 1;
  return (
    <AbsoluteFill style={{padding: `60px ${SAFE.x}px 0`, opacity: enter}}>
      <div style={{display: 'flex', alignItems: 'center', gap: 18, height: 44, fontFamily: theme.mono, fontSize: 28, color: theme.muted}}>
        <span style={{color: theme.text}}>{scene.file}</span>
        <span>{diff ? 'diff' : `lines ${scene.startLine}-${lastLine}`}</span>
      </div>
      <div style={{position: 'absolute', top: PANEL_TOP, left: SAFE.x, width: PANEL_W, height: panelH, boxSizing: 'border-box',
        transformOrigin: `0px ${oy}px`, transform: `scale(${scale})`,
        background: theme.panel, border: `1px solid ${theme.border}`, borderRadius: 18, padding: `${PANEL_PAD}px 0`,
        fontFamily: theme.mono, fontSize: fs, overflow: 'hidden'}}>
        {rows.map((l) => {
          const w = weight(l.n);
          const kind = l.kind ?? 'ctx';
          const tint = kind === 'add' ? '74,222,128' : kind === 'del' ? '248,113,113' : '110,168,255';
          const bg = diff && kind !== 'ctx' ? 0.16 : 0.14 * w;
          return (
            <div key={l.n} style={{display: 'flex', height: rowH, alignItems: 'center', boxSizing: 'border-box',
              opacity: 0.5 + 0.5 * w,
              background: diff && kind === 'ctx' ? 'transparent' : `rgba(${tint},${bg})`,
              borderLeft: `6px solid rgba(110,168,255,${w})`}}>
              {!diff && <span style={{width: GUTTER, flexShrink: 0, textAlign: 'right', paddingRight: 28, color: theme.muted}}>{l.n}</span>}
              {diff && (
                <span style={{width: MARKER + 20, flexShrink: 0, textAlign: 'center', fontWeight: 700,
                  color: kind === 'add' ? theme.green : kind === 'del' ? '#f87171' : theme.muted}}>{MARK[kind]}</span>
              )}
              <span style={{whiteSpace: 'pre', textDecoration: kind === 'del' ? 'line-through' : undefined,
                textDecorationColor: 'rgba(248,113,113,0.6)'}}>
                {l.tokens.map((tk, i) => <span key={i} style={{color: tk.color}}>{tk.c}</span>)}
              </span>
            </div>
          );
        })}
      </div>
      {scene.caption && (
        <div style={{position: 'absolute', top: PANEL_TOP + panelH + 30, left: SAFE.x, width: PANEL_W, fontSize: 36, lineHeight: '46px', color: theme.text}}>
          {scene.caption}
        </div>
      )}
    </AbsoluteFill>
  );
};
