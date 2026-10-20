import {AbsoluteFill, Audio, staticFile} from 'remotion';
import {TransitionSeries, linearTiming} from '@remotion/transitions';
import {fade} from '@remotion/transitions/fade';
import {Captions} from './Captions';
import {Title} from './scenes/Title';
import {Bullets} from './scenes/Bullets';
import {Code} from './scenes/Code';
import {Architecture} from './scenes/Architecture';
import {Sequence as SeqScene} from './scenes/Sequence';
import {TRANSITION_FRAMES, theme} from './theme';
import type {ExplainerProps, Scene} from './types';

const renderScene = (s: Scene) => {
  switch (s.type) {
    case 'title': return <Title scene={s} />;
    case 'bullets': return <Bullets scene={s} />;
    case 'code': return <Code scene={s} />;
    case 'architecture': return <Architecture scene={s} />;
    case 'sequence': return <SeqScene scene={s} />;
  }
};

export const Explainer = ({scenes, transitionFrames = TRANSITION_FRAMES, burnIn = true}: ExplainerProps) => (
  <AbsoluteFill style={{background: theme.bg, fontFamily: theme.font, color: theme.text}}>
    <TransitionSeries>
      {scenes.flatMap((s, i) => {
        const seq = (
          <TransitionSeries.Sequence key={s.id} durationInFrames={s.durationFrames}>
            <AbsoluteFill>
              {renderScene(s)}
              {burnIn && <Captions captions={s.captions} />}
              {s.audio && <Audio src={staticFile(s.audio)} />}
            </AbsoluteFill>
          </TransitionSeries.Sequence>
        );
        return i === 0
          ? [seq]
          : [
              <TransitionSeries.Transition
                key={`t-${s.id}`}
                presentation={fade()}
                timing={linearTiming({durationInFrames: transitionFrames})}
              />,
              seq,
            ];
      })}
    </TransitionSeries>
  </AbsoluteFill>
);
