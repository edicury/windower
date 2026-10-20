// Storyboard schema (contracts/storyboard-schema.md). Zod is the source of truth; the validator
// (scripts/validate-storyboard.ts) adds cross-scene, referential and duration rules on top.
import {z} from 'zod';

export const PLUGIN_VERSION = '0.1.0';

export const LIMITS = {
  titleHeadline: 90,
  titleSubtitle: 80,
  titleBadge: 24,
  bulletsHeading: 60,
  bulletsItems: {min: 2, max: 5},
  bulletsItemChars: 110,
  codeLines: 16,
  codeLineChars: 100,
  narrationWords: {min: 8, max: 60},
  scenes: {min: 3, max: 14},
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

// Prototype scenes: kept working in phase 1, reshaped and limited in phase 2.
export const CodeScene = z
  .strictObject({
    ...base,
    type: z.literal('code'),
    title: z.string().min(1),
    file: z.string().min(1),
    language: z.string().optional(),
    startLine: z.number().int().min(1),
    endLine: z.number().int().min(1),
    focus: z.array(z.tuple([z.number().int(), z.number().int()])).optional(),
  })
  .refine((s) => s.endLine < s.startLine || s.endLine - s.startLine + 1 <= LIMITS.codeLines, {
    path: ['endLine'],
    error: `lines > ${LIMITS.codeLines}`,
  });

export const ArchitectureScene = z.strictObject({
  ...base,
  type: z.literal('architecture'),
  title: z.string().min(1),
  nodes: z
    .array(
      z.strictObject({
        id: z.string().min(1),
        label: z.string().min(1),
        sub: z.string().optional(),
        x: z.number(),
        y: z.number(),
        tone: z.enum(['green', 'violet']).optional(),
      }),
    )
    .min(1),
  edges: z
    .array(z.strictObject({from: z.string(), to: z.string(), label: z.string().optional()}))
    .min(1),
});

export const SequenceScene = z.strictObject({
  ...base,
  type: z.literal('sequence'),
  title: z.string().min(1),
  participants: z.array(z.string().min(1)).min(2),
  messages: z
    .array(
      z.strictObject({
        from: z.number().int(),
        to: z.number().int(),
        text: z.string(),
        note: z.string().optional(),
      }),
    )
    .min(1),
});

export const Scene = z.discriminatedUnion('type', [
  TitleScene,
  BulletsScene,
  CodeScene,
  ArchitectureScene,
  SequenceScene,
]);

export const Storyboard = z.strictObject({
  version: z.literal(1, {
    error: `unsupported storyboard version; windower ${PLUGIN_VERSION} reads version 1`,
  }),
  slug: z.string().regex(/^[a-z0-9-]{1,48}$/, {error: 'slug must match ^[a-z0-9-]{1,48}$'}),
  title: z.string().min(1).max(80, {error: 'title > 80 chars'}),
  audience: z.enum(['onboarding', 'pr-review', 'stakeholder', 'docs']),
  fps: z.literal(30).default(30),
  size: z
    .strictObject({width: z.literal(1920), height: z.literal(1080)})
    .default({width: 1920, height: 1080}),
  repoRoot: z.string().optional(),
  approved: z.boolean().optional(),
  targetSec: z.number().positive().optional(),
  scenes: z
    .array(Scene)
    .min(LIMITS.scenes.min, {error: `a storyboard needs at least ${LIMITS.scenes.min} scenes`})
    .max(LIMITS.scenes.max, {error: `a storyboard allows at most ${LIMITS.scenes.max} scenes`}),
});

export type Storyboard = z.infer<typeof Storyboard>;
export type StoryboardScene = z.infer<typeof Scene>;
export type SourceRef = z.infer<typeof Source>;
