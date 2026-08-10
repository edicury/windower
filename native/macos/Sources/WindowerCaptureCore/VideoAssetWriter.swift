import AVFoundation
import CoreMedia
import CoreVideo
import Foundation
import WindowerSidecarShared

/// Errors surfaced during `VideoAssetWriter` setup. Kept distinct from
/// `SidecarRpcError`/`SidecarErrorCode` deliberately — this type is pure
/// AVFoundation plumbing with no knowledge of the JSON-RPC error taxonomy;
/// the caller wiring this into `startCapture` (Phase 4/5 SCStream glue) is
/// responsible for translating a thrown error here into a `.captureFailed`
/// `SidecarRpcError`.
public enum VideoAssetWriterError: Error {
    case unsupportedCodec(String)
    case unsupportedContainer(String)
    case writerSetupFailed(String)
    case audioInputSetupFailed(String)
}

/// Thin handle around one audio `AVAssetWriterInput` added to a
/// `VideoAssetWriter`'s shared `AVAssetWriter`. Returned by
/// `VideoAssetWriter.addAudioInput(outputSettings:)` — one handle per system
/// audio or microphone track (Phase 5's "separateTracks" case adds two).
/// Deliberately has no lifecycle of its own beyond `append`: `finish()`/
/// `cancel()` on the owning `VideoAssetWriter` manage `markAsFinished()` for
/// every audio input it created, same as the video input.
public final class AudioWriterInputHandle {
    private let input: AVAssetWriterInput

    /// Bug #6 diagnostics: count of audio samples silently dropped because
    /// `isReadyForMoreMediaData` was false at append time. Same rationale as
    /// `VideoAssetWriter.droppedFrameCount` — audio backpressure drops were
    /// previously invisible too.
    public private(set) var droppedFrameCount = 0

    fileprivate init(input: AVAssetWriterInput) {
        self.input = input
    }

    fileprivate var writerInput: AVAssetWriterInput { input }

    /// Appends one audio sample buffer. Returns false (and does NOT throw) if
    /// the writer isn't ready for more data yet — same backpressure contract
    /// as `VideoAssetWriter.append(sampleBuffer:)`. Precondition: the owning
    /// `VideoAssetWriter`'s `start(at:)` must already have been called (session
    /// start is always driven by the first VIDEO frame, per Phase 5's
    /// timestamp-alignment requirement). Audio samples that arrive before the
    /// first video frame — a sub-frame-duration window at session start — are
    /// the caller's responsibility to drop; this method does not buffer them,
    /// it will simply fail to append against a writer with no active session.
    @discardableResult
    public func append(sampleBuffer: CMSampleBuffer) -> Bool {
        guard input.isReadyForMoreMediaData else {
            droppedFrameCount += 1
            return false
        }
        let accepted = input.append(sampleBuffer)
        if !accepted {
            droppedFrameCount += 1
        }
        return accepted
    }
}

/// Thin wrapper around `AVAssetWriter` for turning a stream of
/// `CMSampleBuffer` video frames into a finished `.mp4`/`.mov` file.
/// Deliberately has no dependency on ScreenCaptureKit — it only knows how
/// to accept sample buffers and finalize a file, so it can be built/tested
/// in isolation from the `SCStream` wiring (a separate piece of Phase 4).
public final class VideoAssetWriter {
    public let outputURL: URL

    private let assetWriter: AVAssetWriter
    private let input: AVAssetWriterInput
    private var audioInputs: [AVAssetWriterInput] = []

    /// True once `start(at:)` has been called. Exposed so callers wiring
    /// audio inputs (system audio / mic) can guard against appending to an
    /// audio input before the video-driven session start has happened (see
    /// `AudioWriterInputHandle.append(sampleBuffer:)` doc comment).
    public var hasStarted: Bool {
        diagnosticsLock.lock()
        defer { diagnosticsLock.unlock() }
        return _hasStarted
    }
    private var _hasStarted = false

    // MARK: - Bug #6 diagnostics
    //
    // `append(sampleBuffer:)` previously dropped frames under backpressure
    // (`isReadyForMoreMediaData == false`) with zero instrumentation — there
    // was no way to tell "SCK delivered stale/delayed frames" (upstream,
    // outside this codebase) apart from "our own writer silently ate frames
    // it was handed" (a real, in-our-control gap). These counters/summary
    // make both observable without changing any wire type — diagnostic-only,
    // see bugs.spec.md #6.
    //
    // Structural fix (bugs.spec.md #6, "move fetchShareableContent/
    // captureImage off the RPC thread" session): these counters are written
    // from `append`/`recordAcceptedFrame` on the session's `sampleQueue`
    // (SCStream's delegate queue) and read/written from `checkLiveness` on
    // the session's independent `livenessQueue` timer — two different queues
    // touching the same state, a real pre-existing race even before this
    // session's change. Now that `stopCapture`'s `finish`/`diagnosticsSummary`
    // call can also run on a background RPC-dispatch queue (rather than the
    // sidecar's single synchronous thread), there are three uncoordinated
    // accessors instead of two. `diagnosticsLock` (`NSLock`) guards every
    // read and write below so none of this is a data race regardless of
    // which queue calls in.
    private let diagnosticsLock = NSLock()

    /// Count of video frames silently dropped because `isReadyForMoreMediaData`
    /// was false (backpressure) OR `input.append` itself returned false at
    /// append time. Every increment corresponds to a frame `append(sampleBuffer:)`
    /// returned `false` for.
    public var droppedFrameCount: Int {
        diagnosticsLock.lock()
        defer { diagnosticsLock.unlock() }
        return _droppedFrameCount
    }
    private var _droppedFrameCount = 0

    /// Count of times an ACCEPTED frame's presentation timestamp landed more
    /// than `stallThresholdMs` after the previously-accepted frame's PTS —
    /// i.e. a gap in the encoded timeline, whether caused by dropped frames,
    /// delayed SCK delivery, or a genuine on-screen freeze. See
    /// `Self.stallThresholdMs(forFps:)`.
    public var stallEventCount: Int {
        diagnosticsLock.lock()
        defer { diagnosticsLock.unlock() }
        return _stallEventCount
    }
    private var _stallEventCount = 0

    /// Largest single gap (ms) observed between two consecutively-accepted
    /// frames' PTS, across the whole session. `0` if no gap ever exceeded
    /// `stallThresholdMs`.
    public var maxStallGapMs: Double {
        diagnosticsLock.lock()
        defer { diagnosticsLock.unlock() }
        return _maxStallGapMs
    }
    private var _maxStallGapMs: Double = 0

    /// PTS of the last successfully-appended frame. `nil` until the first
    /// frame is accepted. Deliberately NOT advanced on a dropped frame, so a
    /// stretch of drops followed by an accept reports the FULL gap since the
    /// last real content, not just since the most recent attempt.
    private var lastAcceptedPTS: CMTime?

    /// Gap (ms) above which an accepted frame counts as a "stall" — see
    /// `Self.stallThresholdMs(forFps:)` for the derivation.
    private let stallThresholdMs: Double

    // MARK: - Bug #6 liveness watchdog (wall-clock, independent of PTS gaps)
    //
    // The PTS-gap "stall" detector above only fires on a SUBSEQUENT accepted
    // frame — if `SCStream` stops delivering samples entirely and never
    // resumes, there is no "next frame" to compute a gap against, so it can
    // never fire (bugs.spec.md #6, "Reproduced — Phase 20" entry: a real
    // ~201s session that produced only ~9s of video, with zero drops/stalls
    // reported, because frame delivery stopped outright rather than
    // slowing down). This watchdog is measured from a real `Date` — driven
    // by an external timer calling `checkLiveness(now:)` on a cadence, not
    // from anything inside this class — so a TOTAL stop is still caught even
    // though no frame ever arrives to trigger the PTS-based check.

    /// Wall-clock time (via `clock`, injectable for tests) the most recent
    /// frame was accepted at. Seeded to the session start time by `start(at:)`
    /// so a check running before the first frame lands still has a baseline.
    private var lastAcceptedAt: Date?

    /// Injectable wall clock — defaults to the real `Date()` in production;
    /// tests substitute a controllable clock so this is verifiable without
    /// an actual multi-second sleep (same "synthetic delay" spirit as the
    /// existing PTS-gap tests, which use synthetic `CMTime`s instead of
    /// real capture timing).
    private let clock: () -> Date

    /// True once `checkLiveness(now:)` has observed a gap exceeding
    /// `livenessThresholdMs` since the last accepted frame. Sticky — once
    /// tripped, stays tripped for the rest of the session (there is no
    /// "recovered" state; `stopCapture` and the real-time watchdog both key
    /// off this to avoid re-logging every tick).
    public var hasLivenessFailure: Bool {
        diagnosticsLock.lock()
        defer { diagnosticsLock.unlock() }
        return _hasLivenessFailure
    }
    private var _hasLivenessFailure = false

    /// Largest wall-clock gap (ms) observed by `checkLiveness(now:)` between
    /// "now" and the last accepted frame (or session start, before any frame
    /// landed). `0` until a check is actually run.
    public var maxLivenessGapMs: Double {
        diagnosticsLock.lock()
        defer { diagnosticsLock.unlock() }
        return _maxLivenessGapMs
    }
    private var _maxLivenessGapMs: Double = 0

    /// Gap (ms) above which `checkLiveness` considers the stream stalled:
    /// same "2-3x the configured frame interval, floored at 500ms" shape as
    /// `stallThresholdMs(forFps:)` — sharing the formula (see
    /// `Self.livenessThresholdMs(forFps:)`) since both describe "frame
    /// delivery is behaving abnormally for this fps," just measured two
    /// different ways (PTS-gap-since-last-accept vs. wall-clock-since-last-
    /// accept).
    private let livenessThresholdMsValue: Double

    /// True if this session ever dropped a frame, recorded a PTS-gap stall,
    /// or tripped the wall-clock liveness watchdog — `stopCapture` uses this
    /// to decide whether a diagnostic `log` notification is worth emitting.
    public var hasDiagnosticWarnings: Bool {
        diagnosticsLock.lock()
        defer { diagnosticsLock.unlock() }
        return _droppedFrameCount > 0 || _stallEventCount > 0 || _hasLivenessFailure
    }

    /// Human-readable one-line summary for the `log` notification / stderr,
    /// or `nil` if nothing to report. Kept here (rather than in
    /// `CaptureService`) so the wording lives next to the counters it
    /// describes.
    public func diagnosticsSummary() -> String? {
        // Snapshot every counter under one lock acquisition so the summary
        // reflects one consistent instant, rather than each computed
        // property independently locking/unlocking (still race-free either
        // way, just less internally consistent if a frame lands mid-read).
        let (dropped, stalls, maxStallGap, liveness, maxLivenessGap): (Int, Int, Double, Bool, Double) = {
            diagnosticsLock.lock()
            defer { diagnosticsLock.unlock() }
            return (
                _droppedFrameCount, _stallEventCount, _maxStallGapMs, _hasLivenessFailure,
                _maxLivenessGapMs
            )
        }()
        guard dropped > 0 || stalls > 0 || liveness else { return nil }
        var parts: [String] = []
        if dropped > 0 {
            parts.append("\(dropped) frame(s) dropped under backpressure")
        }
        if stalls > 0 {
            parts.append(
                "\(stalls) stall event(s) detected, longest gap: \(Int(maxStallGap.rounded()))ms")
        }
        if liveness {
            parts.append(
                "liveness check failed: no frame appended for \(Int(maxLivenessGap.rounded()))ms (capture may have silently stopped)"
            )
        }
        return parts.joined(separator: "; ")
    }

    /// Called by an external repeating timer (`CaptureSessionManager`'s
    /// per-session liveness timer, not owned by this class — `VideoAssetWriter`
    /// has no dependency on `SCStream`/dispatch timers so it stays testable in
    /// isolation) on a cadence faster than `livenessThresholdMsValue`. Compares
    /// real wall-clock elapsed time against the last accepted frame (or session
    /// start, if none has landed yet) — NOT against the last frame's own PTS,
    /// which is exactly what makes this independent of the PTS-gap detector
    /// above and able to catch a total stop. Returns `true` the FIRST time this
    /// check newly trips (i.e. the transition into a stalled state), so the
    /// caller can log once instead of on every tick; returns `false` on every
    /// other call (already-known-stalled, or genuinely healthy).
    @discardableResult
    public func checkLiveness(now: Date? = nil) -> Bool {
        diagnosticsLock.lock()
        defer { diagnosticsLock.unlock() }
        guard _hasStarted, let lastAcceptedAt = lastAcceptedAt else {
            // Never started (no session yet) — nothing to check.
            return false
        }
        let currentTime = now ?? clock()
        let gapMs = currentTime.timeIntervalSince(lastAcceptedAt) * 1000
        _maxLivenessGapMs = max(_maxLivenessGapMs, gapMs)
        guard gapMs > livenessThresholdMsValue else { return false }
        let isNewFailure = !_hasLivenessFailure
        _hasLivenessFailure = true
        return isNewFailure
    }

    /// codec is "h264"|"hevc", container is "mp4"|"mov" (data-model.md §VideoSettings).
    /// bitrate is bits-per-second (average). width/height must already be even
    /// (caller's responsibility per encoder requirements). `fps` is the
    /// configured target frame rate (data-model.md §VideoSettings) — used only
    /// to derive `stallThresholdMs`/`livenessThresholdMsValue` for bug #6 gap
    /// detection, defaults to 30 so existing callers/tests that don't care
    /// about diagnostics don't need to change. `clock` is an injectable wall
    /// clock for the liveness watchdog (defaults to real `Date()`); tests
    /// substitute a controllable one so `checkLiveness` is verifiable without
    /// an actual sleep.
    public init(
        outputURL: URL, width: Int, height: Int, codec: String, container: String, bitrate: Int,
        fps: Int = 30, clock: @escaping () -> Date = Date.init
    ) throws {
        let codecType: AVVideoCodecType
        switch codec {
        case "h264":
            codecType = .h264
        case "hevc":
            codecType = .hevc
        default:
            throw VideoAssetWriterError.unsupportedCodec(codec)
        }

        let fileType: AVFileType
        switch container {
        case "mp4":
            fileType = .mp4
        case "mov":
            fileType = .mov
        default:
            throw VideoAssetWriterError.unsupportedContainer(container)
        }

        self.outputURL = outputURL
        self.stallThresholdMs = Self.stallThresholdMs(forFps: fps)
        self.livenessThresholdMsValue = Self.livenessThresholdMs(forFps: fps)
        self.clock = clock

        do {
            assetWriter = try AVAssetWriter(outputURL: outputURL, fileType: fileType)
        } catch {
            throw VideoAssetWriterError.writerSetupFailed(
                "AVAssetWriter init failed: \(error.localizedDescription)")
        }

        let outputSettings: [String: Any] = [
            AVVideoCodecKey: codecType,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: bitrate
            ],
        ]
        input = AVAssetWriterInput(mediaType: .video, outputSettings: outputSettings)
        // Live screen capture, not an offline transcode from a file — frames
        // arrive in real time and the writer must not try to interleave/
        // buffer them as if reading ahead from a source asset.
        input.expectsMediaDataInRealTime = true

        guard assetWriter.canAdd(input) else {
            throw VideoAssetWriterError.writerSetupFailed(
                "AVAssetWriter cannot accept an input with the requested settings")
        }
        assetWriter.add(input)
    }

    /// Must be called once, before the first `append`, with the presentation
    /// timestamp of the first frame that will be appended.
    public func start(at sourceTime: CMTime) {
        // `startWriting()`/`startSession` failures here are a setup-time
        // problem (init already validated codec/container/dimensions) —
        // rather than overengineer a synchronous error path for a method
        // with no return value, let them surface through `assetWriter.status`
        // / `assetWriter.error`, which `finish` already inspects.
        assetWriter.startWriting()
        assetWriter.startSession(atSourceTime: sourceTime)
        diagnosticsLock.lock()
        _hasStarted = true
        // Seed the liveness baseline to the session start moment (not left
        // `nil`) so a `checkLiveness` call that lands before the first frame
        // is actually appended still has something to measure against.
        lastAcceptedAt = clock()
        diagnosticsLock.unlock()
    }

    /// Adds an additional audio input (mediaType `.audio`) to the SAME
    /// underlying `AVAssetWriter` the video input already uses, so system
    /// audio and/or microphone tracks stay on one writer with one shared
    /// session start time (Phase 5's timestamp-alignment requirement). Call
    /// this any time before `finish()`/`cancel()` — including before or after
    /// `start(at:)`, since `AVAssetWriterInput.add` itself doesn't require an
    /// active session, only `append` does (see `AudioWriterInputHandle`).
    ///
    /// `outputSettings` follows the same shape as `AVAssetWriterInput`'s
    /// audio settings (e.g. `AVFormatIDKey: kAudioFormatMPEG4AAC`) — the
    /// caller (parallel `AudioCaptureConfig` work) owns building these.
    public func addAudioInput(outputSettings: [String: Any]) throws -> AudioWriterInputHandle {
        let audioInput = AVAssetWriterInput(mediaType: .audio, outputSettings: outputSettings)
        // Same real-time-capture reasoning as the video input: live audio
        // samples, not an offline transcode reading ahead from a source asset.
        audioInput.expectsMediaDataInRealTime = true

        guard assetWriter.canAdd(audioInput) else {
            throw VideoAssetWriterError.audioInputSetupFailed(
                "AVAssetWriter cannot accept an audio input with the requested settings")
        }
        assetWriter.add(audioInput)
        audioInputs.append(audioInput)
        return AudioWriterInputHandle(input: audioInput)
    }

    /// Appends one video frame. Returns false (and does NOT throw) if the
    /// writer isn't ready for more data yet (caller should drop/skip the
    /// frame rather than block — dropping frames under backpressure is
    /// correct behavior for a live screen-capture writer).
    @discardableResult
    public func append(sampleBuffer: CMSampleBuffer) -> Bool {
        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)

        guard input.isReadyForMoreMediaData else {
            diagnosticsLock.lock()
            _droppedFrameCount += 1
            diagnosticsLock.unlock()
            return false
        }

        let accepted = input.append(sampleBuffer)
        if accepted {
            recordAcceptedFrame(pts: pts)
        } else {
            diagnosticsLock.lock()
            _droppedFrameCount += 1
            diagnosticsLock.unlock()
        }
        return accepted
    }

    /// Bug #6 gap detection: compares this accepted frame's PTS against the
    /// previously-accepted frame's PTS (NOT the previous attempt — dropped
    /// frames in between don't move `lastAcceptedPTS`, so a drop-then-accept
    /// sequence reports the full gap since the last real content landed).
    private func recordAcceptedFrame(pts: CMTime) {
        diagnosticsLock.lock()
        defer { diagnosticsLock.unlock() }
        // Liveness baseline: every accepted frame resets the wall-clock
        // watchdog, independent of the PTS-gap bookkeeping below.
        lastAcceptedAt = clock()
        defer { lastAcceptedPTS = pts }
        guard let previous = lastAcceptedPTS,
            let gapMs = Self.gapMilliseconds(from: previous, to: pts)
        else { return }
        guard gapMs > stallThresholdMs else { return }
        _stallEventCount += 1
        _maxStallGapMs = max(_maxStallGapMs, gapMs)
    }

    /// Finalizes the file. MUST be awaited by the caller before treating the
    /// output file as valid/complete (AVAssetWriter's finishWriting is async
    /// and the file is corrupt/truncated if read before it completes).
    ///
    /// On success, the completion is handed the REAL duration (in
    /// milliseconds) of the finished asset, read back from the file itself
    /// via `AVURLAsset`'s `.duration` — this is the actual decodable content
    /// length, not wall-clock elapsed time (bug #5: wall-clock overstates
    /// duration whenever frames are dropped/delayed during capture). `nil`
    /// means the finished file's duration couldn't be read (corrupt/empty
    /// asset); the caller should fall back to wall-clock in that case rather
    /// than treat it as a hard failure — the write itself still succeeded.
    public func finish(completion: @escaping (Result<Double?, Error>) -> Void) {
        input.markAsFinished()
        for audioInput in audioInputs {
            audioInput.markAsFinished()
        }
        assetWriter.finishWriting { [assetWriter, outputURL] in
            switch assetWriter.status {
            case .completed:
                // Bridge into async/await just for the duration read — the
                // rest of this file/API is completion-handler style (see
                // `finish`'s own signature), so keep this as a self-
                // contained Task rather than making the whole type async.
                Task {
                    let asset = AVURLAsset(url: outputURL)
                    do {
                        let duration = try await asset.load(.duration)
                        completion(.success(Self.milliseconds(from: duration)))
                    } catch {
                        // The write itself succeeded (assetWriter.status ==
                        // .completed) — a duration-read failure is not a
                        // write failure, so report success with no duration
                        // rather than fail the whole finish() call.
                        completion(.success(nil))
                    }
                }
            case .failed:
                completion(
                    .failure(
                        assetWriter.error
                            ?? VideoAssetWriterError.writerSetupFailed("finishWriting failed with no error set")))
            default:
                completion(
                    .failure(
                        VideoAssetWriterError.writerSetupFailed(
                            "finishWriting ended in unexpected status \(assetWriter.status.rawValue)")))
            }
        }
    }

    /// Converts a `CMTime` to milliseconds. Returns `nil` for a non-numeric
    /// (indefinite/invalid) time, e.g. an asset whose duration couldn't be
    /// determined. Pure/free function seam so it's unit-testable without a
    /// real `AVAssetWriter`/capture pipeline.
    static func milliseconds(from time: CMTime) -> Double? {
        guard time.isNumeric else { return nil }
        return CMTimeGetSeconds(time) * 1000
    }

    /// Gap, in milliseconds, between two PTS values (`to - from`). `nil` if
    /// either is non-numeric. Pure/free function seam (same pattern as
    /// `milliseconds(from:)`) so bug #6's stall-detection math is
    /// unit-testable without a real `AVAssetWriter`/capture pipeline.
    static func gapMilliseconds(from: CMTime, to: CMTime) -> Double? {
        guard from.isNumeric, to.isNumeric else { return nil }
        return (CMTimeGetSeconds(to) - CMTimeGetSeconds(from)) * 1000
    }

    /// Threshold (ms) above which a gap between consecutively-accepted
    /// frames counts as a "stall": 3x the configured frame interval, floored
    /// at 500ms so a low fps target (e.g. 5fps, 200ms/frame) doesn't produce
    /// a threshold so tight it flags normal jitter as a stall. `fps <= 0` is
    /// defensive-only (never a valid `VideoSettings.fps`) and falls back to
    /// the 500ms floor.
    static func stallThresholdMs(forFps fps: Int) -> Double {
        guard fps > 0 else { return 500 }
        return max(3.0 * (1000.0 / Double(fps)), 500.0)
    }

    /// Threshold (ms) above which `checkLiveness` considers the stream
    /// stalled: same "3x the configured frame interval" shape as
    /// `stallThresholdMs(forFps:)`, but floored higher (2000ms rather than
    /// 500ms) — this is checked on an external wall-clock poll (see
    /// `checkLiveness(now:)`'s doc comment), not on every accepted frame, so
    /// it needs enough headroom above the poll interval itself to avoid a
    /// false positive from ordinary poll/scheduling jitter. `fps <= 0` is
    /// defensive-only (never a valid `VideoSettings.fps`) and falls back to
    /// the 2000ms floor.
    static func livenessThresholdMs(forFps fps: Int) -> Double {
        guard fps > 0 else { return 2000 }
        return max(3.0 * (1000.0 / Double(fps)), 2000.0)
    }

    /// Aborts writing and deletes whatever partial file exists at outputURL
    /// (cancelCapture's "discard the in-progress file" requirement).
    public func cancel() {
        assetWriter.cancelWriting()
        try? FileManager.default.removeItem(at: outputURL)
    }
}
