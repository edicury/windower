import {AbsoluteFill, Audio, staticFile} from '@windower/framekit-core/compat';
import {TransitionSeries, linearTiming} from '@windower/framekit-transitions/compat';
import {fade} from '@windower/framekit-transitions/compat/fade';
import {slide} from '@windower/framekit-transitions/compat/slide';
import {Captions} from './Captions';
import {Title} from './scenes/Title';
import {Bullets} from './scenes/Bullets';
import {Code} from './scenes/Code';
import {Architecture} from './scenes/Architecture';
import {Sequence as SeqScene} from './scenes/Sequence';
import {Timeline} from './scenes/Timeline';
import {Outro} from './scenes/Outro';
import {brandVars} from './brand';
import {TRANSITION_FRAMES, theme} from './theme';
import type {ExplainerProps, Scene} from './types';

const renderScene = (s: Scene, logo?: string) => {
  switch (s.type) {
    case 'title': return <Title scene={s} logo={logo} />;
    case 'bullets': return <Bullets scene={s} />;
    case 'code': return <Code scene={s} />;
    case 'architecture': return <Architecture scene={s} />;
    case 'sequence': return <SeqScene scene={s} />;
    case 'timeline': return <Timeline scene={s} />;
    case 'outro': return <Outro scene={s} logo={logo} />;
  }
};

export const Explainer = ({scenes, transitionFrames = TRANSITION_FRAMES, burnIn = true, brand}: ExplainerProps) => (
  <AbsoluteFill style={{...brandVars(brand), background: theme.bg, fontFamily: theme.font, color: theme.text}}>
    <TransitionSeries>
      {scenes.flatMap((s, i) => {
        const seq = (
          <TransitionSeries.Sequence key={s.id} durationInFrames={s.durationFrames}>
            <AbsoluteFill>
              {renderScene(s, brand?.logo)}
              {burnIn && <Captions captions={s.captions} />}
              {s.audio && <Audio src={staticFile(s.audio)} />}
            </AbsoluteFill>
          </TransitionSeries.Sequence>
        );
        return i === 0 || s.transition === 'none'
          ? [seq]
          : [
              <TransitionSeries.Transition
                key={`t-${s.id}`}
                presentation={s.transition === 'slide' ? slide({direction: 'from-right'}) : fade()}
                timing={linearTiming({durationInFrames: transitionFrames})}
              />,
              seq,
            ];
      })}
    </TransitionSeries>
  </AbsoluteFill>
);
