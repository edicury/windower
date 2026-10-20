import {AbsoluteFill, Easing, interpolate, useCurrentFrame} from 'remotion';
import {SAFE, theme} from '../theme';
import type {ArchNode, ArchScene} from '../types';
import {
  H_LABEL_W,
  LABEL_FONT,
  LABEL_LINE,
  NODE_H,
  NODE_W,
  hLabelLines,
  labelFont,
  layoutGrid,
  routeEdge,
  wrapText,
  type Point,
  type Route,
} from './architectureLayout';

const kindColor: Record<ArchNode['kind'], string> = {
  service: theme.accent,
  db: theme.green,
  queue: theme.amber,
  client: theme.violet,
  external: theme.muted,
  module: '#38bdf8',
};
const groupPalette = [theme.accent, theme.green, theme.violet, theme.amber, '#f472b6', '#38bdf8'];
const HOP = 24;

const clamp = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'} as const;
const lerp = (a: Point, b: Point, t: number): Point => ({x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t});
const pairKey = (a: string, b: string) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);

interface DrawnEdge {
  from: string;
  to: string;
  label?: string;
  route: Route;
  lane: number;
}

export const Architecture = ({scene}: {scene: ArchScene}) => {
  const f = useCurrentFrame();
  const placed = layoutGrid(scene.nodes.map((n) => n.id));
  const nodeStep = Math.max(6, Math.floor((scene.durationFrames * 0.25) / scene.nodes.length));
  const edgeStep = Math.max(10, Math.floor((scene.durationFrames * 0.4) / Math.max(1, scene.edges.length)));
  const edgeStart = (i: number) => 20 + i * edgeStep;
  const edgesDone = edgeStart(Math.max(0, scene.edges.length - 1)) + 14;

  // Parallel edges between the same pair get separate lanes so they never overlap.
  const seen = new Map<string, number>();
  const total = new Map<string, number>();
  for (const e of scene.edges) total.set(pairKey(e.from, e.to), (total.get(pairKey(e.from, e.to)) ?? 0) + 1);
  const edges: (DrawnEdge | null)[] = scene.edges.map((e) => {
    const a = placed.get(e.from), b = placed.get(e.to);
    if (!a || !b) return null; // unknown ids are rejected by the validator; never crash the renderer
    const k = pairKey(e.from, e.to);
    const idx = seen.get(k) ?? 0;
    seen.set(k, idx + 1);
    const lane = (total.get(k) ?? 1) > 1 ? (idx % 2 === 0 ? -1 : 1) * (1 + Math.floor(idx / 2)) : 0;
    return {from: e.from, to: e.to, label: e.label, route: routeEdge(a, b, lane), lane};
  });

  // Flow hops: consecutive path nodes joined by an edge, oriented along the path.
  const hopRoute = (a: string, b: string): Point[] | null => {
    const i = scene.edges.findIndex((e) => pairKey(e.from, e.to) === pairKey(a, b));
    const d = i >= 0 ? edges[i] : null;
    if (!d) return null;
    const pts = d.route.points;
    return d.from === a ? pts : [...pts].reverse();
  };
  const flows = (scene.flow ?? []).map((fl, k) => {
    const hops: {pts: Point[]; edge: number}[] = [];
    for (let i = 0; i + 1 < fl.path.length; i++) {
      const a = fl.path[i] as string, b = fl.path[i + 1] as string;
      const pts = hopRoute(a, b);
      const edge = scene.edges.findIndex((e) => pairKey(e.from, e.to) === pairKey(a, b));
      if (pts) hops.push({pts, edge});
    }
    const start = Math.round(fl.at !== undefined ? fl.at * scene.durationFrames : edgesDone + k * HOP);
    return {hops, start: Math.max(start, edgesDone)};
  });

  const pulses: {p: Point; key: string}[] = [];
  const lit = new Set<number>();
  flows.forEach((fl, k) => {
    if (!fl.hops.length || f < fl.start) return;
    fl.hops.forEach((h) => lit.add(h.edge));
    const cycle = fl.hops.length * HOP + 20;
    const local = (f - fl.start) % cycle;
    const hi = Math.floor(local / HOP);
    const hop = fl.hops[hi];
    if (!hop) return;
    const t = Easing.inOut(Easing.quad)((local % HOP) / HOP);
    pulses.push({p: lerp(hop.pts[0] as Point, hop.pts[1] as Point, t), key: `f${k}`});
  });
  if (!flows.length) {
    // No explicit flow: a gentle pulse runs along each edge once it has been drawn.
    edges.forEach((d, i) => {
      if (!d) return;
      const local = f - edgeStart(i) - 14;
      if (local < 0) return;
      const t = (local % 45) / 45;
      pulses.push({p: lerp(d.route.points[0] as Point, d.route.points[1] as Point, t), key: `e${i}`});
    });
  }

  const drawEdge = (d: DrawnEdge, i: number) => {
    const [a, b] = d.route.points as [Point, Point];
    const p = interpolate(f, [edgeStart(i), edgeStart(i) + 14], [0, 1], clamp);
    if (p <= 0) return null;
    const e = lerp(a, b, p);
    const hot = lit.has(i);
    return (
      <line key={i} x1={a.x} y1={a.y} x2={e.x} y2={e.y} stroke={hot ? theme.accent : theme.muted}
        strokeWidth={hot ? 6 : 4} strokeDasharray={d.route.clear ? undefined : '14 10'}
        markerEnd={p >= 1 ? (hot ? 'url(#arch-ah-hot)' : 'url(#arch-ah)') : undefined} />
    );
  };

  const groups = [...new Set(scene.nodes.map((n) => n.group).filter((g): g is string => !!g))];
  const groupColor = (g?: string) => (g ? (groupPalette[groups.indexOf(g) % groupPalette.length] as string) : undefined);

  const label = (d: DrawnEdge, i: number) => {
    if (!d.label || !d.route.clear) return null;
    const [a, b] = d.route.points as [Point, Point];
    const o = interpolate(f, [edgeStart(i) + 8, edgeStart(i) + 20], [0, 1], clamp);
    const common = {position: 'absolute', fontSize: LABEL_FONT, lineHeight: `${LABEL_LINE}px`, color: theme.text, opacity: o} as const;
    if (d.route.horizontal) {
      const lines = hLabelLines(d.label);
      const h = lines.length * LABEL_LINE;
      const below = d.lane > 0;
      return (
        <div key={`l${i}`} style={{...common, left: (a.x + b.x) / 2 - H_LABEL_W / 2, width: H_LABEL_W, textAlign: 'center',
          top: below ? a.y + 8 : a.y - 8 - h}}>
          {lines.map((l, k) => <div key={k}>{l}</div>)}
        </div>
      );
    }
    const left = d.lane < 0;
    const lines = wrapText(d.label, 26);
    const h = lines.length * LABEL_LINE;
    return (
      <div key={`l${i}`} style={{...common, top: (a.y + b.y) / 2 - h / 2, width: 420,
        left: left ? a.x - 14 - 420 : a.x + 14, textAlign: left ? 'right' : 'left'}}>
        {lines.map((l, k) => <div key={k}>{l}</div>)}
      </div>
    );
  };

  const defs = (
    <defs>
      {[['arch-ah', theme.muted], ['arch-ah-hot', theme.accent]].map(([id, fill]) => (
        <marker key={id} id={id} markerUnits="userSpaceOnUse" markerWidth="18" markerHeight="18" refX="16" refY="9" orient="auto">
          <path d="M0,0 L18,9 L0,18 z" fill={fill} />
        </marker>
      ))}
    </defs>
  );

  return (
    <AbsoluteFill>
      <div style={{position: 'absolute', left: SAFE.x, top: 70, fontSize: 60, fontWeight: 800}}>{scene.title}</div>
      {/* Edges that cannot run straight between facing sides (invalid input) sit under the boxes. */}
      <svg width={1920} height={1080} style={{position: 'absolute', inset: 0}}>
        {defs}
        {edges.map((d, i) => (d && !d.route.clear ? drawEdge(d, i) : null))}
      </svg>
      {scene.nodes.map((n, i) => {
        const pos = placed.get(n.id);
        if (!pos) return null;
        const s = 6 + i * nodeStep;
        const o = interpolate(f, [s, s + 12], [0, 1], clamp);
        const c = kindColor[n.kind];
        const gc = groupColor(n.group);
        return (
          <div key={n.id} style={{position: 'absolute', left: pos.x, top: pos.y, width: NODE_W, height: NODE_H, opacity: o,
            boxSizing: 'border-box', padding: '0 20px', transform: `scale(${0.92 + 0.08 * o})`, background: theme.panel,
            border: `3px ${n.kind === 'external' ? 'dashed' : 'solid'} ${c}`,
            borderRadius: n.kind === 'db' ? '18px 18px 44px 44px / 18px 18px 22px 22px' : n.kind === 'queue' ? 65 : 18,
            display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', textAlign: 'center'}}>
            <div style={{fontSize: labelFont(n.label), fontWeight: 700, lineHeight: 1.1, whiteSpace: 'nowrap'}}>{n.label}</div>
            {n.sub && <div style={{fontSize: 28, lineHeight: '32px', color: theme.muted, marginTop: 4}}>{n.sub}</div>}
            {gc && <div style={{position: 'absolute', top: 12, right: n.kind === 'queue' ? 34 : 18, width: 14, height: 14, borderRadius: 7, background: gc}} />}
          </div>
        );
      })}
      {/* Straight segments between facing sides cross no node, so they are drawn above the boxes. */}
      <svg width={1920} height={1080} style={{position: 'absolute', inset: 0}}>
        {defs}
        {edges.map((d, i) => (d && d.route.clear ? drawEdge(d, i) : null))}
        {pulses.map((q) => <circle key={q.key} cx={q.p.x} cy={q.p.y} r={9} fill={theme.amber} />)}
      </svg>
      {edges.map((d, i) => (d ? label(d, i) : null))}
      {groups.length > 0 && (
        <div style={{position: 'absolute', left: SAFE.x, top: 892, display: 'flex', gap: 40, fontSize: 28, lineHeight: '34px',
          color: theme.muted, opacity: interpolate(f, [10, 24], [0, 1], clamp)}}>
          {groups.map((g) => (
            <div key={g} style={{display: 'flex', alignItems: 'center', gap: 12}}>
              <div style={{width: 14, height: 14, borderRadius: 7, background: groupColor(g)}} />
              {g}
            </div>
          ))}
        </div>
      )}
    </AbsoluteFill>
  );
};
