## Phase 18 — Marketing Media (dogfood recordings for windower-site)

**Goal:** Use Windower itself (local dev build, not the published npm packages — Phase 14's sidecar-binary publish is still blocked on Apple Developer ID provisioning) to produce the real demo video + terminal recordings that `~/Documents/Development/windower-site` currently only has placeholders for, and wire them into the site.

**Context / why now:** Phase 14 (Packaging) is blocked on Apple Developer ID codesigning credentials being provisioned — see `phase-14-packaging.md`'s "Publish status" section. Rather than idle, this phase does non-blocking dogfooding work: Windower recording itself/its own CLI to fill known media gaps on the marketing site. No dependency on Phase 14 finishing — recording is done from a local dev sidecar build (`native/macos/.build/debug/...`), exactly like every other phase's manual verification pass.

**Known gaps in windower-site** (confirmed by inspection, 2026-08-09):
- `src/components/DemoSlot.tsx` — explicit, load-bearing placeholder (`[ DEMO VIDEO ]`, hint text "drop a 16:9 screen capture of an agent-driven session here"). CSS (`src/App.css` `.demo-placeholder*`) already assumes `aspect-ratio: 16/9`. README.md line 28 confirms this is the one real placeholder in the repo.
- No `public/images|videos|demos` directories exist yet — `public/` currently has only `favicon.svg`. Real assets need to be added there (Vite static-asset convention, root-relative `/path` references).
- `src/data.ts`'s fake CLI-output filenames (`{app-or-context}-{topic}-{date:YYYY-MM-DD}.mp4`, e.g. `safari-pricing-2026-08-09.mp4`) are simulated flavor text inside `Terminal.tsx`/`CliExplorer.tsx` mocks, not real broken links — leave them as-is, they're not in this phase's scope.

**Tasks**

- 🔵 Record the hero demo: an agent-driven Windower session (per DemoSlot's own hint — "an agent-driven session", consistent with the product's AI-native positioning) — use the Phase 9 Claude Code skill's record-a-demo flow (`check_permissions` → `list_targets` → `start_recording` → agent performs a real, presentable action on screen → `stop_recording`) against a local dev sidecar build. Subject: something visually representative of the product (e.g. an agent using the `windower` CLI/MCP tools to record a browser demo, or driving a real coding task) — pick something that reads well muted and looping, not just a terminal scroll.
- 🔵 Record supporting terminal-only footage of the `windower` CLI itself (`targets`, `doctor`, `start`/`stop`, `list`) — useful either as a second embed or as reference footage for `CliExplorer`'s copy/pacing, even if not directly embedded.
- 🔵 Post-process the raw capture into what `DemoSlot.tsx` needs: trimmed to a tight, loop-friendly duration, 16:9, muted-safe (no reliance on audio), plus one extracted poster-frame still image. Phase 15 (Post-Processing) doesn't exist yet, so do this step manually via `ffmpeg`/QuickTime, not via a `windower post-process` command — that command is out of scope until Phase 15 is actually built.
- 🔵 Drop the finished files into `windower-site/public/` (e.g. `public/demo.mp4` + `public/demo-poster.jpg` — exact names TBD at implementation time, follow whatever `DemoSlot.tsx` ends up wired to) and update `DemoSlot.tsx` to render a real `<video muted loop playsInline poster="...">` in place of the placeholder `<div>`, per README.md's own stated plan.
- 🔵 Remove/update the now-stale "placeholder" note in `windower-site/README.md` once real media is wired in.
- 🔵 Visually verify in a real browser (dev server) that the video renders, loops, and matches the `.demo-placeholder`'s existing `aspect-ratio: 16/9` sizing without layout shift.

**Explicitly out of scope for this phase**

- Any `packages/post-process` / Phase 15 tooling — this phase produces media by hand with off-the-shelf tools, it does not build the post-processing pipeline.
- Publishing/codesigning work — unrelated, tracked entirely under Phase 14.
- Redesigning `DemoSlot.tsx`/site layout beyond swapping the placeholder for a real `<video>` — no scope creep into broader site redesign.

**Exit criteria**

- `windower-site`'s `DemoSlot.tsx` renders a real, muted, looping demo video with a poster frame — no more `[ DEMO VIDEO ]` placeholder.
- The video is a real Windower-recorded capture (dogfooded via the CLI/MCP/skill path, not screen-recorded some other way), demonstrating the project's own "record yourself demoing your own product" capability.
- `windower-site/README.md`'s placeholder note is removed/updated to reflect real media being in place.
- No changes made to `packages/post-process`, Phase 15's spec, or Phase 14's packaging/publish state as part of this phase.
