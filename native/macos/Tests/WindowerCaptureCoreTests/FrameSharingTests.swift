import CoreVideo
import Foundation
import XCTest

@testable import WindowerCaptureCore
import WindowerSidecarShared

/// Phase 21 — the frame-sharing optimization
/// (contracts/sidecar-protocol.md §"Frame sharing").
///
/// The hit/miss decision (`streamCoversRequestedTarget`), the `fresh` opt-out,
/// the parked-frame store's lifecycle and the shared-frame render path are all
/// pure logic over a `CVPixelBuffer` — no `SCStream`, no TCC grant — so all of
/// it is covered headlessly here. What is NOT covered here is a real stream
/// actually delivering a frame; that stays e2e-gated like every other live
/// capture path.
final class FrameSharingTests: XCTestCase {

    private func target(_ kind: String, id: String? = nil, displayId: String? = nil, bounds: Rect? = nil)
        -> CaptureTargetInput
    {
        CaptureTargetInput(kind: kind, id: id, displayId: displayId, bounds: bounds)
    }

    private func params(fresh: Bool? = nil, maxWidth: Double? = nil, format: String? = nil)
        throws -> CaptureFrameParams
    {
        var json = #"{"target":{"kind":"display","id":"1"}"#
        if let fresh = fresh { json += ",\"fresh\":\(fresh)" }
        if let maxWidth = maxWidth { json += ",\"maxWidth\":\(maxWidth)" }
        if let format = format { json += ",\"format\":\"\(format)\"" }
        json += "}"
        return try JSONDecoder().decode(CaptureFrameParams.self, from: Data(json.utf8))
    }

    private func makePixelBuffer(width: Int, height: Int) throws -> CVPixelBuffer {
        var buffer: CVPixelBuffer?
        let status = CVPixelBufferCreate(
            kCFAllocatorDefault, width, height, kCVPixelFormatType_32BGRA,
            [kCVPixelBufferCGImageCompatibilityKey: true] as CFDictionary, &buffer)
        guard status == kCVReturnSuccess, let buffer = buffer else {
            throw XCTSkip("CVPixelBufferCreate failed with status \(status)")
        }
        return buffer
    }

    // MARK: - Cache hit/miss: streamCoversRequestedTarget

    func testDisplayStreamCoversTheSameDisplay() {
        XCTAssertTrue(
            FrameCaptureService.streamCoversRequestedTarget(
                streamTarget: target("display", id: "1"),
                requestedTarget: target("display", id: "1")))
    }

    func testDisplayStreamDoesNotCoverADifferentDisplay() {
        XCTAssertFalse(
            FrameCaptureService.streamCoversRequestedTarget(
                streamTarget: target("display", id: "1"),
                requestedTarget: target("display", id: "2")))
    }

    func testWindowStreamCoversTheSameWindow() {
        XCTAssertTrue(
            FrameCaptureService.streamCoversRequestedTarget(
                streamTarget: target("window", id: "77"),
                requestedTarget: target("window", id: "77")))
    }

    func testKindsMustMatch() {
        // A display stream is NOT allowed to serve a window request even
        // though the window is visually inside it — serving it would mean
        // re-deriving the crop, which is exactly the correctness risk the
        // exact-match rule refuses to take.
        XCTAssertFalse(
            FrameCaptureService.streamCoversRequestedTarget(
                streamTarget: target("display", id: "1"),
                requestedTarget: target("window", id: "1")))
        XCTAssertFalse(
            FrameCaptureService.streamCoversRequestedTarget(
                streamTarget: target("window", id: "1"),
                requestedTarget: target("display", id: "1")))
    }

    func testRegionNeverShares() {
        let region = target(
            "region", displayId: "1", bounds: Rect(x: 0, y: 0, width: 100, height: 100))
        XCTAssertFalse(
            FrameCaptureService.streamCoversRequestedTarget(
                streamTarget: region, requestedTarget: region))
    }

    /// A nil id on either side means "the main display", which can only be
    /// resolved with the `SCShareableContent` round-trip this path exists to
    /// avoid — so it must miss rather than guess.
    func testNilIdsMiss() {
        XCTAssertFalse(
            FrameCaptureService.streamCoversRequestedTarget(
                streamTarget: target("display", id: "1"),
                requestedTarget: target("display", id: nil)))
        XCTAssertFalse(
            FrameCaptureService.streamCoversRequestedTarget(
                streamTarget: target("display", id: nil),
                requestedTarget: target("display", id: "1")))
    }

    func testUnknownKindMisses() {
        XCTAssertFalse(
            FrameCaptureService.streamCoversRequestedTarget(
                streamTarget: target("hologram", id: "1"),
                requestedTarget: target("hologram", id: "1")))
    }

    /// With no capture session running there is nothing to share from, so the
    /// manager reports a miss and `captureFrame` falls back to a real capture.
    func testSharedFrameLookupMissesWithNoActiveSession() {
        XCTAssertEqual(CaptureSessionManager.shared.activeSessionCount, 0)
        XCTAssertNil(CaptureSessionManager.shared.sharedFrame(for: target("display", id: "1")))
    }

    // MARK: - `fresh` opt-out decoding

    func testFreshDefaultsToAbsentWhichPermitsSharing() throws {
        XCTAssertNil(try params().fresh)
        XCTAssertNotEqual(try params().fresh, true)
    }

    func testFreshTrueIsDecodedAndOptsOut() throws {
        XCTAssertEqual(try params(fresh: true).fresh, true)
    }

    func testFreshFalseIsDecodedAndStillPermitsSharing() throws {
        XCTAssertEqual(try params(fresh: false).fresh, false)
        XCTAssertNotEqual(try params(fresh: false).fresh, true)
    }

    // MARK: - SharedFrameStore lifecycle

    func testStoreStartsEmpty() {
        let store = SharedFrameStore()
        XCTAssertNil(store.latestFrame())
        XCTAssertNil(store.latestFrameAgeMs())
    }

    func testStoreReturnsTheMostRecentlyStoredFrame() throws {
        let store = SharedFrameStore()
        let first = try makePixelBuffer(width: 4, height: 4)
        let second = try makePixelBuffer(width: 8, height: 8)
        store.store(first)
        store.store(second)
        let latest = try XCTUnwrap(store.latestFrame())
        XCTAssertEqual(CVPixelBufferGetWidth(latest), 8)
    }

    func testStoreReportsFrameAgeFromTheInjectedClock() throws {
        var now: Double = 1000
        let store = SharedFrameStore(clockMs: { now })
        store.store(try makePixelBuffer(width: 4, height: 4))
        XCTAssertEqual(store.latestFrameAgeMs(), 0)
        now = 1033  // one frame period at 30fps — the staleness the contract promises
        XCTAssertEqual(store.latestFrameAgeMs(), 33)
    }

    func testClearDropsTheParkedFrame() throws {
        let store = SharedFrameStore()
        store.store(try makePixelBuffer(width: 4, height: 4))
        store.clear()
        XCTAssertNil(store.latestFrame())
        XCTAssertNil(store.latestFrameAgeMs())
    }

    // MARK: - Shared-frame render path

    func testRenderSharedFrameProducesTheSameWireShapeAsARealCapture() throws {
        let shared = SharedFrame(
            pixelBuffer: try makePixelBuffer(width: 200, height: 100),
            sourcePointsWidth: 100, sessionId: "s-1")
        let result = try FrameCaptureService.renderSharedFrame(shared, params: try params())
        XCTAssertEqual(result.width, 200)
        XCTAssertEqual(result.height, 100)
        // 200 output pixels over 100 source points — the same "output pixels
        // per source point" definition the real-capture path reports.
        XCTAssertEqual(result.scale, 2.0)
        XCTAssertFalse(result.imageBase64.isEmpty)
        XCTAssertNotNil(Data(base64Encoded: result.imageBase64))
    }

    func testRenderSharedFrameHonorsMaxWidthWithTheSameDownscaleMath() throws {
        let shared = SharedFrame(
            pixelBuffer: try makePixelBuffer(width: 200, height: 100),
            sourcePointsWidth: 100, sessionId: "s-1")
        let result = try FrameCaptureService.renderSharedFrame(
            shared, params: try params(maxWidth: 50))
        XCTAssertEqual(result.width, 50)
        XCTAssertEqual(result.height, 25)
        // Downscaling proportionally lowers `scale`, per CaptureFrameResult's
        // contract — 50 output pixels over 100 source points.
        XCTAssertEqual(result.scale, 0.5)
    }

    func testRenderSharedFrameNeverUpscales() throws {
        let shared = SharedFrame(
            pixelBuffer: try makePixelBuffer(width: 64, height: 32),
            sourcePointsWidth: 64, sessionId: "s-1")
        let result = try FrameCaptureService.renderSharedFrame(
            shared, params: try params(maxWidth: 4096))
        XCTAssertEqual(result.width, 64)
        XCTAssertEqual(result.height, 32)
    }

    func testRenderSharedFrameEncodesJpegWhenRequested() throws {
        let shared = SharedFrame(
            pixelBuffer: try makePixelBuffer(width: 32, height: 32),
            sourcePointsWidth: 32, sessionId: "s-1")
        let png = try FrameCaptureService.renderSharedFrame(shared, params: try params())
        let jpeg = try FrameCaptureService.renderSharedFrame(
            shared, params: try params(format: "jpeg"))
        let pngBytes = try XCTUnwrap(Data(base64Encoded: png.imageBase64))
        let jpegBytes = try XCTUnwrap(Data(base64Encoded: jpeg.imageBase64))
        // PNG magic vs JPEG SOI — the shared path goes through the same
        // ImageIO encoder the real-capture path uses.
        XCTAssertEqual(Array(pngBytes.prefix(4)), [0x89, 0x50, 0x4E, 0x47])
        XCTAssertEqual(Array(jpegBytes.prefix(2)), [0xFF, 0xD8])
    }

    func testRenderSharedFrameReportsUnitScaleWhenSourceWidthIsUnknown() throws {
        let shared = SharedFrame(
            pixelBuffer: try makePixelBuffer(width: 10, height: 10),
            sourcePointsWidth: 0, sessionId: "s-1")
        let result = try FrameCaptureService.renderSharedFrame(shared, params: try params())
        XCTAssertEqual(result.scale, 1.0)
    }
}
