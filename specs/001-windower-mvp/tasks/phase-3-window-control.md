## Phase 3 — Window Control

**Goal:** Implement `resizeWindow` so an agent can size a target window to exact pixel dimensions before recording — the MVP's headline "agent specifies sizes" feature.

- 🔵 AXUIElement lookup for a given `targetId` (map `CGWindowID` → owning `pid` → `AXUIElementCreateApplication` → matching `AXUIElement` window by title/position heuristic, since AX has no direct `CGWindowID` lookup).
- 🔵 Pixel↔point conversion using the target's `NSScreen.backingScaleFactor` (see `research.md` §3) — public API is pixels, AX calls are points.
- 🔵 Multi-display global coordinate space handling — correct positioning when the target is on a secondary/negative-origin display.
- 🔵 `kAXResizable` pre-check → return `RESIZE_UNSUPPORTED` immediately for non-resizable windows instead of attempting a no-op write.
- 🔵 Set `kAXPositionAttribute`/`kAXSizeAttribute`, then **read back** the actual resulting frame and report `result: "success"|"partial"` based on whether it matches the request within a small epsilon.
- 🔵 `resizeWindow` wired into the sidecar's method table; `packages/core` client method + Zod validation.

**Exit criteria**

- Matches `spec.md` acceptance item verbatim: `windower resize --window <id> --width 1280 --height 720` moves and resizes a real window to those exact dimensions, verified via read-back — tested against at least 3 real apps (e.g. Safari, Terminal, a non-resizable utility dialog to confirm the `unsupported` path).
- Retina-display test: request 1280x720 pixels on a Retina display, confirm the resulting window's pixel bounds (not points) match.
- Secondary-display test: resize a window living on a non-primary display with negative coordinate offset, confirm correct absolute placement.
