import {AbsoluteFill, interpolate, useCurrentFrame} from '@windower/framekit-core/compat';
import {FONT_FLOOR, SAFE, theme} from '../theme';
import type {SequenceScene} from '../types';

// Layout (1080p, FR-SCN-05 / FR-SB-07). The usable column is x 120..1800; rows fill y 235..930 so
// content stays above the captions bar. Rows never go below ROW_MIN (the validator caps messages at 8,
// which gives ~87 px).
const LEFT = SAFE.x;
const RIGHT = 1920 - SAFE.x;
const ROW_MIN = 60;
const ROW_MAX = 110;
const TEXT_PX = FONT_FLOOR;
const LINE_H = 1.15;
const BOX_TOP = 150;
const LIFELINE_TOP = BOX_TOP + 70;
const ROWS_TOP = LIFELINE_TOP + 15;
const ROWS_BOTTOM = SAFE.contentBottom - 10;

export const Sequence = ({scene}: {scene: SequenceScene}) => {
  const f = useCurrentFrame();
  const n = scene.participants.length;
  const colW = (RIGHT - LEFT) / n;
  const px = (i: number) => LEFT + colW * i + colW / 2;
  const count = Math.max(1, scene.messages.length);
  const rowH = Math.min(ROW_MAX, Math.max(ROW_MIN, (ROWS_BOTTOM - ROWS_TOP) / count));
  const step = Math.max(14, Math.floor((scene.durationFrames - 50) / count));
  const boxW = Math.min(260, colW - 24);
  // Labels may be wider than the arrow span so adjacent participants still get ~2 lines, never more.
  const labelMax = Math.min(560, colW * 2 - 24);
  const valid = (i: number) => Number.isInteger(i) && i >= 0 && i < n;
  return (
    <AbsoluteFill>
      <div style={{position: 'absolute', left: LEFT, top: 40, fontSize: 60, fontWeight: 800, whiteSpace: 'nowrap'}}>
        {scene.title}
      </div>
      <svg width={1920} height={1080} style={{position: 'absolute', inset: 0}}>
        <defs>
          <marker id="ah2" markerUnits="userSpaceOnUse" markerWidth="18" markerHeight="18" refX="16" refY="9" orient="auto">
            <path d="M0,0 L18,9 L0,18 z" fill={theme.accent} />
          </marker>
        </defs>
        {scene.participants.map((_, i) => (
          <line key={i} x1={px(i)} y1={LIFELINE_TOP} x2={px(i)} y2={ROWS_BOTTOM} stroke={theme.border} strokeWidth={3} strokeDasharray="10 10" />
        ))}
        {scene.messages.map((m, i) => {
          if (!valid(m.from) || !valid(m.to)) return null;
          const s = 16 + i * step;
          const p = interpolate(f, [s, s + 12], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
          const y = ROWS_TOP + (i + 1) * rowH - 14;
          const x1 = px(m.from), x2 = px(m.to);
          const dir = Math.sign(x2 - x1) || 1;
          return (
            <line key={i} opacity={p} x1={x1} y1={y} x2={x1 + (x2 - x1) * p - dir * 6} y2={y} stroke={theme.accent} strokeWidth={4} markerEnd="url(#ah2)" />
          );
        })}
      </svg>
      {scene.messages.map((m, i) => {
        if (!valid(m.from) || !valid(m.to)) return null;
        const s = 16 + i * step;
        const p = interpolate(f, [s, s + 12], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
        const y = ROWS_TOP + (i + 1) * rowH - 14;
        const x1 = px(m.from), x2 = px(m.to);
        const mid = (x1 + x2) / 2;
        const span = Math.abs(x2 - x1);
        const w = Math.max(span - 20, labelMax);
        const left = Math.min(Math.max(LEFT, mid - w / 2), RIGHT - w);
        const right = Math.max(m.from, m.to);
        // Notes sit right of the message end; none when that end is the rightmost participant (would clip).
        const noteLeft = px(right) + 18;
        const showNote = !!m.note && right < n - 1;
        return (
          <div key={i} style={{opacity: p}}>
            <div style={{position: 'absolute', left, width: w, top: y - 12, transform: 'translateY(-100%)', display: 'flex', justifyContent: 'center'}}>
              <span style={{background: theme.bg, padding: '0 8px', fontSize: TEXT_PX, lineHeight: LINE_H, textAlign: 'center', color: theme.text, overflowWrap: 'anywhere'}}>{m.text}</span>
            </div>
            {showNote && (
              <div style={{position: 'absolute', left: noteLeft, width: RIGHT - noteLeft, top: y - 12, fontSize: TEXT_PX, lineHeight: LINE_H, color: theme.amber, overflowWrap: 'anywhere'}}>
                {m.note}
              </div>
            )}
          </div>
        );
      })}
      {scene.participants.map((name, i) => (
        <div key={i} style={{position: 'absolute', left: px(i) - boxW / 2, top: BOX_TOP, width: boxW, height: 70, display: 'flex', alignItems: 'center',
          justifyContent: 'center', background: theme.panel, border: `3px solid ${theme.accent}`, borderRadius: 14, fontSize: 30, fontWeight: 700, padding: '0 8px', textAlign: 'center', overflowWrap: 'anywhere', lineHeight: 1.05}}>{name}</div>
      ))}
    </AbsoluteFill>
  );
};
