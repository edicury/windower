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
            return false
        }
        return input.append(sampleBuffer)
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

    /// codec is "h264"|"hevc", container is "mp4"|"mov" (data-model.md §VideoSettings).
    /// bitrate is bits-per-second (average). width/height must already be even
    /// (caller's responsibility per encoder requirements).
    public init(outputURL: URL, width: Int, height: Int, codec: String, container: String, bitrate: Int) throws {
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
        guard input.isReadyForMoreMediaData else {
            return false
        }
        return input.append(sampleBuffer)
    }

    /// Finalizes the file. MUST be awaited by the caller before treating the
    /// output file as valid/complete (AVAssetWriter's finishWriting is async
    /// and the file is corrupt/truncated if read before it completes).
    public func finish(completion: @escaping (Result<Void, Error>) -> Void) {
        input.markAsFinished()
        for audioInput in audioInputs {
            audioInput.markAsFinished()
        }
        assetWriter.finishWriting { [assetWriter] in
            switch assetWriter.status {
            case .completed:
                completion(.success(()))
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

    /// Aborts writing and deletes whatever partial file exists at outputURL
    /// (cancelCapture's "discard the in-progress file" requirement).
    public func cancel() {
        assetWriter.cancelWriting()
        try? FileManager.default.removeItem(at: outputURL)
    }
}
