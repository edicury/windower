import {AbsoluteFill, interpolate, useCurrentFrame} from '@windower/framekit/core/compat';
import {SAFE, theme} from '../theme';
import {Logo} from '../Logo';
import type {TitleScene} from '../types';

/** Keep hyphenated words ("post-mortems") on one line instead of breaking after the hyphen. */
const noHyphenBreak = (text: string) =>
  text.split(' ').map((w, i, all) => (
    <span key={i} style={w.includes('-') ? {whiteSpace: 'nowrap'} : undefined}>
      {w}{i < all.length - 1 ? ' ' : ''}
    </span>
  ));

export const Title = ({scene, logo}: {scene: TitleScene; logo?: string}) => {
  const f = useCurrentFrame();
  const o = interpolate(f, [0, 18], [0, 1], {extrapolateRight: 'clamp'});
  const y = interpolate(f, [0, 18], [24, 0], {extrapolateRight: 'clamp'});
  const o2 = interpolate(f, [10, 30], [0, 1], {extrapolateRight: 'clamp'});
  return (
    <AbsoluteFill style={{justifyContent: 'center', alignItems: 'center', textAlign: 'center', padding: SAFE.x, paddingBottom: 220}}>
      <Logo src={logo} />
      {scene.badge && (
        <div style={{fontSize: 30, fontWeight: 700, letterSpacing: 2, textTransform: 'uppercase', color: theme.accent, border: `2px solid ${theme.accent}`, borderRadius: 999, padding: '6px 24px', marginBottom: 32, opacity: o}}>
          {scene.badge}
        </div>
      )}
      <div style={{width: 120, height: 8, borderRadius: 4, background: theme.accent, marginBottom: 48, opacity: o}} />
      <div style={{fontSize: 108, fontWeight: 800, lineHeight: 1.08, textWrap: 'balance', opacity: o, transform: `translateY(${y}px)`}}>
        {noHyphenBreak(scene.headline)}
      </div>
      {scene.subtitle && <div style={{fontSize: 44, color: theme.muted, marginTop: 32, opacity: o2}}>{scene.subtitle}</div>}
    </AbsoluteFill>
  );
};
