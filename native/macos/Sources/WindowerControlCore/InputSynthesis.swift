import CoreGraphics
import Foundation
import WindowerSidecarShared

// Phase 19 — Operator: synthetic input (`performInput`).
//
// Everything OS-specific about driving the pointer/keyboard lives here.
// The wire shapes below mirror `InputAction` in data-model.md exactly
// (discriminated union on `kind`, coordinates in **pixels**, global
// top-left-origin Quartz space). Pixels→points conversion happens in this
// file and nowhere else — see research.md §3 and CLAUDE.md's units rule.

// MARK: - Synthetic-event tagging
//
// `WindowerEventTag` (the magic `eventSourceUserData` marker this file
// stamps onto every posted event) moved to `WindowerSidecarShared` in
// Phase 21: the capture surface's `EventTapSource` reads the same marker
// back off tapped events, and after the capture/control split neither
// module can import the other. See WindowerSidecarShared/EventTag.swift.

// MARK: - Wire shapes (mirror data-model.md §InputAction)

public enum InputMouseButton: String, Codable, Equatable {
    case left
    case right
    case other
}

public enum InputKeyModifier: String, Codable, Equatable {
    case cmd
    case shift
    case ctrl
    case alt
}

/// Decodable view of `InputAction` (data-model.md). Unknown `kind` values
/// decode into `.unsupported` rather than failing the whole decode: a
/// caller asking for an action this backend can't synthesize must get
/// `INPUT_UNSUPPORTED` (the taxonomy code the contract defines for exactly
/// that case), not a generic invalid-params error.
public enum InputAction: Decodable, Equatable {
    case mouseMove(x: Double, y: Double)
    case mouseDown(x: Double, y: Double, button: InputMouseButton)
    case mouseUp(x: Double, y: Double, button: InputMouseButton)
    case mouseClick(x: Double, y: Double, button: InputMouseButton, clickCount: Int)
    case mouseDrag(
        fromX: Double, fromY: Double, toX: Double, toY: Double, button: InputMouseButton,
        durationMs: Double)
    case scroll(x: Double, y: Double, deltaX: Double, deltaY: Double)
    case typeText(text: String)
    case keyPress(key: String, modifiers: [InputKeyModifier])
    case wait(durationMs: Double)
    case unsupported(kind: String)

    /// data-model.md leaves `clickCount`/`durationMs` optional; these are the
    /// documented-by-omission defaults (a plain single click, and a drag
    /// slow enough that the target app sees intermediate motion rather than
    /// a teleport).
    public static let defaultClickCount = 1
    public static let defaultDragDurationMs: Double = 300

    private enum CodingKeys: String, CodingKey {
        case kind, x, y, button, clickCount
        case fromX, fromY, toX, toY, durationMs
        case deltaX, deltaY, text, key, modifiers
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try c.decode(String.self, forKey: .kind)
        switch kind {
        case "mouse_move":
            self = .mouseMove(
                x: try c.decode(Double.self, forKey: .x),
                y: try c.decode(Double.self, forKey: .y))
        case "mouse_down":
            self = .mouseDown(
                x: try c.decode(Double.self, forKey: .x),
                y: try c.decode(Double.self, forKey: .y),
                button: try c.decode(InputMouseButton.self, forKey: .button))
        case "mouse_up":
            self = .mouseUp(
                x: try c.decode(Double.self, forKey: .x),
                y: try c.decode(Double.self, forKey: .y),
                button: try c.decode(InputMouseButton.self, forKey: .button))
        case "mouse_click":
            self = .mouseClick(
                x: try c.decode(Double.self, forKey: .x),
                y: try c.decode(Double.self, forKey: .y),
                button: try c.decode(InputMouseButton.self, forKey: .button),
                clickCount: try c.decodeIfPresent(Int.self, forKey: .clickCount)
                    ?? InputAction.defaultClickCount)
        case "mouse_drag":
            self = .mouseDrag(
                fromX: try c.decode(Double.self, forKey: .fromX),
                fromY: try c.decode(Double.self, forKey: .fromY),
                toX: try c.decode(Double.self, forKey: .toX),
                toY: try c.decode(Double.self, forKey: .toY),
                button: try c.decode(InputMouseButton.self, forKey: .button),
                durationMs: try c.decodeIfPresent(Double.self, forKey: .durationMs)
                    ?? InputAction.defaultDragDurationMs)
        case "scroll":
            self = .scroll(
                x: try c.decode(Double.self, forKey: .x),
                y: try c.decode(Double.self, forKey: .y),
                deltaX: try c.decode(Double.self, forKey: .deltaX),
                deltaY: try c.decode(Double.self, forKey: .deltaY))
        case "type_text":
            self = .typeText(text: try c.decode(String.self, forKey: .text))
        case "key_press":
            self = .keyPress(
                key: try c.decode(String.self, forKey: .key),
                modifiers: try c.decodeIfPresent([InputKeyModifier].self, forKey: .modifiers) ?? [])
        case "wait":
            self = .wait(durationMs: try c.decode(Double.self, forKey: .durationMs))
        default:
            self = .unsupported(kind: kind)
        }
    }

    /// The capability string (`describe`) this action depends on. Used by the
    /// dispatch layer for per-action capability reasoning; `wait` needs none.
    public var requiredCapability: String? {
        switch self {
        case .mouseMove, .mouseDown, .mouseUp, .mouseClick, .mouseDrag, .scroll:
            return "input.mouse"
        case .typeText, .keyPress:
            return "input.keyboard"
        case .wait, .unsupported:
            return nil
        }
    }
}

public struct PerformInputParams: Decodable {
    /// Optional per the contract — `performInput` is not scoped to a capture
    /// session (the operator may drive the UI before/after recording). It's
    /// accepted and carried for logging/correlation only.
    public let sessionId: String?
    public let actions: [InputAction]
}

public struct PerformInputResult: Encodable, Equatable {
    public let performed: Int

    public init(performed: Int) {
        self.performed = performed
    }
}

// MARK: - Named key → virtual keycode map

/// Named-key → macOS virtual keycode map for `key_press`. Deliberately not
/// used for `type_text` — text typing goes through
/// `CGEvent.keyboardSetUnicodeString`, which is layout- and
/// unicode-agnostic, so this table only needs to cover keys that have no
/// character representation (arrows, function keys, escape…) plus the
/// ASCII letters/digits a caller would reasonably want to press *with
/// modifiers* (`cmd+a`, `ctrl+c`).
///
/// Keycodes are US-layout virtual keycodes (`kVK_*` from Carbon's Events.h),
/// hardcoded rather than resolved through TIS at runtime: for the
/// non-character keys they're layout-independent, and for the letter/digit
/// keys the caller is expressing "the key labelled A on a US keyboard",
/// which is the same thing every other automation tool means by `cmd+a`.
public enum KeyCodeMap {
    public static func keyCode(for name: String) -> CGKeyCode? {
        let normalized = name.lowercased().replacingOccurrences(of: "_", with: "")
        return table[normalized]
    }

    /// Exposed for tests/tooling — the set of names this backend understands.
    public static var knownNames: [String] { Array(table.keys) }

    private static let table: [String: CGKeyCode] = {
        var map: [String: CGKeyCode] = [
            // Editing / whitespace
            "return": 0x24,
            "enter": 0x24,
            "keypadenter": 0x4C,
            "tab": 0x30,
            "space": 0x31,
            "delete": 0x33,  // Backspace on a US keyboard (kVK_Delete)
            "backspace": 0x33,
            "forwarddelete": 0x75,
            "escape": 0x35,
            "esc": 0x35,

            // Navigation
            "left": 0x7B,
            "arrowleft": 0x7B,
            "right": 0x7C,
            "arrowright": 0x7C,
            "down": 0x7D,
            "arrowdown": 0x7D,
            "up": 0x7E,
            "arrowup": 0x7E,
            "home": 0x73,
            "end": 0x77,
            "pageup": 0x74,
            "pagedown": 0x79,

            // Punctuation (US layout)
            "minus": 0x1B,
            "equal": 0x18,
            "leftbracket": 0x21,
            "rightbracket": 0x1E,
            "backslash": 0x2A,
            "semicolon": 0x29,
            "quote": 0x27,
            "comma": 0x2B,
            "period": 0x2F,
            "slash": 0x2C,
            "grave": 0x32,
        ]

        // Letters a–z (US layout kVK_ANSI_* order is not alphabetical).
        let letters: [String: CGKeyCode] = [
            "a": 0x00, "b": 0x0B, "c": 0x08, "d": 0x02, "e": 0x0E, "f": 0x03, "g": 0x05,
            "h": 0x04, "i": 0x22, "j": 0x26, "k": 0x28, "l": 0x25, "m": 0x2E, "n": 0x2D,
            "o": 0x1F, "p": 0x23, "q": 0x0C, "r": 0x0F, "s": 0x01, "t": 0x11, "u": 0x20,
            "v": 0x09, "w": 0x0D, "x": 0x07, "y": 0x10, "z": 0x06,
        ]
        map.merge(letters) { current, _ in current }

        // Digits 0–9 (top row).
        let digits: [String: CGKeyCode] = [
            "0": 0x1D, "1": 0x12, "2": 0x13, "3": 0x14, "4": 0x15,
            "5": 0x17, "6": 0x16, "7": 0x1A, "8": 0x1C, "9": 0x19,
        ]
        map.merge(digits) { current, _ in current }

        // F1–F20.
        let functionKeys: [String: CGKeyCode] = [
            "f1": 0x7A, "f2": 0x78, "f3": 0x63, "f4": 0x76, "f5": 0x60, "f6": 0x61,
            "f7": 0x62, "f8": 0x64, "f9": 0x65, "f10": 0x6D, "f11": 0x67, "f12": 0x6F,
            "f13": 0x69, "f14": 0x6B, "f15": 0x71, "f16": 0x6A, "f17": 0x40, "f18": 0x4F,
            "f19": 0x50, "f20": 0x5A,
        ]
        map.merge(functionKeys) { current, _ in current }

        return map
    }()

    /// Pure modifier-set → `CGEventFlags` mapping.
    public static func flags(for modifiers: [InputKeyModifier]) -> CGEventFlags {
        var flags: CGEventFlags = []
        for modifier in modifiers {
            switch modifier {
            case .cmd: flags.insert(.maskCommand)
            case .shift: flags.insert(.maskShift)
            case .ctrl: flags.insert(.maskControl)
            case .alt: flags.insert(.maskAlternate)
            }
        }
        return flags
    }
}

// MARK: - Coordinate handling (pixels → points, bounds checking)

/// A display's pixel bounds paired with its backing scale factor — the only
/// two facts coordinate conversion needs. Kept as a plain value type so the
/// conversion/bounds logic below is testable with synthetic displays, no
/// real hardware involved.
public struct DisplayGeometry: Equatable {
    public let bounds: Rect
    public let scaleFactor: Double

    public init(bounds: Rect, scaleFactor: Double) {
        self.bounds = bounds
        self.scaleFactor = scaleFactor
    }
}

public enum InputCoordinateSpace {
    /// Half-open containment: `[x, x + width)`. A coordinate exactly on a
    /// display's right/bottom edge belongs to the *next* display (or to
    /// nothing), which is the same convention `CGDisplayBounds` rectangles
    /// tile the global space with.
    public static func contains(_ rect: Rect, x: Double, y: Double) -> Bool {
        x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height
    }

    public static func display(containing x: Double, y: Double, in displays: [DisplayGeometry])
        -> DisplayGeometry?
    {
        displays.first { contains($0.bounds, x: x, y: y) }
    }

    /// Converts a protocol coordinate (**pixels**, global top-left-origin
    /// Quartz space) to the **points** `CGEvent` wants, using the scale
    /// factor of the display the point lands on. This mirrors
    /// `EnumerationService.mapDisplay`'s convention in reverse (capture surface): the repo
    /// defines global pixel coordinates as `points × scaleFactor` with no
    /// axis flip and no origin translation, so the inverse is a plain
    /// divide.
    ///
    /// Throws `INPUT_OUT_OF_BOUNDS` when the coordinate is outside every
    /// known display — posting there would silently clamp to the nearest
    /// display and click the wrong thing, which is far worse for an operator
    /// loop than a hard error.
    public static func pointsLocation(
        pixelX x: Double, pixelY y: Double, displays: [DisplayGeometry]
    ) throws -> CGPoint {
        guard let display = display(containing: x, y: y, in: displays) else {
            throw SidecarRpcError.serverError(
                "Coordinate (\(x), \(y)) px is outside every known display's bounds",
                code: .inputOutOfBounds)
        }
        let scale = display.scaleFactor == 0 ? 1 : display.scaleFactor
        return CGPoint(x: x / scale, y: y / scale)
    }

    /// Live display geometry, in the same global-pixel space every other
    /// coordinate in the protocol uses. `CGDisplayBounds` is already
    /// top-left-origin global *points* (unlike `NSScreen.frame`, which is
    /// bottom-left-origin), so it's the right source here — only the
    /// pixel scaling is applied.
    public static func activeDisplays() -> [DisplayGeometry] {
        var count: UInt32 = 0
        guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else { return [] }
        var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
        guard CGGetActiveDisplayList(count, &ids, &count) == .success else { return [] }
        return ids.prefix(Int(count)).map { id in
            let boundsPoints = CGDisplayBounds(id)
            let scale = ScreenGeometry.backingScaleFactor(forDisplayID: id)
            return DisplayGeometry(
                bounds: Rect(
                    x: boundsPoints.origin.x * scale,
                    y: boundsPoints.origin.y * scale,
                    width: boundsPoints.width * scale,
                    height: boundsPoints.height * scale),
                scaleFactor: scale)
        }
    }
}

// MARK: - Drag interpolation (pure)

public enum DragInterpolation {
    /// ~120Hz of intermediate motion, capped so a long drag doesn't post
    /// thousands of events. `durationMs <= 0` collapses to a single step
    /// (straight to the destination).
    public static let stepIntervalMs: Double = 1000.0 / 120.0
    public static let maxSteps = 240

    public static func stepCount(durationMs: Double) -> Int {
        guard durationMs > 0 else { return 1 }
        let steps = Int((durationMs / stepIntervalMs).rounded())
        return min(maxSteps, max(1, steps))
    }

    /// Linearly interpolated intermediate points, *excluding* the start and
    /// *including* the destination as the final element.
    public static func points(
        fromX: Double, fromY: Double, toX: Double, toY: Double, steps: Int
    ) -> [(x: Double, y: Double)] {
        let steps = max(1, steps)
        return (1...steps).map { i in
            let t = Double(i) / Double(steps)
            return (x: fromX + (toX - fromX) * t, y: fromY + (toY - fromY) * t)
        }
    }
}

// MARK: - Synthesis

public enum InputSynthesisService {
    /// One private `CGEventSource` for the whole process, tagged with the
    /// Windower magic. `.privateState` (rather than `.combinedSessionState`)
    /// keeps synthesized modifier/key state out of the user's real session
    /// state, so a synthetic `cmd` press can't leave the user's session
    /// thinking cmd is held down if the sidecar dies mid-sequence.
    private static let eventSource: CGEventSource? = {
        guard let source = CGEventSource(stateID: .privateState) else { return nil }
        source.userData = WindowerEventTag.magic
        return source
    }()

    /// Executes an action list in order, returning how many actions were
    /// performed. All-or-nothing is deliberately NOT attempted: synthetic
    /// input has real side effects on the user's machine the moment it's
    /// posted, so a failure mid-list reports the error and the caller learns
    /// how far it got from the fact that the error came back at all (the
    /// operator loop re-observes with `captureFrame` after every step).
    public static func perform(
        params: PerformInputParams,
        displays: [DisplayGeometry] = InputCoordinateSpace.activeDisplays(),
        accessibility: PermissionStatus = PermissionsService.accessibilityStatus()
    ) throws -> PerformInputResult {
        guard accessibility == .granted else {
            throw SidecarRpcError.serverError(
                "performInput requires the Accessibility permission (CGEventPost is blocked without it)",
                code: .permissionDenied)
        }
        guard let source = eventSource else {
            throw SidecarRpcError.serverError(
                "Failed to create a private CGEventSource", code: .internalError)
        }

        var performed = 0
        for action in params.actions {
            try perform(action: action, source: source, displays: displays)
            performed += 1
        }
        return PerformInputResult(performed: performed)
    }

    private static func perform(
        action: InputAction, source: CGEventSource, displays: [DisplayGeometry]
    ) throws {
        switch action {
        case .mouseMove(let x, let y):
            let location = try InputCoordinateSpace.pointsLocation(
                pixelX: x, pixelY: y, displays: displays)
            try postMouse(type: .mouseMoved, at: location, button: .left, source: source)

        case .mouseDown(let x, let y, let button):
            let location = try InputCoordinateSpace.pointsLocation(
                pixelX: x, pixelY: y, displays: displays)
            try postMouse(
                type: downType(for: button), at: location, button: cgButton(for: button),
                source: source)

        case .mouseUp(let x, let y, let button):
            let location = try InputCoordinateSpace.pointsLocation(
                pixelX: x, pixelY: y, displays: displays)
            try postMouse(
                type: upType(for: button), at: location, button: cgButton(for: button),
                source: source)

        case .mouseClick(let x, let y, let button, let clickCount):
            let location = try InputCoordinateSpace.pointsLocation(
                pixelX: x, pixelY: y, displays: displays)
            // Move first so the app under the pointer sees a hover/enter
            // before the click, matching what a real pointer does.
            try postMouse(type: .mouseMoved, at: location, button: .left, source: source)
            let count = max(1, clickCount)
            for click in 1...count {
                // `mouseEventClickState` is what turns two separate
                // down/up pairs into a double-click as far as AppKit is
                // concerned — posting two plain clicks is NOT a double click.
                try postMouse(
                    type: downType(for: button), at: location, button: cgButton(for: button),
                    source: source, clickState: click)
                try postMouse(
                    type: upType(for: button), at: location, button: cgButton(for: button),
                    source: source, clickState: click)
            }

        case .mouseDrag(let fromX, let fromY, let toX, let toY, let button, let durationMs):
            let start = try InputCoordinateSpace.pointsLocation(
                pixelX: fromX, pixelY: fromY, displays: displays)
            let steps = DragInterpolation.stepCount(durationMs: durationMs)
            let path = DragInterpolation.points(
                fromX: fromX, fromY: fromY, toX: toX, toY: toY, steps: steps)
            // Validate the whole path up front: a drag that leaves the
            // display halfway through would otherwise strand the button in
            // the down state.
            let pathPoints = try path.map {
                try InputCoordinateSpace.pointsLocation(pixelX: $0.x, pixelY: $0.y, displays: displays)
            }

            try postMouse(type: .mouseMoved, at: start, button: .left, source: source)
            try postMouse(
                type: downType(for: button), at: start, button: cgButton(for: button),
                source: source, clickState: 1)
            let stepDelay = durationMs > 0 ? (durationMs / Double(steps)) / 1000.0 : 0
            for point in pathPoints {
                try postMouse(
                    type: dragType(for: button), at: point, button: cgButton(for: button),
                    source: source, clickState: 1)
                if stepDelay > 0 { Thread.sleep(forTimeInterval: stepDelay) }
            }
            let end = pathPoints.last ?? start
            try postMouse(
                type: upType(for: button), at: end, button: cgButton(for: button), source: source,
                clickState: 1)

        case .scroll(let x, let y, let deltaX, let deltaY):
            let location = try InputCoordinateSpace.pointsLocation(
                pixelX: x, pixelY: y, displays: displays)
            // Scroll events carry no location of their own — they go to
            // whatever is under the cursor, so move there first.
            try postMouse(type: .mouseMoved, at: location, button: .left, source: source)
            // `.pixel` units: deltas are in the same pixel space as every
            // other coordinate in the protocol. wheel1 = vertical,
            // wheel2 = horizontal (CGEvent's fixed ordering).
            guard
                let event = CGEvent(
                    scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2,
                    wheel1: Int32(clamping: Int(deltaY.rounded())),
                    wheel2: Int32(clamping: Int(deltaX.rounded())), wheel3: 0)
            else {
                throw SidecarRpcError.serverError(
                    "Failed to create scroll event", code: .internalError)
            }
            post(event)

        case .typeText(let text):
            // Unicode-safe by construction: no keycode table, no layout
            // assumptions. One down/up pair per grapheme cluster so emoji
            // and combining sequences arrive intact.
            for character in text {
                try postUnicode(String(character), source: source)
            }

        case .keyPress(let key, let modifiers):
            guard let keyCode = KeyCodeMap.keyCode(for: key) else {
                throw SidecarRpcError.serverError(
                    "Unknown key name '\(key)' — no virtual keycode mapping on this backend",
                    code: .inputUnsupported)
            }
            let flags = KeyCodeMap.flags(for: modifiers)
            guard
                let keyDown = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: true),
                let keyUp = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: false)
            else {
                throw SidecarRpcError.serverError(
                    "Failed to create keyboard event for '\(key)'", code: .internalError)
            }
            keyDown.flags = flags
            keyUp.flags = flags
            post(keyDown)
            post(keyUp)

        case .wait(let durationMs):
            if durationMs > 0 {
                Thread.sleep(forTimeInterval: durationMs / 1000.0)
            }

        case .unsupported(let kind):
            throw SidecarRpcError.serverError(
                "InputAction kind '\(kind)' cannot be synthesized by this backend",
                code: .inputUnsupported)
        }
    }

    // MARK: - Event construction helpers

    private static func postMouse(
        type: CGEventType, at location: CGPoint, button: CGMouseButton, source: CGEventSource,
        clickState: Int? = nil
    ) throws {
        guard
            let event = CGEvent(
                mouseEventSource: source, mouseType: type, mouseCursorPosition: location,
                mouseButton: button)
        else {
            throw SidecarRpcError.serverError("Failed to create mouse event", code: .internalError)
        }
        if let clickState = clickState {
            event.setIntegerValueField(.mouseEventClickState, value: Int64(clickState))
        }
        post(event)
    }

    private static func postUnicode(_ string: String, source: CGEventSource) throws {
        let utf16 = Array(string.utf16)
        guard
            let keyDown = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
            let keyUp = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false)
        else {
            throw SidecarRpcError.serverError(
                "Failed to create keyboard event for text", code: .internalError)
        }
        keyDown.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
        keyUp.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
        post(keyDown)
        post(keyUp)
    }

    /// Single choke point for posting: stamps the magic on every event
    /// (belt and braces alongside `CGEventSource.userData`, which some event
    /// paths don't propagate) and posts to the session tap so the event is
    /// seen by other processes' taps — including this sidecar's own
    /// `EventTapSource`, which is what makes `source: "operator"`
    /// classification possible at all.
    private static func post(_ event: CGEvent) {
        event.setIntegerValueField(.eventSourceUserData, value: WindowerEventTag.magic)
        event.post(tap: .cghidEventTap)
    }

    private static func cgButton(for button: InputMouseButton) -> CGMouseButton {
        switch button {
        case .left: return .left
        case .right: return .right
        case .other: return .center
        }
    }

    private static func downType(for button: InputMouseButton) -> CGEventType {
        switch button {
        case .left: return .leftMouseDown
        case .right: return .rightMouseDown
        case .other: return .otherMouseDown
        }
    }

    private static func upType(for button: InputMouseButton) -> CGEventType {
        switch button {
        case .left: return .leftMouseUp
        case .right: return .rightMouseUp
        case .other: return .otherMouseUp
        }
    }

    private static func dragType(for button: InputMouseButton) -> CGEventType {
        switch button {
        case .left: return .leftMouseDragged
        case .right: return .rightMouseDragged
        case .other: return .otherMouseDragged
        }
    }
}
