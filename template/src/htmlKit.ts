// Motion/theme kit for `html` scenes. Pure strings, no imports: used by the Html scene and tests.
//
// Time contract: the renderer sets `--t` (seconds into the scene) and `--p` (0..1 progress) on
// <html> for every frame and seeks every Web Animation / CSS animation (document.getAnimations())
// to `--t`. Pages must therefore animate with CSS @keyframes (or `animation` classes from this
// kit) and may read `--t` / `--p` in calc(); they must not use wall-clock time.

export const KIT_ID = 'windower-kit';

/** Theme variables (name -> fallback). The Html scene overwrites them from the run's brand. */
export const KIT_THEME_VARS = {
  '--w-bg': '#0b1020',
  '--w-panel': '#131a33',
  '--w-border': '#27315a',
  '--w-text': '#e8ecff',
  '--w-muted': '#98a2cf',
  '--w-accent': '#6ea8ff',
  '--w-accent2': '#4ade80',
  '--w-font': 'Inter, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif',
} as const;

/** Maps kit variables to the composition's `--ve-*` brand variables read at render time. */
export const KIT_BRAND_MAP: Record<keyof typeof KIT_THEME_VARS, string> = {
  '--w-bg': '--ve-bg',
  '--w-panel': '--ve-panel',
  '--w-border': '--ve-border',
  '--w-text': '--ve-text',
  '--w-muted': '--ve-muted',
  '--w-accent': '--ve-accent',
  '--w-accent2': '--ve-accent2',
  '--w-font': '--ve-font',
};

const stagger = Array.from(
  {length: 12},
  (_, i) => `.w-stagger>:nth-child(${i + 1}){animation-delay:calc((var(--d,0) + ${i} * var(--gap,.18)) * 1s)}`,
).join('');

export const KIT_CSS = `
:root{${Object.entries(KIT_THEME_VARS).map(([k, v]) => `${k}:${v}`).join(';')};--t:0;--p:0;--w-mono:"JetBrains Mono","SF Mono",Menlo,Consolas,monospace}
*,*::before,*::after{box-sizing:border-box;transition:none!important}
html,body{margin:0;padding:0;width:1920px;height:1080px;overflow:hidden;background:var(--w-bg);color:var(--w-text);font-family:var(--w-font);-webkit-font-smoothing:antialiased}
.w-stage{position:absolute;inset:0;padding:96px 120px 150px;display:flex;flex-direction:column;justify-content:center;gap:32px}
.w-eyebrow{font-size:30px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--w-accent)}
.w-h1{font-size:92px;line-height:1.05;font-weight:800;letter-spacing:-.02em;margin:0;text-wrap:balance}
.w-h2{font-size:56px;line-height:1.12;font-weight:700;letter-spacing:-.01em;margin:0;text-wrap:balance}
.w-lead{font-size:40px;line-height:1.35;color:var(--w-muted);margin:0;max-width:1400px}
.w-body{font-size:34px;line-height:1.4;margin:0}
.w-muted{color:var(--w-muted)}.w-accent{color:var(--w-accent)}.w-mono{font-family:var(--w-mono)}
.w-row{display:flex;gap:40px;align-items:stretch}.w-col{display:flex;flex-direction:column;gap:24px}
.w-grid{display:grid;gap:32px}.w-grid-2{grid-template-columns:repeat(2,1fr)}.w-grid-3{grid-template-columns:repeat(3,1fr)}
.w-card{background:var(--w-panel);border:2px solid var(--w-border);border-radius:24px;padding:36px 40px}
.w-rule{height:8px;width:120px;border-radius:4px;background:var(--w-accent)}
.w-kpi{font-size:120px;font-weight:800;line-height:1;letter-spacing:-.03em;color:var(--w-accent)}
.w-bar{height:20px;border-radius:10px;background:var(--w-accent);transform-origin:left center}
@keyframes w-rise{from{opacity:0;transform:translateY(32px)}to{opacity:1;transform:none}}
@keyframes w-fade{from{opacity:0}to{opacity:1}}
@keyframes w-pop{from{opacity:0;transform:scale(.92)}to{opacity:1;transform:none}}
@keyframes w-slide{from{opacity:0;transform:translateX(-48px)}to{opacity:1;transform:none}}
@keyframes w-grow{from{transform:scaleX(0)}to{transform:scaleX(1)}}
@keyframes w-draw{from{stroke-dashoffset:1}to{stroke-dashoffset:0}}
.w-reveal,.w-rise,.w-fade,.w-pop,.w-slide,.w-grow,.w-draw{animation-duration:calc(var(--dur,.7) * 1s);animation-delay:calc(var(--d,0) * 1s);animation-fill-mode:both;animation-timing-function:cubic-bezier(.2,.7,.2,1)}
.w-reveal,.w-rise{animation-name:w-rise}.w-fade{animation-name:w-fade}.w-pop{animation-name:w-pop}.w-slide{animation-name:w-slide}.w-grow{animation-name:w-grow}
.w-draw{animation-name:w-draw;stroke-dasharray:1;stroke-dashoffset:1}
${stagger}
`.trim();

/** CSP that makes the page offline and inert: no scripts, no network, data: assets only. */
export const KIT_CSP =
  "default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; media-src 'none'; connect-src 'none'; form-action 'none'";

/** Wraps a fragment or a full document with charset, CSP and the kit (kit first so author CSS wins). */
export function buildSrcdoc(html: string): string {
  const head = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${KIT_CSP}"><style id="${KIT_ID}">${KIT_CSS}</style>`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => `${m}${head}`);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => `${m}<head>${head}</head>`);
  return `<!doctype html><html><head>${head}</head><body>${html}</body></html>`;
}
