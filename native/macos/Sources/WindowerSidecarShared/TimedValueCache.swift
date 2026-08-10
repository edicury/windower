import Foundation

// Phase 21 — capture/control process split.
//
// A minimal, thread-safe, single-slot TTL cache. Introduced for
// `EnumerationService.fetchShareableContent`'s short-TTL
// `SCShareableContent` cache (phase-21, "Native macOS"): back-to-back
// `enumerateTargets` calls — `list_targets` immediately followed by the
// resolve-target-for-capture call `startCapture`/`captureFrame` makes — used
// to trigger one independent `SCShareableContent` round-trip each, and every
// such round-trip is a chance to destabilize `replayd` (bugs.spec.md #6).
//
// Lives in the shared module rather than next to its only current caller so
// it stays free of ScreenCaptureKit and is unit-testable with an injected
// clock (a real `SCShareableContent` can't be constructed in CI — CLAUDE.md's
// "TCC permissions gate CI").
public final class TimedValueCache<Value> {
    /// Time-to-live in milliseconds. A stored value older than this is
    /// treated as absent.
    public let ttlMs: Double

    private let clockMs: () -> Double
    private let lock = NSLock()
    private var stored: (value: Value, storedAtMs: Double)?

    /// - Parameters:
    ///   - ttlMs: how long a stored value stays valid. `<= 0` disables the
    ///     cache entirely (every `value()` misses), which is the intended way
    ///     to turn the optimization off without branching at call sites.
    ///   - clockMs: monotonic-ish millisecond clock; injectable so tests can
    ///     drive expiry deterministically instead of sleeping.
    public init(
        ttlMs: Double,
        clockMs: @escaping () -> Double = { ProcessInfo.processInfo.systemUptime * 1000 }
    ) {
        self.ttlMs = ttlMs
        self.clockMs = clockMs
    }

    /// The stored value if one was stored less than `ttlMs` ago, else `nil`.
    public func value() -> Value? {
        lock.lock()
        defer { lock.unlock() }
        guard ttlMs > 0, let stored = stored else { return nil }
        let age = clockMs() - stored.storedAtMs
        // A negative age (clock moved backwards) is treated as fresh rather
        // than as an error: the worst case is one extra hit of an
        // already-validated value.
        if age > ttlMs {
            self.stored = nil
            return nil
        }
        return stored.value
    }

    public func store(_ value: Value) {
        lock.lock()
        defer { lock.unlock() }
        stored = (value: value, storedAtMs: clockMs())
    }

    /// Drops any stored value. Used when a caller knows the cached content is
    /// stale (e.g. right after a capture target changed).
    public func invalidate() {
        lock.lock()
        defer { lock.unlock() }
        stored = nil
    }
}
