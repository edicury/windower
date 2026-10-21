import {AbsoluteFill, Img} from '@windower/framekit/core/compat';
import {SAFE} from './theme';

/** Brand logo, top-right of title/outro scenes. Renders nothing without a logo. */
export const Logo = ({src}: {src?: string}) =>
  src ? (
    <AbsoluteFill style={{alignItems: 'flex-end', padding: `${SAFE.top}px ${SAFE.x}px`, pointerEvents: 'none'}}>
      <Img src={src} style={{height: 96, maxWidth: 360, objectFit: 'contain', objectPosition: 'right top'}} />
    </AbsoluteFill>
  ) : null;
