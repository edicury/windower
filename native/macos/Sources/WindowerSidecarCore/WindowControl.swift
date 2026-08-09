import ApplicationServices
import AppKit
import CoreGraphics
import Foundation

/// Phase 3 — `resizeWindow`. Maps a `CGWindowID` (the `targetId` string
/// produced by `EnumerationService.mapWindow`) to its owning process, then to
/// the matching `AXUIElement` window, and sets its frame via the
/// Accessibility API. Public params/results are always **pixels** in the
/// global coordinate space (see `Rect`); all AX/Quartz math happens in
/// **points** and is converted at the boundary, mirroring the pattern in
/// `EnumerationService`.

public struct ResizeWindowParams: Decodable {
    public let targetId: String
    public let bounds: Rect
}

public struct ResizeWindowResult: Encodable {
    public let actualBounds: Rect
    public let result: String

    public init(actualBounds: Rect, result: String) {
        self.actualBounds = actualBounds
        self.result = result
    }
}

public enum WindowControlService {
    /// Snapshot of the `CGWindowListCopyWindowInfo` entry for a given
    /// `CGWindowID`: owning pid plus bounds/title in **points**, screen
    /// (Quartz global) coordinates — the same space AX position/size use.
    struct CGWindowSnapshot {
        let pid: pid_t
        let bounds: CGRect
        let title: String?
    }

    // MARK: - Public entry point

    public static func resizeWindow(targetId: String, bounds: Rect) throws -> ResizeWindowResult {
        guard let windowIDValue = UInt32(targetId) else {
            throw SidecarRpcError.serverError(
                "targetId '\(targetId)' is not a valid window id", code: .targetNotFound)
        }
        let windowID = CGWindowID(windowIDValue)

        let snapshot = try lookupCGWindowSnapshot(windowID: windowID)
        let axWindow = try findAXWindow(pid: snapshot.pid, matching: snapshot)

        var positionSettable: DarwinBoolean = false
        var sizeSettable: DarwinBoolean = false
        _ = AXUIElementIsAttributeSettable(axWindow, kAXPositionAttribute as CFString, &positionSettable)
        _ = AXUIElementIsAttributeSettable(axWindow, kAXSizeAttribute as CFString, &sizeSettable)
        guard positionSettable.boolValue, sizeSettable.boolValue else {
            throw SidecarRpcError.serverError(
                "targetId '\(targetId)' does not support programmatic resize", code: .resizeUnsupported)
        }

        // Same scale factor convention as EnumerationService.mapWindow: the
        // screen the window's origin falls on. bounds is pixels in the same
        // global-origin space CGWindowList/AX use, so dividing by
        // scaleFactor (no axis flip) is the correct inverse of mapWindow's
        // points * scaleFactor.
        let scaleFactor = EnumerationService.backingScaleFactor(
            forPoint: CGPoint(x: bounds.x, y: bounds.y))
        let pointsBounds = pixelsToPoints(bounds, scaleFactor: scaleFactor)

        var pointOrigin = CGPoint(x: pointsBounds.x, y: pointsBounds.y)
        var pointSize = CGSize(width: pointsBounds.width, height: pointsBounds.height)
        guard let positionValue = AXValueCreate(.cgPoint, &pointOrigin),
            let sizeValue = AXValueCreate(.cgSize, &pointSize)
        else {
            throw SidecarRpcError.serverError(
                "Failed to construct AXValue for requested bounds", code: .internalError)
        }

        // Position then size: matches the common AX convention (setting
        // size first can clip against the current position on some apps
        // when growing toward a screen edge).
        _ = AXUIElementSetAttributeValue(axWindow, kAXPositionAttribute as CFString, positionValue)
        _ = AXUIElementSetAttributeValue(axWindow, kAXSizeAttribute as CFString, sizeValue)

        guard let actualPositionPoints = axPosition(of: axWindow),
            let actualSizePoints = axSize(of: axWindow)
        else {
            throw SidecarRpcError.serverError(
                "Failed to read back window frame after resize", code: .internalError)
        }
        let actualPointsRect = Rect(
            x: actualPositionPoints.x, y: actualPositionPoints.y,
            width: actualSizePoints.width, height: actualSizePoints.height)
        let actualPixelsRect = pointsToPixels(actualPointsRect, scaleFactor: scaleFactor)

        return ResizeWindowResult(
            actualBounds: actualPixelsRect,
            result: resultForActual(requested: bounds, actual: actualPixelsRect))
    }

    // MARK: - CGWindowList lookup

    static func lookupCGWindowSnapshot(windowID: CGWindowID) throws -> CGWindowSnapshot {
        guard let infoList = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]] else {
            throw SidecarRpcError.serverError("Failed to query window list", code: .internalError)
        }
        guard
            let info = infoList.first(where: { entry in
                guard let number = entry[kCGWindowNumber as String] as? Int else { return false }
                return CGWindowID(number) == windowID
            })
        else {
            throw SidecarRpcError.serverError(
                "targetId '\(windowID)' no longer exists", code: .targetNotFound)
        }
        guard let ownerPidInt = info[kCGWindowOwnerPID as String] as? Int else {
            throw SidecarRpcError.serverError(
                "targetId '\(windowID)' has no owning process", code: .targetNotFound)
        }
        guard let boundsDict = info[kCGWindowBounds as String] as? [String: Any],
            let bounds = CGRect(dictionaryRepresentation: boundsDict as CFDictionary)
        else {
            throw SidecarRpcError.serverError(
                "targetId '\(windowID)' has no bounds", code: .targetNotFound)
        }
        let title = info[kCGWindowName as String] as? String
        return CGWindowSnapshot(pid: pid_t(ownerPidInt), bounds: bounds, title: title)
    }

    // MARK: - AXUIElement lookup

    static func findAXWindow(pid: pid_t, matching snapshot: CGWindowSnapshot) throws -> AXUIElement {
        let appElement = AXUIElementCreateApplication(pid)
        var windowsRef: CFTypeRef?
        let axError = AXUIElementCopyAttributeValue(appElement, kAXWindowsAttribute as CFString, &windowsRef)
        guard axError == .success, let windows = windowsRef as? [AXUIElement], !windows.isEmpty else {
            throw SidecarRpcError.serverError(
                "No AX windows found for the owning process", code: .targetNotFound)
        }

        let candidates: [(position: CGPoint, size: CGSize, title: String?)] = windows.map { window in
            (position: axPosition(of: window) ?? .zero, size: axSize(of: window) ?? .zero,
                title: axTitle(of: window))
        }

        guard
            let matchIndex = bestMatchIndex(
                candidates: candidates, targetBounds: snapshot.bounds, targetTitle: snapshot.title)
        else {
            throw SidecarRpcError.serverError(
                "No AX window matched targetId's position/size/title", code: .targetNotFound)
        }
        return windows[matchIndex]
    }

    static func axPosition(of element: AXUIElement) -> CGPoint? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &value) == .success,
            let axValue = value
        else { return nil }
        var point = CGPoint.zero
        guard AXValueGetValue((axValue as! AXValue), .cgPoint, &point) else { return nil }
        return point
    }

    static func axSize(of element: AXUIElement) -> CGSize? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &value) == .success,
            let axValue = value
        else { return nil }
        var size = CGSize.zero
        guard AXValueGetValue((axValue as! AXValue), .cgSize, &size) else { return nil }
        return size
    }

    static func axTitle(of element: AXUIElement) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXTitleAttribute as CFString, &value) == .success
        else { return nil }
        return value as? String
    }

    // MARK: - Pure, headlessly-testable logic

    /// Picks the AX window candidate whose position+size (both **points**,
    /// screen coords) is closest (Euclidean distance across x/y/w/h) to the
    /// `CGWindowList` snapshot's bounds for the target window. AX exposes no
    /// direct `CGWindowID`, so this positional match is the only available
    /// correlation (per phase-3-window-control.md); an exact title match is
    /// used as a tiebreaker to accept a looser geometry match (windows can
    /// shift slightly between the two independent queries).
    public static func bestMatchIndex(
        candidates: [(position: CGPoint, size: CGSize, title: String?)],
        targetBounds: CGRect,
        targetTitle: String?,
        geometryEpsilon: Double = 2.0
    ) -> Int? {
        var bestIndex: Int?
        var bestDistance = Double.greatestFiniteMagnitude
        for (idx, candidate) in candidates.enumerated() {
            let dx = candidate.position.x - targetBounds.origin.x
            let dy = candidate.position.y - targetBounds.origin.y
            let dw = candidate.size.width - targetBounds.width
            let dh = candidate.size.height - targetBounds.height
            let distance = (dx * dx + dy * dy + dw * dw + dh * dh).squareRoot()
            if distance < bestDistance {
                bestDistance = distance
                bestIndex = idx
            }
        }
        guard let idx = bestIndex else { return nil }
        if bestDistance <= geometryEpsilon { return idx }
        if let targetTitle, !targetTitle.isEmpty,
            candidates[idx].title == targetTitle,
            bestDistance <= geometryEpsilon * 25
        {
            return idx
        }
        return nil
    }

    /// Inverse of `EnumerationService.mapWindow`'s `points * scaleFactor` —
    /// same origin convention (global Quartz coordinates), just scaled down.
    public static func pixelsToPoints(_ rect: Rect, scaleFactor: Double) -> Rect {
        Rect(
            x: rect.x / scaleFactor, y: rect.y / scaleFactor,
            width: rect.width / scaleFactor, height: rect.height / scaleFactor)
    }

    public static func pointsToPixels(_ rect: Rect, scaleFactor: Double) -> Rect {
        Rect(
            x: rect.x * scaleFactor, y: rect.y * scaleFactor,
            width: rect.width * scaleFactor, height: rect.height * scaleFactor)
    }

    /// `"success"` if the actual resulting pixel bounds match the requested
    /// pixel bounds within `epsilon` on every field, `"partial"` otherwise
    /// (window managers can clamp/snap to screen edges, minimum sizes, etc).
    public static func resultForActual(requested: Rect, actual: Rect, epsilon: Double = 1.0) -> String {
        let matches =
            abs(requested.x - actual.x) <= epsilon
            && abs(requested.y - actual.y) <= epsilon
            && abs(requested.width - actual.width) <= epsilon
            && abs(requested.height - actual.height) <= epsilon
        return matches ? "success" : "partial"
    }
}
