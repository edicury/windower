// Storyboard schema (contracts/storyboard-schema.md). Zod is the source of truth; the validator
// (scripts/validate-storyboard.ts) adds cross-scene, referential and duration rules on top.
import {z} from 'zod';
import {codeTextProblems} from './codeLines';
import {MODE_IDS} from './modes';

export const PLUGIN_VERSION = '0.2.0';

export const LIMITS = {
  titleHeadline: 90,
  titleSubtitle: 80,
  titleBadge: 24,
  bulletsHeading: 60,
  bulletsItems: {min: 2, max: 5},
  bulletsItemChars: 110,
  codeLines: 16,
  codeLineChars: 100,
  archNodes: {min: 2, max: 9},
  archEdges: {min: 1, max: 12},
  archLabel: 20,
  archSub: 30,
  archEdgeLabel: 24,
  narrationWords: {min: 8, max: 60},
  scenes: {min: 3, max: 40},
  seqParticipants: {min: 2, max: 5},
  seqParticipantChars: 18,
  seqMessages: {min: 2, max: 8},
  seqTextChars: 40,
  seqNoteChars: 36,
  timelineItems: {min: 3, max: 7},
  timelineLabelChars: 24,
  timelineDetailChars: 80,
  timelineWhenChars: 20,
  outroHeadline: 90,
  outroSubtitle: 80,
  outroItems: 3,
  outroItemChars: 60,
  /** Bullets: wrapped-line budget (46 px text, ~68 chars per line in the 1560 px column). */
  bulletsWrappedLines: 8,
  bulletsCharsPerLine: 68,
} as const;

export const countWords = (text: string): number => {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
};

export const Source = z.strictObject({
  kind: z.enum(['file', 'url', 'git']),
  ref: z.string().min(1),
});

const Narration = z
  .string()
  .refine((s) => countWords(s) >= LIMITS.narrationWords.min, {
    error: `narration has fewer than ${LIMITS.narrationWords.min} words`,
  })
  .refine((s) => countWords(s) <= LIMITS.narrationWords.max, {
    error: `narration has more than ${LIMITS.narrationWords.max} words`,
  })
  .refine((s) => !/[<>`*#]|\]\(/.test(s), {
    error: 'narration must be plain text (no markup: < > ` * # or links)',
  });

const base = {
  id: z.string().regex(/^s[0-9]{2}$/, {error: 'id must look like s01, s02, ...'}),
  narration: Narration,
  /** Optional chapter label; consecutive scenes sharing a label form a chapter (must be contiguous). */
  chapter: z.string().trim().min(1).max(40, {error: 'chapter label > 40 chars'}).optional(),
  sources: z.array(Source),
  minDurationSec: z.number().min(2).max(20).optional(),
  transition: z.enum(['fade', 'slide', 'none']).default('fade'),
};

export const TitleScene = z.strictObject({
  ...base,
  type: z.literal('title'),
  headline: z.string().min(1).max(LIMITS.titleHeadline, {error: `headline > ${LIMITS.titleHeadline} chars`}),
  subtitle: z.string().max(LIMITS.titleSubtitle, {error: `subtitle > ${LIMITS.titleSubtitle} chars`}).optional(),
  badge: z.string().max(LIMITS.titleBadge, {error: `badge > ${LIMITS.titleBadge} chars`}).optional(),
});

export const BulletsScene = z.strictObject({
  ...base,
  type: z.literal('bullets'),
  heading: z.string().min(1).max(LIMITS.bulletsHeading, {error: `heading > ${LIMITS.bulletsHeading} chars`}),
  items: z
    .array(
      z.string().min(1).max(LIMITS.bulletsItemChars, {error: `item length > ${LIMITS.bulletsItemChars} chars`}),
    )
    .min(LIMITS.bulletsItems.min, {error: `items < ${LIMITS.bulletsItems.min}`})
    .max(LIMITS.bulletsItems.max, {error: `items > ${LIMITS.bulletsItems.max}`}),
});

// Code scene (FR-SCN-03). `focus[].lines` are snippet line numbers: startLine + row index (in diff
// mode rows include removed lines). `focus[].at` is the fraction of the scene when the focus starts.
export const CodeScene = z
  .strictObject({
    ...base,
    type: z.literal('code'),
    file: z.string().min(1),
    language: z.string().min(1),
    startLine: z.number().int().min(1),
    code: z.string().min(1),
    focus: z
      .array(
        z.strictObject({
          lines: z.tuple([z.number().int(), z.number().int()]),
          at: z.number().min(0).max(1).optional(),
        }),
      )
      .optional(),
    mode: z.enum(['plain', 'diff']).default('plain'),
    caption: z.string().max(100, {error: 'caption > 100 chars'}).optional(),
  })
  .superRefine((s, ctx) => {
    for (const p of codeTextProblems(s, {lines: LIMITS.codeLines, chars: LIMITS.codeLineChars}))
      ctx.addIssue({code: 'custom', path: p.path, message: p.message});
  });

export const ARCH_KINDS = ['service', 'db', 'queue', 'client', 'external', 'module'] as const;

export const ArchitectureScene = z.strictObject({
  ...base,
  type: z.literal('architecture'),
  title: z.string().min(1),
  nodes: z
    .array(
      z.strictObject({
        id: z.string().min(1),
        label: z.string().min(1).max(LIMITS.archLabel, {error: `label > ${LIMITS.archLabel} chars`}),
        sub: z.string().max(LIMITS.archSub, {error: `sub > ${LIMITS.archSub} chars`}).optional(),
        kind: z.enum(ARCH_KINDS),
        group: z.string().min(1).max(LIMITS.archLabel, {error: `group > ${LIMITS.archLabel} chars`}).optional(),
      }),
    )
    .min(LIMITS.archNodes.min, {error: `nodes < ${LIMITS.archNodes.min}`})
    .max(LIMITS.archNodes.max, {error: `nodes > ${LIMITS.archNodes.max}`}),
  edges: z
    .array(
      z.strictObject({
        from: z.string(),
        to: z.string(),
        label: z.string().max(LIMITS.archEdgeLabel, {error: `label > ${LIMITS.archEdgeLabel} chars`}).optional(),
      }),
    )
    .min(LIMITS.archEdges.min, {error: `edges < ${LIMITS.archEdges.min}`})
    .max(LIMITS.archEdges.max, {error: `edges > ${LIMITS.archEdges.max}`}),
  flow: z
    .array(
      z.strictObject({
        path: z.array(z.string()).min(2, {error: 'flow path needs at least 2 node ids'}),
        at: z.number().min(0).max(1).optional(),
      }),
    )
    .optional(),
});

export const SequenceScene = z.strictObject({
  ...base,
  type: z.literal('sequence'),
  title: z.string().min(1).max(60, {error: 'title > 60 chars'}),
  participants: z
    .array(
      z
        .string()
        .min(1)
        .max(LIMITS.seqParticipantChars, {error: `participant name > ${LIMITS.seqParticipantChars} chars`}),
    )
    .min(LIMITS.seqParticipants.min, {error: `participants < ${LIMITS.seqParticipants.min}`})
    .max(LIMITS.seqParticipants.max, {error: `participants > ${LIMITS.seqParticipants.max}`}),
  messages: z
    .array(
      z.strictObject({
        from: z.number().int(),
        to: z.number().int(),
        text: z.string().min(1).max(LIMITS.seqTextChars, {error: `text > ${LIMITS.seqTextChars} chars`}),
        note: z.string().max(LIMITS.seqNoteChars, {error: `note > ${LIMITS.seqNoteChars} chars`}).optional(),
      }),
    )
    .min(LIMITS.seqMessages.min, {error: `messages < ${LIMITS.seqMessages.min}`})
    .max(LIMITS.seqMessages.max, {error: `messages > ${LIMITS.seqMessages.max}`}),
});

// Timeline (FR-SCN-06): 3-7 events revealed in order along a horizontal axis.
export const TimelineScene = z.strictObject({
  ...base,
  type: z.literal('timeline'),
  title: z.string().min(1).max(60, {error: 'title > 60 chars'}),
  orientation: z.literal('horizontal').default('horizontal'),
  items: z
    .array(
      z.strictObject({
        label: z.string().min(1).max(LIMITS.timelineLabelChars, {error: `label > ${LIMITS.timelineLabelChars} chars`}),
        detail: z.string().max(LIMITS.timelineDetailChars, {error: `detail > ${LIMITS.timelineDetailChars} chars`}).optional(),
        when: z.string().max(LIMITS.timelineWhenChars, {error: `when > ${LIMITS.timelineWhenChars} chars`}).optional(),
      }),
    )
    .min(LIMITS.timelineItems.min, {error: `items < ${LIMITS.timelineItems.min}`})
    .max(LIMITS.timelineItems.max, {error: `items > ${LIMITS.timelineItems.max}`}),
});

// Outro card (FR-SCN-07): title-style payload plus up to 3 takeaway lines. `sources` may be empty.
export const OutroScene = z.strictObject({
  ...base,
  type: z.literal('outro'),
  headline: z.string().min(1).max(LIMITS.outroHeadline, {error: `headline > ${LIMITS.outroHeadline} chars`}),
  subtitle: z.string().max(LIMITS.outroSubtitle, {error: `subtitle > ${LIMITS.outroSubtitle} chars`}).optional(),
  items: z
    .array(z.string().min(1).max(LIMITS.outroItemChars, {error: `item length > ${LIMITS.outroItemChars} chars`}))
    .max(LIMITS.outroItems, {error: `items > ${LIMITS.outroItems}`})
    .optional(),
});

export const Scene = z.discriminatedUnion('type', [
  TitleScene,
  BulletsScene,
  CodeScene,
  ArchitectureScene,
  SequenceScene,
  TimelineScene,
  OutroScene,
]);

export const Storyboard = z.strictObject({
  version: z.literal(1, {
    error: `unsupported storyboard version; windower ${PLUGIN_VERSION} reads version 1`,
  }),
  slug: z.string().regex(/^[a-z0-9-]{1,48}$/, {error: 'slug must match ^[a-z0-9-]{1,48}$'}),
  title: z.string().min(1).max(80, {error: 'title > 80 chars'}),
  audience: z.enum(['onboarding', 'pr-review', 'stakeholder', 'docs']),
  /** Video mode (length profile); absent means `normal`. */
  mode: z.enum(MODE_IDS).optional(),
  fps: z.literal(30).default(30),
  size: z
    .strictObject({width: z.literal(1920), height: z.literal(1080)})
    .default({width: 1920, height: 1080}),
  repoRoot: z.string().optional(),
  approved: z.boolean().optional(),
  approvedAt: z.string().optional(),
  targetSec: z.number().positive().optional(),
  scenes: z
    .array(Scene)
    .min(LIMITS.scenes.min, {error: `a storyboard needs at least ${LIMITS.scenes.min} scenes`})
    .max(LIMITS.scenes.max, {error: `a storyboard allows at most ${LIMITS.scenes.max} scenes`}),
});

export type Storyboard = z.infer<typeof Storyboard>;
export type StoryboardScene = z.infer<typeof Scene>;
export type SourceRef = z.infer<typeof Source>;
