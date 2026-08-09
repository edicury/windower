# Spec Status

Current phase: **6 — Daemon & Session Lifecycle** (not started)
Active phase file: `tasks/phase-6-daemon-session-lifecycle.md`
Previous: Phase 5 (Audio) — complete, see below.

Blocked: none

Planned (MVP, in order): Phase 0 (Foundation) → Phase 1 (Sidecar Protocol) → Phase 2 (macOS Enumeration & Permissions) → Phase 3 (Window Control) → Phase 4 (Video Capture) → Phase 5 (Audio) → Phase 6 (Daemon & Sessions) → Phase 7 (CLI) → Phase 8 (MCP Server) → Phase 9 (Claude Code Plugin + Skill) → Phase 10 (Event Timeline) → Phase 11 (Narration Hook) → Phase 12 (Output Management) → Phase 13 (Testing & Hardening) → Phase 14 (Packaging)

Planned (v1.1): Phase 15 (Post-Processing: trim, auto-zoom, ripples, gif/webm)

Planned (post-MVP): Phase 16 (Windows backend), Phase 17 (Linux backend)

Completed: Phase 0 (Foundation), Phase 1 (Sidecar Protocol & Capability Model), Phase 2 (macOS Enumeration & Permissions), Phase 3 (Window Control), Phase 4 (Video Capture), Phase 5 (Audio)

## Recently completed

- **Phase 5 — Audio** (2026-08-09): system-audio and microphone capture wired into Phase 4's video pipeline.
  - Built via 2 parallel subagents (`AudioCaptureConfig.swift` — pure `AudioSettingsInput`/`AudioTrackPlan` decode+config math, `AudioDeviceService` device enumeration/resolution; `VideoAssetWriter.swift` extended with `addAudioInput(outputSettings:)` returning an `AudioWriterInputHandle`, so system/mic tracks share the video input's `AVAssetWriter` and session-start time; `MicrophoneCaptureSource.swift` — `AVCaptureSession` wrapper) followed by this integration pass (`CaptureService.swift`).
  - `CaptureSessionManager.startCapture`: computes `AudioTrackPlan` from `StartCaptureParams.audio` (now typed `AudioSettingsInput?`, replacing the Phase 4 opaque `JSONValue?` placeholder); sets `SCStreamConfiguration.capturesAudio` and attaches a second `SCStreamOutput` (`CaptureSystemAudioOutput`, type `.audio`) for system audio; resolves/builds `MicrophoneCaptureSource` for mic requests, started only after `SCStream.startCapture` succeeds; `AudioTrackPlan.bothMixed` routes both system-audio and mic sample handlers into ONE shared `AudioWriterInputHandle` — an interleaving approximation of real mixing (not PCM-level summing), documented as a known simplification rather than hidden.
  - Graceful degradation: mic requested + `PermissionsService.microphoneStatus() == .denied` throws `PERMISSION_DENIED` before any capture resource is created (`AudioPermissionGate.shouldFailFast`, extracted as a pure function so it's unit-testable without a real mic/TCC grant); a stale/removed `deviceId` throws `TARGET_NOT_FOUND`, also fail-fast.
  - `stopCapture`/`cancelCapture`/`handleStreamStoppedUnexpectedly` now stop any running `MicrophoneCaptureSource` alongside the `SCStream`; `VideoAssetWriter.finish()` already covered `markAsFinished()` for all audio inputs, verified unchanged.
  - `main.swift`: `audio.system`/`audio.microphone` now advertised (deliberately not `audio.system.perApp` — `AudioTrackConfig` has no field to invoke it).
  - Deviation: `Package.swift`'s platform floor bumped from macOS 12.3 to 13.0 — `SCStreamConfiguration.capturesAudio` requires 13.0+; documented inline in `Package.swift`.
  - 100/100 Swift tests passing (39 new across `CaptureServiceTests`, `IntegrationTests`, plus the two parallel tasks' own new test files `AudioCaptureConfigTests.swift`/`MicrophoneCaptureSourceTests.swift`/`AudioAssetWriterTests.swift`), up from the pre-Phase-5 baseline of 61. `pnpm build` + `pnpm turbo run test`: 12/12 tasks passing, TS side untouched.
  - Not verified in this sandbox (no Screen Recording/Microphone TCC grant, no GUI — same gap as Phase 2-4): the clap-test fixture's frame-accurate sync verification, `ffprobe`-confirmed track count/layout on a real output file, live mic device enumeration against real hardware, and `AudioTrackPlan.bothMixed`'s actual audible-mix quality. Deferred to Phase 13's local e2e process. `getPermissions`/a dedicated RPC surfacing `listAudioDevices` was deliberately not added yet — `AudioDeviceService.listMicrophoneDevices()` exists and is unit-tested, but its only named consumer (Phase 7's `--mic-device` CLI flag) doesn't exist yet, so wiring a listing endpoint now would be speculative.

- **Phase 4 — Video Capture** (2026-08-09): `startCapture`/`stopCapture`/`cancelCapture` implemented, video-only (audio deferred to Phase 5).
  - Built via 3 subagents: two independent/parallel (`CaptureConfig.swift` — pure quality/geometry math; `VideoAssetWriter.swift` — `AVAssetWriter` wrapper, no SCK dependency) followed by one integration pass (`CaptureService.swift` — `CaptureSessionManager` wiring `SCStream` frame delivery into the writer, `SCContentFilter`/`SCStreamConfiguration` resolution for display/window/region targets, `NSLock`-protected session dict for concurrent-session safety, `captureEnded` notification on stream failure).
  - `main.swift`: `capture.display`/`capture.window`/`capture.region` now advertised; `writeLine` made thread-safe (background SCStream queues emit notifications concurrently with the main dispatch loop).
  - Quality→bitrate mapping table documented in `tasks/phase-4-video-capture.md`. Region crop done via `SCStreamConfiguration.sourceRect`/`.destinationRect`, not a content filter (SCK has no arbitrary-rect target).
  - `packages/core` untouched — Phase 1 already shipped `startCapture`/`stopCapture`/`cancelCapture` schemas/client methods correctly.
  - 61/61 Swift tests passing (35 new). `VideoAssetWriterTests` is a real functional test with no TCC dependency (synthetic-frame write→finalize→read-back via `AVURLAsset`). `pnpm build` + `pnpm turbo run test`: 12/12 passing.
  - Not verified in this sandbox (no Screen Recording/Accessibility grant, no GUI — same gap as Phase 2/3): any real `SCStream` capture, `ffprobe`/VLC-verified output correctness, live region-crop framing, concurrent two-session capture, `captureEnded` end-to-end. Deferred to Phase 13's local e2e process. Also flagged: `captureEnded.reason` always reports `"error"` (SCK doesn't document a way to distinguish target-closed from a generic stream failure via `didStopWithError`) — daemon behavior is identical either way per contract, so this is a documented limitation, not a bug.

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
