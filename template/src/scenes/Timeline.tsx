import {AbsoluteFill, interpolate, useCurrentFrame} from '@windower/framekit/core/compat';
import {FONT_FLOOR, SAFE, theme} from '../theme';
import type {TimelineScene} from '../types';

const LEFT = SAFE.x;
const RIGHT = 1920 - SAFE.x;
const AXIS_Y = 420;

/** Horizontal timeline (FR-SCN-06): 3-7 items revealed in order along an axis. */
export const Timeline = ({scene}: {scene: TimelineScene}) => {
  const f = useCurrentFrame();
  const n = Math.max(1, scene.items.length);
  const colW = (RIGHT - LEFT) / n;
  const span = Math.max(30, scene.durationFrames - 60);
  const step = span / n;
  const start = (i: number) => 14 + i * step * 0.8;
  const clamp = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'} as const;
  const lineP = interpolate(f, [14, start(n - 1) + 14], [0, 1], clamp);
  return (
    <AbsoluteFill>
      <div style={{position: 'absolute', left: LEFT, top: 70, fontSize: 60, fontWeight: 800, whiteSpace: 'nowrap'}}>{scene.title}</div>
      <div style={{position: 'absolute', left: LEFT, top: AXIS_Y - 2, width: (RIGHT - LEFT) * lineP, height: 4, background: theme.border}} />
      {scene.items.map((it, i) => {
        const s = start(i);
        const o = interpolate(f, [s, s + 14], [0, 1], clamp);
        const y = interpolate(f, [s, s + 14], [16, 0], clamp);
        const left = LEFT + colW * i;
        return (
          <div key={i} style={{position: 'absolute', left, top: 0, width: colW, height: 1080, opacity: o, transform: `translateY(${y}px)`}}>
            {it.when && (
              <div style={{position: 'absolute', left: 12, right: 12, bottom: 1080 - AXIS_Y + 36, fontSize: FONT_FLOOR, lineHeight: 1.15, color: theme.amber, fontWeight: 700, overflowWrap: 'anywhere'}}>
                {it.when}
              </div>
            )}
            <div style={{position: 'absolute', left: 12, top: AXIS_Y - 14, width: 28, height: 28, borderRadius: 14, background: theme.accent, border: `4px solid ${theme.bg}`, boxSizing: 'border-box'}} />
            <div style={{position: 'absolute', left: 12, right: 12, top: AXIS_Y + 40, fontSize: 36, fontWeight: 800, lineHeight: 1.15, overflowWrap: 'anywhere'}}>
              {it.label}
              {it.detail && (
                <div style={{fontSize: FONT_FLOOR, fontWeight: 400, lineHeight: 1.25, color: theme.muted, marginTop: 14, overflowWrap: 'anywhere'}}>{it.detail}</div>
              )}
            </div>
          </div>
        );
      })}
    </AbsoluteFill>
  );
};
