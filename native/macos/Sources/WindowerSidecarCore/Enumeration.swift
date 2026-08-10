import AppKit
import CoreGraphics
import Foundation
import ScreenCaptureKit

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

    /// `SCShareableContent.current` is async-only on the ScreenCaptureKit
    /// API surface; this wraps it in a semaphore so it can be called from
    /// the synchronous per-line dispatch loop in main.swift. Enumeration is
    /// normally fast (no frame capture involved), but the wait is bounded
    /// (see `EnumerationError.timedOut`) rather than unconditional — this is
    /// the ONLY thread servicing the sidecar's JSON-RPC loop, so a call here
    /// that never completes must not be allowed to wedge the whole process.
    public static func fetchShareableContent(
        timeoutMs: Double = fetchShareableContentTimeoutMs
    ) throws -> SCShareableContent {
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

    public static func backingScaleFactor(forDisplayID displayID: CGDirectDisplayID) -> Double {
        for screen in NSScreen.screens {
            guard let screenNumber = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber
            else { continue }
            if CGDirectDisplayID(screenNumber.uint32Value) == displayID {
                return Double(screen.backingScaleFactor)
            }
        }
        return Double(NSScreen.main?.backingScaleFactor ?? 1.0)
    }

    public static func backingScaleFactor(forPoint point: CGPoint) -> Double {
        for screen in NSScreen.screens where screen.frame.contains(point) {
            return Double(screen.backingScaleFactor)
        }
        return Double(NSScreen.main?.backingScaleFactor ?? 1.0)
    }

    public static func displayName(forDisplayID displayID: CGDirectDisplayID) -> String {
        for screen in NSScreen.screens {
            guard let screenNumber = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber
            else { continue }
            if CGDirectDisplayID(screenNumber.uint32Value) == displayID {
                if #available(macOS 10.15, *) {
                    return screen.localizedName
                }
            }
        }
        return "Display \(displayID)"
    }
}
