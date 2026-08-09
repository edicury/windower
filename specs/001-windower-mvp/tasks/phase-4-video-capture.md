## Phase 4 — Video Capture

**Goal:** Implement `startCapture`/`stopCapture`/`cancelCapture` for video-only recording of a window, display, or region, with configurable `VideoSettings`.

- 🔵 `SCStreamConfiguration` built from `VideoSettings` (fps, resolution, `showsCursor`), `SCContentFilter` built from the resolved `CaptureTarget` (display, window, or a display filter + crop rect for `region`).
- 🔵 `SCStream` → frame delivery → `AVAssetWriter` with `AVAssetWriterInput` configured for H.264 or HEVC (`VideoSettings.codec`) into `.mp4` or `.mov` (`VideoSettings.container`).
- 🔵 Quality presets (`low|medium|high|lossless_ish`) mapped to concrete bitrate/quality encoder settings — documented mapping table in this file once tuned.
- 🔵 Region capture: crop implemented as a `SCContentFilter` rect against the containing display (per `research.md` §2, SCK has no native arbitrary-rect target).
- 🔵 `stopCapture` — clean `AVAssetWriter` finalization (must call `finishWriting` and await completion before returning `outputFilePath`, or the file is corrupt/truncated).
- 🔵 `cancelCapture` — stop the stream and discard the in-progress file (no valid output expected).
- 🔵 `captureEnded` notification when the target window closes mid-recording (SCK stream error/interruption callback).
- 🔵 Concurrent capture test: two sidecar processes, two different targets, recording simultaneously without interfering.

**Exit criteria**

- Matches `spec.md` acceptance item: a window, display, and region recording each produce a valid, playable (VLC/QuickTime-verified) video file at the requested resolution/fps/codec.
- `ffprobe` on each output confirms actual resolution/fps/codec/container match the request (or the target's native resolution when unspecified).
- Closing the target window mid-recording produces a `captureEnded` notification and a `failed` session, not a hang or crash.
- Two concurrent recordings on different targets both produce correct, independent files.
