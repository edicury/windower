import AppKit
import CoreGraphics
import Foundation
import ScreenCaptureKit
import WindowerSidecarShared

public struct EnumerateTargetsParams: Decodable {
    public let kinds: [String]?
}

public struct EnumerateTargetsResult: Encodable {
    public let targets: [CaptureTarget]

    public init(targets: [CaptureTarget]) {
        self.targets = targets
    }
}

public enum EnumerationError: Error {
    case sckFailure(String)
    /// bugs.spec.md #6: `SCShareableContent.getWithCompletionHandler`'s
    /// completion handler is not guaranteed to fire promptly (or, per field
    /// evidence, possibly at all) when called on the same process as an
    /// active `SCStream` recording — `enumerateTargets`/`captureFrame` both
    /// route through this call, and both are invoked repeatedly by the
    /// operator loop *during* a live capture. Before this fix, an unbounded
    /// `semaphore.wait()` here meant a hang in that completion handler
    /// permanently wedged the sidecar's single-threaded stdio dispatch loop
    /// (`main.swift`'s `while let line = readLine()`) — no more RPCs of ANY
    /// kind could ever be serviced again, matching the observed symptom
    /// exactly (the daemon-free `operate` CLI and sidecar process both sat
    /// alive producing zero further output). Bounding the wait converts that
    /// silent total freeze into a reported, catchable error the caller (the
    /// operator loop, which already re-observes after every failed step) can
    /// recover from instead of hanging forever.
    case timedOut(afterMs: Double)
}

public enum EnumerationService {
    /// Default bound for `fetchShareableContent`'s blocking wait — see
    /// `EnumerationError.timedOut`'s doc. 8s is generous relative to the
    /// sub-100ms latency this call shows in every observed healthy run
    /// (raw-sidecar repros in bugs.spec.md #6 consistently logged <150ms),
    /// while still short enough that an `operate` step waiting on it fails
    /// fast rather than looking indistinguishable from a total hang.
    public static let fetchShareableContentTimeoutMs: Double = 8000

    /// Phase 21 — short-TTL `SCShareableContent` cache.
    ///
    /// Every `SCShareableContent.getWithCompletionHandler` call is a
    /// round-trip into `replayd`, the shared system singleton whose
    /// destabilization is the root cause of bugs.spec.md #6. The organic call
    /// pattern is bursty rather than steady: `enumerateTargets` (a
    /// `list_targets`) is routinely followed within milliseconds by a
    /// resolve-the-target call from `startCapture`/`captureFrame`, and each
    /// one used to pay its own independent round-trip for content that could
    /// not meaningfully have changed in between.
    ///
    /// 250ms is the tunable: long enough to collapse a burst into one
    /// round-trip, short enough that a window that genuinely moved or closed
    /// is picked up within a frame or two at 30fps — and every consumer of
    /// this content already tolerates the target vanishing between
    /// enumeration and use (`captureFrame` maps exactly that race to
    /// `TARGET_NOT_FOUND`). Set to `0` to disable the cache entirely.
    public static let shareableContentCacheTtlMs: Double = 250

    /// Process-wide, and therefore only ever populated inside
    /// `windower-capture-macos` — the one process allowed to hold
    /// ScreenCaptureKit state at all (phase-21's governing invariant).
    static let shareableContentCache = TimedValueCache<SCShareableContent>(
        ttlMs: shareableContentCacheTtlMs)

    /// Drops the cached content. Call after anything that is known to change
    /// the shareable-content set in a way a caller will immediately observe.
    public static func invalidateShareableContentCache() {
        shareableContentCache.invalidate()
    }

    /// `SCShareableContent.current` is async-only on the ScreenCaptureKit
    /// API surface; this wraps it in a semaphore so it can be called from
    /// the synchronous per-line dispatch loop in main.swift. Enumeration is
    /// normally fast (no frame capture involved), but the wait is bounded
    /// (see `EnumerationError.timedOut`) rather than unconditional — this is
    /// the ONLY thread servicing the sidecar's JSON-RPC loop, so a call here
    /// that never completes must not be allowed to wedge the whole process.
    ///
    /// Served from `shareableContentCache` when a result younger than
    /// `shareableContentCacheTtlMs` is available; pass `bypassCache: true`
    /// for the rare caller that needs an unconditionally fresh round-trip.
    public static func fetchShareableContent(
        timeoutMs: Double = fetchShareableContentTimeoutMs,
        bypassCache: Bool = false
    ) throws -> SCShareableContent {
        if !bypassCache, let cached = shareableContentCache.value() {
            return cached
        }
        var result: Result<SCShareableContent, Error>?
        let semaphore = DispatchSemaphore(value: 0)
        SCShareableContent.getWithCompletionHandler { content, error in
            if let error = error {
                result = .failure(error)
            } else if let content = content {
                result = .success(content)
            } else {
                result = .failure(EnumerationError.sckFailure("SCShareableContent returned neither content nor error"))
            }
            semaphore.signal()
        }
        let waitResult = semaphore.wait(timeout: .now() + .milliseconds(Int(timeoutMs)))
        if waitResult == .timedOut {
            throw EnumerationError.timedOut(afterMs: timeoutMs)
        }
        switch result {
        case .success(let content):
            // Only successes are cached — an error or a timeout must not be
            // sticky, or one bad round-trip would poison every call for the
            // whole TTL window.
            shareableContentCache.store(content)
            return content
        case .failure(let error):
            throw error
        case .none:
            throw EnumerationError.sckFailure("SCShareableContent completion handler never fired")
        }
    }

    public static func enumerateTargets(kinds: [String]?) throws -> [CaptureTarget] {
        let wantDisplays = kinds?.contains("display") ?? true
        let wantWindows = kinds?.contains("window") ?? true

        let content = try fetchShareableContent()
        var targets: [CaptureTarget] = []

        if wantDisplays {
            targets.append(contentsOf: content.displays.map(mapDisplay))
        }
        if wantWindows {
            targets.append(contentsOf: content.windows.compactMap(mapWindow))
        }
        return targets
    }

    /// Maps an `SCDisplay` (whose `.frame` is in **points**) to
    /// `CaptureTarget.display` with `bounds` converted to **pixels** via the
    /// matching `NSScreen`'s `backingScaleFactor`. See research.md §3 — this
    /// conversion must never leak past the sidecar boundary as points.
    public static func mapDisplay(_ display: SCDisplay) -> CaptureTarget {
        let scaleFactor = backingScaleFactor(forDisplayID: display.displayID)
        let pointsFrame = display.frame
        let bounds = Rect(
            x: pointsFrame.origin.x * scaleFactor,
            y: pointsFrame.origin.y * scaleFactor,
            width: pointsFrame.width * scaleFactor,
            height: pointsFrame.height * scaleFactor
        )
        let isPrimary = display.displayID == CGMainDisplayID()
        let name = displayName(forDisplayID: display.displayID)
        return .display(
            id: String(display.displayID),
            name: name,
            bounds: bounds,
            isPrimary: isPrimary,
            scaleFactor: scaleFactor
        )
    }

    /// Maps an `SCWindow` (whose `.frame` is in **points**, on the *primary*
    /// display's coordinate origin per Quartz window server conventions) to
    /// `CaptureTarget.window` with `bounds` converted to **pixels** using the
    /// scale factor of the screen the window's origin falls on. Windows with
    /// no title and no owning app are skipped (matches "visible windows with
    /// non-empty titles" from the phase-2 exit criteria — off-screen/system
    /// windows without titles aren't useful recording targets).
    public static func mapWindow(_ window: SCWindow) -> CaptureTarget? {
        guard let app = window.owningApplication else { return nil }
        let title = window.title ?? ""
        if title.isEmpty { return nil }
        // Per-Space/per-display desktop and window-server layer entries
        // (e.g. duplicate "Desktop" windows, one per virtual display
        // arrangement) surface with a title but no real owning app identity.
        // Real application windows always have both; skip anything missing
        // either rather than showing noise agents/users would have to
        // filter out themselves (see bugs.spec.md #1).
        if app.applicationName.isEmpty || app.bundleIdentifier.isEmpty { return nil }

        let scaleFactor = backingScaleFactor(forPoint: window.frame.origin)
        let pointsFrame = window.frame
        let bounds = Rect(
            x: pointsFrame.origin.x * scaleFactor,
            y: pointsFrame.origin.y * scaleFactor,
            width: pointsFrame.width * scaleFactor,
            height: pointsFrame.height * scaleFactor
        )

        let isFocused = NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processID

        return .window(
            id: String(window.windowID),
            title: title,
            appName: app.applicationName,
            appBundleId: app.bundleIdentifier,
            bounds: bounds,
            isFocused: isFocused,
            // ScreenCaptureKit doesn't directly expose "is this window
            // programmatically resizable"; that's an AX-layer question
            // (Phase 3's window-control capability). Conservatively report
            // `true` only for normal on-screen windows with a non-empty
            // title (a reasonable proxy at enumeration time); Phase 3's
            // resizeWindow is the source of truth and returns
            // RESIZE_UNSUPPORTED per-call regardless of this flag.
            resizable: true
        )
    }

    // Phase 21: the actual implementations moved to
    // `WindowerSidecarShared.ScreenGeometry` so `WindowerControlCore` (which
    // needs the same per-display Retina math for `performInput`/`resizeWindow`)
    // can use them without importing this ScreenCaptureKit-linked module.
    // These forwarders keep this file's own call sites — and the "scale factor
    // conventions live next to the mapping that defines them" reading of
    // research.md §3 — intact.

    public static func backingScaleFactor(forDisplayID displayID: CGDirectDisplayID) -> Double {
        ScreenGeometry.backingScaleFactor(forDisplayID: displayID)
    }

    public static func backingScaleFactor(forPoint point: CGPoint) -> Double {
        ScreenGeometry.backingScaleFactor(forPoint: point)
    }

    public static func displayName(forDisplayID displayID: CGDirectDisplayID) -> String {
        ScreenGeometry.displayName(forDisplayID: displayID)
    }
}
