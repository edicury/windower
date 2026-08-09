import CoreMedia
import XCTest

import WindowerSidecarCore

/// Pure geometry/config math tests for `CaptureConfigService` — bitrate
/// presets, frame-interval conversion, resolution resolution/rounding, and
/// region sourceRect math. No SCStream/AVAssetWriter involved; these must
/// run headlessly.
final class CaptureConfigTests: XCTestCase {

    // MARK: - bitrate(forQuality:width:height:)

    func testQualityTiersAreDistinctAndMonotonicallyIncreasing() {
        let low = CaptureConfigService.bitrate(forQuality: "low", width: 1920, height: 1080)
        let medium = CaptureConfigService.bitrate(forQuality: "medium", width: 1920, height: 1080)
        let high = CaptureConfigService.bitrate(forQuality: "high", width: 1920, height: 1080)
        let losslessIsh = CaptureConfigService.bitrate(forQuality: "lossless_ish", width: 1920, height: 1080)

        XCTAssertLessThan(low, medium)
        XCTAssertLessThan(medium, high)
        XCTAssertLessThan(high, losslessIsh)
    }

    func testUnknownQualityFallsBackToMediumWithoutCrashing() {
        let medium = CaptureConfigService.bitrate(forQuality: "medium", width: 1920, height: 1080)
        let unknown = CaptureConfigService.bitrate(forQuality: "ultra-mega", width: 1920, height: 1080)
        XCTAssertEqual(unknown, medium)
    }

    func testMediumAt1080pMatchesWorkedExample() {
        let bitrate = CaptureConfigService.bitrate(forQuality: "medium", width: 1920, height: 1080)
        // 0.08 * 1920 * 1080 * 30 = 4,976,640 bps
        XCTAssertEqual(bitrate, 4_976_640)
    }

    func testBitrateScalesUpWithResolution() {
        let hd = CaptureConfigService.bitrate(forQuality: "high", width: 1920, height: 1080)
        let smaller = CaptureConfigService.bitrate(forQuality: "high", width: 1280, height: 720)
        XCTAssertGreaterThan(hd, smaller)
    }

    // MARK: - minimumFrameInterval(forFps:)

    func testMinimumFrameIntervalFor30Fps() {
        let interval = CaptureConfigService.minimumFrameInterval(forFps: 30)
        XCTAssertEqual(interval.value, 1)
        XCTAssertEqual(interval.timescale, 30)
    }

    func testMinimumFrameIntervalFor24Fps() {
        let interval = CaptureConfigService.minimumFrameInterval(forFps: 24)
        XCTAssertEqual(interval.value, 1)
        XCTAssertEqual(interval.timescale, 24)
    }

    func testMinimumFrameIntervalFor60Fps() {
        let interval = CaptureConfigService.minimumFrameInterval(forFps: 60)
        XCTAssertEqual(interval.value, 1)
        XCTAssertEqual(interval.timescale, 60)
    }

    // MARK: - resolvedPixelDimensions

    func testResolvedPixelDimensionsUsesRequestedWhenProvided() {
        let result = CaptureConfigService.resolvedPixelDimensions(
            requestedWidth: 1280, requestedHeight: 720,
            nativeWidth: 1920, nativeHeight: 1080
        )
        XCTAssertEqual(result.width, 1280)
        XCTAssertEqual(result.height, 720)
    }

    func testResolvedPixelDimensionsFallsBackToNativeWhenOmitted() {
        let result = CaptureConfigService.resolvedPixelDimensions(
            requestedWidth: nil, requestedHeight: nil,
            nativeWidth: 1920, nativeHeight: 1080
        )
        XCTAssertEqual(result.width, 1920)
        XCTAssertEqual(result.height, 1080)
    }

    func testResolvedPixelDimensionsRoundsOddNativeDimensionsDownToEven() {
        let result = CaptureConfigService.resolvedPixelDimensions(
            requestedWidth: nil, requestedHeight: nil,
            nativeWidth: 1281, nativeHeight: 721
        )
        XCTAssertEqual(result.width, 1280)
        XCTAssertEqual(result.height, 720)
    }

    func testResolvedPixelDimensionsRoundsOddRequestedDimensionsDownToEven() {
        let result = CaptureConfigService.resolvedPixelDimensions(
            requestedWidth: 801, requestedHeight: 601,
            nativeWidth: 1920, nativeHeight: 1080
        )
        XCTAssertEqual(result.width, 800)
        XCTAssertEqual(result.height, 600)
    }

    func testResolvedPixelDimensionsNeverReturnsBelowTwo() {
        let result = CaptureConfigService.resolvedPixelDimensions(
            requestedWidth: 1, requestedHeight: 0,
            nativeWidth: 1920, nativeHeight: 1080
        )
        XCTAssertGreaterThanOrEqual(result.width, 2)
        XCTAssertGreaterThanOrEqual(result.height, 2)
    }

    // MARK: - regionSourceRect

    func testRegionSourceRectOnPrimaryDisplayAtOrigin() {
        let rect = CaptureConfigService.regionSourceRect(
            regionPixelBounds: (x: 100, y: 100, width: 400, height: 300),
            displayPixelBounds: (x: 0, y: 0, width: 2560, height: 1440),
            scaleFactor: 2.0
        )
        XCTAssertEqual(rect.origin.x, 50)
        XCTAssertEqual(rect.origin.y, 50)
        XCTAssertEqual(rect.width, 200)
        XCTAssertEqual(rect.height, 150)
    }

    func testRegionSourceRectOnSecondaryDisplayWithNegativeOrigin() {
        // A display to the left of the primary display, at global pixel
        // origin (-1920, 0). The region's offset relative to the display's
        // own origin must be used, not the region's absolute global coords.
        let rect = CaptureConfigService.regionSourceRect(
            regionPixelBounds: (x: -1820, y: 100, width: 400, height: 300),
            displayPixelBounds: (x: -1920, y: 0, width: 1920, height: 1080),
            scaleFactor: 1.0
        )
        XCTAssertEqual(rect.origin.x, 100)
        XCTAssertEqual(rect.origin.y, 100)
        XCTAssertEqual(rect.width, 400)
        XCTAssertEqual(rect.height, 300)
    }
}
