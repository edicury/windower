import AppKit
import CoreGraphics
import Foundation

// Phase 21 — capture/control process split.
//
// Display geometry lookups (backing scale factor, localized display name)
// used to live on `EnumerationService` in the (now capture-only)
// ScreenCaptureKit-importing module. Both surfaces need them — the capture
// surface for pixel/point conversion when mapping `SCDisplay`/`SCWindow`, the
// control surface for `performInput`'s pixels→points conversion and
// `resizeWindow`'s AX bounds math — and neither of those uses touches
// ScreenCaptureKit: `NSScreen`/`CGDirectDisplayID` are plain AppKit/CoreGraphics.
//
// Keeping them here is what lets `WindowerControlCore` (and therefore
// `windower-control-macos`) stay free of any ScreenCaptureKit linkage while
// still doing correct per-display Retina math. See CLAUDE.md's units rule and
// research.md §3.
public enum ScreenGeometry {
    public static func backingScaleFactor(forDisplayID displayID: CGDirectDisplayID) -> Double {
        for screen in NSScreen.screens {
            guard
                let screenNumber = screen.deviceDescription[
                    NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber
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
            guard
                let screenNumber = screen.deviceDescription[
                    NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber
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
