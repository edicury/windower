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
