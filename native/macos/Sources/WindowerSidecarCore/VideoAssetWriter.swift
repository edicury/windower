import AVFoundation
import CoreMedia
import CoreVideo
import Foundation

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
    public private(set) var hasStarted = false

    // MARK: - Bug #6 diagnostics
    //
    // `append(sampleBuffer:)` previously dropped frames under backpressure
    // (`isReadyForMoreMediaData == false`) with zero instrumentation — there
    // was no way to tell "SCK delivered stale/delayed frames" (upstream,
    // outside this codebase) apart from "our own writer silently ate frames
    // it was handed" (a real, in-our-control gap). These counters/summary
    // make both observable without changing any wire type — diagnostic-only,
    // see bugs.spec.md #6.

    /// Count of video frames silently dropped because `isReadyForMoreMediaData`
    /// was false (backpressure) OR `input.append` itself returned false at
    /// append time. Every increment corresponds to a frame `append(sampleBuffer:)`
    /// returned `false` for.
    public private(set) var droppedFrameCount = 0

    /// Count of times an ACCEPTED frame's presentation timestamp landed more
    /// than `stallThresholdMs` after the previously-accepted frame's PTS —
    /// i.e. a gap in the encoded timeline, whether caused by dropped frames,
    /// delayed SCK delivery, or a genuine on-screen freeze. See
    /// `Self.stallThresholdMs(forFps:)`.
    public private(set) var stallEventCount = 0

    /// Largest single gap (ms) observed between two consecutively-accepted
    /// frames' PTS, across the whole session. `0` if no gap ever exceeded
    /// `stallThresholdMs`.
    public private(set) var maxStallGapMs: Double = 0

    /// PTS of the last successfully-appended frame. `nil` until the first
    /// frame is accepted. Deliberately NOT advanced on a dropped frame, so a
    /// stretch of drops followed by an accept reports the FULL gap since the
    /// last real content, not just since the most recent attempt.
    private var lastAcceptedPTS: CMTime?

    /// Gap (ms) above which an accepted frame counts as a "stall" — see
    /// `Self.stallThresholdMs(forFps:)` for the derivation.
    private let stallThresholdMs: Double

    /// True if this session ever dropped a frame or recorded a stall —
    /// `stopCapture` uses this to decide whether a diagnostic `log`
    /// notification is worth emitting.
    public var hasDiagnosticWarnings: Bool {
        droppedFrameCount > 0 || stallEventCount > 0
    }

    /// Human-readable one-line summary for the `log` notification / stderr,
    /// or `nil` if nothing to report. Kept here (rather than in
    /// `CaptureService`) so the wording lives next to the counters it
    /// describes.
    public func diagnosticsSummary() -> String? {
        guard hasDiagnosticWarnings else { return nil }
        var parts: [String] = []
        if droppedFrameCount > 0 {
            parts.append("\(droppedFrameCount) frame(s) dropped under backpressure")
        }
        if stallEventCount > 0 {
            parts.append(
                "\(stallEventCount) stall event(s) detected, longest gap: \(Int(maxStallGapMs.rounded()))ms")
        }
        return parts.joined(separator: "; ")
    }

    /// codec is "h264"|"hevc", container is "mp4"|"mov" (data-model.md §VideoSettings).
    /// bitrate is bits-per-second (average). width/height must already be even
    /// (caller's responsibility per encoder requirements). `fps` is the
    /// configured target frame rate (data-model.md §VideoSettings) — used only
    /// to derive `stallThresholdMs` for bug #6 gap detection, defaults to 30
    /// so existing callers/tests that don't care about diagnostics don't need
    /// to change.
    public init(
        outputURL: URL, width: Int, height: Int, codec: String, container: String, bitrate: Int,
        fps: Int = 30
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
        hasStarted = true
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
            droppedFrameCount += 1
            return false
        }

        let accepted = input.append(sampleBuffer)
        if accepted {
            recordAcceptedFrame(pts: pts)
        } else {
            droppedFrameCount += 1
        }
        return accepted
    }

    /// Bug #6 gap detection: compares this accepted frame's PTS against the
    /// previously-accepted frame's PTS (NOT the previous attempt — dropped
    /// frames in between don't move `lastAcceptedPTS`, so a drop-then-accept
    /// sequence reports the full gap since the last real content landed).
    private func recordAcceptedFrame(pts: CMTime) {
        defer { lastAcceptedPTS = pts }
        guard let previous = lastAcceptedPTS,
            let gapMs = Self.gapMilliseconds(from: previous, to: pts)
        else { return }
        guard gapMs > stallThresholdMs else { return }
        stallEventCount += 1
        maxStallGapMs = max(maxStallGapMs, gapMs)
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

    /// Aborts writing and deletes whatever partial file exists at outputURL
    /// (cancelCapture's "discard the in-progress file" requirement).
    public func cancel() {
        assetWriter.cancelWriting()
        try? FileManager.default.removeItem(at: outputURL)
    }
}
