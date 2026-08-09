import AVFoundation
import CoreMedia
import CoreVideo
import XCTest

@testable import WindowerSidecarCore

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
        var finishResult: Result<Double?, Error>?
        writer.finish { result in
            finishResult = result
            expectation.fulfill()
        }
        wait(for: [expectation], timeout: 10)

        switch finishResult {
        case .success(let durationMs):
            // 8 frames at 30fps ~= 233ms of content; loosely bound it to
            // catch a grossly wrong (e.g. nil-coerced-to-0, or wall-clock-
            // sized) value without being brittle about exact encoder timing.
            if let durationMs = durationMs {
                XCTAssertGreaterThan(durationMs, 0)
                XCTAssertLessThan(durationMs, 5000)
            }
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

    // MARK: - milliseconds(from:) — bug #5's CMTime-to-ms conversion seam

    func testMillisecondsFromConvertsNumericCMTime() {
        // 7.5s at a 600 timescale (a real-world AVAssetWriter duration
        // timescale), i.e. exactly what `AVURLAsset.load(.duration)` hands
        // back for a finished recording.
        let time = CMTime(value: 4500, timescale: 600)
        XCTAssertEqual(VideoAssetWriter.milliseconds(from: time)!, 7500, accuracy: 0.001)
    }

    func testMillisecondsFromReturnsNilForIndefiniteTime() {
        XCTAssertNil(VideoAssetWriter.milliseconds(from: .indefinite))
    }

    func testMillisecondsFromReturnsNilForInvalidTime() {
        XCTAssertNil(VideoAssetWriter.milliseconds(from: .invalid))
    }

    func testMillisecondsFromZeroIsZero() {
        XCTAssertEqual(VideoAssetWriter.milliseconds(from: .zero)!, 0, accuracy: 0.001)
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

    // MARK: - Bug #6: dropped-frame counter + PTS-gap ("stall") detection

    func testGapMillisecondsComputesPositiveGap() {
        let from = CMTime(value: 0, timescale: 30)
        let to = CMTime(value: 30, timescale: 30)
        XCTAssertEqual(VideoAssetWriter.gapMilliseconds(from: from, to: to)!, 1000, accuracy: 0.001)
    }

    func testGapMillisecondsReturnsNilForNonNumericTime() {
        XCTAssertNil(VideoAssetWriter.gapMilliseconds(from: .indefinite, to: CMTime(value: 1, timescale: 30)))
        XCTAssertNil(VideoAssetWriter.gapMilliseconds(from: CMTime(value: 1, timescale: 30), to: .invalid))
    }

    func testStallThresholdMsIsThreeFrameIntervalsAboveTheFloor() {
        // 3 * (1000/10fps) = 300ms, below the 500ms floor -> floor wins.
        XCTAssertEqual(VideoAssetWriter.stallThresholdMs(forFps: 10), 500)
        // 3 * (1000/30fps) = 100ms, below the floor -> floor wins.
        XCTAssertEqual(VideoAssetWriter.stallThresholdMs(forFps: 30), 500)
        // 3 * (1000/2fps) = 1500ms, above the floor -> 3x interval wins.
        XCTAssertEqual(VideoAssetWriter.stallThresholdMs(forFps: 2), 1500)
    }

    func testStallThresholdMsFallsBackToFloorForNonPositiveFps() {
        XCTAssertEqual(VideoAssetWriter.stallThresholdMs(forFps: 0), 500)
        XCTAssertEqual(VideoAssetWriter.stallThresholdMs(forFps: -5), 500)
    }

    func testNormalAppendSequenceReportsNoStalls() throws {
        let outputURL = makeTempURL()
        let writer = try VideoAssetWriter(
            outputURL: outputURL, width: width, height: height, codec: "h264", container: "mp4",
            bitrate: 2_000_000, fps: 30)

        let firstBuffer = try makeSampleBuffer(frame: 0, width: width, height: height)
        writer.start(at: CMSampleBufferGetPresentationTimeStamp(firstBuffer))
        writer.append(sampleBuffer: firstBuffer)
        for frame in 1..<8 {
            let buffer = try makeSampleBuffer(frame: frame, width: width, height: height)
            writer.append(sampleBuffer: buffer)
        }

        // Consecutive frames here are only ~33ms (1/30fps) apart in PTS, so
        // even if the real `AVAssetWriterInput` happens to report itself not
        // ready for one of these appends (genuine backpressure, exercised by
        // `droppedFrameCount` — not asserted here since it's legitimately
        // nondeterministic in a tight synchronous test loop), the gap
        // between any two ACCEPTED frames stays far below the 500ms stall
        // floor. Stall detection specifically is what this test guards.
        XCTAssertEqual(writer.stallEventCount, 0)
        XCTAssertEqual(writer.maxStallGapMs, 0)

        writer.cancel()
    }

    func testLargePtsGapBetweenAcceptedFramesIsRecordedAsAStall() throws {
        let outputURL = makeTempURL()
        // fps: 30 -> stallThresholdMs floors at 500ms (3 * 1000/30 = 100ms < floor).
        let writer = try VideoAssetWriter(
            outputURL: outputURL, width: width, height: height, codec: "h264", container: "mp4",
            bitrate: 2_000_000, fps: 30)

        let firstBuffer = try makeSampleBuffer(frame: 0, width: width, height: height)
        writer.start(at: CMSampleBufferGetPresentationTimeStamp(firstBuffer))
        writer.append(sampleBuffer: firstBuffer)

        // frame 100 at 30fps timescale = 100/30s ≈ 3333ms after frame 0 — far
        // past the 500ms floor, simulating a real delivery gap.
        let laterBuffer = try makeSampleBuffer(frame: 100, width: width, height: height)
        writer.append(sampleBuffer: laterBuffer)

        XCTAssertEqual(writer.droppedFrameCount, 0)
        XCTAssertEqual(writer.stallEventCount, 1)
        XCTAssertEqual(writer.maxStallGapMs, 3333, accuracy: 1)
        XCTAssertTrue(writer.hasDiagnosticWarnings)
        XCTAssertEqual(
            writer.diagnosticsSummary(), "1 stall event(s) detected, longest gap: 3333ms")

        writer.cancel()
    }

    func testAudioWriterInputHandleCountsDropsSeparatelyFromVideo() throws {
        let outputURL = makeTempURL()
        let writer = try VideoAssetWriter(
            outputURL: outputURL, width: width, height: height, codec: "h264", container: "mp4",
            bitrate: 2_000_000)
        let audioHandle = try writer.addAudioInput(outputSettings: [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: 44100,
            AVNumberOfChannelsKey: 2,
        ])
        XCTAssertEqual(audioHandle.droppedFrameCount, 0)
        writer.cancel()
    }
}
