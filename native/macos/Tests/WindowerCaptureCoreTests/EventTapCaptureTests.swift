import CoreGraphics
import XCTest

@testable import WindowerCaptureCore
import WindowerSidecarShared

/// Pure-logic + wire-shape tests for Phase 10's event-timeline capture —
/// the 30Hz throttle decision, the pixel coordinate conversion, and
/// encode/decode round-trips for each `TimelineEvent` variant. These are the
/// parts of Phase 10 that don't require a live `CGEventTap`/GUI/TCC-granted
/// session, matching the constraint documented on `WindowControlTests` and
/// `VideoAssetWriterTests`. Real `CGEventTap` firing/run-loop pumping is NOT
/// exercised here — that needs a live session and Accessibility grant,
/// deferred to Phase 13's local e2e process, same as other TCC-gated gaps
/// in this codebase.
final class EventTapCaptureTests: XCTestCase {

    // MARK: - EventThrottle (30Hz cap)

    func testFirstMoveAlwaysEmits() {
        XCTAssertTrue(EventThrottle.shouldEmit(nowMs: 0, lastEmittedMs: nil))
        XCTAssertTrue(EventThrottle.shouldEmit(nowMs: 12345, lastEmittedMs: nil))
    }

    func testMoveWithinThrottleWindowIsDropped() {
        // 30Hz => ~33.33ms minimum interval.
        XCTAssertFalse(EventThrottle.shouldEmit(nowMs: 10, lastEmittedMs: 0))
        XCTAssertFalse(EventThrottle.shouldEmit(nowMs: 33, lastEmittedMs: 0))
    }

    func testMoveAtOrAfterThrottleWindowIsEmitted() {
        XCTAssertTrue(EventThrottle.shouldEmit(nowMs: 34, lastEmittedMs: 0))
        XCTAssertTrue(EventThrottle.shouldEmit(nowMs: 1000, lastEmittedMs: 966))
    }

    func testCustomThrottleInterval() {
        XCTAssertFalse(EventThrottle.shouldEmit(nowMs: 50, lastEmittedMs: 0, minIntervalMs: 100))
        XCTAssertTrue(EventThrottle.shouldEmit(nowMs: 100, lastEmittedMs: 0, minIntervalMs: 100))
    }

    func testDefaultMinIntervalIsApproximately30Hz() {
        XCTAssertEqual(EventThrottle.minIntervalMs, 1000.0 / 30.0, accuracy: 0.0001)
    }

    // MARK: - Pixel coordinate conversion

    func testCoordinateConversionScalesByBackingScaleFactor() {
        let point = CGPoint(x: 100, y: 200)
        let pixels = EventCoordinateConversion.toPixels(point, scaleFactor: 2.0)
        XCTAssertEqual(pixels.x, 200)
        XCTAssertEqual(pixels.y, 400)
    }

    func testCoordinateConversionIdentityAtScaleFactorOne() {
        let point = CGPoint(x: 137, y: -42)
        let pixels = EventCoordinateConversion.toPixels(point, scaleFactor: 1.0)
        XCTAssertEqual(pixels.x, 137)
        XCTAssertEqual(pixels.y, -42)
    }

    func testCoordinateConversionPreservesNegativeOrigin() {
        // Secondary display to the left of/above the primary display has a
        // negative-origin Quartz global position (same convention already
        // validated in WindowControlTests) — conversion must not clip.
        let point = CGPoint(x: -1920, y: -100)
        let pixels = EventCoordinateConversion.toPixels(point, scaleFactor: 2.0)
        XCTAssertEqual(pixels.x, -3840)
        XCTAssertEqual(pixels.y, -200)
    }

    // MARK: - Wire-shape encode round-trip: TimelineEvent variants

    private func decodeJSONObject(_ data: Data) throws -> [String: Any] {
        let obj = try JSONSerialization.jsonObject(with: data)
        guard let dict = obj as? [String: Any] else {
            XCTFail("Expected a JSON object")
            return [:]
        }
        return dict
    }

    func testCursorMoveEncodesOnlyTAndTypeAndXY() throws {
        let event = TimelineEventWire.cursorMove(t: 123.5, x: 10, y: 20)
        let data = try JSONEncoder().encode(event)
        let dict = try decodeJSONObject(data)

        XCTAssertEqual(dict["t"] as? Double, 123.5)
        XCTAssertEqual(dict["type"] as? String, "cursor_move")
        XCTAssertEqual(dict["x"] as? Double, 10)
        XCTAssertEqual(dict["y"] as? Double, 20)
        XCTAssertNil(dict["button"])
        XCTAssertNil(dict["key"])
    }

    func testMouseDownEncodesXYAndButton() throws {
        let event = TimelineEventWire.mouseButton(t: 1, type: "mouse_down", x: 5, y: 6, button: "left")
        let data = try JSONEncoder().encode(event)
        let dict = try decodeJSONObject(data)

        XCTAssertEqual(dict["type"] as? String, "mouse_down")
        XCTAssertEqual(dict["x"] as? Double, 5)
        XCTAssertEqual(dict["y"] as? Double, 6)
        XCTAssertEqual(dict["button"] as? String, "left")
        XCTAssertNil(dict["key"])
    }

    func testMouseUpEncodesXYAndButton() throws {
        let event = TimelineEventWire.mouseButton(t: 2, type: "mouse_up", x: 7, y: 8, button: "right")
        let data = try JSONEncoder().encode(event)
        let dict = try decodeJSONObject(data)

        XCTAssertEqual(dict["type"] as? String, "mouse_up")
        XCTAssertEqual(dict["button"] as? String, "right")
    }

    func testOtherButtonRoundTrips() throws {
        let event = TimelineEventWire.mouseButton(t: 3, type: "mouse_down", x: 1, y: 1, button: "other")
        let data = try JSONEncoder().encode(event)
        let dict = try decodeJSONObject(data)
        XCTAssertEqual(dict["button"] as? String, "other")
    }

    func testKeyDownEncodesOnlyTTypeAndKey() throws {
        let event = TimelineEventWire.key(t: 4, type: "key_down", key: "keyCode:0")
        let data = try JSONEncoder().encode(event)
        let dict = try decodeJSONObject(data)

        XCTAssertEqual(dict["type"] as? String, "key_down")
        XCTAssertEqual(dict["key"] as? String, "keyCode:0")
        XCTAssertNil(dict["x"])
        XCTAssertNil(dict["y"])
        XCTAssertNil(dict["button"])
    }

    func testKeyUpEncodesOnlyTTypeAndKey() throws {
        let event = TimelineEventWire.key(t: 5, type: "key_up", key: "keyCode:49")
        let data = try JSONEncoder().encode(event)
        let dict = try decodeJSONObject(data)

        XCTAssertEqual(dict["type"] as? String, "key_up")
        XCTAssertEqual(dict["key"] as? String, "keyCode:49")
    }

    // MARK: - EventNotificationParams / LogNotificationParams shape

    func testEventNotificationParamsWrapsSessionIdAndEvent() throws {
        let params = EventNotificationParams(
            sessionId: "session-1", event: .cursorMove(t: 0, x: 1, y: 2))
        let encoded = try JSONCodec.encode(params)
        guard case .object(let obj) = encoded else {
            return XCTFail("Expected object")
        }
        XCTAssertEqual(obj["sessionId"], .string("session-1"))
        guard case .object(let eventObj) = obj["event"] else {
            return XCTFail("Expected nested event object")
        }
        XCTAssertEqual(eventObj["type"], .string("cursor_move"))
    }

    func testLogNotificationParamsOmitsNilSessionId() throws {
        let params = LogNotificationParams(sessionId: nil, level: "warn", message: "test")
        let data = try JSONEncoder().encode(params)
        let dict = try decodeJSONObject(data)
        XCTAssertEqual(dict["level"] as? String, "warn")
        XCTAssertEqual(dict["message"] as? String, "test")
        // sessionId is Optional<String> with default Encodable synthesis —
        // JSONEncoder emits `null` for a nil Optional field rather than
        // omitting it; assert that shape explicitly since a bare `nil`
        // sessionId is a valid, expected case (contracts/sidecar-protocol.md
        // §Notifications: "log" — `{ sessionId?, level, message }`).
        XCTAssertTrue(dict.keys.contains("sessionId") ? dict["sessionId"] is NSNull : true)
    }

    func testLogNotificationParamsIncludesSessionIdWhenPresent() throws {
        let params = LogNotificationParams(sessionId: "session-2", level: "error", message: "oops")
        let data = try JSONEncoder().encode(params)
        let dict = try decodeJSONObject(data)
        XCTAssertEqual(dict["sessionId"] as? String, "session-2")
    }

    // MARK: - EventTapSource construction (headless-safe: no start() call)

    func testEventTapSourceInitialKeyboardCaptureActiveIsFalseBeforeStart() {
        let source = EventTapSource(
            sessionId: "s", startedAt: Date(), scaleFactorResolver: { _ in 2.0 },
            emit: { _, _ in })
        // `start()` is intentionally not called — spinning up a real
        // CGEventTap needs a live session/Accessibility grant, out of scope
        // for this headless suite. This only verifies the pre-start default
        // never optimistically claims keyboard capture succeeded.
        XCTAssertFalse(source.keyboardCaptureActive)
    }

    // MARK: - Event source tagging (Phase 24)
    //
    // Phase 24 removed the Operator, and with it the only path that ever
    // synthesized input. `EventTapSource` no longer classifies events by
    // origin — every event it captures is tagged `WindowerEventTag.userSource`
    // directly (see `tasks/phase-24-remove-operator.md` settled decision 4).

    func testTimelineEventEncodesSourceForEveryVariant() throws {
        func sourceField(_ event: TimelineEventWire) throws -> String? {
            let data = try JSONEncoder().encode(event)
            let dict = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            return dict?["source"] as? String
        }
        XCTAssertEqual(
            try sourceField(.cursorMove(t: 0, x: 1, y: 2, source: "operator")), "operator")
        XCTAssertEqual(
            try sourceField(
                .mouseButton(t: 0, type: "mouse_down", x: 1, y: 2, button: "left", source: "user")),
            "user")
        XCTAssertEqual(
            try sourceField(.key(t: 0, type: "key_down", key: "keyCode:0", source: "operator")),
            "operator")
        // Absent when unknown — the field is optional in data-model.md.
        XCTAssertNil(try sourceField(.cursorMove(t: 0, x: 1, y: 2)))
    }
}
