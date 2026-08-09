import AVFoundation
import XCTest

import WindowerSidecarCore

/// Smoke test for `MicrophoneCaptureSource`. This can't be meaningfully
/// unit-tested without a real microphone and a granted Microphone TCC
/// permission — same gated situation as `SCStream` capture, per CLAUDE.md's
/// "TCC permissions gate CI" note (see `CaptureServiceTests.swift` for the
/// precedent). This test only verifies the class constructs and
/// starts/stops without crashing when a default audio device is present;
/// full functional/TCC-gated verification (does audio actually flow to the
/// sample handler) is deferred to Phase 13's local e2e process.
final class MicrophoneCaptureSourceTests: XCTestCase {

    func testInitStartStopDoNotCrashWhenDeviceAvailable() throws {
        guard let device = AVCaptureDevice.default(for: .audio) else {
            throw XCTSkip("No default audio input device on this machine (expected on a headless CI runner)")
        }

        let source = try MicrophoneCaptureSource(device: device) { _ in
            // Intentionally no-op: exercising sample delivery requires a
            // granted Microphone TCC permission, out of scope here.
        }

        source.start()
        source.stop()
    }
}
