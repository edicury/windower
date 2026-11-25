// Shared rules for the `html` scene payload (schema, validator, prepare). Dependency-free.
// Pages render in a sandboxed iframe with no scripts and no network, so the lint mostly reports
// what would silently not work, and what would make a frame depend on wall-clock time.

export type HtmlProblem = {severity: 'error' | 'warning'; message: string};

const NAMESPACE = /\b(?:xmlns(?::\w+)?)\s*=\s*["'][^"']*["']/gi;
const SVG_NS = /https?:\/\/www\.w3\.org\/\d{4}\/[\w-]+/g;

/** Strips comments so commented-out code is not linted. */
const stripComments = (s: string) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

/** Lints an HTML page; errors block validation, warnings are advisory. */
export function htmlProblems(html: string): HtmlProblem[] {
  const out: HtmlProblem[] = [];
  const err = (message: string) => out.push({severity: 'error', message});
  const warn = (message: string) => out.push({severity: 'warning', message});
  const src = stripComments(html).replace(NAMESPACE, '').replace(SVG_NS, '');

  if (/<script\b[^>]*\bsrc\s*=/i.test(src)) err('<script src> is not allowed; pages cannot load scripts (remote or local)');
  else if (/<script\b/i.test(src)) warn('inline <script> never runs (the page is sandboxed); drive motion with CSS animations or --t/--p');
  if (/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\b/.test(src)) err('network APIs (fetch, XMLHttpRequest, WebSocket) are not allowed; the page is rendered offline');
  if (/@import\b/i.test(src)) err('@import is not allowed; inline the CSS in a <style> block');
  if (/https?:\/\//i.test(src) || /(?:src|href|url\()\s*=?\s*["']?\/\//i.test(src))
    err('remote URLs are not allowed (images, fonts, stylesheets, links); embed assets as data: URIs');
  if (/<link\b/i.test(src)) err('<link> is not allowed; put styles in a <style> block and embed assets as data: URIs');
  if (/<(?:iframe|object|embed|base|video|audio|source|track)\b/i.test(src)) err('<iframe>, <object>, <embed>, <base>, <video> and <audio> are not allowed in an html scene');
  if (/<meta\b[^>]*http-equiv/i.test(src)) err('<meta http-equiv> (refresh, CSP) is not allowed');
  for (const m of src.matchAll(/\b(?:src|href|poster)\s*=\s*["']([^"']*)["']/gi)) {
    const v = (m[1] ?? '').trim();
    if (v && !v.startsWith('data:') && !v.startsWith('#')) {
      err(`asset "${v.slice(0, 40)}" cannot load; only data: URIs and #fragment links work`);
      break;
    }
  }
  for (const m of src.matchAll(/url\(\s*(["']?)([^)"']*)\1\s*\)/gi)) {
    const v = (m[2] ?? '').trim();
    if (v && !v.startsWith('data:') && !v.startsWith('#')) {
      err(`CSS url("${v.slice(0, 40)}") cannot load; only data: URIs work`);
      break;
    }
  }
  if (/\b(?:Date\.now|new Date|performance\.now|requestAnimationFrame|setTimeout|setInterval|Math\.random)\b/.test(src))
    err('wall-clock or random sources (Date, performance.now, requestAnimationFrame, setTimeout, Math.random) make frames non-deterministic; use CSS animations, --t and --p');
  if (/<canvas\b/i.test(src)) err('<canvas> needs scripts and is not allowed; use HTML, CSS and inline SVG');
  if (/\btransition\s*:/i.test(src) && !/animation|@keyframes|var\(--[tp]\)/i.test(src))
    warn('CSS transitions are disabled in rendering; use @keyframes animations or --t/--p');
  if (!/@keyframes|\banimation(?:-name)?\s*:|var\(--[tp]\)|\.animate\(|\bw-(?:reveal|rise|fade|pop|draw|stagger)/i.test(src))
    warn('page has no animation; reveal elements over time with the w-* kit classes, @keyframes, or --t/--p so the scene is not a static slide');
  for (const m of src.matchAll(/font-size\s*:\s*(\d+(?:\.\d+)?)px/gi)) {
    if (Number(m[1]) < 28) {
      warn(`font-size ${m[1]}px is below the 28px readability floor for video`);
      break;
    }
  }
  return out;
}
