# Spec Status

Current phase: **4 — Video Capture** (not started)
Active phase file: `tasks/phase-4-video-capture.md`
Previous: Phase 3 (Window Control) — complete, see below.

Blocked: none

Planned (MVP, in order): Phase 0 (Foundation) → Phase 1 (Sidecar Protocol) → Phase 2 (macOS Enumeration & Permissions) → Phase 3 (Window Control) → Phase 4 (Video Capture) → Phase 5 (Audio) → Phase 6 (Daemon & Sessions) → Phase 7 (CLI) → Phase 8 (MCP Server) → Phase 9 (Claude Code Plugin + Skill) → Phase 10 (Event Timeline) → Phase 11 (Narration Hook) → Phase 12 (Output Management) → Phase 13 (Testing & Hardening) → Phase 14 (Packaging)

Planned (v1.1): Phase 15 (Post-Processing: trim, auto-zoom, ripples, gif/webm)

Planned (post-MVP): Phase 16 (Windows backend), Phase 17 (Linux backend)

Completed: Phase 0 (Foundation), Phase 1 (Sidecar Protocol & Capability Model), Phase 2 (macOS Enumeration & Permissions), Phase 3 (Window Control)

## Recently completed

- **Phase 3 — Window Control** (2026-08-09): `resizeWindow` implemented in the macOS sidecar.
  - `native/macos/Sources/WindowerSidecarCore/WindowControl.swift`: `CGWindowID` → owning pid (`CGWindowListCopyWindowInfo`) → `AXUIElementCreateApplication` → best-match `AXUIElement` window (position/size Euclidean distance + title tiebreaker, since AX has no direct `CGWindowID` lookup) → `AXUIElementIsAttributeSettable` pre-check (`RESIZE_UNSUPPORTED` if not resizable) → pixels→points via the same `backingScaleFactor` convention `EnumerationService.mapWindow` already established → `AXUIElementSetAttributeValue` for position/size → read-back → points→pixels → epsilon (1.0px) comparison for `result: "success"|"partial"`. `TARGET_NOT_FOUND` on stale/unmatched windowID. Wired into `main.swift` (`"window-control"` now advertised in `describe`). `packages/core`'s `resizeWindow` client/schema needed zero changes — Phase 1 already shipped it correctly.
  - 16 new headless XCTest cases (coordinate math round-trips including negative-origin/secondary-display, epsilon comparison, best-match heuristic, wire-shape encode/decode). `swift test`: 27/27 passing. `pnpm build` + `pnpm turbo run test`: 12/12 tasks passing.
  - Not verified in this sandbox (no interactive GUI/TCC/Accessibility grant, per CLAUDE.md's CI note): the exit criteria's 3-real-app resize test (Safari/Terminal/non-resizable dialog), real Retina pixel-bounds correctness, real secondary-display negative-origin placement. Deferred to Phase 13's local e2e process.

- **Phase 2 — macOS Sidecar: Enumeration & Permissions** (2026-08-09): first real macOS implementation.
  - `native/macos/`: real newline-delimited JSON-RPC 2.0 stdio loop, split into `WindowerSidecarCore` library + thin executable target (required for XCTest `@testable` linking). `describe` advertises exactly `enumerate.displays`/`enumerate.windows`/`enumerate.apps`. `enumerateTargets` via `SCShareableContent`, points→pixels conversion via `backingScaleFactor` happens entirely inside the sidecar. `getPermissions`/`requestPermission` wired to real `CGPreflightScreenCaptureAccess`/`AXIsProcessTrusted`/`AVCaptureDevice` APIs. Error taxonomy correctly applied (`UNSUPPORTED_CAPABILITY` for unknown methods, `PERMISSION_DENIED` for TCC denials). 11/11 XCTest passing.
  - `packages/core/src/process/`: `resolveSidecarBinaryPath()` + `SidecarProcess`/`spawnSidecar()` — real `child_process.spawn` wired into `SidecarClient`, env-var override for future Phase 14 packaged-binary resolution, clean SIGTERM→SIGKILL teardown, in-flight request rejection on crash/kill. 55/55 `@windower/core` tests passing (10 new, including one integration test against the real compiled Swift binary).
  - Full `pnpm build` + `turbo run test` verified clean across TS + Swift together.
  - Not verified in this sandbox (no interactive GUI/TCC access, matches CLAUDE.md's CI note that permission grants are e2e-gated/local-only): actual OS permission-prompt dialogs appearing, `enumerateTargets` output against a real granted-permissions screen. API usage is correct per Apple's docs; flagged rather than claimed.

- **Phase 1 — Sidecar Protocol & Capability Model** (2026-08-09): protocol frozen.
  - `packages/core/src/schemas/` — Zod schemas + inferred types for every data-model.md type (Rect, CaptureTarget, VideoSettings, AudioTrackConfig/AudioSettings, SessionState/RecordingSession, OutputManifest, TimelineEvent/EventTimeline, PermissionStatus/PermissionReport), 31 unit tests.
  - `packages/core/src/protocol/` — JSON-RPC 2.0 envelope schemas, full method table (`describe`, `enumerateTargets`, `getPermissions`, `requestPermission`, `resizeWindow`, `startCapture`, `stopCapture`, `cancelCapture`), error taxonomy (`SidecarError`/`SidecarErrorCode`), `SidecarClient` (transport-agnostic over any `Duplex`, newline-delimited JSON), notification API (`event`/`log`/`captureEnded`).
  - `packages/core/src/protocol/fake-sidecar.ts` — in-memory TS echo sidecar for testing the client without macOS/real capture; 14 round-trip tests including error-taxonomy propagation and streamed `event` notifications during an active capture.
  - Contract fix: `contracts/sidecar-protocol.md`'s `enumerateTargets.kinds` listed `"app"` as a filterable kind, but `CaptureTarget.kind` only has `display`/`window`/`region`. Corrected to `("display"|"window")[]` (region has no independent ID, never independently enumerated per data-model.md) and updated the implementation to match — no other drift found.
  - Verified: `pnpm --filter @windower/core build/typecheck/test` all pass, 45/45 tests, zero `any`.

- **Phase 0 — Foundation** (2026-08-09): monorepo scaffolding stood up, no functional capability yet.
  - pnpm workspace (`apps/*`, `packages/*`, `plugins/*`, `native/*`) + root `package.json` + `turbo.json`.
  - `packages/config` — shared `biome.json` + base `tsconfig.base.json`.
  - Empty-but-wired TS packages: `packages/core`, `packages/cli`, `packages/mcp-server`, `apps/daemon`, `plugins/claude-code` — each builds via `tsc --build` and is driven by `turbo run build`/`test`/`typecheck`.
  - `plugins/claude-code` — `.claude-plugin/plugin.json` + placeholder `SKILL.md` (real authoring is Phase 9).
  - `native/macos` — Swift Package (`Package.swift`, macOS 12.3+ floor), executable target `windower-sidecar-macos` that hand-rolls a `describe` JSON-RPC-ish response over stdio (proves plumbing only — real protocol is Phase 1), plus an XCTest placeholder target. Wired into turbo via a thin `native/macos/package.json` (`build` → `swift build`, `test` → `swift test`).
  - `.gitignore`, root `README.md`, `.github/workflows/ci.yml` (macOS runner: install → lint → typecheck → build → test).
  - Verified locally: `pnpm install`, `pnpm build`, `pnpm turbo run test` (12/12 tasks, TS + Swift), `pnpm turbo run lint`/`typecheck` all exit 0.
  - Deviations from phase file: added `native/*` to the pnpm workspace globs (not explicitly listed in the phase file's workspace bullet, but required so turbo can drive `swift build`/`swift test` as a workspace task); TS `test`/`typecheck` scripts use `vitest run --passWithNoTests` / `tsc --build --noEmit` since no real source exists yet.

---
_Update this file at the end of each work session._
