import AVFoundation
import CoreMedia
import CoreVideo
import XCTest

import WindowerSidecarCore

/// Integration tests for `VideoAssetWriter` — real `AVAssetWriter` file I/O
/// against synthetic `CVPixelBuffer`/`CMSampleBuffer` frames. This is
/// headless-safe (no screen-recording/Accessibility TCC grant needed, per
/// CLAUDE.md's "TCC permissions gate CI" note) so, unlike the SCStream
/// wiring, these can and must actually run and pass in CI.
final class VideoAssetWriterTests: XCTestCase {

    private let width = 320
    private let height = 240

    private func makeTempURL(ext: String = "mp4") -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + "." + ext)
    }

    /// Builds one synthetic black BGRA frame wrapped as a `CMSampleBuffer`
    /// with presentation timestamp `frame / 30fps`.
    private func makeSampleBuffer(frame: Int, width: Int, height: Int) throws -> CMSampleBuffer {
        var pixelBufferOpt: CVPixelBuffer?
        let status = CVPixelBufferCreate(
            kCFAllocatorDefault, width, height, kCVPixelFormatType_32BGRA, nil, &pixelBufferOpt)
        guard status == kCVReturnSuccess, let pixelBuffer = pixelBufferOpt else {
            throw XCTSkip("CVPixelBufferCreate failed with status \(status)")
        }

        CVPixelBufferLockBaseAddress(pixelBuffer, [])
        if let base = CVPixelBufferGetBaseAddress(pixelBuffer) {
            let rowBytes = CVPixelBufferGetBytesPerRow(pixelBuffer)
            memset(base, 0, rowBytes * height)
        }
        CVPixelBufferUnlockBaseAddress(pixelBuffer, [])

        var formatDescriptionOpt: CMVideoFormatDescription?
        let formatStatus = CMVideoFormatDescriptionCreateForImageBuffer(
            allocator: kCFAllocatorDefault, imageBuffer: pixelBuffer, formatDescriptionOut: &formatDescriptionOpt)
        guard formatStatus == noErr, let formatDescription = formatDescriptionOpt else {
            throw VideoAssetWriterError.writerSetupFailed(
                "CMVideoFormatDescriptionCreateForImageBuffer failed: \(formatStatus)")
        }

        let presentationTime = CMTime(value: Int64(frame), timescale: 30)
        var timingInfo = CMSampleTimingInfo(
            duration: CMTime(value: 1, timescale: 30),
            presentationTimeStamp: presentationTime,
            decodeTimeStamp: .invalid)

        var sampleBufferOpt: CMSampleBuffer?
        let sampleStatus = CMSampleBufferCreateForImageBuffer(
            allocator: kCFAllocatorDefault,
            imageBuffer: pixelBuffer,
            dataReady: true,
            makeDataReadyCallback: nil,
            refcon: nil,
            formatDescription: formatDescription,
            sampleTiming: &timingInfo,
            sampleBufferOut: &sampleBufferOpt)
        guard sampleStatus == noErr, let sampleBuffer = sampleBufferOpt else {
            throw VideoAssetWriterError.writerSetupFailed(
                "CMSampleBufferCreateForImageBuffer failed: \(sampleStatus)")
        }
        return sampleBuffer
    }

    // MARK: - Happy path: write frames, finish, verify the file

    func testWritesPlayableFileWithExpectedTrackAndSize() throws {
        let outputURL = makeTempURL()
        let writer = try VideoAssetWriter(
            outputURL: outputURL, width: width, height: height, codec: "h264", container: "mp4",
            bitrate: 2_000_000)

        let frameCount = 8
        let firstBuffer = try makeSampleBuffer(frame: 0, width: width, height: height)
        writer.start(at: CMSampleBufferGetPresentationTimeStamp(firstBuffer))
        writer.append(sampleBuffer: firstBuffer)
        for frame in 1..<frameCount {
            let buffer = try makeSampleBuffer(frame: frame, width: width, height: height)
            writer.append(sampleBuffer: buffer)
        }

        let expectation = expectation(description: "finishWriting completes")
        var finishResult: Result<Void, Error>?
        writer.finish { result in
            finishResult = result
            expectation.fulfill()
        }
        wait(for: [expectation], timeout: 10)

        switch finishResult {
        case .success:
            break
        case .failure(let error):
            XCTFail("finish() reported failure: \(error)")
        case .none:
            XCTFail("finish() never called its completion handler")
        }

        XCTAssertTrue(FileManager.default.fileExists(atPath: outputURL.path))
        let attributes = try FileManager.default.attributesOfItem(atPath: outputURL.path)
        let fileSize = attributes[.size] as? Int ?? 0
        XCTAssertGreaterThan(fileSize, 0)

        let asset = AVURLAsset(url: outputURL)
        let tracks = asset.tracks(withMediaType: .video)
        XCTAssertEqual(tracks.count, 1)
        if let track = tracks.first {
            let naturalSize = track.naturalSize
            XCTAssertEqual(Int(naturalSize.width), width)
            XCTAssertEqual(Int(naturalSize.height), height)
        }

        try? FileManager.default.removeItem(at: outputURL)
    }

    // MARK: - cancel()

    func testCancelDiscardsPartialFile() throws {
        let outputURL = makeTempURL()
        let writer = try VideoAssetWriter(
            outputURL: outputURL, width: width, height: height, codec: "h264", container: "mp4",
            bitrate: 2_000_000)

        let firstBuffer = try makeSampleBuffer(frame: 0, width: width, height: height)
        writer.start(at: CMSampleBufferGetPresentationTimeStamp(firstBuffer))
        writer.append(sampleBuffer: firstBuffer)
        let secondBuffer = try makeSampleBuffer(frame: 1, width: width, height: height)
        writer.append(sampleBuffer: secondBuffer)

        writer.cancel()

        XCTAssertFalse(FileManager.default.fileExists(atPath: outputURL.path))
    }

    // MARK: - init validation

    func testInitThrowsForUnsupportedCodec() {
        let outputURL = makeTempURL()
        XCTAssertThrowsError(
            try VideoAssetWriter(
                outputURL: outputURL, width: width, height: height, codec: "vp9", container: "mp4",
                bitrate: 2_000_000)
        ) { error in
            guard case VideoAssetWriterError.unsupportedCodec(let codec) = error else {
                XCTFail("Expected unsupportedCodec, got \(error)")
                return
            }
            XCTAssertEqual(codec, "vp9")
        }
    }

    func testInitThrowsForUnsupportedContainer() {
        let outputURL = makeTempURL(ext: "webm")
        XCTAssertThrowsError(
            try VideoAssetWriter(
                outputURL: outputURL, width: width, height: height, codec: "h264", container: "webm",
                bitrate: 2_000_000)
        ) { error in
            guard case VideoAssetWriterError.unsupportedContainer(let container) = error else {
                XCTFail("Expected unsupportedContainer, got \(error)")
                return
            }
            XCTAssertEqual(container, "webm")
        }
    }
}
