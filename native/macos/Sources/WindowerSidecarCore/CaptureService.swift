import AVFoundation
import CoreGraphics
import CoreMedia
import CoreVideo
import Foundation
import ScreenCaptureKit

// Phase 4 — video capture. Wires `CaptureConfigService` (pure geometry/
// bitrate math) and `VideoAssetWriter` (AVAssetWriter plumbing) to a live
// `SCStream`, and exposes the three RPC entry points from
// contracts/sidecar-protocol.md: startCapture/stopCapture/cancelCapture.
//
// Everything here is macOS-specific by construction — it lives below the
// stdio line, so no protocol-shape decisions are made here beyond matching
// the params/result shapes already frozen in
// packages/core/src/protocol/methods.ts.

/// Same free-form stderr-only logging convention as
/// `EventTapCapture.swift`'s file-private `logStderr` (contracts/
/// sidecar-protocol.md §Transport: "stderr is free-form human-readable
/// logs only, never protocol data") — not shared across files because it's
/// a two-line function, not because the convention differs.
private func logStderr(_ message: String) {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
}

// MARK: - Wire shapes (mirror packages/core/src/protocol/methods.ts)

/// Decodable view of `CaptureTargetSchema`'s discriminated union. The
/// existing `CaptureTarget` enum in CaptureTarget.swift is Encodable-only
/// and shaped for `enumerateTargets`' *output* (it has no `region` case,
/// since regions are never enumerated). `startCapture` accepts a region as
/// *input*, so decoding needs this permissive flat struct instead.
public struct CaptureTargetInput: Codable, Equatable {
    public let kind: String
    /// Present for `display`/`window` targets.
    public let id: String?
    /// Present for `region` targets — the containing display's id.
    public let displayId: String?
    /// Present for `window`/`display`/`region`; pixels, global space.
    public let bounds: Rect?

    public init(kind: String, id: String? = nil, displayId: String? = nil, bounds: Rect? = nil) {
        self.kind = kind
        self.id = id
        self.displayId = displayId
        self.bounds = bounds
    }
}

/// Mirrors `VideoSettingsSchema`. `resolution` omitted means "native target
/// resolution" (data-model.md §VideoSettings).
public struct VideoSettingsInput: Codable, Equatable {
    public struct Resolution: Codable, Equatable {
        public let width: Double
        public let height: Double

        public init(width: Double, height: Double) {
            self.width = width
            self.height = height
        }
    }

    public let fps: Int
    public let codec: String
    public let container: String
    public let resolution: Resolution?
    public let quality: String
    public let showCursor: Bool

    public init(
        fps: Int, codec: String, container: String, resolution: Resolution?, quality: String,
        showCursor: Bool
    ) {
        self.fps = fps
        self.codec = codec
        self.container = container
        self.resolution = resolution
        self.quality = quality
        self.showCursor = showCursor
    }
}

public struct StartCaptureParams: Decodable {
    public let sessionId: String
    public let target: CaptureTargetInput
    public let video: VideoSettingsInput
    /// Mirrors `AudioSettings` (data-model.md). Optional despite the
    /// protocol's `startCapture` params schema requiring `audio` — decoded
    /// defensively (matching this codebase's existing defensiveness
    /// elsewhere, e.g. `decodeParams`'s empty-object fallback for absent
    /// params) so a well-formed request that omits it still decodes. A
    /// `nil` value is treated downstream as `AudioTrackPlan.none`
    /// (no audio tracks requested, video-only output).
    public let audio: AudioSettingsInput?
}

public struct StartCaptureResult: Codable, Equatable {
    public let started: Bool

    public init(started: Bool = true) {
        self.started = started
    }
}

public struct StopCaptureParams: Codable, Equatable {
    public let sessionId: String

    public init(sessionId: String) {
        self.sessionId = sessionId
    }
}

public struct StopCaptureResult: Codable, Equatable {
    public struct Resolution: Codable, Equatable {
        public let width: Int
        public let height: Int

        public init(width: Int, height: Int) {
            self.width = width
            self.height = height
        }
    }

    public let outputFilePath: String
    public let actualDurationMs: Double
    public let actualResolution: Resolution

    public init(outputFilePath: String, actualDurationMs: Double, actualResolution: Resolution) {
        self.outputFilePath = outputFilePath
        self.actualDurationMs = actualDurationMs
        self.actualResolution = actualResolution
    }
}

public struct CancelCaptureParams: Codable, Equatable {
    public let sessionId: String

    public init(sessionId: String) {
        self.sessionId = sessionId
    }
}

public struct CancelCaptureResult: Codable, Equatable {
    public let canceled: Bool

    public init(canceled: Bool = true) {
        self.canceled = canceled
    }
}

/// Mirrors `CaptureEndedNotificationParamsSchema`.
public struct CaptureEndedNotificationParams: Codable, Equatable {
    public let sessionId: String
    /// "target-closed" | "error"
    public let reason: String

    public init(sessionId: String, reason: String) {
        self.sessionId = sessionId
        self.reason = reason
    }
}

// MARK: - Stream plumbing

/// Receives `CMSampleBuffer`s from `SCStream` on a dedicated serial queue
/// and feeds them to the session's `VideoAssetWriter`.
///
/// SCStream does NOT retain its output/delegate objects — the owning
/// `CaptureSessionContext` holds the strong reference for the session's
/// lifetime. Letting this deallocate would silently stop frame delivery.
final class CaptureStreamOutput: NSObject, SCStreamOutput {
    private let writer: VideoAssetWriter
    /// Only ever touched from the session's serial sample-handler queue.
    private var didStartSession = false
    private let startedLock = NSLock()

    init(writer: VideoAssetWriter) {
        self.writer = writer
    }

    /// True once the first frame has arrived and the asset writer session
    /// has been started. `stopCapture` needs this to distinguish "recorded
    /// zero frames" (finishWriting would fail) from a normal finish.
    var hasStartedSession: Bool {
        startedLock.lock()
        defer { startedLock.unlock() }
        return didStartSession
    }

    func stream(
        _ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of type: SCStreamOutputType
    ) {
        guard type == .screen else { return }
        guard CMSampleBufferIsValid(sampleBuffer) else { return }
        // SCStream also delivers "idle"/"blank" status frames with no image
        // buffer when the screen content hasn't changed; appending those
        // would corrupt the timeline.
        guard CMSampleBufferGetImageBuffer(sampleBuffer) != nil else { return }
        guard isCompleteFrame(sampleBuffer) else { return }

        startedLock.lock()
        let needsStart = !didStartSession
        if needsStart { didStartSession = true }
        startedLock.unlock()

        if needsStart {
            writer.start(at: CMSampleBufferGetPresentationTimeStamp(sampleBuffer))
        }
        // A false return means the writer wasn't ready for more data —
        // dropping the frame under backpressure is correct for live
        // capture, not an error.
        _ = writer.append(sampleBuffer: sampleBuffer)
    }

    /// SCStream attaches an `SCStreamFrameInfo.status` to each buffer;
    /// only `.complete` frames carry new pixel content.
    private func isCompleteFrame(_ sampleBuffer: CMSampleBuffer) -> Bool {
        guard
            let attachments = CMSampleBufferGetSampleAttachmentsArray(
                sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
            let first = attachments.first,
            let rawStatus = first[.status] as? Int,
            let status = SCFrameStatus(rawValue: rawStatus)
        else {
            // No attachment metadata at all — treat as usable rather than
            // silently dropping every frame if Apple changes the shape.
            return true
        }
        return status == .complete
    }
}

/// Receives system-audio `CMSampleBuffer`s from `SCStream` (type `.audio`)
/// and routes them to the session's system-audio `AudioWriterInputHandle`.
/// Analogous to `CaptureStreamOutput` but for the audio output type — kept
/// as a separate `SCStreamOutput` conformer rather than teaching
/// `CaptureStreamOutput` to branch on `type` because the two feed different
/// writer inputs and have no shared state (video session-start bookkeeping
/// doesn't apply to audio).
///
/// For `AudioTrackPlan.bothMixed`, this output and `MicrophoneCaptureSource`'s
/// sample handler are both wired to append to the SAME handle (see
/// `startCapture`) — that is the whole "mix," see the doc comment on
/// `AudioTrackPlan.bothMixed` and on the `.bothMixed` branch below for why
/// this is an approximation, not real PCM-level mixing.
final class CaptureSystemAudioOutput: NSObject, SCStreamOutput {
    private let handle: AudioWriterInputHandle

    init(handle: AudioWriterInputHandle) {
        self.handle = handle
    }

    func stream(
        _ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of type: SCStreamOutputType
    ) {
        guard type == .audio else { return }
        guard CMSampleBufferIsValid(sampleBuffer) else { return }
        guard CMSampleBufferDataIsReady(sampleBuffer) else { return }
        _ = handle.append(sampleBuffer: sampleBuffer)
    }
}

/// Surfaces SCStream-initiated stops (target window closed, display
/// disconnected, stream error) so the sidecar can emit `captureEnded`
/// instead of leaving the daemon's session hung in `recording`.
final class CaptureStreamDelegate: NSObject, SCStreamDelegate {
    private let sessionId: String
    private weak var manager: CaptureSessionManager?

    init(sessionId: String, manager: CaptureSessionManager) {
        self.sessionId = sessionId
        self.manager = manager
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        manager?.handleStreamStoppedUnexpectedly(sessionId: sessionId, error: error)
    }
}

/// Everything the manager needs to keep alive for one in-flight capture.
/// A class (not a struct) so the delegate/output back-references stay
/// stable and the whole thing is cheap to hand around under a lock.
final class CaptureSessionContext {
    let sessionId: String
    let stream: SCStream
    let writer: VideoAssetWriter
    let output: CaptureStreamOutput
    let delegate: CaptureStreamDelegate
    let sampleQueue: DispatchQueue
    let outputURL: URL
    let resolvedWidth: Int
    let resolvedHeight: Int
    let startedAt: Date
    /// Strong reference for the session's lifetime — `SCStream` does not
    /// retain its stream outputs (same caveat as `CaptureStreamOutput`).
    /// `nil` when `AudioTrackPlan` didn't request system audio.
    let systemAudioOutput: CaptureSystemAudioOutput?
    /// Strong reference for the session's lifetime — per
    /// `MicrophoneCaptureSource`'s doc comment, letting it deallocate
    /// silently stops sample delivery. `nil` when `AudioTrackPlan` didn't
    /// request microphone audio.
    let microphoneSource: MicrophoneCaptureSource?
    /// Strong reference for the session's lifetime (Phase 10) — event-tap
    /// capture runs on its own dedicated thread/run loop for as long as this
    /// is retained; `nil` when tap creation failed entirely (non-fatal, see
    /// `startCapture`'s doc comment on this field).
    let eventTapSource: EventTapSource?
    /// Bug #6 wall-clock liveness watchdog (~CaptureSessionManager.
    /// startLivenessTimer doc comment) — a repeating `DispatchSourceTimer`
    /// that must be retained for the session's lifetime (a `DispatchSource`
    /// with no other strong reference is eligible for deallocation, which
    /// silently stops it firing, same caveat as every other per-session
    /// resource in this struct) and explicitly canceled on every teardown
    /// path (stop/cancel/unexpected-stop) so it doesn't keep firing — and
    /// keep the process alive — after the session ends.
    let livenessTimer: DispatchSourceTimer

    init(
        sessionId: String, stream: SCStream, writer: VideoAssetWriter,
        output: CaptureStreamOutput, delegate: CaptureStreamDelegate,
        sampleQueue: DispatchQueue, outputURL: URL, resolvedWidth: Int, resolvedHeight: Int,
        startedAt: Date, livenessTimer: DispatchSourceTimer,
        systemAudioOutput: CaptureSystemAudioOutput? = nil,
        microphoneSource: MicrophoneCaptureSource? = nil,
        eventTapSource: EventTapSource? = nil
    ) {
        self.sessionId = sessionId
        self.stream = stream
        self.writer = writer
        self.output = output
        self.delegate = delegate
        self.sampleQueue = sampleQueue
        self.outputURL = outputURL
        self.resolvedWidth = resolvedWidth
        self.resolvedHeight = resolvedHeight
        self.startedAt = startedAt
        self.livenessTimer = livenessTimer
        self.systemAudioOutput = systemAudioOutput
        self.microphoneSource = microphoneSource
        self.eventTapSource = eventTapSource
    }
}

// MARK: - Audio plan helpers

extension AudioTrackPlan {
    /// Whether this plan requires `SCStreamConfiguration.capturesAudio` and
    /// a second `.audio`-type `SCStreamOutput`.
    var requiresSystemAudio: Bool {
        switch self {
        case .systemOnly, .bothSeparate, .bothMixed:
            return true
        case .none, .microphoneOnly:
            return false
        }
    }

    /// `nil` when microphone audio isn't requested at all; `.some(deviceId)`
    /// (where `deviceId` may itself be `nil`, meaning "default device") when
    /// it is. Mirrors the `requested`/`deviceId` split
    /// `AudioCaptureConfigService.microphoneRequest` uses for the same
    /// "requested vs. not requested" ambiguity.
    var microphoneDeviceId: String?? {
        switch self {
        case .none, .systemOnly:
            return nil
        case .microphoneOnly(let deviceId), .bothSeparate(let deviceId), .bothMixed(let deviceId):
            return .some(deviceId)
        }
    }

    /// Whether system audio and microphone audio (when both requested)
    /// should share ONE `AVAssetWriterInput` (`bothMixed`) rather than two.
    var mixesSystemAndMicrophone: Bool {
        if case .bothMixed = self { return true }
        return false
    }
}

/// Pure, headlessly-testable gate for Phase 5's "graceful degradation"
/// requirement: mic requested + permission denied must fail the whole
/// `startCapture` call with `PERMISSION_DENIED` rather than silently
/// recording without audio. Extracted as a standalone pure function (rather
/// than inlined in `startCapture`) specifically so it can be unit tested
/// without a real `SCStream`/mic — see `CaptureServiceTests`'s "TCC-gated
/// boundary" precedent in its header doc comment.
enum AudioPermissionGate {
    static func shouldFailFast(microphoneRequested: Bool, microphoneStatus: PermissionStatus) -> Bool {
        microphoneRequested && microphoneStatus == .denied
    }
}

// MARK: - Session manager

/// Owns all in-flight capture sessions for this sidecar process, keyed by
/// `sessionId`. The dictionary is NSLock-protected because SCStream
/// delegate callbacks arrive on arbitrary background queues (one per
/// session) concurrently with the synchronous main-thread dispatch loop.
public final class CaptureSessionManager {
    public static let shared = CaptureSessionManager()

    private var sessions: [String: CaptureSessionContext] = [:]
    private let lock = NSLock()

    /// Set once at startup by main.swift to a thread-safe stdout line
    /// writer. Called from background stream-delegate queues, so the
    /// installed closure MUST be thread-safe.
    private var notificationHandler: ((String, JSONValue) -> Void)?
    private let notificationLock = NSLock()

    public init() {}

    public var onNotification: ((String, JSONValue) -> Void)? {
        get {
            notificationLock.lock()
            defer { notificationLock.unlock() }
            return notificationHandler
        }
        set {
            notificationLock.lock()
            notificationHandler = newValue
            notificationLock.unlock()
        }
    }

    // MARK: startCapture

    public func startCapture(params: StartCaptureParams) throws -> StartCaptureResult {
        let video = params.video
        let content = try fetchShareableContentMappingErrors()

        let filter: SCContentFilter
        let nativeWidth: Double
        let nativeHeight: Double
        var sourceRect: CGRect?

        switch params.target.kind {
        case "display":
            let display = try resolveDisplay(id: params.target.id, in: content)
            filter = SCContentFilter(display: display, excludingWindows: [])
            let bounds = displayPixelBounds(display)
            nativeWidth = bounds.width
            nativeHeight = bounds.height

        case "window":
            guard let id = params.target.id,
                let window = content.windows.first(where: { String($0.windowID) == id })
            else {
                throw SidecarRpcError.serverError(
                    "No window matching id \(params.target.id ?? "<nil>")", code: .targetNotFound)
            }
            // NOTE: deliberately NOT `SCContentFilter(desktopIndependentWindow:)`.
            // This is a headless stdio process with no NSApplication/run loop, so
            // it never establishes a WindowServer/CGS connection the way a normal
            // GUI app does — `desktopIndependentWindow` touches a CGS-session-
            // requiring API and aborts the whole process with
            // `Assertion failed: (did_initialize), function CGS_REQUIRE_INIT`
            // (bugs.spec.md #4). `SCContentFilter(display:including:)` is the
            // same initializer the "display"/"region" branches above already
            // use safely, so instead: resolve the display the window is on and
            // build a display-based filter restricted to just this window, then
            // crop to the window's bounds via sourceRect/destinationRect (same
            // pattern as the "region" branch below). Trade-off: unlike
            // desktopIndependentWindow, this won't keep capturing if the window
            // moves to another Space mid-recording — acceptable given the
            // crash; don't revert to desktopIndependentWindow without fixing the
            // underlying CGS-init problem first.
            let windowDisplay = try resolveWindowDisplay(window, in: content)
            filter = SCContentFilter(display: windowDisplay, including: [window])
            let scaleFactor = EnumerationService.backingScaleFactor(forPoint: window.frame.origin)
            nativeWidth = window.frame.width * scaleFactor
            nativeHeight = window.frame.height * scaleFactor
            let windowDisplayScaleFactor = EnumerationService.backingScaleFactor(
                forDisplayID: windowDisplay.displayID)
            let windowDisplayBounds = displayPixelBounds(windowDisplay)
            sourceRect = CaptureConfigService.regionSourceRect(
                regionPixelBounds: (
                    x: window.frame.origin.x * windowDisplayScaleFactor,
                    y: window.frame.origin.y * windowDisplayScaleFactor,
                    width: window.frame.width * windowDisplayScaleFactor,
                    height: window.frame.height * windowDisplayScaleFactor
                ),
                displayPixelBounds: (
                    x: windowDisplayBounds.x, y: windowDisplayBounds.y,
                    width: windowDisplayBounds.width, height: windowDisplayBounds.height
                ),
                scaleFactor: windowDisplayScaleFactor
            )

        case "region":
            // SCK has no arbitrary-rect capture target (research.md §2) —
            // a region is a full-display capture cropped via
            // sourceRect/destinationRect on the stream configuration.
            let display = try resolveDisplay(id: params.target.displayId, in: content)
            guard let regionBounds = params.target.bounds else {
                throw SidecarRpcError.invalidParams("region target requires bounds")
            }
            filter = SCContentFilter(display: display, excludingWindows: [])
            nativeWidth = regionBounds.width
            nativeHeight = regionBounds.height
            let displayBounds = displayPixelBounds(display)
            let scaleFactor = EnumerationService.backingScaleFactor(forDisplayID: display.displayID)
            sourceRect = CaptureConfigService.regionSourceRect(
                regionPixelBounds: (
                    x: regionBounds.x, y: regionBounds.y, width: regionBounds.width,
                    height: regionBounds.height
                ),
                displayPixelBounds: (
                    x: displayBounds.x, y: displayBounds.y, width: displayBounds.width,
                    height: displayBounds.height
                ),
                scaleFactor: scaleFactor
            )

        default:
            throw SidecarRpcError.serverError(
                "Unsupported capture target kind: \(params.target.kind)", code: .targetNotFound)
        }

        let resolved = CaptureConfigService.resolvedPixelDimensions(
            requestedWidth: video.resolution?.width,
            requestedHeight: video.resolution?.height,
            nativeWidth: nativeWidth,
            nativeHeight: nativeHeight
        )

        // Audio plan (Phase 5). Computed before any capture resource is
        // created so a denied-mic-permission fail-fast leaves no partial
        // session running. A nil/absent `audio` param decodes to "no tracks
        // requested" per `StartCaptureParams.audio`'s doc comment.
        let plan = AudioCaptureConfigService.trackPlan(
            for: params.audio ?? AudioSettingsInput(tracks: [], separateTracks: false))

        if let requestedMicDeviceId = plan.microphoneDeviceId {
            let micStatus = PermissionsService.microphoneStatus()
            if AudioPermissionGate.shouldFailFast(
                microphoneRequested: true, microphoneStatus: micStatus)
            {
                throw SidecarRpcError.serverError(
                    "Microphone permission not granted", code: .permissionDenied)
            }
            // Resolved early (before any writer/stream resource is created)
            // so a stale/removed `deviceId` also fails fast rather than
            // leaving a partial session running.
            guard AudioDeviceService.resolveDevice(deviceId: requestedMicDeviceId) != nil else {
                throw SidecarRpcError.serverError(
                    "No microphone device matching id \(requestedMicDeviceId ?? "<default>")",
                    code: .targetNotFound)
            }
        }

        let configuration = SCStreamConfiguration()
        // SCStreamConfiguration.width/height are the output frame buffer's
        // dimensions in **pixels** — deliberately the same numbers handed to
        // AVAssetWriter below, so the encoder's expected frame size and the
        // delivered buffer size can never disagree.
        configuration.width = resolved.width
        configuration.height = resolved.height
        configuration.minimumFrameInterval = CaptureConfigService.minimumFrameInterval(
            forFps: video.fps)
        configuration.showsCursor = video.showCursor
        configuration.pixelFormat = kCVPixelFormatType_32BGRA
        configuration.queueDepth = 5
        if let sourceRect = sourceRect {
            configuration.sourceRect = sourceRect
            configuration.destinationRect = CGRect(
                x: 0, y: 0, width: resolved.width, height: resolved.height)
        }
        // System audio (Phase 5): capturesAudio requires the macOS 13.0
        // platform floor set in Package.swift.
        configuration.capturesAudio = plan.requiresSystemAudio

        let bitrate = CaptureConfigService.bitrate(
            forQuality: video.quality, width: resolved.width, height: resolved.height)

        // Phase 6's daemon owns real output-path management (manifest and
        // timeline live next to the video file, per CLAUDE.md); the sidecar
        // just needs *a* writable, collision-free path.
        let outputURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("windower-\(params.sessionId).\(video.container)")
        try? FileManager.default.removeItem(at: outputURL)

        let writer: VideoAssetWriter
        do {
            writer = try VideoAssetWriter(
                outputURL: outputURL, width: resolved.width, height: resolved.height,
                codec: video.codec, container: video.container, bitrate: bitrate, fps: video.fps)
        } catch {
            throw SidecarRpcError.serverError(
                "Failed to prepare video writer: \(error)", code: .captureFailed)
        }

        // Audio writer inputs (Phase 5). Added to the SAME AVAssetWriter the
        // video input uses, so every track shares one session-start time
        // (`VideoAssetWriter.addAudioInput`'s timestamp-alignment
        // guarantee). `bothMixed` deliberately creates only ONE input and
        // routes both the system-audio SCStreamOutput and the
        // MicrophoneCaptureSource sample handler to it — an approximation
        // of real audio mixing (interleaving two independent sources into
        // one AAC track, not summing PCM levels), which is what "mixed into
        // the system-audio track" (phase-5-audio.md) is taken to mean here.
        // Real level-mixing (AVAudioEngine / manual PCM summing) is a
        // documented gap, not implemented in this phase.
        var systemAudioHandle: AudioWriterInputHandle?
        var microphoneAudioHandle: AudioWriterInputHandle?
        do {
            if plan.mixesSystemAndMicrophone {
                let sharedHandle = try writer.addAudioInput(
                    outputSettings: AudioCaptureConfigService.aacOutputSettings())
                systemAudioHandle = sharedHandle
                microphoneAudioHandle = sharedHandle
            } else {
                if plan.requiresSystemAudio {
                    systemAudioHandle = try writer.addAudioInput(
                        outputSettings: AudioCaptureConfigService.aacOutputSettings())
                }
                if plan.microphoneDeviceId != nil {
                    microphoneAudioHandle = try writer.addAudioInput(
                        outputSettings: AudioCaptureConfigService.aacOutputSettings())
                }
            }
        } catch {
            writer.cancel()
            throw SidecarRpcError.serverError(
                "Failed to prepare audio writer input: \(error)", code: .captureFailed)
        }

        let output = CaptureStreamOutput(writer: writer)
        let delegate = CaptureStreamDelegate(sessionId: params.sessionId, manager: self)
        let stream = SCStream(filter: filter, configuration: configuration, delegate: delegate)
        let sampleQueue = DispatchQueue(label: "windower.capture.\(params.sessionId)")

        do {
            try stream.addStreamOutput(
                output, type: .screen, sampleHandlerQueue: sampleQueue)
        } catch {
            writer.cancel()
            throw SidecarRpcError.serverError(
                "Failed to attach stream output: \(error)", code: .captureFailed)
        }

        var systemAudioOutput: CaptureSystemAudioOutput?
        if let systemAudioHandle = systemAudioHandle {
            let audioOutput = CaptureSystemAudioOutput(handle: systemAudioHandle)
            do {
                try stream.addStreamOutput(
                    audioOutput, type: .audio, sampleHandlerQueue: sampleQueue)
            } catch {
                writer.cancel()
                throw SidecarRpcError.serverError(
                    "Failed to attach audio stream output: \(error)", code: .captureFailed)
            }
            systemAudioOutput = audioOutput
        }

        // Microphone source (Phase 5). Device availability and permission
        // were already validated fail-fast above, before any resource here
        // was created — this just builds the `AVCaptureSession` wiring;
        // `.start()` happens after `stream.startCapture` succeeds, mirroring
        // the ordering below.
        var microphoneSource: MicrophoneCaptureSource?
        if let requestedMicDeviceId = plan.microphoneDeviceId, let micHandle = microphoneAudioHandle
        {
            guard let device = AudioDeviceService.resolveDevice(deviceId: requestedMicDeviceId)
            else {
                writer.cancel()
                throw SidecarRpcError.serverError(
                    "No microphone device matching id \(requestedMicDeviceId ?? "<default>")",
                    code: .targetNotFound)
            }
            do {
                microphoneSource = try MicrophoneCaptureSource(device: device) { sampleBuffer in
                    _ = micHandle.append(sampleBuffer: sampleBuffer)
                }
            } catch {
                writer.cancel()
                throw SidecarRpcError.serverError(
                    "Failed to set up microphone capture: \(error)", code: .captureFailed)
            }
        }

        if let error = awaitCompletion({ done in stream.startCapture(completionHandler: done) }) {
            writer.cancel()
            let nsError = error as NSError
            if nsError.domain == "com.apple.ScreenCaptureKit.SCStreamErrorDomain",
                nsError.code == -3801
            {
                throw SidecarRpcError.serverError(
                    "startCapture failed: Screen Recording permission not granted",
                    code: .permissionDenied)
            }
            throw SidecarRpcError.serverError(
                "startCapture failed: \(error)", code: .captureFailed)
        }

        microphoneSource?.start()

        let startedAt = Date()

        // Event-tap capture (Phase 10). Additive-only: a `CGEventTap`
        // creation failure (e.g. Accessibility not actually granted despite
        // the Phase 2/3 baseline check, or a transient failure) must never
        // fail `startCapture` — video capture is core, event capture is not.
        // `EventTapSource.start()` handles its own internal failures (mouse
        // vs. keyboard taps independently, see its doc comment) and never
        // throws.
        let eventTapSource = EventTapSource(
            sessionId: params.sessionId, startedAt: startedAt,
            emit: { [weak self] method, encoded in
                self?.onNotification?(method, encoded)
            })
        eventTapSource.start()

        // Bug #6 wall-clock liveness watchdog: a repeating timer, independent
        // of `VideoAssetWriter`'s PTS-gap "stall" detector, which can only
        // fire on a subsequent accepted frame and therefore structurally
        // cannot catch `SCStream` stopping delivery ENTIRELY (see
        // `VideoAssetWriter.checkLiveness(now:)`'s doc comment and
        // bugs.spec.md #6's "Reproduced — Phase 20" entry, which found
        // exactly that shape: zero drops/stalls reported for a session that
        // silently stopped recording after ~9s of a ~201s capture). Polls at
        // 1/3 of the liveness threshold so a real stall is caught within one
        // threshold window, not two-to-three.
        let livenessThresholdMs = VideoAssetWriter.livenessThresholdMs(forFps: video.fps)
        let livenessQueue = DispatchQueue(label: "windower.capture.liveness.\(params.sessionId)")
        let livenessTimer = DispatchSource.makeTimerSource(queue: livenessQueue)
        livenessTimer.schedule(
            deadline: .now() + .milliseconds(Int(livenessThresholdMs)),
            repeating: .milliseconds(max(1, Int(livenessThresholdMs / 3))))
        // Bug #6 follow-up (post-passthrough-fix session): the PTS-gap
        // "stall" detector (`VideoAssetWriter.stallEventCount`/
        // `maxStallGapMs`) previously only surfaced as a rolled-up count in
        // `diagnosticsSummary()` at `stopCapture` time — e.g. "37 PTS-gap
        // stall events" reported only after the whole session ended, with no
        // way to know WHEN during the session any individual stall happened.
        // That made it impossible to correlate a stall against what the
        // operator loop was doing at that moment (a `captureFrame`/
        // `enumerateTargets` RPC, a `performInput` burst, plain UI-driven
        // encoder load, ...) without re-running the whole investigation with
        // custom instrumentation each time. Piggybacking on this same poll
        // timer (already running at 1/3 of the liveness threshold, so a new
        // stall is surfaced within a few hundred ms of when it actually
        // happened, not just at session end) closes that gap for the next
        // real repro: every new stall since the last tick now gets its own
        // real-time `warn` `log` notification with a timestamp a caller can
        // line up against `.events.json`/the operator's own step log.
        var lastLoggedStallEventCount = 0
        livenessTimer.setEventHandler { [weak self] in
            guard let self else { return }
            let stallEventCount = writer.stallEventCount
            if stallEventCount > lastLoggedStallEventCount {
                let newStalls = stallEventCount - lastLoggedStallEventCount
                lastLoggedStallEventCount = stallEventCount
                self.emitLog(
                    sessionId: params.sessionId, level: "warn",
                    message:
                        "capture PTS-gap stall detected for session \(params.sessionId): \(newStalls) new stall event(s) (cumulative \(stallEventCount), longest gap so far \(Int(writer.maxStallGapMs.rounded()))ms) — frame delivery resumed after exceeding the stall threshold"
                )
            }
            guard writer.checkLiveness() else { return }
            // `checkLiveness` only returns `true` on the transition into a
            // stalled state, so this fires once per session, not on every
            // tick after the first failure.
            self.emitLog(
                sessionId: params.sessionId, level: "error",
                message:
                    "capture liveness check failed for session \(params.sessionId): no frame appended for over \(Int(livenessThresholdMs))ms — capture may have silently stopped delivering frames"
            )
        }
        livenessTimer.resume()

        let context = CaptureSessionContext(
            sessionId: params.sessionId, stream: stream, writer: writer, output: output,
            delegate: delegate, sampleQueue: sampleQueue, outputURL: outputURL,
            resolvedWidth: resolved.width, resolvedHeight: resolved.height, startedAt: startedAt,
            livenessTimer: livenessTimer,
            systemAudioOutput: systemAudioOutput, microphoneSource: microphoneSource,
            eventTapSource: eventTapSource)

        lock.lock()
        sessions[params.sessionId] = context
        lock.unlock()

        return StartCaptureResult(started: true)
    }

    // MARK: stopCapture

    public func stopCapture(params: StopCaptureParams) throws -> StopCaptureResult {
        guard let context = removeSession(params.sessionId) else {
            throw SidecarRpcError.serverError(
                "Unknown sessionId: \(params.sessionId)", code: .sessionNotFound)
        }

        // Stop mic hardware capture alongside the SCStream so it doesn't
        // keep running (and consuming the TCC-granted mic) after the
        // session ends.
        context.microphoneSource?.stop()
        context.eventTapSource?.stop()
        context.livenessTimer.cancel()

        // Best-effort: even if the stream errors on stop, the frames already
        // handed to the writer are still worth finalizing.
        _ = awaitCompletion { done in context.stream.stopCapture(completionHandler: done) }

        // Wall-clock elapsed time. Kept as a diagnostic/fallback value only —
        // see bug #5: this overstates the real video length whenever frames
        // are dropped/delayed during capture (e.g. an occluded/backgrounded
        // window not delivering frames), since it has nothing to do with the
        // actual encoded content. Never report this directly as
        // `actualDurationMs` when the real asset duration is available.
        let wallClockDurationMs = Date().timeIntervalSince(context.startedAt) * 1000

        guard context.output.hasStartedSession else {
            // AVAssetWriter was never started (no frames ever arrived), so
            // finishWriting would fail and leave a zero-byte file behind.
            context.writer.cancel()
            throw SidecarRpcError.serverError(
                "Capture produced no frames for session \(params.sessionId)", code: .captureFailed)
        }

        // MUST be awaited — reading the file before finishWriting completes
        // yields a corrupt/truncated video (phase-4 exit criteria).
        var finishError: Error?
        var realDurationMs: Double?
        let semaphore = DispatchSemaphore(value: 0)
        context.writer.finish { result in
            switch result {
            case .success(let duration):
                realDurationMs = duration
            case .failure(let error):
                finishError = error
            }
            semaphore.signal()
        }
        semaphore.wait()

        if let finishError = finishError {
            throw SidecarRpcError.serverError(
                "Failed to finalize recording: \(finishError)", code: .captureFailed)
        }

        // Prefer the real, asset-derived duration (bug #5); fall back to
        // wall-clock only if the finished file's duration couldn't be read
        // (best-effort accuracy improvement, not a hard requirement).
        let durationMs = realDurationMs ?? wallClockDurationMs

        // Bug #6 diagnostics: surface any writer-side backpressure drops or
        // PTS gaps ("stalls") now that the session is finalized — see
        // `VideoAssetWriter.diagnosticsSummary()`. Diagnostic-only: does not
        // change `StopCaptureResult`/the manifest, just makes the drops
        // observable via the existing `log` notification + stderr, so this
        // is visible to the daemon/MCP caller (if listening) and to anyone
        // reading the sidecar's own stderr even without one.
        if let summary = context.writer.diagnosticsSummary() {
            emitLog(
                sessionId: params.sessionId, level: "warn",
                message: "capture diagnostics for session \(params.sessionId): \(summary)")
        }

        return StopCaptureResult(
            outputFilePath: context.outputURL.path,
            actualDurationMs: durationMs,
            actualResolution: StopCaptureResult.Resolution(
                width: context.resolvedWidth, height: context.resolvedHeight)
        )
    }

    // MARK: cancelCapture

    public func cancelCapture(params: CancelCaptureParams) throws -> CancelCaptureResult {
        guard let context = removeSession(params.sessionId) else {
            throw SidecarRpcError.serverError(
                "Unknown sessionId: \(params.sessionId)", code: .sessionNotFound)
        }
        context.microphoneSource?.stop()
        context.eventTapSource?.stop()
        context.livenessTimer.cancel()
        // Errors ignored deliberately — we're discarding the output anyway.
        _ = awaitCompletion { done in context.stream.stopCapture(completionHandler: done) }
        context.writer.cancel()
        return CancelCaptureResult(canceled: true)
    }

    // MARK: Stream-initiated stop

    /// Called from `SCStreamDelegate.stream(_:didStopWithError:)` on a
    /// background queue. Discards the in-flight session and notifies the
    /// daemon so it can mark the session `failed` rather than hanging in
    /// `recording`.
    func handleStreamStoppedUnexpectedly(sessionId: String, error: Error) {
        guard let context = removeSession(sessionId) else { return }
        context.microphoneSource?.stop()
        context.eventTapSource?.stop()
        context.livenessTimer.cancel()
        context.writer.cancel()
        emitCaptureEnded(sessionId: sessionId, reason: captureEndedReason(for: error))
    }

    /// ScreenCaptureKit reports a closed target window and a generic stream
    /// failure through the same `didStopWithError` path, and the error codes
    /// it uses are not documented as distinguishing the two. Rather than
    /// guess wrong, everything defaults to `"error"` — the daemon's
    /// behaviour (transition to `failed`) is identical for both reasons per
    /// contracts/sidecar-protocol.md.
    private func captureEndedReason(for error: Error) -> String {
        _ = error
        return "error"
    }

    private func emitCaptureEnded(sessionId: String, reason: String) {
        guard let handler = onNotification else { return }
        let params = CaptureEndedNotificationParams(sessionId: sessionId, reason: reason)
        guard let encoded = try? JSONCodec.encode(params) else { return }
        handler("captureEnded", encoded)
    }

    /// Bug #6: emits a `log` notification (existing mechanism, same shape
    /// `EventTapCapture.swift` already uses for e.g. keyboard-capture-
    /// unavailable warnings — no wire-schema change) AND writes to stderr
    /// directly, so the diagnostics are visible even without a daemon
    /// currently listening for notifications on this session.
    private func emitLog(sessionId: String, level: String, message: String) {
        logStderr("windower-sidecar-macos: \(message)")
        guard let handler = onNotification else { return }
        let params = LogNotificationParams(sessionId: sessionId, level: level, message: message)
        guard let encoded = try? JSONCodec.encode(params) else { return }
        handler("log", encoded)
    }

    // MARK: Helpers

    /// Test/introspection hook — number of sessions currently in flight.
    public var activeSessionCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return sessions.count
    }

    private func removeSession(_ sessionId: String) -> CaptureSessionContext? {
        lock.lock()
        defer { lock.unlock() }
        return sessions.removeValue(forKey: sessionId)
    }

    private func resolveDisplay(id: String?, in content: SCShareableContent) throws -> SCDisplay {
        guard let id = id,
            let display = content.displays.first(where: { String($0.displayID) == id })
        else {
            throw SidecarRpcError.serverError(
                "No display matching id \(id ?? "<nil>")", code: .targetNotFound)
        }
        return display
    }

    /// Resolves which `SCDisplay` a window is on, for the "window" branch of
    /// `startCapture` (see the crash-avoidance comment there). Matches by
    /// point-containment of the window's origin first (the same approach
    /// `EnumerationService.backingScaleFactor(forPoint:)`/`mapWindow` already
    /// use for the points→pixels scale-factor lookup), falls back to frame
    /// intersection for a window straddling two displays, then falls back to
    /// the first enumerated display (roughly "primary") rather than crashing
    /// — a window on a since-disconnected display is an edge case, not a
    /// reason to abort the process.
    private func resolveWindowDisplay(_ window: SCWindow, in content: SCShareableContent) throws
        -> SCDisplay
    {
        if let exact = content.displays.first(where: { $0.frame.contains(window.frame.origin) }) {
            return exact
        }
        if let overlapping = content.displays.first(where: { $0.frame.intersects(window.frame) })
        {
            return overlapping
        }
        if let primary = content.displays.first {
            return primary
        }
        throw SidecarRpcError.serverError(
            "No display found for window \(window.windowID)", code: .targetNotFound)
    }

    /// Same pixel conversion `EnumerationService.mapDisplay` performs — an
    /// `SCDisplay.frame` is in points, everything above the sidecar boundary
    /// is pixels (CLAUDE.md §units, research.md §3).
    private func displayPixelBounds(_ display: SCDisplay) -> Rect {
        let scaleFactor = EnumerationService.backingScaleFactor(forDisplayID: display.displayID)
        return Rect(
            x: display.frame.origin.x * scaleFactor,
            y: display.frame.origin.y * scaleFactor,
            width: display.frame.width * scaleFactor,
            height: display.frame.height * scaleFactor
        )
    }

    private func fetchShareableContentMappingErrors() throws -> SCShareableContent {
        do {
            return try EnumerationService.fetchShareableContent()
        } catch {
            let nsError = error as NSError
            if nsError.domain == "com.apple.ScreenCaptureKit.SCStreamErrorDomain",
                nsError.code == -3801
            {
                throw SidecarRpcError.serverError(
                    "startCapture failed: Screen Recording permission not granted",
                    code: .permissionDenied)
            }
            throw SidecarRpcError.serverError(
                "Failed to enumerate shareable content: \(error)", code: .captureFailed)
        }
    }

    /// Bridges SCStream's async completion-handler API into the sidecar's
    /// synchronous per-line dispatch loop — the same blocking convention
    /// `EnumerationService.fetchShareableContent()` established.
    private func awaitCompletion(_ body: (@escaping (Error?) -> Void) -> Void) -> Error? {
        var captured: Error?
        let semaphore = DispatchSemaphore(value: 0)
        body { error in
            captured = error
            semaphore.signal()
        }
        semaphore.wait()
        return captured
    }
}
