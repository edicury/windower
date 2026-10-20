// Brand theming (FR-CFG, US-07). Brand colors become CSS custom properties on the root; theme.ts
// reads them with the built-in palette as fallback, so a run without brand renders unchanged.
export type Brand = {
  primary: string;
  background: string;
  accent?: string;
  text?: string;
  /** Safe family name; rendered as `"<font>", <system stack>`, never fetched from the network. */
  font?: string;
  /** data: URI (svg or png) embedded by prepare. */
  logo?: string;
};

export const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
export const SAFE_FONT = /^[A-Za-z0-9][A-Za-z0-9 -]{0,63}$/;
export const SYSTEM_STACK = '-apple-system, "Segoe UI", Helvetica, Arial, sans-serif';
export const DEFAULT_TEXT = '#e8ecff';
export const DEFAULT_BG = '#0b1020';

export const toRgb = (hex: string): [number, number, number] => {
  const h = hex.slice(1);
  const f = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16)) as [number, number, number];
};

const toHex = (rgb: number[]): string =>
  '#' + rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

/** `amount` of b mixed into a. */
export const mix = (a: string, b: string, amount: number): string => {
  const x = toRgb(a);
  const y = toRgb(b);
  return toHex(x.map((v, i) => v + ((y[i] ?? 0) - v) * amount));
};

const lum = (hex: string): number => {
  const [r, g, b] = toRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** WCAG contrast ratio, 1..21. */
export const contrastRatio = (a: string, b: string): number => {
  const [hi, lo] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

/** CSS custom properties for a brand; empty object when no brand. */
export const brandVars = (brand?: Brand): Record<string, string> => {
  if (!brand) return {};
  const text = brand.text ?? DEFAULT_TEXT;
  const bg = brand.background;
  const vars: Record<string, string> = {
    '--ve-bg': bg,
    '--ve-text': text,
    '--ve-accent': brand.primary,
    '--ve-panel': mix(bg, text, 0.08),
    '--ve-border': mix(bg, text, 0.2),
    '--ve-muted': mix(bg, text, 0.65),
    '--ve-capbg': `${mix(bg, text, 0.1)}f0`,
  };
  if (brand.accent) vars['--ve-accent2'] = brand.accent;
  if (brand.font) vars['--ve-font'] = `"${brand.font}", ${SYSTEM_STACK}`;
  return vars;
};
