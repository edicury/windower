import {AbsoluteFill, interpolate, useCurrentFrame} from '@windower/framekit/core/compat';
import {SAFE, theme} from '../theme';
import {Logo} from '../Logo';
import type {OutroScene} from '../types';

/** Closing card (FR-SCN-07): headline, optional subtitle and up to 3 takeaway chips. */
export const Outro = ({scene, logo}: {scene: OutroScene; logo?: string}) => {
  const f = useCurrentFrame();
  const clamp = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'} as const;
  const o = interpolate(f, [0, 18], [0, 1], clamp);
  const y = interpolate(f, [0, 18], [24, 0], clamp);
  const items = scene.items ?? [];
  return (
    <AbsoluteFill style={{justifyContent: 'center', alignItems: 'center', textAlign: 'center', padding: SAFE.x, paddingBottom: 220}}>
      <Logo src={logo} />
      <div style={{width: 120, height: 8, borderRadius: 4, background: theme.accent2, marginBottom: 48, opacity: o}} />
      <div style={{fontSize: 96, fontWeight: 800, lineHeight: 1.1, textWrap: 'balance', opacity: o, transform: `translateY(${y}px)`}}>{scene.headline}</div>
      {scene.subtitle && (
        <div style={{fontSize: 44, color: theme.muted, marginTop: 28, opacity: interpolate(f, [10, 30], [0, 1], clamp)}}>{scene.subtitle}</div>
      )}
      {items.length > 0 && (
        <div style={{display: 'flex', flexDirection: 'column', gap: 16, marginTop: 44, alignItems: 'center'}}>
          {items.map((t, i) => {
            const s = 30 + i * 18;
            return (
              <div key={i} style={{fontSize: 36, border: `2px solid ${theme.border}`, background: theme.panel, borderRadius: 999, padding: '10px 32px', opacity: interpolate(f, [s, s + 14], [0, 1], clamp)}}>{t}</div>
            );
          })}
        </div>
      )}
    </AbsoluteFill>
  );
};
