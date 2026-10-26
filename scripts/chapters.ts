// Chapters: optional `chapter` label on scenes; consecutive scenes sharing a label form a chapter.
export interface ChapterGroup {
  label: string;
  /** Scene indexes, in order. */
  indexes: number[];
}

/** Groups consecutive scenes by label. Scenes without a label end the current chapter and are skipped. */
export function groupChapters(labels: (string | undefined)[]): ChapterGroup[] {
  const out: ChapterGroup[] = [];
  let cur: ChapterGroup | null = null;
  labels.forEach((l, i) => {
    if (!l) {
      cur = null;
      return;
    }
    if (cur && cur.label === l) cur.indexes.push(i);
    else {
      cur = {label: l, indexes: [i]};
      out.push(cur);
    }
  });
  return out;
}

/** Labels that appear in more than one separate run (non-contiguous). */
export function splitChapters(labels: (string | undefined)[]): string[] {
  const seen = new Set<string>();
  const split = new Set<string>();
  for (const g of groupChapters(labels)) {
    if (seen.has(g.label)) split.add(g.label);
    seen.add(g.label);
  }
  return [...split];
}

/** Videos over this many seconds get a render-size note and (deep, no chapters) a chapters hint. */
export const CHAPTER_HINT_S = 150;
