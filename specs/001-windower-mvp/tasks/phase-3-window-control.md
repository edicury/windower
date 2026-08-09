## Phase 3 — Window Control

**Goal:** Implement `resizeWindow` so an agent can size a target window to exact pixel dimensions before recording — the MVP's headline "agent specifies sizes" feature.

- ✅ AXUIElement lookup for a given `targetId` (map `CGWindowID` → owning `pid` → `AXUIElementCreateApplication` → matching `AXUIElement` window by title/position heuristic, since AX has no direct `CGWindowID` lookup).
- ✅ Pixel↔point conversion using the target's `NSScreen.backingScaleFactor` (see `research.md` §3) — public API is pixels, AX calls are points.
- ✅ Multi-display global coordinate space handling — correct positioning when the target is on a secondary/negative-origin display.
- ✅ `kAXResizable` pre-check → return `RESIZE_UNSUPPORTED` immediately for non-resizable windows instead of attempting a no-op write.
- ✅ Set `kAXPositionAttribute`/`kAXSizeAttribute`, then **read back** the actual resulting frame and report `result: "success"|"partial"` based on whether it matches the request within a small epsilon.
- ✅ `resizeWindow` wired into the sidecar's method table; `packages/core` client method + Zod validation.

**Exit criteria**

- Matches `spec.md` acceptance item verbatim: `windower resize --window <id> --width 1280 --height 720` moves and resizes a real window to those exact dimensions, verified via read-back — tested against at least 3 real apps (e.g. Safari, Terminal, a non-resizable utility dialog to confirm the `unsupported` path).
- Retina-display test: request 1280x720 pixels on a Retina display, confirm the resulting window's pixel bounds (not points) match.
- Secondary-display test: resize a window living on a non-primary display with negative coordinate offset, confirm correct absolute placement.

## Sign-off (2026-08-09)

Implemented `WindowControlService.resizeWindow` in `native/macos/Sources/WindowerSidecarCore/WindowControl.swift`: `CGWindowID` → owning pid via `CGWindowListCopyWindowInfo` → `AXUIElementCreateApplication` → best-match `AXUIElement` window (Euclidean position/size distance, exact-title tiebreaker for looser drift) → `AXUIElementIsAttributeSettable` pre-check (throws `RESIZE_UNSUPPORTED` if not settable) → pixels→points via the same `backingScaleFactor` convention as `EnumerationService.mapWindow` (no axis flip — Rect and AX/Quartz share the same global origin) → `AXUIElementSetAttributeValue` for position then size → read-back → points→pixels → epsilon (1.0px) comparison for `"success"`/`"partial"`. `TARGET_NOT_FOUND` thrown when the windowID no longer resolves in `CGWindowListCopyWindowInfo` or no AX window matches. Wired into `main.swift`'s dispatch loop as its own case (split out of the Phase 2 catch-all); `"window-control"` added to `supportedCapabilities`. `packages/core`'s `resizeWindow` client method + Zod schema (`ResizeWindowParamsSchema`/`ResizeWindowResultSchema` in `methods.ts`) already existed from Phase 1 and needed no changes — verified zero diff.

Test coverage: 16 new headless XCTest cases in `WindowControlTests.swift` covering pixel↔point round-trip math (including negative-origin/secondary-display cases), the success/partial epsilon comparison, the `bestMatchIndex` heuristic (exact match, small drift, far-candidate rejection, title tiebreaker, empty input), and params/result wire-shape encode/decode. `swift test`: 27/27 passing. `pnpm build` + `pnpm turbo run test`: 12/12 tasks passing, TS side untouched.

**Not verified in this sandbox** (no interactive GUI/TCC/Accessibility grant available here, consistent with how Phase 2 flagged `SCShareableContent` and with CLAUDE.md's "TCC permissions gate CI" note): the 3-real-app acceptance test (Safari/Terminal/non-resizable dialog), actual Retina pixel-bounds correctness against real hardware, actual secondary-display negative-origin placement against a live multi-display setup, and whether `AXUIElementIsAttributeSettable` reports `false` for real non-resizable dialogs. The implementation follows Apple's documented AX API contract and mirrors `EnumerationService`'s established, already-verified pixel/point conversion exactly; these three items require Phase 13's local e2e process with a real Accessibility grant before being called fully verified.
