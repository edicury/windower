import {AbsoluteFill, useCurrentFrame, useVideoConfig} from 'remotion';
import {chunkCaptions} from './captionChunks';
import {SAFE, theme} from './theme';
import type {Caption} from './types';

/** Burned-in captions: one cue at a time (max ~2 lines), bottom safe area, spoken words highlighted. */
export const Captions = ({captions}: {captions: Caption[]}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const ms = (frame / fps) * 1000;
  const groups = chunkCaptions(captions);
  const group = groups.find((g) => ms < g[g.length - 1].endMs) ?? groups[groups.length - 1];
  if (!group || ms < group[0].startMs - 150) return null;
  return (
    <AbsoluteFill style={{justifyContent: 'flex-end', alignItems: 'center', paddingBottom: SAFE.captionsBottom}}>
      <div style={{
        background: 'rgba(5,8,20,0.82)', padding: '14px 32px', borderRadius: 14,
        fontSize: 44, fontWeight: 600, letterSpacing: 0.2, maxWidth: 1600, textAlign: 'center',
        border: `1px solid ${theme.border}`,
      }}>
        {group.map((w, i) => (
          <span key={i} style={{color: ms >= w.startMs ? theme.text : theme.muted}}>
            {w.text}{i < group.length - 1 ? ' ' : ''}
          </span>
        ))}
      </div>
    </AbsoluteFill>
  );
};
