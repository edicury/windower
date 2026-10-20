import {AbsoluteFill, interpolate, useCurrentFrame} from 'remotion';
import {FONT_FLOOR, SAFE, theme} from '../theme';
import type {BulletsScene} from '../types';

const BODY_PX = Math.max(FONT_FLOOR, 46);

export const Bullets = ({scene}: {scene: BulletsScene}) => {
  const f = useCurrentFrame();
  // Items are revealed in order, spread across the scene so the last lands before the final ~2 s.
  const span = Math.max(30, scene.durationFrames - 60);
  const step = span / scene.items.length;
  return (
    <AbsoluteFill style={{padding: `${SAFE.top}px ${SAFE.x + 20}px 0`}}>
      <div style={{fontSize: 72, fontWeight: 800, marginBottom: 40, lineHeight: 1.1, textWrap: 'balance'}}>{scene.heading}</div>
      {scene.items.map((b, i) => {
        const start = 14 + i * step * 0.8;
        const o = interpolate(f, [start, start + 14], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
        const x = interpolate(f, [start, start + 14], [-30, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
        return (
          <div key={i} style={{display: 'flex', gap: 28, alignItems: 'flex-start', fontSize: BODY_PX, lineHeight: 1.3, marginBottom: 28, opacity: o, transform: `translateX(${x}px)`}}>
            <div style={{width: 18, height: 18, borderRadius: 9, background: theme.accent, marginTop: 20, flexShrink: 0}} />
            <div>{b}</div>
          </div>
        );
      })}
    </AbsoluteFill>
  );
};
