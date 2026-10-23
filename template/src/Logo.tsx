import {AbsoluteFill, Img} from '@windower/framekit/core/compat';
import type {LogoPosition} from './brand';
import {SAFE} from './theme';

const FRAME_HEIGHT = 1080;
/** Bottom corners end at the content limit, so the logo stays above the captions bar. */
const BOTTOM_INSET = FRAME_HEIGHT - SAFE.contentBottom;

const PLACEMENT: Record<LogoPosition, {align: 'flex-start' | 'flex-end'; justify: 'flex-start' | 'flex-end'; object: string}> = {
  'top-left': {align: 'flex-start', justify: 'flex-start', object: 'left top'},
  'top-right': {align: 'flex-end', justify: 'flex-start', object: 'right top'},
  'bottom-left': {align: 'flex-start', justify: 'flex-end', object: 'left bottom'},
  'bottom-right': {align: 'flex-end', justify: 'flex-end', object: 'right bottom'},
};

/** Brand logo in a chosen corner (default top-right), drawn once over all scenes. Renders nothing without a logo. */
export const Logo = ({src, position = 'top-right'}: {src?: string; position?: LogoPosition}) => {
  if (!src) return null;
  const p = PLACEMENT[position];
  const top = position.startsWith('top');
  return (
    <AbsoluteFill
      style={{
        alignItems: p.align,
        justifyContent: p.justify,
        padding: `${top ? SAFE.top : 0}px ${SAFE.x}px ${top ? 0 : BOTTOM_INSET}px`,
        pointerEvents: 'none',
      }}
    >
      <Img src={src} style={{height: 96, maxWidth: 360, objectFit: 'contain', objectPosition: p.object}} />
    </AbsoluteFill>
  );
};
