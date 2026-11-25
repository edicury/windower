import {useLayoutEffect, useRef, useState} from 'react';
import {AbsoluteFill, continueRender, delayRender, useCurrentFrame, useVideoConfig} from '@windower/framekit/core/compat';
import {KIT_BRAND_MAP, buildSrcdoc} from '../htmlKit';
import type {HtmlScene} from '../types';

/**
 * Designed HTML page in a fixed 1920x1080 canvas. The page lives in a sandboxed, script-less
 * iframe (srcdoc + CSP); every frame we set `--t` / `--p` on its root and seek all animations,
 * so output depends only on the frame number.
 */
export const Html = ({scene}: {scene: HtmlScene}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const wrap = useRef<HTMLDivElement>(null);
  const ref = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const [handle] = useState(() => delayRender('html scene ' + scene.id));
  const srcDoc = useRef(buildSrcdoc(scene.html)).current;

  const apply = () => {
    const doc = ref.current?.contentDocument;
    if (!doc?.documentElement) return;
    const root = doc.documentElement;
    const t = frame / fps;
    root.style.setProperty('--t', t.toFixed(4));
    root.style.setProperty('--p', Math.min(1, Math.max(0, frame / Math.max(1, scene.durationFrames - 1))).toFixed(4));
    if (wrap.current) {
      const cs = getComputedStyle(wrap.current);
      for (const [kit, ve] of Object.entries(KIT_BRAND_MAP)) {
        const v = cs.getPropertyValue(ve).trim();
        if (v) root.style.setProperty(kit, v);
      }
    }
    for (const a of doc.getAnimations()) {
      a.pause();
      a.currentTime = t * 1000;
    }
  };

  useLayoutEffect(() => {
    if (!ready) return;
    apply();
  });

  const onLoad = () => {
    const doc = ref.current?.contentDocument;
    const done = () => {
      apply();
      setReady(true);
      continueRender(handle);
    };
    if (doc?.fonts?.ready) doc.fonts.ready.then(done, done);
    else done();
  };

  return (
    <AbsoluteFill style={{background: 'var(--ve-bg, #0b1020)'}}>
      <div ref={wrap} style={{position: 'absolute', inset: 0}} />
      <iframe
        ref={ref}
        title={scene.title ?? scene.id}
        sandbox="allow-same-origin"
        srcDoc={srcDoc}
        onLoad={onLoad}
        style={{position: 'absolute', left: 0, top: 0, width: 1920, height: 1080, border: 0}}
      />
    </AbsoluteFill>
  );
};
