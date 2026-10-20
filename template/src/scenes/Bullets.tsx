import {AbsoluteFill, interpolate, useCurrentFrame} from 'remotion';
import {theme} from '../theme';
import type {BulletsScene} from '../types';

export const Bullets = ({scene}: {scene: BulletsScene}) => {
  const f = useCurrentFrame();
  const step = Math.max(30, Math.floor((scene.durationFrames - 60) / scene.bullets.length));
  return (
    <AbsoluteFill style={{padding: '90px 140px 0'}}>
      <div style={{fontSize: 72, fontWeight: 800, marginBottom: 56}}>{scene.title}</div>
      {scene.bullets.map((b, i) => {
        const start = 14 + i * step * 0.8;
        const o = interpolate(f, [start, start + 14], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
        const x = interpolate(f, [start, start + 14], [-30, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
        return (
          <div key={i} style={{display: 'flex', gap: 28, alignItems: 'flex-start', fontSize: 46, lineHeight: 1.3, marginBottom: 36, opacity: o, transform: `translateX(${x}px)`}}>
            <div style={{width: 18, height: 18, borderRadius: 9, background: theme.accent, marginTop: 20, flexShrink: 0}} />
            <div>{b}</div>
          </div>
        );
      })}
    </AbsoluteFill>
  );
};
