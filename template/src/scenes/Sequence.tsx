import {AbsoluteFill, interpolate, useCurrentFrame} from 'remotion';
import {theme} from '../theme';
import type {SequenceScene} from '../types';

export const Sequence = ({scene}: {scene: SequenceScene}) => {
  const f = useCurrentFrame();
  const n = scene.participants.length;
  const colW = 1560 / n;
  const px = (i: number) => 180 + colW * i + colW / 2;
  const top = 250, bottom = 840;
  const step = Math.max(14, Math.floor((scene.durationFrames - 50) / scene.messages.length));
  const rowH = (bottom - top - 110) / scene.messages.length;
  return (
    <AbsoluteFill>
      <div style={{position: 'absolute', left: 120, top: 70, fontSize: 60, fontWeight: 800}}>{scene.title}</div>
      <svg width={1920} height={1080} style={{position: 'absolute', inset: 0}}>
        <defs>
          <marker id="ah2" markerUnits="userSpaceOnUse" markerWidth="18" markerHeight="18" refX="16" refY="9" orient="auto">
            <path d="M0,0 L18,9 L0,18 z" fill={theme.accent} />
          </marker>
        </defs>
        {scene.participants.map((_, i) => (
          <line key={i} x1={px(i)} y1={top + 40} x2={px(i)} y2={bottom} stroke={theme.border} strokeWidth={3} strokeDasharray="10 10" />
        ))}
        {scene.messages.map((m, i) => {
          const s = 16 + i * step;
          const p = interpolate(f, [s, s + 12], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
          const y = top + 110 + i * rowH;
          const x1 = px(m.from), x2 = px(m.to);
          const dir = Math.sign(x2 - x1) || 1;
          return (
            <g key={i} opacity={p}>
              <line x1={x1} y1={y} x2={x1 + (x2 - x1) * p - dir * 6} y2={y} stroke={theme.accent} strokeWidth={4} markerEnd="url(#ah2)" />
              <text x={(x1 + x2) / 2} y={y - 12} textAnchor="middle" fill={theme.text} fontSize={28} fontFamily={theme.font}>{m.text}</text>
              {m.note && <text x={Math.max(x1, x2) + 18} y={y + 34} textAnchor="start" fill={theme.amber} fontSize={26} fontFamily={theme.font}>{m.note}</text>}
            </g>
          );
        })}
      </svg>
      {scene.participants.map((name, i) => (
        <div key={i} style={{position: 'absolute', left: px(i) - 130, top: top - 30, width: 260, height: 70, display: 'flex', alignItems: 'center',
          justifyContent: 'center', background: theme.panel, border: `3px solid ${theme.accent}`, borderRadius: 14, fontSize: 30, fontWeight: 700}}>{name}</div>
      ))}
    </AbsoluteFill>
  );
};
