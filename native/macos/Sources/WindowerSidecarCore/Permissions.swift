import AVFoundation
import ApplicationServices
import CoreGraphics
import Foundation

/// Mirrors `PermissionStatus` in `data-model.md` exactly (raw values are the
/// wire strings).
public enum PermissionStatus: String, Encodable {
    case granted
    case denied
    case notDetermined = "not_determined"
    case notApplicable = "not_applicable"
}

/// Mirrors `PermissionReport` in `data-model.md`. The contract's
/// `getPermissions` result type is documented as "PermissionReport
/// (backend-relevant subset)" — TS accepts a `.partial()` of the full
/// shape, so the sidecar only fills in what it can actually speak to.
///
/// `daemonRunning` is omitted: the sidecar process has no visibility into
/// whether the daemon that spawned it is "the daemon" in any meaningful
/// sense beyond "something is talking to me over stdio right now", which
/// isn't the same question `PermissionReport.daemonRunning` is asking on
/// the TS side (whether the long-lived daemon process is up). That's a
/// daemon-process concern, so the sidecar leaves the field absent rather
/// than emit a meaningless `true`.
public struct PermissionReport: Encodable {
    public let screenRecording: PermissionStatus
    public let accessibility: PermissionStatus
    public let microphone: PermissionStatus
    public let sidecarAvailable: Bool
    public let sidecarVersion: String

    public init(
        screenRecording: PermissionStatus, accessibility: PermissionStatus,
        microphone: PermissionStatus, sidecarAvailable: Bool, sidecarVersion: String
    ) {
        self.screenRecording = screenRecording
        self.accessibility = accessibility
        self.microphone = microphone
        self.sidecarAvailable = sidecarAvailable
        self.sidecarVersion = sidecarVersion
    }
}

public enum PermissionKind: String, Decodable {
    case screenRecording
    case accessibility
    case microphone
}

public struct RequestPermissionParams: Decodable {
    public let kind: PermissionKind
}

public struct RequestPermissionResult: Encodable {
    public let status: PermissionStatus

    public init(status: PermissionStatus) {
        self.status = status
    }
}

public enum PermissionsService {
    /// Query current status for all three kinds without prompting the user.
    public static func currentReport(sidecarVersion: String) -> PermissionReport {
        PermissionReport(
            screenRecording: screenRecordingStatus(),
            accessibility: accessibilityStatus(),
            microphone: microphoneStatus(),
            sidecarAvailable: true,
            sidecarVersion: sidecarVersion
        )
    }

    public static func screenRecordingStatus() -> PermissionStatus {
        // CGPreflightScreenCaptureAccess never prompts; it simply reports the
        // current TCC decision. macOS has no distinct "not determined" signal
        // for this API — the first real attempt (or CGRequestScreenCaptureAccess)
        // is what surfaces the prompt, so an un-prompted process reads as
        // `denied` here until requestPermission is called at least once.
        CGPreflightScreenCaptureAccess() ? .granted : .denied
    }

    public static func accessibilityStatus() -> PermissionStatus {
        AXIsProcessTrusted() ? .granted : .denied
    }

    public static func microphoneStatus() -> PermissionStatus {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            return .granted
        case .denied, .restricted:
            return .denied
        case .notDetermined:
            return .notDetermined
        @unknown default:
            return .notDetermined
        }
    }

    /// Triggers the real OS prompt for the given kind (if not already
    /// decided) and returns the resulting status. Screen Recording and
    /// Accessibility grants only take effect after the app is
    /// relaunched/re-approved by the user in System Settings — the status
    /// returned here reflects the OS's synchronous answer to the request
    /// call, which for those two kinds is usually unchanged until the user
    /// acts on the prompt.
    public static func requestPermission(
        _ kind: PermissionKind, completion: @escaping (PermissionStatus) -> Void
    ) {
        switch kind {
        case .screenRecording:
            _ = CGRequestScreenCaptureAccess()
            completion(screenRecordingStatus())
        case .accessibility:
            let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue(): true] as CFDictionary
            _ = AXIsProcessTrustedWithOptions(options)
            completion(accessibilityStatus())
        case .microphone:
            AVCaptureDevice.requestAccess(for: .audio) { _ in
                completion(microphoneStatus())
            }
        }
    }
}
