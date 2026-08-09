## Phase 4 — Video Capture

**Goal:** Implement `startCapture`/`stopCapture`/`cancelCapture` for video-only recording of a window, display, or region, with configurable `VideoSettings`.

- ✅ `SCStreamConfiguration` built from `VideoSettings` (fps, resolution, `showsCursor`), `SCContentFilter` built from the resolved `CaptureTarget` (display, window, or a display filter + crop rect for `region`).
- ✅ `SCStream` → frame delivery → `AVAssetWriter` with `AVAssetWriterInput` configured for H.264 or HEVC (`VideoSettings.codec`) into `.mp4` or `.mov` (`VideoSettings.container`).
- ✅ Quality presets (`low|medium|high|lossless_ish`) mapped to concrete bitrate/quality encoder settings — documented mapping table below.
- ✅ Region capture: crop implemented as a `SCStreamConfiguration.sourceRect`/`.destinationRect` against the containing display's filter (per `research.md` §2, SCK has no native arbitrary-rect target).
- ✅ `stopCapture` — clean `AVAssetWriter` finalization (must call `finishWriting` and await completion before returning `outputFilePath`, or the file is corrupt/truncated).
- ✅ `cancelCapture` — stop the stream and discard the in-progress file (no valid output expected).
- ✅ `captureEnded` notification when the target window closes mid-recording (SCK stream error/interruption callback).
- 🔵 Concurrent capture test: two sidecar processes, two different targets, recording simultaneously without interfering. (Implementation is session-keyed/lock-protected and per-session queued so it should be safe; not exercised live — see Sign-off.)

### Quality → bitrate mapping

`bitrate = bpp * width * height * 30` (30fps reference baseline; bpp = bits per pixel per frame, screen content is mostly static UI/text so these presets are deliberately lower than typical camera-video presets). Implemented in `CaptureConfigService.bitrate(forQuality:width:height:)`.

| quality | bpp | 1920x1080 (30fps ref) |
|---|---|---|
| low | 0.04 | ≈ 2.49 Mbps |
| medium | 0.08 | ≈ 4.98 Mbps |
| high | 0.15 | ≈ 9.33 Mbps |
| lossless_ish | 0.35 | ≈ 21.77 Mbps |

Unknown quality strings fall back to `medium`'s bpp.

**Exit criteria**

- Matches `spec.md` acceptance item: a window, display, and region recording each produce a valid, playable (VLC/QuickTime-verified) video file at the requested resolution/fps/codec.
- `ffprobe` on each output confirms actual resolution/fps/codec/container match the request (or the target's native resolution when unspecified).
- Closing the target window mid-recording produces a `captureEnded` notification and a `failed` session, not a hang or crash.
- Two concurrent recordings on different targets both produce correct, independent files.

## Sign-off (2026-08-09)

Implemented across three new files in `native/macos/Sources/WindowerSidecarCore/`: `CaptureConfig.swift` (pure geometry/bitrate math — `bitrate(forQuality:width:height:)`, `minimumFrameInterval(forFps:)`, `resolvedPixelDimensions(...)` with even-dimension rounding for H.264/HEVC, `regionSourceRect(...)` converting a region's global-pixel bounds into the display-relative point rect `SCStreamConfiguration.sourceRect` expects), `VideoAssetWriter.swift` (`AVAssetWriter`/`AVAssetWriterInput` wrapper: codec/container mapping, start/append/finish-awaited/cancel, no ScreenCaptureKit dependency), and `CaptureService.swift` (`CaptureSessionManager`, the orchestrator: resolves `SCDisplay`/`SCWindow`/region-against-display from `SCShareableContent`, builds `SCContentFilter`+`SCStreamConfiguration`, wires `SCStream` frame delivery into the `VideoAssetWriter`, session dictionary keyed by `sessionId` under an `NSLock` for concurrent-session safety, `captureEnded` notification on `SCStreamDelegate.stream(_:didStopWithError:)`). `main.swift`: `capture.display`/`capture.window`/`capture.region` added to `supportedCapabilities`, `startCapture`/`stopCapture`/`cancelCapture` given real handlers, `writeLine` made `NSLock`-thread-safe since capture notifications arrive on background SCStream queues concurrently with the main dispatch loop's own responses. `packages/core` untouched — Phase 1 already shipped correct schemas/client methods for all three RPCs.

Known, deliberate limitation: `captureEnded`'s `reason` always reports `"error"`, never `"target-closed"` — SCK's `didStopWithError` path doesn't document a way to distinguish a closed target from a generic stream failure, and the daemon's contractually-required behavior (transition the session to `failed`) is identical either way, so guessing at a discriminator was rejected in favor of flagging it here for Phase 13 to revisit if a reliable signal turns up.

Test coverage: `CaptureConfigTests.swift` (14 cases, pure math incl. secondary/negative-origin display region math), `VideoAssetWriterTests.swift` (4 cases — genuinely headless-safe, no TCC needed: real synthetic-frame write→finalize→read-back round trip via `AVURLAsset`, verifying track count and `naturalSize`; cancel-discards-file; unsupported codec/container throw), `CaptureServiceTests.swift` (17 cases — wire-shape encode/decode for all three target kinds and both settings structs, `SESSION_NOT_FOUND` taxonomy for stop/cancel on an unknown session, notification-line shape). `swift test`: 61/61 passing. `pnpm build` + `pnpm turbo run test`: 12/12 tasks passing, `packages/core` diff-free.

**Not verified in this sandbox** (no Screen Recording/Accessibility grant or GUI session available here — same constraint documented for Phase 2/3, per CLAUDE.md's "TCC permissions gate CI"): any real `SCStream` capture (display/window/region), output file correctness via `ffprobe`/VLC, actual region-crop framing against a live display, concurrent two-session capture under real load, and `captureEnded` end-to-end against a window closed mid-recording. The `VideoAssetWriter` file-writing path is the one piece of this phase verified with a real functional test (no permission dependency); everything upstream of it (SCStream wiring, target resolution, region math against live geometry) follows Apple's documented API contract but needs Phase 13's local e2e pass with real grants before being called fully verified.
