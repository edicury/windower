import {AbsoluteFill, interpolate, useCurrentFrame} from 'remotion';

export const Hello = () => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 20], [0, 1], {extrapolateRight: 'clamp'});
  return (
    <AbsoluteFill
      style={{
        background: '#0f172a',
        color: '#f8fafc',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'sans-serif',
        fontSize: 96,
        opacity,
      }}
    >
      windower
    </AbsoluteFill>
  );
};
