import AppKit
import CoreGraphics
import Foundation

// Phase 10 — Event Timeline (macOS capture side only). `EventTapSource` is
// constructed per-session by `CaptureSessionManager.startCapture` and torn
// down alongside the session (stop/cancel/stream-error), mirroring
// `MicrophoneCaptureSource`'s lifecycle. See CLAUDE.md "protocol before
// platform" — the wire shapes below mirror
// packages/core/src/schemas/event-timeline.ts / data-model.md §EventTimeline
// exactly; nothing macOS-specific leaks past them.

/// `main.swift`'s `logStderr` lives in the executable target and isn't
/// reachable from this library target — this is the same free-form
/// stderr-only logging convention (contracts/sidecar-protocol.md §Transport:
/// "stderr is free-form human-readable logs only, never protocol data").
private func logStderr(_ message: String) {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
}

// MARK: - Wire shapes (mirror packages/core/src/schemas/event-timeline.ts)

/// Mirrors `TimelineEvent` (data-model.md §EventTimeline) — a discriminated
/// union on `type`. Modeled as a flat struct with optional fields (rather
/// than a Swift enum) because `Encodable`'s built-in support for tagged
/// unions doesn't produce the flat `{ t, type, x, y, ... }` wire shape the
/// TS `z.discriminatedUnion` expects without custom `encode(to:)` per case —
/// a flat struct with `Encodable`'s default synthesis already produces
/// exactly that shape when unused fields are simply absent... except
/// `Encodable` always emits fields it has, so this DOES implement a custom
/// `encode(to:)` to omit fields that don't apply to a given `type`.
public struct TimelineEventWire: Codable, Equatable {
    public let t: Double
    public let type: String
    public let x: Double?
    public let y: Double?
    public let button: String?
    public let key: String?

    public init(t: Double, type: String, x: Double? = nil, y: Double? = nil, button: String? = nil, key: String? = nil) {
        self.t = t
        self.type = type
        self.x = x
        self.y = y
        self.button = button
        self.key = key
    }

    public static func cursorMove(t: Double, x: Double, y: Double) -> TimelineEventWire {
        TimelineEventWire(t: t, type: "cursor_move", x: x, y: y)
    }

    public static func mouseButton(t: Double, type: String, x: Double, y: Double, button: String) -> TimelineEventWire {
        TimelineEventWire(t: t, type: type, x: x, y: y, button: button)
    }

    public static func key(t: Double, type: String, key: String) -> TimelineEventWire {
        TimelineEventWire(t: t, type: type, key: key)
    }

    private enum CodingKeys: String, CodingKey {
        case t, type, x, y, button, key
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(t, forKey: .t)
        try container.encode(type, forKey: .type)
        switch type {
        case "cursor_move", "mouse_down", "mouse_up":
            try container.encode(x, forKey: .x)
            try container.encode(y, forKey: .y)
            if type != "cursor_move" {
                try container.encode(button, forKey: .button)
            }
        case "key_down", "key_up":
            try container.encode(key, forKey: .key)
        default:
            break
        }
    }
}

/// Mirrors `EventNotificationParamsSchema` — the `event` notification wraps
/// a single `TimelineEvent` alongside the session it belongs to.
public struct EventNotificationParams: Encodable, Equatable {
    public let sessionId: String
    public let event: TimelineEventWire

    public init(sessionId: String, event: TimelineEventWire) {
        self.sessionId = sessionId
        self.event = event
    }
}

/// Mirrors `LogNotificationParamsSchema`.
public struct LogNotificationParams: Encodable, Equatable {
    public let sessionId: String?
    public let level: String
    public let message: String

    public init(sessionId: String?, level: String, message: String) {
        self.sessionId = sessionId
        self.level = level
        self.message = message
    }
}

// MARK: - Pure, headlessly-testable logic

/// Pure 30Hz throttle decision, extracted so it's testable without a live
/// `CGEventTap`/run loop. `lastEmittedMs` is `nil` on the very first move
/// (always emitted). Timestamps are in the same "ms since session start"
/// unit as `TimelineEvent.t`.
public enum EventThrottle {
    public static let minIntervalMs: Double = 1000.0 / 30.0

    public static func shouldEmit(nowMs: Double, lastEmittedMs: Double?, minIntervalMs: Double = EventThrottle.minIntervalMs) -> Bool {
        guard let lastEmittedMs = lastEmittedMs else { return true }
        return (nowMs - lastEmittedMs) >= minIntervalMs
    }
}

/// Pure pixel-coordinate conversion, matching the convention already used by
/// `EnumerationService.mapDisplay`/`mapWindow`: `CaptureTarget.bounds` is
/// pixels in the same top-left-origin global Quartz space `CGEventTap`
/// event locations already use — the only conversion needed is
/// `× scaleFactor` (no axis flip, no origin translation).
public enum EventCoordinateConversion {
    public static func toPixels(_ point: CGPoint, scaleFactor: Double) -> (x: Double, y: Double) {
        (x: point.x * scaleFactor, y: point.y * scaleFactor)
    }
}

// MARK: - Live capture source

/// Session-scoped `CGEventTap`-based cursor/click/key capture. Two
/// independent taps are used deliberately (see the class doc below on
/// `keyboardCaptureActive`) rather than one combined tap: a keyboard-only
/// tap failure (e.g. some secure-input contexts block `CGEventTap` creation
/// for `.keyDown`/`.keyUp`) must not take down cursor/click capture, which
/// has no such failure mode once Accessibility is granted (Phase 2/3
/// baseline).
///
/// Threading: `CGEventTap` requires an active `CFRunLoop` pumping its
/// `CFRunLoopSource` — the process's main thread here is driven by a
/// blocking synchronous `readLine()` loop in `main.swift` with no run loop
/// of its own, so this class spins up ONE dedicated background thread with
/// its own `CFRunLoop` and installs both taps' sources on it. Getting this
/// wrong (e.g. creating the tap without ever pumping a run loop on the
/// thread that owns it) silently no-ops — the tap is created successfully
/// but never fires.
public final class EventTapSource {
    private let sessionId: String
    private let startedAt: Date
    private let scaleFactorResolver: (CGPoint) -> Double
    private let emit: (String, JSONValue) -> Void

    private var thread: Thread?
    private var runLoop: CFRunLoop?

    private var mouseTap: CFMachPort?
    private var mouseRunLoopSource: CFRunLoopSource?
    private var keyTap: CFMachPort?
    private var keyRunLoopSource: CFRunLoopSource?

    /// Only ever touched from the tap callback thread (single-threaded once
    /// installed on the dedicated run loop), so no separate lock is needed
    /// for this field specifically.
    private var lastCursorMoveEmittedMs: Double?

    private let stateLock = NSLock()
    private var stopped = false

    /// Whether the keyboard tap was actually created successfully this
    /// session. `false` until `start()` determines the outcome; backs
    /// `eventTimeline.keyboard` capability truthfulness at the
    /// `EventTimeline.capabilities.keystrokes` level the daemon populates
    /// (see main.swift's `supportedCapabilities` doc comment for the
    /// static-vs-per-session capability-granularity discussion).
    public private(set) var keyboardCaptureActive: Bool = false

    public init(
        sessionId: String,
        startedAt: Date,
        scaleFactorResolver: @escaping (CGPoint) -> Double = EnumerationService.backingScaleFactor(forPoint:),
        emit: @escaping (String, JSONValue) -> Void
    ) {
        self.sessionId = sessionId
        self.startedAt = startedAt
        self.scaleFactorResolver = scaleFactorResolver
        self.emit = emit
    }

    /// Creates both taps and starts pumping their run loop on a dedicated
    /// background thread. Safe to call at most once. Never throws — tap
    /// creation failures are handled internally (mouse-tap failure means no
    /// cursor/click capture this session; keyboard-tap failure is logged via
    /// the `log` notification and reflected in `keyboardCaptureActive`).
    public func start() {
        let thread = Thread { [weak self] in
            self?.runOnDedicatedThread()
        }
        thread.name = "windower.eventtap.\(sessionId)"
        thread.qualityOfService = .userInteractive
        self.thread = thread
        thread.start()
    }

    /// Invalidates both taps' run loop sources and stops the dedicated run
    /// loop, mirroring `MicrophoneCaptureSource.stop()`'s call pattern from
    /// `CaptureSessionManager`. Safe to call multiple times / from any
    /// thread.
    public func stop() {
        stateLock.lock()
        if stopped {
            stateLock.unlock()
            return
        }
        stopped = true
        stateLock.unlock()

        // Tear down on the owning run loop so CFMachPort invalidation
        // happens on the thread that installed it.
        if let runLoop = runLoop {
            CFRunLoopPerformBlock(runLoop, CFRunLoopMode.commonModes.rawValue) { [weak self] in
                self?.teardownTaps()
                if let rl = self?.runLoop {
                    CFRunLoopStop(rl)
                }
            }
            CFRunLoopWakeUp(runLoop)
        }
    }

    deinit {
        stop()
    }

    // MARK: - Dedicated thread/run loop

    private func runOnDedicatedThread() {
        runLoop = CFRunLoopGetCurrent()

        installMouseTap()
        installKeyTap()

        // Keep the run loop alive even if both taps failed to create — the
        // thread just idles until `stop()` wakes it, which is simpler and
        // safer than tearing the thread down and racing `stop()`.
        CFRunLoopRun()
    }

    private func installMouseTap() {
        let eventMask: CGEventMask =
            (1 << CGEventType.mouseMoved.rawValue)
            | (1 << CGEventType.leftMouseDown.rawValue)
            | (1 << CGEventType.leftMouseUp.rawValue)
            | (1 << CGEventType.rightMouseDown.rawValue)
            | (1 << CGEventType.rightMouseUp.rawValue)
            | (1 << CGEventType.otherMouseDown.rawValue)
            | (1 << CGEventType.otherMouseUp.rawValue)

        let refcon = Unmanaged.passUnretained(self).toOpaque()
        guard
            let tap = CGEvent.tapCreate(
                tap: .cgSessionEventTap,
                place: .headInsertEventTap,
                options: .listenOnly,
                eventsOfInterest: eventMask,
                callback: { _, type, event, userInfo in
                    guard let userInfo = userInfo else { return Unmanaged.passUnretained(event) }
                    let source = Unmanaged<EventTapSource>.fromOpaque(userInfo).takeUnretainedValue()
                    source.handleMouseEvent(type: type, event: event)
                    return Unmanaged.passUnretained(event)
                },
                userInfo: refcon)
        else {
            logStderr("windower-sidecar-macos: failed to create mouse/cursor CGEventTap for session \(sessionId)")
            return
        }

        mouseTap = tap
        let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        mouseRunLoopSource = source
        if let source = source, let runLoop = runLoop {
            CFRunLoopAddSource(runLoop, source, .commonModes)
        }
        CGEvent.tapEnable(tap: tap, enable: true)
    }

    private func installKeyTap() {
        let eventMask: CGEventMask =
            (1 << CGEventType.keyDown.rawValue) | (1 << CGEventType.keyUp.rawValue)

        let refcon = Unmanaged.passUnretained(self).toOpaque()
        guard
            let tap = CGEvent.tapCreate(
                tap: .cgSessionEventTap,
                place: .headInsertEventTap,
                options: .listenOnly,
                eventsOfInterest: eventMask,
                callback: { _, type, event, userInfo in
                    guard let userInfo = userInfo else { return Unmanaged.passUnretained(event) }
                    let source = Unmanaged<EventTapSource>.fromOpaque(userInfo).takeUnretainedValue()
                    source.handleKeyEvent(type: type, event: event)
                    return Unmanaged.passUnretained(event)
                },
                userInfo: refcon)
        else {
            // Best-effort: some secure-input contexts (e.g. a password
            // field focused elsewhere) block key-event tap creation
            // entirely. Never fail startCapture over this — just signal it
            // so the daemon/user has a log trail, per phase-10's explicit
            // "never silently claim a capability that didn't actually work
            // this session" requirement.
            logStderr("windower-sidecar-macos: failed to create keyboard CGEventTap for session \(sessionId) (secure input or missing Accessibility grant)")
            emitLog(level: "warn", message: "keyboard capture unavailable this session: CGEventTap creation failed (secure input or missing Accessibility grant)")
            keyboardCaptureActive = false
            return
        }

        keyTap = tap
        let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        keyRunLoopSource = source
        if let source = source, let runLoop = runLoop {
            CFRunLoopAddSource(runLoop, source, .commonModes)
        }
        CGEvent.tapEnable(tap: tap, enable: true)
        keyboardCaptureActive = true
    }

    private func teardownTaps() {
        if let source = mouseRunLoopSource, let runLoop = runLoop {
            CFRunLoopRemoveSource(runLoop, source, .commonModes)
        }
        if let tap = mouseTap {
            CGEvent.tapEnable(tap: tap, enable: false)
        }
        mouseTap = nil
        mouseRunLoopSource = nil

        if let source = keyRunLoopSource, let runLoop = runLoop {
            CFRunLoopRemoveSource(runLoop, source, .commonModes)
        }
        if let tap = keyTap {
            CGEvent.tapEnable(tap: tap, enable: false)
        }
        keyTap = nil
        keyRunLoopSource = nil
    }

    // MARK: - Event handling (runs on the dedicated tap thread)

    private func handleMouseEvent(type: CGEventType, event: CGEvent) {
        let nowMs = Date().timeIntervalSince(startedAt) * 1000
        // `event.location` is in the same top-left-origin global Quartz
        // coordinate space as SCWindow.frame/SCDisplay bounds (points) —
        // see EnumerationService.mapWindow's doc comment on that
        // convention. Only the scale-factor conversion is needed here.
        let location = event.location
        let scaleFactor = scaleFactorResolver(location)
        let pixels = EventCoordinateConversion.toPixels(location, scaleFactor: scaleFactor)

        switch type {
        case .mouseMoved:
            guard EventThrottle.shouldEmit(nowMs: nowMs, lastEmittedMs: lastCursorMoveEmittedMs) else { return }
            lastCursorMoveEmittedMs = nowMs
            emitEvent(.cursorMove(t: nowMs, x: pixels.x, y: pixels.y))

        case .leftMouseDown:
            emitEvent(.mouseButton(t: nowMs, type: "mouse_down", x: pixels.x, y: pixels.y, button: "left"))
        case .leftMouseUp:
            emitEvent(.mouseButton(t: nowMs, type: "mouse_up", x: pixels.x, y: pixels.y, button: "left"))
        case .rightMouseDown:
            emitEvent(.mouseButton(t: nowMs, type: "mouse_down", x: pixels.x, y: pixels.y, button: "right"))
        case .rightMouseUp:
            emitEvent(.mouseButton(t: nowMs, type: "mouse_up", x: pixels.x, y: pixels.y, button: "right"))
        case .otherMouseDown:
            emitEvent(.mouseButton(t: nowMs, type: "mouse_down", x: pixels.x, y: pixels.y, button: "other"))
        case .otherMouseUp:
            emitEvent(.mouseButton(t: nowMs, type: "mouse_up", x: pixels.x, y: pixels.y, button: "other"))
        default:
            break
        }
    }

    private func handleKeyEvent(type: CGEventType, event: CGEvent) {
        let nowMs = Date().timeIntervalSince(startedAt) * 1000
        let key = Self.keyDescription(for: event)
        switch type {
        case .keyDown:
            emitEvent(.key(t: nowMs, type: "key_down", key: key))
        case .keyUp:
            emitEvent(.key(t: nowMs, type: "key_up", key: key))
        default:
            break
        }
    }

    /// Best-effort key description (phase-10 explicitly does not require a
    /// full keymap): prefer the raw keycode stringified, since it's always
    /// available and stable regardless of modifier state/layout — matching
    /// "best-effort keystrokes" from spec.md §2.3/data-model.md's comment on
    /// `TimelineEvent.key`.
    static func keyDescription(for event: CGEvent) -> String {
        let keyCode = event.getIntegerValueField(.keyboardEventKeycode)
        return "keyCode:\(keyCode)"
    }

    // MARK: - Emission

    private func emitEvent(_ event: TimelineEventWire) {
        let params = EventNotificationParams(sessionId: sessionId, event: event)
        guard let encoded = try? JSONCodec.encode(params) else { return }
        emit("event", encoded)
    }

    private func emitLog(level: String, message: String) {
        let params = LogNotificationParams(sessionId: sessionId, level: level, message: message)
        guard let encoded = try? JSONCodec.encode(params) else { return }
        emit("log", encoded)
    }
}
