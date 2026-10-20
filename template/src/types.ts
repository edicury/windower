export type Word = {text: string; startMs: number; endMs: number};
type Base = {id: string; narration: string; sources: string[]; durationFrames: number; words: Word[]; audio?: string | null};
export type TitleScene = Base & {type: 'title'; title: string; subtitle?: string};
export type BulletsScene = Base & {type: 'bullets'; title: string; bullets: string[]};
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
export type ExplainerProps = {title: string; scenes: Scene[]};
