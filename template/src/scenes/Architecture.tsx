import {AbsoluteFill, interpolate, useCurrentFrame} from 'remotion';
import {theme} from '../theme';
import type {ArchScene} from '../types';

const W = 440, H = 130;
const tone = (t?: string) => (t === 'green' ? theme.green : t === 'violet' ? theme.violet : theme.accent);

export const Architecture = ({scene}: {scene: ArchScene}) => {
  const f = useCurrentFrame();
  const byId = Object.fromEntries(scene.nodes.map((n) => [n.id, n]));
  const nodeStep = Math.max(6, Math.floor((scene.durationFrames * 0.5) / scene.nodes.length));
  const edgeStart = (i: number) => 20 + i * Math.max(10, Math.floor((scene.durationFrames * 0.7) / scene.edges.length));
  return (
    <AbsoluteFill>
      <div style={{position: 'absolute', left: 120, top: 70, fontSize: 60, fontWeight: 800}}>{scene.title}</div>
      <svg width={1920} height={1080} style={{position: 'absolute', inset: 0}}>
        <defs>
          <marker id="ah" markerUnits="userSpaceOnUse" markerWidth="18" markerHeight="18" refX="16" refY="9" orient="auto">
            <path d="M0,0 L18,9 L0,18 z" fill={theme.muted} />
          </marker>
        </defs>
        {scene.edges.map((e, i) => {
          const a = byId[e.from], b = byId[e.to];
          const ax = a.x + W / 2, ay = a.y + H / 2, bx = b.x + W / 2, by = b.y + H / 2;
          // clip endpoints to box borders
          const dx = bx - ax, dy = by - ay;
          const clip = (cx: number, cy: number, sx: number, sy: number) => {
            const t = Math.min((W / 2 + 6) / Math.max(Math.abs(sx), 1e-6), (H / 2 + 6) / Math.max(Math.abs(sy), 1e-6));
            return [cx + sx * t, cy + sy * t];
          };
          const [x1, y1] = clip(ax, ay, dx, dy);
          const [x2, y2] = clip(bx, by, -dx, -dy);
          const p = interpolate(f, [edgeStart(i), edgeStart(i) + 14], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
          const len = Math.hypot(x2 - x1, y2 - y1);
          const pulse = ((f - edgeStart(i) - 14) % 45) / 45;
          return (
            <g key={i} opacity={p > 0 ? 1 : 0}>
              <line x1={x1} y1={y1} x2={x1 + (x2 - x1) * p} y2={y1 + (y2 - y1) * p} stroke={theme.muted} strokeWidth={4}
                markerEnd={p >= 1 ? 'url(#ah)' : undefined} />
              {p >= 1 && pulse >= 0 && <circle cx={x1 + (x2 - x1) * pulse} cy={y1 + (y2 - y1) * pulse} r={9} fill={theme.amber} />}
              <title>{len}</title>
            </g>
          );
        })}
      </svg>
      {scene.nodes.map((n, i) => {
        const s = 6 + i * nodeStep;
        const o = interpolate(f, [s, s + 12], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
        const c = tone(n.tone);
        return (
          <div key={n.id} style={{position: 'absolute', left: n.x, top: n.y, width: W, height: H, opacity: o,
            transform: `scale(${0.92 + 0.08 * o})`, background: theme.panel, border: `3px solid ${c}`, borderRadius: 18,
            display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center'}}>
            <div style={{fontSize: 38, fontWeight: 700}}>{n.label}</div>
            {n.sub && <div style={{fontSize: 26, color: theme.muted, marginTop: 6}}>{n.sub}</div>}
          </div>
        );
      })}
    </AbsoluteFill>
  );
};
