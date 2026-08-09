import CoreGraphics
import XCTest

@testable import WindowerSidecarCore

/// Phase 19 (operator) — pure-logic tests for `performInput`'s decoding,
/// coordinate handling, keycode mapping and drag interpolation. Nothing here
/// posts a real `CGEvent`: `CGEventPost` needs the Accessibility TCC grant,
/// which can't be granted non-interactively on a CI runner (CLAUDE.md's
/// "TCC permissions gate CI" note), so actually-drives-the-pointer coverage
/// is e2e-gated exactly like the live `CGEventTap` gap in
/// `EventTapCaptureTests`.
final class InputSynthesisTests: XCTestCase {

    private func decode(_ json: String) throws -> InputAction {
        try JSONDecoder().decode(InputAction.self, from: Data(json.utf8))
    }

    private func decodeParams(_ json: String) throws -> PerformInputParams {
        try JSONDecoder().decode(PerformInputParams.self, from: Data(json.utf8))
    }

    // MARK: - InputAction decoding: all 9 kinds

    func testDecodeMouseMove() throws {
        XCTAssertEqual(
            try decode(#"{"kind":"mouse_move","x":100,"y":200}"#),
            .mouseMove(x: 100, y: 200))
    }

    func testDecodeMouseDown() throws {
        XCTAssertEqual(
            try decode(#"{"kind":"mouse_down","x":1,"y":2,"button":"left"}"#),
            .mouseDown(x: 1, y: 2, button: .left))
    }

    func testDecodeMouseUp() throws {
        XCTAssertEqual(
            try decode(#"{"kind":"mouse_up","x":3,"y":4,"button":"right"}"#),
            .mouseUp(x: 3, y: 4, button: .right))
    }

    func testDecodeMouseClickDefaultsClickCountToOne() throws {
        XCTAssertEqual(
            try decode(#"{"kind":"mouse_click","x":5,"y":6,"button":"other"}"#),
            .mouseClick(x: 5, y: 6, button: .other, clickCount: 1))
    }

    func testDecodeMouseClickHonorsExplicitClickCount() throws {
        XCTAssertEqual(
            try decode(#"{"kind":"mouse_click","x":5,"y":6,"button":"left","clickCount":2}"#),
            .mouseClick(x: 5, y: 6, button: .left, clickCount: 2))
    }

    func testDecodeMouseDragDefaultsDuration() throws {
        XCTAssertEqual(
            try decode(
                #"{"kind":"mouse_drag","fromX":0,"fromY":0,"toX":10,"toY":20,"button":"left"}"#),
            .mouseDrag(
                fromX: 0, fromY: 0, toX: 10, toY: 20, button: .left,
                durationMs: InputAction.defaultDragDurationMs))
    }

    func testDecodeMouseDragHonorsExplicitDuration() throws {
        XCTAssertEqual(
            try decode(
                #"{"kind":"mouse_drag","fromX":1,"fromY":2,"toX":3,"toY":4,"button":"right","durationMs":1000}"#
            ),
            .mouseDrag(fromX: 1, fromY: 2, toX: 3, toY: 4, button: .right, durationMs: 1000))
    }

    func testDecodeScroll() throws {
        XCTAssertEqual(
            try decode(#"{"kind":"scroll","x":10,"y":20,"deltaX":-5,"deltaY":30}"#),
            .scroll(x: 10, y: 20, deltaX: -5, deltaY: 30))
    }

    func testDecodeTypeTextWithUnicode() throws {
        XCTAssertEqual(
            try decode(#"{"kind":"type_text","text":"héllo 🌍 日本語"}"#),
            .typeText(text: "héllo 🌍 日本語"))
    }

    func testDecodeKeyPressDefaultsToNoModifiers() throws {
        XCTAssertEqual(try decode(#"{"kind":"key_press","key":"enter"}"#), .keyPress(key: "enter", modifiers: []))
    }

    func testDecodeKeyPressWithModifiers() throws {
        XCTAssertEqual(
            try decode(#"{"kind":"key_press","key":"a","modifiers":["cmd","shift"]}"#),
            .keyPress(key: "a", modifiers: [.cmd, .shift]))
    }

    func testDecodeWait() throws {
        XCTAssertEqual(try decode(#"{"kind":"wait","durationMs":250}"#), .wait(durationMs: 250))
    }

    func testUnknownKindDecodesToUnsupportedRatherThanFailing() throws {
        XCTAssertEqual(try decode(#"{"kind":"teleport","x":1}"#), .unsupported(kind: "teleport"))
    }

    func testDecodePerformInputParamsWithOptionalSessionId() throws {
        let withSession = try decodeParams(
            #"{"sessionId":"s-1","actions":[{"kind":"wait","durationMs":1}]}"#)
        XCTAssertEqual(withSession.sessionId, "s-1")
        XCTAssertEqual(withSession.actions.count, 1)

        let withoutSession = try decodeParams(#"{"actions":[]}"#)
        XCTAssertNil(withoutSession.sessionId)
        XCTAssertTrue(withoutSession.actions.isEmpty)
    }

    func testPerformInputResultEncodesPerformedCount() throws {
        let data = try JSONEncoder().encode(PerformInputResult(performed: 3))
        let dict = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        XCTAssertEqual(dict?["performed"] as? Int, 3)
    }

    // MARK: - Per-action required capability

    func testRequiredCapabilityPerKind() {
        XCTAssertEqual(InputAction.mouseMove(x: 0, y: 0).requiredCapability, "input.mouse")
        XCTAssertEqual(
            InputAction.scroll(x: 0, y: 0, deltaX: 0, deltaY: 0).requiredCapability, "input.mouse")
        XCTAssertEqual(InputAction.typeText(text: "x").requiredCapability, "input.keyboard")
        XCTAssertEqual(
            InputAction.keyPress(key: "a", modifiers: []).requiredCapability, "input.keyboard")
        XCTAssertNil(InputAction.wait(durationMs: 1).requiredCapability)
    }

    // MARK: - Synthetic-event tagging

    func testMagicConstantIsWindowerAscii() {
        XCTAssertEqual(WindowerEventTag.magic, 0x5749_4E44_4F57_4552)
        // Positive (fits Int64 without wrapping) and not a plausible default.
        XCTAssertGreaterThan(WindowerEventTag.magic, 0)
    }

    func testSourceClassificationFromEventSourceUserData() {
        XCTAssertEqual(WindowerEventTag.source(forUserData: WindowerEventTag.magic), "operator")
        XCTAssertEqual(WindowerEventTag.source(forUserData: 0), "user")
        XCTAssertEqual(WindowerEventTag.source(forUserData: 1), "user")
        XCTAssertEqual(WindowerEventTag.source(forUserData: -1), "user")
        XCTAssertEqual(
            WindowerEventTag.source(forUserData: WindowerEventTag.magic + 1), "user")
    }

    func testEventTapSourceClassifiesAnUnstampedEventAsUser() throws {
        guard let event = CGEvent(source: nil) else {
            throw XCTSkip("CGEvent creation unavailable in this environment")
        }
        XCTAssertEqual(EventTapSource.source(for: event), "user")
    }

    func testEventTapSourceClassifiesAStampedEventAsOperator() throws {
        guard let event = CGEvent(source: nil) else {
            throw XCTSkip("CGEvent creation unavailable in this environment")
        }
        // Exactly what `InputSynthesisService.post` does before posting —
        // no CGEventPost involved, so no Accessibility grant is needed.
        event.setIntegerValueField(.eventSourceUserData, value: WindowerEventTag.magic)
        XCTAssertEqual(EventTapSource.source(for: event), "operator")
    }

    func testTimelineEventEncodesSourceForEveryVariant() throws {
        func sourceField(_ event: TimelineEventWire) throws -> String? {
            let data = try JSONEncoder().encode(event)
            let dict = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            return dict?["source"] as? String
        }
        XCTAssertEqual(try sourceField(.cursorMove(t: 0, x: 1, y: 2, source: "operator")), "operator")
        XCTAssertEqual(
            try sourceField(
                .mouseButton(t: 0, type: "mouse_down", x: 1, y: 2, button: "left", source: "user")),
            "user")
        XCTAssertEqual(try sourceField(.key(t: 0, type: "key_down", key: "keyCode:0", source: "operator")), "operator")
        // Absent when unknown — the field is optional in data-model.md.
        XCTAssertNil(try sourceField(.cursorMove(t: 0, x: 1, y: 2)))
    }

    // MARK: - Bounds checking / pixels → points

    private let primary = DisplayGeometry(
        bounds: Rect(x: 0, y: 0, width: 3840, height: 2160), scaleFactor: 2.0)
    /// A 1x secondary display to the LEFT of the primary — negative global
    /// origin, the case that catches naive `abs()`/clamping bugs.
    private let secondary = DisplayGeometry(
        bounds: Rect(x: -1920, y: 0, width: 1920, height: 1080), scaleFactor: 1.0)

    func testContainsIsHalfOpen() {
        let rect = Rect(x: 0, y: 0, width: 100, height: 100)
        XCTAssertTrue(InputCoordinateSpace.contains(rect, x: 0, y: 0))
        XCTAssertTrue(InputCoordinateSpace.contains(rect, x: 99.9, y: 99.9))
        XCTAssertFalse(InputCoordinateSpace.contains(rect, x: 100, y: 50))
        XCTAssertFalse(InputCoordinateSpace.contains(rect, x: 50, y: 100))
        XCTAssertFalse(InputCoordinateSpace.contains(rect, x: -0.1, y: 50))
    }

    func testPointsConversionDividesByThatDisplaysScaleFactor() throws {
        let point = try InputCoordinateSpace.pointsLocation(
            pixelX: 1000, pixelY: 500, displays: [primary, secondary])
        XCTAssertEqual(point.x, 500)
        XCTAssertEqual(point.y, 250)
    }

    func testPointsConversionUsesTheContainingDisplaysOwnScaleFactor() throws {
        // Lands on the 1x secondary — must NOT be divided by the primary's 2x.
        let point = try InputCoordinateSpace.pointsLocation(
            pixelX: -960, pixelY: 100, displays: [primary, secondary])
        XCTAssertEqual(point.x, -960)
        XCTAssertEqual(point.y, 100)
    }

    func testOffScreenCoordinateThrowsInputOutOfBounds() {
        XCTAssertThrowsError(
            try InputCoordinateSpace.pointsLocation(
                pixelX: 99999, pixelY: 99999, displays: [primary, secondary])
        ) { error in
            guard let rpcError = error as? SidecarRpcError else {
                return XCTFail("Expected SidecarRpcError, got \(error)")
            }
            XCTAssertEqual(rpcError.taxonomyCode, .inputOutOfBounds)
        }
    }

    func testCoordinateInTheGapBetweenDisplaysThrows() {
        // y beyond the secondary's 1080 height but x inside its x-range:
        // inside no display's rect, even though each axis alone looks valid.
        XCTAssertThrowsError(
            try InputCoordinateSpace.pointsLocation(
                pixelX: -500, pixelY: 1500, displays: [primary, secondary])
        ) { error in
            XCTAssertEqual((error as? SidecarRpcError)?.taxonomyCode, .inputOutOfBounds)
        }
    }

    func testNoDisplaysAtAllThrowsOutOfBounds() {
        XCTAssertThrowsError(
            try InputCoordinateSpace.pointsLocation(pixelX: 0, pixelY: 0, displays: [])
        ) { error in
            XCTAssertEqual((error as? SidecarRpcError)?.taxonomyCode, .inputOutOfBounds)
        }
    }

    func testOutOfBoundsTaxonomyCodeSerializesToTheContractString() throws {
        let data = try JSONEncoder().encode(
            JsonRpcErrorData(code: .inputOutOfBounds))
        XCTAssertEqual(
            String(data: data, encoding: .utf8), #"{"code":"INPUT_OUT_OF_BOUNDS"}"#)
        let unsupported = try JSONEncoder().encode(JsonRpcErrorData(code: .inputUnsupported))
        XCTAssertEqual(
            String(data: unsupported, encoding: .utf8), #"{"code":"INPUT_UNSUPPORTED"}"#)
    }

    // MARK: - Permission gating (no TCC grant required to assert the refusal)

    func testPerformThrowsPermissionDeniedWhenAccessibilityIsNotGranted() {
        let params = try! decodeParams(#"{"actions":[{"kind":"wait","durationMs":0}]}"#)
        XCTAssertThrowsError(
            try InputSynthesisService.perform(
                params: params, displays: [primary], accessibility: .denied)
        ) { error in
            XCTAssertEqual((error as? SidecarRpcError)?.taxonomyCode, .permissionDenied)
        }
    }

    /// `wait` posts no events, so this exercises the perform loop end-to-end
    /// (permission check, iteration, `performed` count) without needing the
    /// Accessibility grant CI can't have.
    func testPerformCountsWaitOnlyActions() throws {
        let params = try decodeParams(
            #"{"actions":[{"kind":"wait","durationMs":0},{"kind":"wait","durationMs":1}]}"#)
        let result = try InputSynthesisService.perform(
            params: params, displays: [primary], accessibility: .granted)
        XCTAssertEqual(result.performed, 2)
    }

    func testPerformThrowsInputUnsupportedForAnUnknownKind() throws {
        let params = try decodeParams(#"{"actions":[{"kind":"levitate"}]}"#)
        XCTAssertThrowsError(
            try InputSynthesisService.perform(
                params: params, displays: [primary], accessibility: .granted)
        ) { error in
            XCTAssertEqual((error as? SidecarRpcError)?.taxonomyCode, .inputUnsupported)
        }
    }

    func testPerformThrowsInputUnsupportedForAnUnmappedKeyName() throws {
        let params = try decodeParams(
            #"{"actions":[{"kind":"key_press","key":"eject-warp-core"}]}"#)
        XCTAssertThrowsError(
            try InputSynthesisService.perform(
                params: params, displays: [primary], accessibility: .granted)
        ) { error in
            XCTAssertEqual((error as? SidecarRpcError)?.taxonomyCode, .inputUnsupported)
        }
    }

    func testPerformThrowsOutOfBoundsBeforePostingAnyMouseEvent() throws {
        let params = try decodeParams(#"{"actions":[{"kind":"mouse_move","x":99999,"y":99999}]}"#)
        XCTAssertThrowsError(
            try InputSynthesisService.perform(
                params: params, displays: [primary], accessibility: .granted)
        ) { error in
            XCTAssertEqual((error as? SidecarRpcError)?.taxonomyCode, .inputOutOfBounds)
        }
    }

    // MARK: - Keycode / modifier map

    func testNamedKeyMapCoversCommonKeys() {
        let expected: [String: CGKeyCode] = [
            "return": 0x24, "enter": 0x24, "tab": 0x30, "space": 0x31,
            "escape": 0x35, "esc": 0x35, "delete": 0x33, "backspace": 0x33,
            "up": 0x7E, "down": 0x7D, "left": 0x7B, "right": 0x7C,
            "f1": 0x7A, "f12": 0x6F, "a": 0x00, "z": 0x06, "0": 0x1D, "9": 0x19,
        ]
        for (name, code) in expected {
            XCTAssertEqual(KeyCodeMap.keyCode(for: name), code, "keycode mismatch for '\(name)'")
        }
    }

    func testKeyNameLookupIsCaseAndUnderscoreInsensitive() {
        XCTAssertEqual(KeyCodeMap.keyCode(for: "Escape"), KeyCodeMap.keyCode(for: "escape"))
        XCTAssertEqual(KeyCodeMap.keyCode(for: "ARROW_LEFT"), KeyCodeMap.keyCode(for: "left"))
        XCTAssertEqual(KeyCodeMap.keyCode(for: "Page_Down"), KeyCodeMap.keyCode(for: "pagedown"))
        XCTAssertEqual(
            KeyCodeMap.keyCode(for: "forward_delete"), KeyCodeMap.keyCode(for: "forwarddelete"))
    }

    func testAllFunctionKeysF1ThroughF12AreMapped() {
        for n in 1...12 {
            XCTAssertNotNil(KeyCodeMap.keyCode(for: "f\(n)"), "f\(n) missing")
        }
    }

    func testEveryLetterAndDigitIsMapped() {
        for scalar in UnicodeScalar("a").value...UnicodeScalar("z").value {
            let name = String(UnicodeScalar(scalar)!)
            XCTAssertNotNil(KeyCodeMap.keyCode(for: name), "'\(name)' missing")
        }
        for digit in 0...9 {
            XCTAssertNotNil(KeyCodeMap.keyCode(for: "\(digit)"), "'\(digit)' missing")
        }
    }

    func testUnknownKeyNameMapsToNil() {
        XCTAssertNil(KeyCodeMap.keyCode(for: "hyperspace"))
        XCTAssertNil(KeyCodeMap.keyCode(for: ""))
    }

    func testModifierFlagMapping() {
        XCTAssertEqual(KeyCodeMap.flags(for: []), [])
        XCTAssertEqual(KeyCodeMap.flags(for: [.cmd]), .maskCommand)
        XCTAssertEqual(KeyCodeMap.flags(for: [.shift]), .maskShift)
        XCTAssertEqual(KeyCodeMap.flags(for: [.ctrl]), .maskControl)
        XCTAssertEqual(KeyCodeMap.flags(for: [.alt]), .maskAlternate)
        XCTAssertEqual(
            KeyCodeMap.flags(for: [.cmd, .shift, .ctrl, .alt]),
            [.maskCommand, .maskShift, .maskControl, .maskAlternate])
        // Duplicates are a set union, not a double-toggle.
        XCTAssertEqual(KeyCodeMap.flags(for: [.cmd, .cmd]), .maskCommand)
    }

    // MARK: - Drag interpolation

    func testDragStepCountScalesWithDuration() {
        XCTAssertEqual(DragInterpolation.stepCount(durationMs: 0), 1)
        XCTAssertEqual(DragInterpolation.stepCount(durationMs: -5), 1)
        // ~120Hz => 300ms ≈ 36 steps.
        XCTAssertEqual(DragInterpolation.stepCount(durationMs: 300), 36)
        // Capped so a very long drag can't post thousands of events.
        XCTAssertEqual(DragInterpolation.stepCount(durationMs: 600_000), DragInterpolation.maxSteps)
    }

    func testDragPointsEndExactlyAtTheDestination() {
        let points = DragInterpolation.points(fromX: 0, fromY: 0, toX: 100, toY: 50, steps: 4)
        XCTAssertEqual(points.count, 4)
        XCTAssertEqual(points[0].x, 25)
        XCTAssertEqual(points[0].y, 12.5)
        XCTAssertEqual(points.last!.x, 100)
        XCTAssertEqual(points.last!.y, 50)
    }

    func testDragPointsWithSingleStepJumpsStraightToDestination() {
        let points = DragInterpolation.points(fromX: 10, fromY: 10, toX: 20, toY: 30, steps: 1)
        XCTAssertEqual(points.count, 1)
        XCTAssertEqual(points[0].x, 20)
        XCTAssertEqual(points[0].y, 30)
    }
}
