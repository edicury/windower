import Foundation
import XCTest

@testable import WindowerCaptureCore
import WindowerSidecarShared

/// Phase 19 (operator) — pure-logic tests for `captureFrame`'s param decoding,
/// downscale math and jpeg-quality normalization. A real
/// `SCScreenshotManager` grab needs the Screen Recording TCC grant, which CI
/// can't have (CLAUDE.md's "TCC permissions gate CI"), so the actual capture
/// path is e2e-gated the same way `CaptureServiceTests` treats live capture.
final class FrameCaptureTests: XCTestCase {

    private func decodeParams(_ json: String) throws -> CaptureFrameParams {
        try JSONDecoder().decode(CaptureFrameParams.self, from: Data(json.utf8))
    }

    // MARK: - Param decoding

    func testDecodeMinimalParamsDefaultsToPng() throws {
        let params = try decodeParams(#"{"target":{"kind":"display","id":"1"}}"#)
        XCTAssertEqual(params.target.kind, "display")
        XCTAssertEqual(params.target.id, "1")
        XCTAssertNil(params.format)
        XCTAssertNil(params.maxWidth)
        XCTAssertNil(params.quality)
        XCTAssertFalse(FrameCaptureService.isJPEG(format: params.format))
    }

    func testDecodeFullParams() throws {
        let params = try decodeParams(
            #"{"target":{"kind":"window","id":"42"},"format":"jpeg","maxWidth":1280,"quality":0.6}"#)
        XCTAssertEqual(params.target.kind, "window")
        XCTAssertEqual(params.maxWidth, 1280)
        XCTAssertEqual(params.quality, 0.6)
        XCTAssertTrue(FrameCaptureService.isJPEG(format: params.format))
    }

    func testFormatDetectionIsCaseInsensitive() {
        XCTAssertTrue(FrameCaptureService.isJPEG(format: "JPEG"))
        XCTAssertTrue(FrameCaptureService.isJPEG(format: "jpg"))
        XCTAssertFalse(FrameCaptureService.isJPEG(format: "png"))
        XCTAssertFalse(FrameCaptureService.isJPEG(format: "PNG"))
        XCTAssertFalse(FrameCaptureService.isJPEG(format: nil))
    }

    // MARK: - maxWidth downscale math

    func testNoMaxWidthKeepsNativePixelDimensions() {
        let dims = FrameCaptureService.scaledDimensions(
            nativeWidth: 3840, nativeHeight: 2160, maxWidth: nil)
        XCTAssertEqual(dims.width, 3840)
        XCTAssertEqual(dims.height, 2160)
    }

    func testMaxWidthDownscalesPreservingAspectRatio() {
        let dims = FrameCaptureService.scaledDimensions(
            nativeWidth: 3840, nativeHeight: 2160, maxWidth: 1920)
        XCTAssertEqual(dims.width, 1920)
        XCTAssertEqual(dims.height, 1080)
    }

    func testMaxWidthDownscaleRoundsHeight() {
        // 1512x982 (a MacBook Air native window) capped to 1000 wide:
        // 982 * (1000/1512) = 649.47 -> 649.
        let dims = FrameCaptureService.scaledDimensions(
            nativeWidth: 1512, nativeHeight: 982, maxWidth: 1000)
        XCTAssertEqual(dims.width, 1000)
        XCTAssertEqual(dims.height, 649)
    }

    func testMaxWidthLargerThanNativeNeverUpscales() {
        let dims = FrameCaptureService.scaledDimensions(
            nativeWidth: 800, nativeHeight: 600, maxWidth: 4000)
        XCTAssertEqual(dims.width, 800)
        XCTAssertEqual(dims.height, 600)
    }

    func testMaxWidthEqualToNativeIsANoOp() {
        let dims = FrameCaptureService.scaledDimensions(
            nativeWidth: 1280, nativeHeight: 720, maxWidth: 1280)
        XCTAssertEqual(dims.width, 1280)
        XCTAssertEqual(dims.height, 720)
    }

    func testZeroOrNegativeMaxWidthIsIgnored() {
        XCTAssertEqual(
            FrameCaptureService.scaledDimensions(nativeWidth: 100, nativeHeight: 50, maxWidth: 0)
                .width, 100)
        XCTAssertEqual(
            FrameCaptureService.scaledDimensions(nativeWidth: 100, nativeHeight: 50, maxWidth: -10)
                .width, 100)
    }

    func testExtremeDownscaleNeverProducesAZeroDimension() {
        let dims = FrameCaptureService.scaledDimensions(
            nativeWidth: 3840, nativeHeight: 2160, maxWidth: 1)
        XCTAssertEqual(dims.width, 1)
        XCTAssertGreaterThanOrEqual(dims.height, 1)
    }

    func testDegenerateNativeDimensionsClampToOne() {
        let dims = FrameCaptureService.scaledDimensions(
            nativeWidth: 0, nativeHeight: 0, maxWidth: nil)
        XCTAssertEqual(dims.width, 1)
        XCTAssertEqual(dims.height, 1)
    }

    // MARK: - jpeg quality

    func testQualityDefaultsWhenAbsent() {
        XCTAssertEqual(FrameCaptureService.normalizedQuality(nil), 0.8)
    }

    func testQualityIsClampedToZeroOne() {
        XCTAssertEqual(FrameCaptureService.normalizedQuality(0.35), 0.35)
        XCTAssertEqual(FrameCaptureService.normalizedQuality(-1), 0)
        XCTAssertEqual(FrameCaptureService.normalizedQuality(5), 1)
    }

    // MARK: - Result wire shape

    func testResultEncodesTheContractFields() throws {
        let result = CaptureFrameResult(
            imageBase64: "AAAA", width: 1920, height: 1080, scale: 2.0)
        let data = try JSONEncoder().encode(result)
        let dict = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        XCTAssertEqual(dict?["imageBase64"] as? String, "AAAA")
        XCTAssertEqual(dict?["width"] as? Int, 1920)
        XCTAssertEqual(dict?["height"] as? Int, 1080)
        XCTAssertEqual(dict?["scale"] as? Double, 2.0)
    }
}
