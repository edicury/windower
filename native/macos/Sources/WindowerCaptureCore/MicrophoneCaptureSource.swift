import AVFoundation
import CoreMedia
import Foundation
import WindowerSidecarShared

/// Errors surfaced while setting up `MicrophoneCaptureSource`. Kept distinct
/// from `SidecarRpcError`/`SidecarErrorCode` deliberately — same rationale as
/// `VideoAssetWriterError`: this is pure AVFoundation plumbing, the caller
/// wiring this into a capture session is responsible for translating a
/// thrown error here into a JSON-RPC error.
public enum MicrophoneCaptureSourceError: Error {
    case deviceUnavailable
    case sessionConfigurationFailed(String)
}

/// Captures microphone audio via `AVCaptureSession` and hands each
/// `CMSampleBuffer` to a caller-supplied closure. Mirrors the
/// `CaptureStreamOutput`/`CaptureStreamDelegate` pattern in
/// `CaptureService.swift` (buffers -> closure/writer) but for
/// `AVCaptureAudioDataOutputSampleBufferDelegate` instead of `SCStreamOutput`
/// — Phase 5's microphone track, kept independent of ScreenCaptureKit so it
/// can be built/wired in isolation.
///
/// `AVCaptureSession` does not retain its output's delegate — same caveat as
/// `SCStream` in `CaptureStreamOutput`'s doc comment — so the owner of a
/// `MicrophoneCaptureSource` instance must hold a strong reference for the
/// capture's lifetime, or sample delivery silently stops.
public final class MicrophoneCaptureSource: NSObject, AVCaptureAudioDataOutputSampleBufferDelegate {
    private let session: AVCaptureSession
    private let sampleHandler: (CMSampleBuffer) -> Void
    /// Dedicated serial queue for audio sample delivery, matching the
    /// dedicated-serial-queue-per-source pattern used for the video sample
    /// handler queue in `CaptureService.swift`.
    private let sampleQueue = DispatchQueue(label: "com.windower.sidecar.microphone-capture")

    /// Builds (but does not start) an `AVCaptureSession` wired from `device`
    /// to `sampleHandler`. Throws if the device input or audio data output
    /// can't be added to the session — e.g. an unavailable/disconnected
    /// device, or a session already misconfigured.
    public init(device: AVCaptureDevice, sampleHandler: @escaping (CMSampleBuffer) -> Void) throws {
        self.sampleHandler = sampleHandler
        session = AVCaptureSession()

        let input: AVCaptureDeviceInput
        do {
            input = try AVCaptureDeviceInput(device: device)
        } catch {
            throw MicrophoneCaptureSourceError.deviceUnavailable
        }

        super.init()

        session.beginConfiguration()
        guard session.canAddInput(input) else {
            session.commitConfiguration()
            throw MicrophoneCaptureSourceError.sessionConfigurationFailed(
                "AVCaptureSession cannot add input for device \(device.uniqueID)")
        }
        session.addInput(input)

        let output = AVCaptureAudioDataOutput()
        output.setSampleBufferDelegate(self, queue: sampleQueue)
        guard session.canAddOutput(output) else {
            session.commitConfiguration()
            throw MicrophoneCaptureSourceError.sessionConfigurationFailed(
                "AVCaptureSession cannot add AVCaptureAudioDataOutput")
        }
        session.addOutput(output)
        session.commitConfiguration()
    }

    /// Starts hardware audio capture. Real I/O — per CLAUDE.md's "TCC
    /// permissions gate CI" note, this requires a granted microphone
    /// permission and cannot be meaningfully exercised in CI.
    public func start() {
        session.startRunning()
    }

    /// Stops hardware audio capture.
    public func stop() {
        session.stopRunning()
    }

    public func captureOutput(
        _ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection
    ) {
        // Defensive validation mirroring `CaptureStreamOutput.stream(...)`:
        // don't hand invalid/non-audio buffers to the caller.
        guard CMSampleBufferIsValid(sampleBuffer) else { return }
        guard CMSampleBufferDataIsReady(sampleBuffer) else { return }
        guard let formatDescription = CMSampleBufferGetFormatDescription(sampleBuffer) else { return }
        guard CMFormatDescriptionGetMediaType(formatDescription) == kCMMediaType_Audio else { return }

        sampleHandler(sampleBuffer)
    }
}
