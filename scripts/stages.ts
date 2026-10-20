// stages: pure resume logic (FR-SCOPE-04, FR-SB-05). No filesystem access; status.ts gathers the facts.
export const STAGES = ['brief', 'storyboard', 'approved', 'timing', 'props', 'video'] as const;
export type StageName = (typeof STAGES)[number];
export type StageState = 'missing' | 'done' | 'stale';

export const STAGE_FILES: Record<StageName, string> = {
  brief: 'brief.md',
  storyboard: 'storyboard.json',
  approved: 'storyboard.json',
  timing: 'timing.json',
  props: 'props.json',
  video: 'out/video.mp4',
};

export interface RunFacts {
  /** mtime in ms, or undefined when the file does not exist. */
  mtime: {
    brief?: number;
    storyboard?: number;
    timing?: number;
    props?: number;
    video?: number;
    captions?: number;
  };
  /** Only meaningful when storyboard exists. */
  storyboardValid?: boolean;
  storyboardApproved?: boolean;
  /** First validator errors, for the report. */
  storyboardErrors?: string[];
}

export interface StageReport {
  stage: StageName;
  file: string;
  state: StageState;
  reason?: string;
}

export interface RunStatus {
  stages: StageReport[];
  /** First stage that is not done, or null when the whole run is complete. */
  next: StageName | null;
  complete: boolean;
  notes: string[];
}

const SKILL_ACTION: Record<StageName, string> = {
  brief: 'gather code and write brief.md',
  storyboard: 'author and validate storyboard.json',
  approved: 'show the storyboard summary and ask for approval',
  timing: 'run ve:prepare',
  props: 'run ve:prepare',
  video: 'run ve:render',
};
export const actionFor = (s: StageName): string => SKILL_ACTION[s];

const newer = (input: number | undefined, output: number): boolean =>
  input !== undefined && input > output;

export function computeStatus(f: RunFacts): RunStatus {
  const m = f.mtime;
  const notes: string[] = [];
  const out: StageReport[] = [];
  const add = (stage: StageName, state: StageState, reason?: string) =>
    out.push({stage, file: STAGE_FILES[stage], state, ...(reason ? {reason} : {})});
  /** Once an upstream stage is not done, anything that exists downstream is stale. */
  let upstreamOk = true;
  /** Records a non-done stage and blocks everything after it. */
  const block = (stage: StageName, state: StageState, reason?: string) => {
    add(stage, state, reason);
    upstreamOk = false;
  };
  const orphan = (stage: StageName, exists: boolean): boolean => {
    if (upstreamOk) return false;
    add(stage, exists ? 'stale' : 'missing', exists ? 'an earlier stage is not done' : undefined);
    return true;
  };

  if (m.brief === undefined) block('brief', 'missing');
  else add('brief', 'done');

  // User edits to the storyboard are honored: older than brief is only a note.
  if (!orphan('storyboard', m.storyboard !== undefined)) {
    if (m.storyboard === undefined) block('storyboard', 'missing');
    else if (f.storyboardValid === false)
      block('storyboard', 'stale', `invalid: ${(f.storyboardErrors ?? []).slice(0, 3).join('; ')}`);
    else {
      add('storyboard', 'done');
      if (m.brief !== undefined && m.storyboard < m.brief)
        notes.push(
          'storyboard.json is older than brief.md; it is kept as-is (user edits are honored). Re-check it against the brief if the brief changed.',
        );
    }
  }

  if (!orphan('approved', false)) {
    if (f.storyboardApproved === true) add('approved', 'done');
    else block('approved', 'missing');
  }

  if (!orphan('timing', m.timing !== undefined)) {
    if (m.timing === undefined) block('timing', 'missing');
    else if (newer(m.storyboard, m.timing)) block('timing', 'stale', 'older than storyboard.json');
    else add('timing', 'done');
  }

  if (!orphan('props', m.props !== undefined)) {
    if (m.props === undefined) block('props', 'missing');
    else if (newer(m.timing, m.props) || newer(m.storyboard, m.props))
      block('props', 'stale', 'older than timing.json or storyboard.json');
    else add('props', 'done');
  }

  if (!orphan('video', m.video !== undefined)) {
    if (m.video === undefined) add('video', 'missing');
    else if (newer(m.props, m.video)) add('video', 'stale', 'older than props.json');
    else if (m.captions === undefined) add('video', 'stale', 'captions are missing from out/');
    else add('video', 'done');
  }

  const first = out.find((s) => s.state !== 'done');
  return {stages: out, next: first?.stage ?? null, complete: !first, notes};
}

/** kebab-case slug matching ^[a-z0-9-]{1,48}$ */
export function slugify(text: string, max = 48): string {
  const s = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return s || 'video';
}

/** Returns the slug, or slug-2, slug-3, ... not in `existing`; always within 48 chars. */
export function uniqueSlug(base: string, existing: Iterable<string>, max = 48): string {
  const taken = new Set(existing);
  const root = slugify(base, max);
  if (!taken.has(root)) return root;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const cand = root.slice(0, max - suffix.length).replace(/-+$/g, '') + suffix;
    if (!taken.has(cand)) return cand;
  }
}
