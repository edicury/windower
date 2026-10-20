export const theme = {
  bg: '#0b1020',
  panel: '#131a33',
  border: '#27315a',
  text: '#e8ecff',
  muted: '#98a2cf',
  accent: '#6ea8ff',
  green: '#4ade80',
  violet: '#a78bfa',
  amber: '#fbbf24',
  font: 'Inter, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif',
  mono: '"JetBrains Mono", "SF Mono", Menlo, Consolas, monospace',
};
export const FPS = 30;
export const TRANSITION_FRAMES = 12;

// Layout tokens at 1080p (FR-SCN-09). Content must end above the captions bar.
export const SAFE = {
  x: 120,
  top: 80,
  /** Scene content ends above this y; the burned-in captions bar lives below it. */
  contentBottom: 940,
  captionsBottom: 56,
};
/** Minimum font size for scene text (code scenes may shrink to CODE_FONT_FLOOR). */
export const FONT_FLOOR = 28;
export const CODE_FONT_FLOOR = 24;
