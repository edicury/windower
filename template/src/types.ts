import type {SourceRef} from './schema';

/** Same field names as `Caption` from @remotion/captions (verified against 4.0.537). Times are ms from scene start. */
export type Caption = {
  text: string;
  startMs: number;
  endMs: number;
  timestampMs: number | null;
  confidence: number | null;
};
type Base = {
  id: string;
  narration: string;
  sources: SourceRef[];
  transition?: 'fade' | 'slide' | 'none';
  durationFrames: number;
  /** First frame of the scene on the composition timeline (transition overlaps already subtracted). */
  startFrame: number;
  captions: Caption[];
  audio?: string | null;
};
export type TitleScene = Base & {type: 'title'; headline: string; subtitle?: string; badge?: string};
export type BulletsScene = Base & {type: 'bullets'; heading: string; items: string[]};
export type CodeToken = {c: string; color?: string};
export type CodeLine = {n: number; tokens: CodeToken[]};
export type CodeScene = Base & {
  type: 'code'; title: string; file: string; startLine: number; endLine: number;
  focus: [number, number][]; lines: CodeLine[];
};
export type ArchNode = {id: string; label: string; sub?: string; x: number; y: number; tone?: 'green' | 'violet'};
export type ArchScene = Base & {
  type: 'architecture'; title: string; nodes: ArchNode[]; edges: {from: string; to: string; label?: string}[];
};
export type SequenceScene = Base & {
  type: 'sequence'; title: string; participants: string[];
  messages: {from: number; to: number; text: string; note?: string}[];
};
export type Scene = TitleScene | BulletsScene | CodeScene | ArchScene | SequenceScene;
export type ExplainerProps = {
  title: string;
  fps: number;
  transitionFrames: number;
  totalFrames: number;
  /** Burn captions into the video (FR-CAP-03); sidecar SRT/VTT are always exported. */
  burnIn?: boolean;
  scenes: Scene[];
};
