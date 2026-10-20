import {Composition} from 'remotion';
import {Explainer} from './Explainer';
import {Hello} from './Hello';
import {FPS, TRANSITION_FRAMES} from './theme';
import type {ExplainerProps} from './types';

const defaultProps: ExplainerProps = {title: 'empty', scenes: []};

export const Root = () => (
  <>
  <Composition
    id="Explainer"
    component={Explainer}
    width={1920}
    height={1080}
    fps={FPS}
    durationInFrames={FPS}
    defaultProps={defaultProps}
    calculateMetadata={({props}) => {
      const sum = props.scenes.reduce((a, s) => a + s.durationFrames, 0);
      const overlaps = Math.max(0, props.scenes.length - 1) * TRANSITION_FRAMES;
      return {durationInFrames: Math.max(FPS, sum - overlaps)};
    }}
  />
  <Composition id="Hello" component={Hello} width={1920} height={1080} fps={FPS} durationInFrames={FPS * 2} />
  </>
);
