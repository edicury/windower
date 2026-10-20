// Grid layout for architecture scenes (ADR-03: deterministic grid helper instead of elkjs).
// Pure functions, no React: the renderer and the validator both import this file.
export const NODE_W = 440;
export const NODE_H = 130;
/** Column left edges for a 3-column grid (column gap 180 px >= 150 px). */
export const COL_X_3 = [120, 740, 1360] as const;
/** Column left edges when only two columns are needed (centred, same 180 px gap). */
export const COL_X_2 = [430, 1050] as const;
export const MAX_COLS = 3;
/** Row tops by row count; the last node row ends at y 870, above the captions bar (y ~ 940). */
const ROW_Y: Record<number, readonly number[]> = {
  1: [470],
  2: [335, 605],
  3: [200, 470, 740],
};
/** Edge label box beside horizontal edges: the 180 px gap minus a margin on both sides. */
export const H_LABEL_W = 168;
export const LABEL_FONT = 28;
export const LABEL_LINE = 34;
export const MAX_H_LABEL_LINES = 3;

export interface Cell {
  col: number;
  row: number;
}
export interface Placed extends Cell {
  id: string;
  x: number;
  y: number;
}

/** Number of columns used for `n` nodes: 2 -> 2, 3 -> 3, 4 -> 2 (2x2), 5..9 -> 3. */
export function columnsFor(n: number): number {
  if (n <= 2) return 2;
  if (n === 4) return 2;
  return MAX_COLS;
}

/** Places nodes row-major on the grid. Returns an id -> placement map. */
export function layoutGrid(ids: readonly string[]): Map<string, Placed> {
  const n = ids.length;
  const cols = columnsFor(n);
  const rows = Math.min(3, Math.max(1, Math.ceil(n / cols)));
  const xs = cols === 2 ? COL_X_2 : COL_X_3;
  const ys = ROW_Y[rows] ?? ROW_Y[3]!;
  const out = new Map<string, Placed>();
  ids.forEach((id, i) => {
    const col = i % cols;
    const row = Math.min(rows - 1, Math.floor(i / cols));
    out.set(id, {id, col, row, x: xs[col] ?? xs[0]!, y: ys[row] ?? ys[0]!});
  });
  return out;
}

/** Two cells are adjacent when they share a side (orthogonal neighbours). */
export function adjacent(a: Cell, b: Cell): boolean {
  return Math.abs(a.col - b.col) + Math.abs(a.row - b.row) === 1;
}

/** Greedy word wrap by character count; words longer than `max` are split. */
export function wrapText(text: string, max: number): string[] {
  const lines: string[] = [];
  let cur = '';
  for (let word of text.split(/\s+/).filter(Boolean)) {
    while (word.length > max) {
      if (cur) {
        lines.push(cur);
        cur = '';
      }
      lines.push(word.slice(0, max));
      word = word.slice(max);
    }
    if (!cur) cur = word;
    else if (cur.length + 1 + word.length <= max) cur += ` ${word}`;
    else {
      lines.push(cur);
      cur = word;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Characters of the label font that fit in the horizontal-edge label box (0.56 em average advance). */
export const H_LABEL_CHARS = Math.floor(H_LABEL_W / (LABEL_FONT * 0.56));

/** Wrapped lines an edge label needs beside a horizontal edge. */
export const hLabelLines = (label: string): string[] => wrapText(label, H_LABEL_CHARS);

export interface Point {
  x: number;
  y: number;
}
export interface Route {
  /** Polyline from the source side to the target side (arrow tip at the last point). */
  points: Point[];
  /** True when the straight segment between facing sides crosses no node box. */
  clear: boolean;
  horizontal: boolean;
}

const PAD = 6;

/**
 * Route for an edge between two placements. Adjacent nodes get a straight segment between the facing
 * sides (the 180 px / 140 px gaps contain no node, so it can be drawn above the boxes). `lane` shifts
 * parallel edges between the same pair by +-16 px. Non-adjacent pairs (rejected by the validator)
 * fall back to a centre-to-centre segment flagged `clear: false`, to be drawn under the boxes.
 */
export function routeEdge(a: Placed, b: Placed, lane = 0): Route {
  const off = lane * 16;
  if (adjacent(a, b)) {
    if (a.row === b.row) {
      const y = a.y + NODE_H / 2 + off;
      const right = b.col > a.col;
      const x1 = right ? a.x + NODE_W + PAD : a.x - PAD;
      const x2 = right ? b.x - PAD : b.x + NODE_W + PAD;
      return {points: [{x: x1, y}, {x: x2, y}], clear: true, horizontal: true};
    }
    const x = a.x + NODE_W / 2 + off;
    const down = b.row > a.row;
    const y1 = down ? a.y + NODE_H + PAD : a.y - PAD;
    const y2 = down ? b.y - PAD : b.y + NODE_H + PAD;
    return {points: [{x, y: y1}, {x, y: y2}], clear: true, horizontal: false};
  }
  return {
    points: [
      {x: a.x + NODE_W / 2, y: a.y + NODE_H / 2},
      {x: b.x + NODE_W / 2, y: b.y + NODE_H / 2},
    ],
    clear: false,
    horizontal: a.row === b.row,
  };
}

/** Auto-fit font size for a node label: 38 px max, 30 px floor, inside the 396 px text width. */
export const labelFont = (label: string): number =>
  Math.max(30, Math.min(38, Math.floor(396 / (0.6 * Math.max(1, label.length)))));
