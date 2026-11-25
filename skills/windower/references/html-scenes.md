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

### Design skill guidance

<!-- PLACEHOLDER: a later step fills this section with the principles of a specific design skill.
     Until then, when writing an html scene in a harness that has the `frontend-design` skill
     installed, consult it for aesthetic direction, typography and avoiding templated defaults,
     and apply it within the rendering contract above (offline, seekable, 1920x1080). -->

Until this section is filled in, use the installed `frontend-design` skill for general visual direction, and keep to the contract above.

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
