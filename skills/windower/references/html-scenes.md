# HTML scenes

An `html` scene shows a designed page (a fixed 1920x1080 canvas) instead of one of the built-in layouts, narrated by the usual TTS. Use it when a point is best shown as a composed page: a metrics card, a before/after, a comparison, a diagram that `architecture` cannot express. Prefer the built-in scenes for code, plain lists and sequences; they are cheaper and already validated for layout.

```json
{
  "id": "s04",
  "type": "html",
  "title": "Latency before and after",
  "html": "<main class=\"w-stage\">...</main>",
  "narration": "...",
  "sources": [{"kind": "file", "ref": "src/cache.ts:10-40"}]
}
```

Give either `html` (inline string, <= 60000 chars) or `file` (path to a `.html` file relative to the storyboard directory, inside it; prepare inlines it). `title` (<= 60) is an optional accessible label. Narration, sources, `transition`, `minDurationSec` and `chapter` work as on every scene. Pages can be a fragment or a full document.

## The rendering contract

The page runs in a sandboxed iframe with no scripts, no network and a strict CSP. Anything not in the page itself does not exist.

- Assets must be `data:` URIs (images, SVG, fonts). No `http(s)` or `//` URLs, no `<link>`, no `@import`, no remote web fonts, no relative file paths. Prefer inline SVG.
- No `<script>` (inert), `fetch`/XHR, `<canvas>`, `<video>`, `<audio>`, `<iframe>`, `<meta http-equiv>`.
- Time is injected, never read. Every frame the renderer sets CSS variables on `<html>` and seeks every animation to the same instant:
  - `--t`: seconds into the scene; `--p`: progress 0..1.
  - All CSS animations and Web Animations are paused and seeked to `--t`. Animate with `@keyframes` (use `animation-delay` for sequencing, `animation-fill-mode: both`) or compute from `--t`/`--p` in `calc()`, for example `width: calc(var(--p) * 100%)`.
  - CSS `transition` is disabled. Do not use wall-clock or random sources (`Date`, `performance.now`, `requestAnimationFrame`, `setTimeout`, `Math.random`); the validator rejects them.
- Content must stay above the captions bar: keep the bottom 140 px clear (`.w-stage` already does) and side margins at 120 px.

The validator reports errors for the above, and warnings for a page with no animation and for `font-size` below 28 px.

## Theme and motion kit

Every page gets a kit injected first, so your CSS overrides it. Theme variables follow the run's brand (`.windower.json`) and default to the built-in dark theme: `--w-bg`, `--w-panel`, `--w-border`, `--w-text`, `--w-muted`, `--w-accent`, `--w-accent2`, `--w-font`, `--w-mono`. Use them instead of hard-coded colors so branded runs restyle automatically.

Layout and type: `.w-stage` (padded full canvas, vertical flex, safe above captions), `.w-eyebrow`, `.w-h1`, `.w-h2`, `.w-lead`, `.w-body`, `.w-muted`, `.w-accent`, `.w-mono`, `.w-row`, `.w-col`, `.w-grid` with `.w-grid-2`/`.w-grid-3`, `.w-card`, `.w-rule`, `.w-kpi`, `.w-bar`.

Motion (seekable): `.w-reveal` (rise and fade in), `.w-fade`, `.w-pop`, `.w-slide`, `.w-grow` (scaleX from the left), `.w-draw` (SVG stroke draw; give the path `pathLength="1"`). Tune with `--d` (delay in seconds, unitless number) and `--dur` (seconds). `.w-stagger` on a parent delays its first 12 children by `--gap` (default .18) each, starting at `--d`.

Time the reveals to the narration: about 2.9 words per second, so a point spoken at word 20 appears near `--d: 7`.

## Design guidance

- One idea per page. A headline, one supporting visual or 3 or fewer cards. If it needs a paragraph, use `bullets`.
- Typography: one family (the kit font), at most three sizes, large. Headline 56-92 px, body 34 px or more, never below 28 px. Tight tracking on big type, generous line-height on body. Left-align text; center only a lone statement.
- Layout: a clear grid, 120 px side margins, consistent 24-40 px gaps, generous negative space. Align to the grid; avoid stacked boxes with the same weight.
- Color: neutral surface plus one accent (`--w-accent`), a second accent only to mark a contrast (before/after). Keep text contrast at 4.5:1 or better. No gradients for decoration, no drop-shadow stacks.
- Motion: reveal in the order the narration mentions things; ease out, 0.5-0.8 s; one motion idea per page. Nothing should move continuously without a reason; the final 20 frames of a scene should be still (snapshot frames are taken there).
- Data: show the number big (`.w-kpi`) with a short label; compare with two bars of true relative length rather than a chart library.
- Ground it: every figure on the page must come from the brief and be cited in `sources`.

### Design guidance (Astryx)

Source: these values come from the public repo of Astryx, Meta's open-source design system (MIT; https://github.com/meta/astryx, docs https://astryx.atmeta.com), default theme in `packages/core/src/theme/tokens.stylex.ts`. Scenes are inspired by Astryx, not a copy of its components. The official Claude plugin (`claude plugin marketplace add meta/astryx`) is React/CLI oriented, so it is not used here. Always apply the contract above (offline, seekable, 1920x1080) first.

Brand first: when the repo has a brand, the `--w-*` variables already carry it; use them and do not hardcode colors. With no brand, fall back to these Astryx defaults.

- Color (dark video default / light): `--w-bg` #111112 / #F1F4F7; `--w-panel` #1F1F22 / #FFFFFF; `--w-text` #DFE2E5 / #0A1317; `--w-muted` #B0B5BB / #445564; `--w-accent` #0171E3 / #0064E0 (accent text on dark #3E9EFB).
- Status: success rgba(38,167,86), warning rgba(226,164,0), error rgba(227,25,59). Never rely on color alone: pair with an icon, a word ("Passed", "Failed") or a shape.
- Pick foreground and background together: text on `--w-panel` or `--w-bg` only, never on an arbitrary tint. Keep contrast high at video compression.
- Type: system stack (-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif); mono "SF Mono", Monaco, Consolas; weights 400-700.
- Scale: Astryx is a 1.2 ratio (10/12/14/17/20/24/29/35/42 at a 14px base). On the canvas scale by about 2.5x and snap to the kit: `.w-h1` 92, `.w-h2` 56, `.w-lead` 40, `.w-body` 34. Nothing under the 28px lint minimum.
- Distinct type roles: eyebrow, heading, lead, body, mono for code. Do not invent a fifth size; vary weight or `--w-muted` instead.
- Constrain line length: about 60 characters (`max-width` near 1400px for lead, narrower for body). Short lines, one idea per line.
- One primary emphasis per group: a single `.w-kpi`, accent word or accent card per cluster. Everything else stays quiet (`--w-text` or `--w-muted`).
- Spacing: 4px grid, scaled for video (multiples of 8/16/24/32/40). Equal gaps inside a group, larger gaps between groups.
- Radii: 4/8/12/28/full scale; on the canvas prefer the kit's 24px cards and full-round pills. One radius family per scene.
- Elevation: use an edge OR a shadow as the boundary, not both. `.w-card` already has a border, so add no shadow. If you use a shadow, keep it quiet and drop the border.
- Motion: fast 175ms, medium 410ms, slow 975ms. Entrances ease `cubic-bezier(0.24,1,0.4,1)`, exits `cubic-bezier(0.3,0,0.6,0.6)`. No bounce or overshoot. Motion carries meaning (order of reading, cause and effect), never decoration. Stagger with `.w-stagger`, and keep every animation a seekable CSS animation driven by `--t`.

## Examples

Metric with a growing bar (fragment):

```html
<main class="w-stage">
  <div class="w-eyebrow w-fade">Cache hit rate</div>
  <div class="w-kpi w-pop" style="--d:.3">92%</div>
  <p class="w-lead w-reveal" style="--d:.9">up from 61% after the key change</p>
  <div class="w-bar w-grow" style="--d:1.4;--dur:1.2;width:92%"></div>
</main>
```

Page driven by progress (full document):

```html
<!doctype html>
<html>
  <head>
    <style>
      .meter {
        height: 24px;
        border-radius: 12px;
        background: var(--w-border);
        overflow: hidden;
      }
      .meter i {
        display: block;
        height: 100%;
        width: calc(var(--p) * 100%);
        background: var(--w-accent2);
      }
    </style>
  </head>
  <body>
    <main class="w-stage">
      <h1 class="w-h2 w-reveal">Rollout</h1>
      <div class="meter"><i></i></div>
    </main>
  </body>
</html>
```

Staggered cards: put `.w-stagger` on a `.w-grid` and 2-3 `.w-card` children (see `fixtures/storyboards/html.json`).
