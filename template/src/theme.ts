export const theme = {
  bg: 'var(--ve-bg, #0b1020)',
  panel: 'var(--ve-panel, #131a33)',
  border: 'var(--ve-border, #27315a)',
  text: 'var(--ve-text, #e8ecff)',
  muted: 'var(--ve-muted, #98a2cf)',
  accent: 'var(--ve-accent, #6ea8ff)',
  green: '#4ade80',
  /** Brand accent for the outro bar (falls back to green). */
  accent2: 'var(--ve-accent2, #4ade80)',
  violet: '#a78bfa',
  amber: '#fbbf24',
  font: 'var(--ve-font, Inter, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif)',
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
