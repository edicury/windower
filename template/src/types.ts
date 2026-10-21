import type {SourceRef} from './schema';
import type {Brand} from './brand';

/** Same field names as `Caption` from the captions package convention. Times are ms from scene start. */
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
/** `n` is the snippet line number (startLine + row index); `kind` is set in diff mode. */
export type CodeLine = {n: number; kind?: 'add' | 'del' | 'ctx'; tokens: CodeToken[]};
export type CodeScene = Base & {
  type: 'code'; file: string; language: string; startLine: number; mode: 'plain' | 'diff';
  caption?: string; focus: {lines: [number, number]; at?: number}[]; lines: CodeLine[];
};
export type ArchNode = {
  id: string; label: string; sub?: string; group?: string;
  kind: 'service' | 'db' | 'queue' | 'client' | 'external' | 'module';
};
export type ArchScene = Base & {
  type: 'architecture'; title: string; nodes: ArchNode[];
  edges: {from: string; to: string; label?: string}[];
  flow?: {path: string[]; at?: number}[];
};
export type SequenceScene = Base & {
  type: 'sequence'; title: string; participants: string[];
  messages: {from: number; to: number; text: string; note?: string}[];
};
export type TimelineScene = Base & {
  type: 'timeline'; title: string; orientation?: 'horizontal';
  items: {label: string; detail?: string; when?: string}[];
};
export type OutroScene = Base & {type: 'outro'; headline: string; subtitle?: string; items?: string[]};
export type Scene = TitleScene | BulletsScene | CodeScene | ArchScene | SequenceScene | TimelineScene | OutroScene;
export type ExplainerProps = {
  title: string;
  fps: number;
  transitionFrames: number;
  totalFrames: number;
  /** Burn captions into the video (FR-CAP-03); sidecar SRT/VTT are always exported. */
  burnIn?: boolean;
  /** From .windower.json; absent means the built-in theme. */
  brand?: Brand;
  scenes: Scene[];
};
