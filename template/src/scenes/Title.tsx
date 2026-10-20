import {AbsoluteFill, interpolate, useCurrentFrame} from 'remotion';
import {theme} from '../theme';
import type {TitleScene} from '../types';

export const Title = ({scene}: {scene: TitleScene}) => {
  const f = useCurrentFrame();
  const o = interpolate(f, [0, 18], [0, 1], {extrapolateRight: 'clamp'});
  const y = interpolate(f, [0, 18], [24, 0], {extrapolateRight: 'clamp'});
  const o2 = interpolate(f, [10, 30], [0, 1], {extrapolateRight: 'clamp'});
  return (
    <AbsoluteFill style={{justifyContent: 'center', alignItems: 'center', textAlign: 'center', padding: 120, paddingBottom: 220}}>
      <div style={{width: 120, height: 8, borderRadius: 4, background: theme.accent, marginBottom: 48, opacity: o}} />
      <div style={{fontSize: 108, fontWeight: 800, lineHeight: 1.08, opacity: o, transform: `translateY(${y}px)`}}>{scene.title}</div>
      {scene.subtitle && <div style={{fontSize: 44, color: theme.muted, marginTop: 32, opacity: o2}}>{scene.subtitle}</div>}
    </AbsoluteFill>
  );
};
