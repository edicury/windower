// Video modes: one profile per mode drives length targets, scene counts and warnings.
// Exploration is deliberately not part of a mode; every mode researches the same way.
export const MODE_IDS = ['quick', 'normal', 'deep'] as const;
export type Mode = (typeof MODE_IDS)[number];
export const DEFAULT_MODE: Mode = 'normal';

export interface ModeProfile {
  id: Mode;
  /** Seconds. Outside `target` is a warning. */
  target: readonly [number, number];
  /** Seconds. Outside `hard` is an error. */
  hard: readonly [number, number];
  scenes: {min: number; max: number};
  /** Per-scene soft cap in seconds. */
  sceneCapS: number;
  /** Deep runs warn about API credit use when narration is voiced. */
  voiceWarn: boolean;
  /** Narration word budget the author writes to (about target midpoint x WORDS_PER_SECOND, less pad). */
  wordBudget: readonly [number, number];
}

export const MODES: Record<Mode, ModeProfile> = {
  quick: {
    id: 'quick',
    target: [25, 35],
    hard: [20, 45],
    scenes: {min: 3, max: 5},
    sceneCapS: 10,
    voiceWarn: false,
    wordBudget: [60, 90],
  },
  normal: {
    id: 'normal',
    target: [70, 90],
    hard: [55, 110],
    scenes: {min: 6, max: 10},
    sceneCapS: 20,
    voiceWarn: false,
    wordBudget: [180, 240],
  },
  deep: {
    id: 'deep',
    target: [120, 360],
    hard: [90, 600],
    scenes: {min: 10, max: 40},
    sceneCapS: 25,
    voiceWarn: true,
    wordBudget: [330, 1000],
  },
};

export const isMode = (v: unknown): v is Mode =>
  typeof v === 'string' && (MODE_IDS as readonly string[]).includes(v);

export const profileOf = (mode: Mode | undefined): ModeProfile => MODES[mode ?? DEFAULT_MODE];
