import AVFoundation
import CoreMedia
import CoreVideo
import XCTest

import WindowerCaptureCore
import WindowerSidecarShared

/// Integration tests for `VideoAssetWriter`'s audio-input support
/// (`addAudioInput(outputSettings:)` / `AudioWriterInputHandle`) — real
/// `AVAssetWriter` file I/O against synthetic video + audio `CMSampleBuffer`s.
/// Headless-safe (no TCC grant needed), same rationale as
/// `VideoAssetWriterTests`. Kept in its own file per Phase 5 task split: the
/// video-only test file stays untouched so its existing suite keeps passing
/// unmodified.
final class AudioAssetWriterTests: XCTestCase {

    private let width = 320
    private let height = 240

    private func makeTempURL(ext: String = "mp4") -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + "." + ext)
    }

    /// Builds one synthetic black BGRA frame wrapped as a `CMSampleBuffer`
    /// with presentation timestamp `frame / 30fps`. Mirrors
    /// `VideoAssetWriterTests.makeSampleBuffer` — duplicated locally rather
    /// than shared, matching this codebase's existing per-file test-helper
    /// pattern (each test file is self-contained).
    private func makeVideoSampleBuffer(frame: Int, width: Int, height: Int) throws -> CMSampleBuffer {
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

    /// Builds one synthetic silent LPCM 16-bit stereo 44100Hz `CMSampleBuffer`
    /// (`frameCount` audio frames) with presentation timestamp
    /// `sampleIndex / 44100`. This is the *source* format handed to
    /// `append` — `AVAssetWriterInput` transcodes to whatever
    /// `outputSettings` the input was created with (e.g. AAC), so the source
    /// format only needs to be a simple, valid PCM buffer, per the task brief.
    private func makeAudioSampleBuffer(sampleIndex: Int64, frameCount: Int = 1024) throws -> CMSampleBuffer {
        var asbd = AudioStreamBasicDescription(
            mSampleRate: 44100,
            mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked,
            mBytesPerPacket: 4,
            mFramesPerPacket: 1,
            mBytesPerFrame: 4,
            mChannelsPerFrame: 2,
            mBitsPerChannel: 16,
            mReserved: 0)

        var formatDescriptionOpt: CMAudioFormatDescription?
        let formatStatus = CMAudioFormatDescriptionCreate(
            allocator: kCFAllocatorDefault,
            asbd: &asbd,
            layoutSize: 0,
            layout: nil,
            magicCookieSize: 0,
            magicCookie: nil,
            extensions: nil,
            formatDescriptionOut: &formatDescriptionOpt)
        guard formatStatus == noErr, let formatDescription = formatDescriptionOpt else {
            throw VideoAssetWriterError.writerSetupFailed(
                "CMAudioFormatDescriptionCreate failed: \(formatStatus)")
        }

        let bytesPerFrame = Int(asbd.mBytesPerFrame)
        let dataSize = frameCount * bytesPerFrame
        var blockBufferOpt: CMBlockBuffer?
        let blockStatus = CMBlockBufferCreateWithMemoryBlock(
            allocator: kCFAllocatorDefault,
            memoryBlock: nil,
            blockLength: dataSize,
            blockAllocator: kCFAllocatorDefault,
            customBlockSource: nil,
            offsetToData: 0,
            dataLength: dataSize,
            flags: 0,
            blockBufferOut: &blockBufferOpt)
        guard blockStatus == kCMBlockBufferNoErr, let blockBuffer = blockBufferOpt else {
            throw VideoAssetWriterError.writerSetupFailed(
                "CMBlockBufferCreateWithMemoryBlock failed: \(blockStatus)")
        }
        let fillStatus = CMBlockBufferFillDataBytes(
            with: 0, blockBuffer: blockBuffer, offsetIntoDestination: 0, dataLength: dataSize)
        guard fillStatus == kCMBlockBufferNoErr else {
            throw VideoAssetWriterError.writerSetupFailed(
                "CMBlockBufferFillDataBytes failed: \(fillStatus)")
        }

        let presentationTime = CMTime(value: sampleIndex, timescale: 44100)
        var sampleBufferOpt: CMSampleBuffer?
        let sampleStatus = CMAudioSampleBufferCreateReadyWithPacketDescriptions(
            allocator: kCFAllocatorDefault,
            dataBuffer: blockBuffer,
            formatDescription: formatDescription,
            sampleCount: frameCount,
            presentationTimeStamp: presentationTime,
            packetDescriptions: nil,
            sampleBufferOut: &sampleBufferOpt)
        guard sampleStatus == noErr, let sampleBuffer = sampleBufferOpt else {
            throw VideoAssetWriterError.writerSetupFailed(
                "CMAudioSampleBufferCreateReadyWithPacketDescriptions failed: \(sampleStatus)")
        }
        return sampleBuffer
    }

    private var aacOutputSettings: [String: Any] {
        [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: 44100,
            AVNumberOfChannelsKey: 2,
            AVEncoderBitRateKey: 128_000,
        ]
    }

    private func runFinish(_ writer: VideoAssetWriter) -> Result<Double?, Error> {
        let expectation = expectation(description: "finishWriting completes")
        var finishResult: Result<Double?, Error>?
        writer.finish { result in
            finishResult = result
            expectation.fulfill()
        }
        wait(for: [expectation], timeout: 10)
        guard let result = finishResult else {
            XCTFail("finish() never called its completion handler")
            return .failure(VideoAssetWriterError.writerSetupFailed("no completion"))
        }
        return result
    }

    // MARK: - 1 video + 1 audio

    func testWritesVideoAndSingleAudioTrack() throws {
        let outputURL = makeTempURL()
        let writer = try VideoAssetWriter(
            outputURL: outputURL, width: width, height: height, codec: "h264", container: "mp4",
            bitrate: 2_000_000)
        let audioHandle = try writer.addAudioInput(outputSettings: aacOutputSettings)

        let firstVideoBuffer = try makeVideoSampleBuffer(frame: 0, width: width, height: height)
        writer.start(at: CMSampleBufferGetPresentationTimeStamp(firstVideoBuffer))
        writer.append(sampleBuffer: firstVideoBuffer)
        for frame in 1..<8 {
            writer.append(sampleBuffer: try makeVideoSampleBuffer(frame: frame, width: width, height: height))
        }
        for i in 0..<4 {
            audioHandle.append(sampleBuffer: try makeAudioSampleBuffer(sampleIndex: Int64(i) * 1024))
        }

        if case .failure(let error) = runFinish(writer) {
            XCTFail("finish() reported failure: \(error)")
        }

        let asset = AVURLAsset(url: outputURL)
        XCTAssertEqual(asset.tracks(withMediaType: .video).count, 1)
        XCTAssertEqual(asset.tracks(withMediaType: .audio).count, 1)

        try? FileManager.default.removeItem(at: outputURL)
    }

    // MARK: - 1 video + 2 audio (system + mic)

    func testWritesVideoAndTwoAudioTracks() throws {
        let outputURL = makeTempURL()
        let writer = try VideoAssetWriter(
            outputURL: outputURL, width: width, height: height, codec: "h264", container: "mp4",
            bitrate: 2_000_000)
        let systemAudioHandle = try writer.addAudioInput(outputSettings: aacOutputSettings)
        let micAudioHandle = try writer.addAudioInput(outputSettings: aacOutputSettings)

        let firstVideoBuffer = try makeVideoSampleBuffer(frame: 0, width: width, height: height)
        writer.start(at: CMSampleBufferGetPresentationTimeStamp(firstVideoBuffer))
        writer.append(sampleBuffer: firstVideoBuffer)
        for frame in 1..<8 {
            writer.append(sampleBuffer: try makeVideoSampleBuffer(frame: frame, width: width, height: height))
        }
        for i in 0..<4 {
            systemAudioHandle.append(sampleBuffer: try makeAudioSampleBuffer(sampleIndex: Int64(i) * 1024))
            micAudioHandle.append(sampleBuffer: try makeAudioSampleBuffer(sampleIndex: Int64(i) * 1024))
        }

        if case .failure(let error) = runFinish(writer) {
            XCTFail("finish() reported failure: \(error)")
        }

        let asset = AVURLAsset(url: outputURL)
        XCTAssertEqual(asset.tracks(withMediaType: .video).count, 1)
        XCTAssertEqual(asset.tracks(withMediaType: .audio).count, 2)
        XCTAssertEqual(asset.tracks.count, 3)

        try? FileManager.default.removeItem(at: outputURL)
    }

    // MARK: - Audio input added but never fed

    func testFinishSucceedsWithUnusedAudioInput() throws {
        let outputURL = makeTempURL()
        let writer = try VideoAssetWriter(
            outputURL: outputURL, width: width, height: height, codec: "h264", container: "mp4",
            bitrate: 2_000_000)
        _ = try writer.addAudioInput(outputSettings: aacOutputSettings)

        let firstVideoBuffer = try makeVideoSampleBuffer(frame: 0, width: width, height: height)
        writer.start(at: CMSampleBufferGetPresentationTimeStamp(firstVideoBuffer))
        writer.append(sampleBuffer: firstVideoBuffer)
        for frame in 1..<8 {
            writer.append(sampleBuffer: try makeVideoSampleBuffer(frame: frame, width: width, height: height))
        }
        // Deliberately never append any audio sample buffers.

        if case .failure(let error) = runFinish(writer) {
            XCTFail("finish() reported failure: \(error)")
        }

        XCTAssertTrue(FileManager.default.fileExists(atPath: outputURL.path))
        try? FileManager.default.removeItem(at: outputURL)
    }

    // MARK: - cancel() with audio inputs

    func testCancelDiscardsPartialFileWithAudioInputs() throws {
        let outputURL = makeTempURL()
        let writer = try VideoAssetWriter(
            outputURL: outputURL, width: width, height: height, codec: "h264", container: "mp4",
            bitrate: 2_000_000)
        let audioHandle = try writer.addAudioInput(outputSettings: aacOutputSettings)

        let firstVideoBuffer = try makeVideoSampleBuffer(frame: 0, width: width, height: height)
        writer.start(at: CMSampleBufferGetPresentationTimeStamp(firstVideoBuffer))
        writer.append(sampleBuffer: firstVideoBuffer)
        audioHandle.append(sampleBuffer: try makeAudioSampleBuffer(sampleIndex: 0))

        writer.cancel()

        XCTAssertFalse(FileManager.default.fileExists(atPath: outputURL.path))
    }
}
