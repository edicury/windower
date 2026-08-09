## Phase 15 — Post-Processing (v1.1)

**Goal:** Build the Screen Studio-signature visual polish — click ripples, cursor highlight, auto-zoom-on-click, trim, background/padding/rounded corners, gif/webm export — as a post-process consuming the MVP's `EventTimeline` (Phase 10) and finalized video/manifest. Not built in MVP; specced now so the timeline data model doesn't need to change later.

- 🔵 `packages/post-process` — new package, operates on an existing `manifest.json` + `.events.json` + video file, produces a new derived output (does not mutate the original recording).
- 🔵 Auto-zoom-on-click: read `mouse_down` events from the timeline, render a smooth zoom/pan toward the click coordinate over a configurable window, hold, zoom back out — likely implemented via `ffmpeg` filter graphs (`zoompan`) driven by a generated keyframe list from the timeline, or a custom frame-by-frame compositor if `ffmpeg` proves insufficiently controllable.
- 🔵 Click ripple / cursor highlight overlay: compositing pass drawing a ripple/halo at each `mouse_down` timestamp+coordinate.
- 🔵 Trim: start/end offset trimming, re-mux without re-encoding where possible.
- 🔵 Background/padding/rounded corners: for window recordings, composite onto a configurable background canvas with padding and corner radius — mirrors Screen Studio's signature look.
- 🔵 Export targets: gif and webm in addition to the MVP's mp4/mov, with size/quality trade-off presets.
- 🔵 Interface surface: new `windower post-process <manifestPath> [options]` CLI command + corresponding MCP tool + CLI/MCP additions to the existing contracts (extend `contracts/cli.md` / `contracts/mcp-tools.md` at implementation time — not modified now to keep MVP contracts frozen).

**Exit criteria**

- Given an MVP-produced recording + event timeline, auto-zoom and click-ripple rendering produce a visually correct, smooth result on representative demo footage.
- Trim, background/padding, and gif/webm export each verified against `ffprobe`/visual playback.
- No changes required to `packages/core`'s MVP schemas (`EventTimeline`, `OutputManifest`) to support this phase — confirms the Phase 10/12 design held up.
