import CoreGraphics
import XCTest

import WindowerSidecarCore

/// Pure-logic tests for `WindowControlService` — pixel↔point conversion,
/// the epsilon success/partial comparison, and the AX-window matching
/// heuristic. These are the parts of Phase 3 that don't require a live
/// AXUIElement/GUI/TCC grant, so they must run headlessly in CI (see
/// CLAUDE.md's "TCC permissions gate CI" note). Real AX resize against a
/// live window is NOT exercised here — that needs local interactive
/// Accessibility permission and is out of scope for this sandbox, matching
/// how Phase 2 flagged SCShareableContent as "not verified in this sandbox".
final class WindowControlTests: XCTestCase {

    // MARK: - Pixel <-> point conversion

    func testPixelsToPointsDividesByScaleFactor() {
        let pixels = Rect(x: 200, y: 400, width: 2560, height: 1440)
        let points = WindowControlService.pixelsToPoints(pixels, scaleFactor: 2.0)
        XCTAssertEqual(points.x, 100)
        XCTAssertEqual(points.y, 200)
        XCTAssertEqual(points.width, 1280)
        XCTAssertEqual(points.height, 720)
    }

    func testPointsToPixelsMultipliesByScaleFactor() {
        let points = Rect(x: 100, y: 200, width: 1280, height: 720)
        let pixels = WindowControlService.pointsToPixels(points, scaleFactor: 2.0)
        XCTAssertEqual(pixels.x, 200)
        XCTAssertEqual(pixels.y, 400)
        XCTAssertEqual(pixels.width, 2560)
        XCTAssertEqual(pixels.height, 1440)
    }

    func testPixelsToPointsRoundTripsThroughPointsToPixels() {
        let original = Rect(x: 137, y: -84, width: 913, height: 511)
        for scaleFactor in [1.0, 2.0, 3.0] {
            let roundTripped = WindowControlService.pointsToPixels(
                WindowControlService.pixelsToPoints(original, scaleFactor: scaleFactor),
                scaleFactor: scaleFactor)
            XCTAssertEqual(roundTripped.x, original.x, accuracy: 0.0001)
            XCTAssertEqual(roundTripped.y, original.y, accuracy: 0.0001)
            XCTAssertEqual(roundTripped.width, original.width, accuracy: 0.0001)
            XCTAssertEqual(roundTripped.height, original.height, accuracy: 0.0001)
        }
    }

    func testScaleFactorOneIsIdentity() {
        let rect = Rect(x: 10, y: 20, width: 30, height: 40)
        XCTAssertEqual(WindowControlService.pixelsToPoints(rect, scaleFactor: 1.0), rect)
        XCTAssertEqual(WindowControlService.pointsToPixels(rect, scaleFactor: 1.0), rect)
    }

    func testNegativeOriginSurvivesConversion() {
        // Secondary display to the left of/above the primary display has a
        // negative-origin Quartz global position; conversion must not clip
        // or flip sign.
        let pixels = Rect(x: -3840, y: -200, width: 1920, height: 1080)
        let points = WindowControlService.pixelsToPoints(pixels, scaleFactor: 2.0)
        XCTAssertEqual(points.x, -1920)
        XCTAssertEqual(points.y, -100)
    }

    // MARK: - success/partial epsilon comparison

    func testResultForActualIsSuccessWhenExactMatch() {
        let requested = Rect(x: 0, y: 0, width: 1280, height: 720)
        let actual = Rect(x: 0, y: 0, width: 1280, height: 720)
        XCTAssertEqual(WindowControlService.resultForActual(requested: requested, actual: actual), "success")
    }

    func testResultForActualIsSuccessWithinEpsilon() {
        let requested = Rect(x: 0, y: 0, width: 1280, height: 720)
        let actual = Rect(x: 0.5, y: -0.5, width: 1280.9, height: 719.1)
        XCTAssertEqual(WindowControlService.resultForActual(requested: requested, actual: actual), "success")
    }

    func testResultForActualIsPartialWhenClamped() {
        // Window manager clamped width to fit the screen.
        let requested = Rect(x: 0, y: 0, width: 5000, height: 720)
        let actual = Rect(x: 0, y: 0, width: 1920, height: 720)
        XCTAssertEqual(WindowControlService.resultForActual(requested: requested, actual: actual), "partial")
    }

    func testResultForActualRespectsCustomEpsilon() {
        let requested = Rect(x: 0, y: 0, width: 1280, height: 720)
        let actual = Rect(x: 3, y: 0, width: 1280, height: 720)
        XCTAssertEqual(
            WindowControlService.resultForActual(requested: requested, actual: actual, epsilon: 1.0), "partial")
        XCTAssertEqual(
            WindowControlService.resultForActual(requested: requested, actual: actual, epsilon: 5.0), "success")
    }

    // MARK: - AX window matching heuristic

    func testBestMatchIndexPicksExactGeometryMatch() {
        let candidates: [(position: CGPoint, size: CGSize, title: String?)] = [
            (CGPoint(x: 0, y: 0), CGSize(width: 400, height: 300), "Other Window"),
            (CGPoint(x: 100, y: 200), CGSize(width: 800, height: 600), "My Editor"),
        ]
        let target = CGRect(x: 100, y: 200, width: 800, height: 600)
        let match = WindowControlService.bestMatchIndex(
            candidates: candidates, targetBounds: target, targetTitle: "My Editor")
        XCTAssertEqual(match, 1)
    }

    func testBestMatchIndexAcceptsSmallGeometryDrift() {
        let candidates: [(position: CGPoint, size: CGSize, title: String?)] = [
            (CGPoint(x: 100.3, y: 199.8), CGSize(width: 800.1, height: 599.9), "My Editor")
        ]
        let target = CGRect(x: 100, y: 200, width: 800, height: 600)
        let match = WindowControlService.bestMatchIndex(
            candidates: candidates, targetBounds: target, targetTitle: "My Editor")
        XCTAssertEqual(match, 0)
    }

    func testBestMatchIndexRejectsFarCandidateWithNoTitleMatch() {
        let candidates: [(position: CGPoint, size: CGSize, title: String?)] = [
            (CGPoint(x: 900, y: 900), CGSize(width: 100, height: 100), "Unrelated")
        ]
        let target = CGRect(x: 100, y: 200, width: 800, height: 600)
        let match = WindowControlService.bestMatchIndex(
            candidates: candidates, targetBounds: target, targetTitle: "My Editor")
        XCTAssertNil(match)
    }

    func testBestMatchIndexUsesTitleAsTiebreakerForLooseGeometry() {
        // Position drifted by a few points (e.g. window moved between the
        // CGWindowList snapshot and the AX query) but still well within the
        // title-tiebreaker tolerance, and the title matches exactly.
        let candidates: [(position: CGPoint, size: CGSize, title: String?)] = [
            (CGPoint(x: 110, y: 205), CGSize(width: 805, height: 600), "My Editor")
        ]
        let target = CGRect(x: 100, y: 200, width: 800, height: 600)
        let match = WindowControlService.bestMatchIndex(
            candidates: candidates, targetBounds: target, targetTitle: "My Editor")
        XCTAssertEqual(match, 0)
    }

    func testBestMatchIndexReturnsNilForEmptyCandidates() {
        let target = CGRect(x: 0, y: 0, width: 100, height: 100)
        XCTAssertNil(
            WindowControlService.bestMatchIndex(candidates: [], targetBounds: target, targetTitle: nil))
    }

    // MARK: - Params/result wire shapes

    func testResizeWindowParamsDecodesDataModelShape() throws {
        let json = """
            {"targetId":"1001","bounds":{"x":0,"y":0,"width":1280,"height":720}}
            """
        let params = try JSONDecoder().decode(ResizeWindowParams.self, from: Data(json.utf8))
        XCTAssertEqual(params.targetId, "1001")
        XCTAssertEqual(params.bounds, Rect(x: 0, y: 0, width: 1280, height: 720))
    }

    func testResizeWindowResultEncodesDataModelShape() throws {
        let result = ResizeWindowResult(
            actualBounds: Rect(x: 0, y: 0, width: 1280, height: 720), result: "success")
        let data = try JSONEncoder().encode(result)
        let obj = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(obj["result"] as? String, "success")
        let bounds = try XCTUnwrap(obj["actualBounds"] as? [String: Any])
        XCTAssertEqual(bounds["width"] as? Double, 1280)
    }
}
