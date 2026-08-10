import CoreGraphics
import CoreImage
import CoreVideo
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers
import WindowerSidecarShared

// Phase 19 — Operator: one-shot frame grab (`captureFrame`).
//
// A single `SCScreenshotManager` capture of a `CaptureTarget`, encoded to
// PNG/JPEG and returned base64 so it can ride the JSON-RPC line back to the
// daemon without a temp file. Deliberately separate from
// `CaptureSessionManager`: this shares no state with an active recording and
// must work with no session at all (the operator observes before it records).

// MARK: - Wire shapes

public struct CaptureFrameParams: Decodable {
    public let target: CaptureTargetInput
    /// `"png"` or `"jpeg"`. Absent defaults to png (lossless, no `quality`
    /// interaction) — the contract types it as required, this is decoded
    /// defensively the same way `StartCaptureParams.audio` is.
    public let format: String?
    /// Longest-edge-independent cap on output **width**, pixels. Height
    /// follows from the source aspect ratio. Never upscales.
    public let maxWidth: Double?
    /// 0...1, jpeg only; ignored for png.
    public let quality: Double?
    /// Phase 21 — opt out of frame sharing
    /// (contracts/sidecar-protocol.md §"Frame sharing"). Absent/`false`
    /// permits serving the most recent frame of a live stream that already
    /// covers this target; `true` forces a real `SCScreenshotManager` capture
    /// regardless. Callers should leave it unset — every frame served from a
    /// live stream is one fewer `SCShareableContent` round-trip, which is the
    /// whole point (bugs.spec.md #6).
    public let fresh: Bool?
}

public struct CaptureFrameResult: Encodable, Equatable {
    public let imageBase64: String
    /// Pixels — same unit as every other dimension in the protocol.
    public let width: Int
    public let height: Int
    /// Pixels-per-point of the returned image. Equal to the target display's
    /// backing scale factor when no `maxWidth` downscale was applied, and
    /// proportionally lower when it was — so a caller can always convert a
    /// coordinate found in the image back to protocol pixels by
    /// `imageCoord * (targetScale / scale)`, or more simply work in image
    /// space and scale by `nativeWidth / width`.
    public let scale: Double

    public init(imageBase64: String, width: Int, height: Int, scale: Double) {
        self.imageBase64 = imageBase64
        self.width = width
        self.height = height
        self.scale = scale
    }
}

// MARK: - Service

public enum FrameCaptureService {
    /// Pure downscale math: preserve aspect ratio, never upscale, never
    /// return a zero dimension.
    public static func scaledDimensions(
        nativeWidth: Double, nativeHeight: Double, maxWidth: Double?
    ) -> (width: Int, height: Int) {
        let width = max(1.0, nativeWidth.rounded())
        let height = max(1.0, nativeHeight.rounded())
        guard let maxWidth = maxWidth, maxWidth > 0, maxWidth < width else {
            return (Int(width), Int(height))
        }
        let ratio = maxWidth / width
        return (Int(max(1, maxWidth.rounded())), Int(max(1, (height * ratio).rounded())))
    }

    /// jpeg `quality` clamped into ImageIO's 0...1 range; absent defaults to
    /// 0.8 (visually clean UI screenshots at roughly a third of a png's
    /// bytes, which matters when the payload rides a JSON-RPC line into an
    /// LLM context window).
    public static func normalizedQuality(_ quality: Double?) -> Double {
        guard let quality = quality else { return 0.8 }
        return min(1.0, max(0.0, quality))
    }

    public static func isJPEG(format: String?) -> Bool {
        (format ?? "png").lowercased() == "jpeg" || (format ?? "").lowercased() == "jpg"
    }

    /// Phase 21 frame sharing — is the frame a live stream is already
    /// producing a valid answer for this `captureFrame` request?
    ///
    /// Deliberately an exact-target match, not a geometric containment test.
    /// Serving a crop of a stream frame would mean re-deriving that crop from
    /// the stream's own scaled output (`SCStreamConfiguration.width`/`height`
    /// + `sourceRect`), and a subtly wrong crop hands the operator an image
    /// whose coordinates no longer map back to protocol pixels — i.e. a wrong
    /// click. A miss costs one `SCScreenshotManager` round-trip; a wrong hit
    /// costs correctness, so this errs hard toward missing.
    ///
    /// A `nil` display id on the request means "the main display" and cannot
    /// be compared against a stream's explicit id without resolving content,
    /// which is the round-trip this whole path exists to avoid — so it misses.
    public static func streamCoversRequestedTarget(
        streamTarget: CaptureTargetInput, requestedTarget: CaptureTargetInput
    ) -> Bool {
        guard streamTarget.kind == requestedTarget.kind else { return false }
        switch requestedTarget.kind {
        case "display", "window":
            guard let requestedId = requestedTarget.id, let streamId = streamTarget.id else {
                return false
            }
            return requestedId == streamId
        default:
            // "region" (and anything unknown) never shares: a region frame is
            // by definition a crop, which is exactly what this function
            // refuses to re-derive.
            return false
        }
    }

    public static func captureFrame(params: CaptureFrameParams) throws -> CaptureFrameResult {
        guard PermissionsService.screenRecordingStatus() == .granted else {
            throw SidecarRpcError.serverError(
                "captureFrame requires the Screen Recording permission", code: .permissionDenied)
        }

        // Frame sharing (contracts/sidecar-protocol.md §"Frame sharing"): when
        // a live stream already covers this target and the caller didn't ask
        // for a guaranteed-at-this-instant frame, serve the stream's most
        // recent buffer. This is the single biggest reduction in
        // ScreenCaptureKit call frequency in the recording-active case — the
        // operator calls `captureFrame` every step, and every avoided call is
        // one fewer `SCShareableContent` + `SCScreenshotManager` round-trip
        // into `replayd` (bugs.spec.md #6). Note it runs BEFORE the macOS 14
        // check below: sharing needs no `SCScreenshotManager`, so a 13.x host
        // with a live recording can serve frames it could not otherwise
        // capture at all.
        if params.fresh != true,
            let shared = CaptureSessionManager.shared.sharedFrame(for: params.target),
            let result = try? renderSharedFrame(shared, params: params)
        {
            return result
        }

        guard #available(macOS 14.0, *) else {
            // SCScreenshotManager is macOS 14+. The package's deployment
            // target is 13.0 (bumped for audio capture in Phase 5), so a
            // 13.x host reaches here — report it as the capability gap it
            // is rather than crashing, the same way any other unadvertised
            // capability is reported.
            throw SidecarRpcError.unsupportedCapability(
                "captureFrame requires macOS 14 or newer (SCScreenshotManager)")
        }

        let content = try fetchShareableContent()
        let plan = try resolvePlan(
            target: params.target, maxWidth: params.maxWidth, content: content)

        let config = SCStreamConfiguration()
        config.width = plan.outputWidth
        config.height = plan.outputHeight
        if let sourceRect = plan.sourceRect {
            config.sourceRect = sourceRect
        }
        config.scalesToFit = true
        // A one-shot observation frame should show the UI, not a pointer
        // artifact that moves between otherwise-identical frames.
        config.showsCursor = false

        let image = try captureImage(filter: plan.filter, configuration: config)
        let data = try encode(
            image: image, jpeg: isJPEG(format: params.format), quality: params.quality)

        return CaptureFrameResult(
            imageBase64: data.base64EncodedString(),
            width: image.width,
            height: image.height,
            scale: plan.pointsWidth > 0 ? Double(image.width) / plan.pointsWidth : plan.scaleFactor
        )
    }

    // MARK: - Frame sharing (phase 21)

    /// Renders a frame parked by a live stream through the *same* downscale +
    /// PNG/JPEG pipeline the real-capture path uses, so a shared frame and a
    /// captured one are indistinguishable on the wire apart from staleness
    /// (bounded by the stream's frame interval — see the protocol note).
    ///
    /// Throws rather than returning `nil` on any conversion problem; the call
    /// site treats a throw as a cache miss and falls back to a real capture,
    /// so a bad shared frame degrades into the old behavior instead of into an
    /// error the caller sees.
    static func renderSharedFrame(_ shared: SharedFrame, params: CaptureFrameParams) throws
        -> CaptureFrameResult
    {
        let image = try cgImage(from: shared.pixelBuffer)
        let dims = scaledDimensions(
            nativeWidth: Double(image.width), nativeHeight: Double(image.height),
            maxWidth: params.maxWidth)
        let rendered =
            (dims.width == image.width && dims.height == image.height)
            ? image : try downscale(image, toWidth: dims.width, height: dims.height)
        let data = try encode(
            image: rendered, jpeg: isJPEG(format: params.format), quality: params.quality)
        return CaptureFrameResult(
            imageBase64: data.base64EncodedString(),
            width: rendered.width,
            height: rendered.height,
            // Same definition as the real-capture path: output pixels per
            // source point. `sourcePointsWidth` is the stream's own record of
            // what it is capturing, so the two paths agree.
            scale: shared.sourcePointsWidth > 0
                ? Double(rendered.width) / shared.sourcePointsWidth : 1.0
        )
    }

    /// One shared `CIContext`: constructing one per call allocates a fresh
    /// render pipeline (and, on a GPU-backed context, a Metal command queue)
    /// every operator step for no reason.
    private static let sharedFrameCIContext = CIContext(options: nil)

    static func cgImage(from pixelBuffer: CVPixelBuffer) throws -> CGImage {
        let width = CVPixelBufferGetWidth(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)
        guard width > 0, height > 0 else {
            throw SidecarRpcError.serverError(
                "Shared frame has zero dimensions", code: .captureFailed)
        }
        let ciImage = CIImage(cvPixelBuffer: pixelBuffer)
        guard
            let image = sharedFrameCIContext.createCGImage(
                ciImage, from: CGRect(x: 0, y: 0, width: width, height: height))
        else {
            throw SidecarRpcError.serverError(
                "Failed to convert shared frame to CGImage", code: .captureFailed)
        }
        return image
    }

    static func downscale(_ image: CGImage, toWidth width: Int, height: Int) throws -> CGImage {
        guard
            let context = CGContext(
                data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                space: image.colorSpace ?? CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue
                    | CGBitmapInfo.byteOrder32Little.rawValue)
        else {
            throw SidecarRpcError.serverError(
                "Failed to create downscale context", code: .internalError)
        }
        context.interpolationQuality = .high
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        guard let scaled = context.makeImage() else {
            throw SidecarRpcError.serverError("Failed to downscale shared frame", code: .internalError)
        }
        return scaled
    }

    // MARK: - Target resolution

    private struct CapturePlan {
        let filter: SCContentFilter
        /// Points, relative to the containing display's own top-left origin.
        /// `nil` means "the whole filter's content".
        let sourceRect: CGRect?
        let outputWidth: Int
        let outputHeight: Int
        /// Width of the captured source in points — used to report `scale`.
        let pointsWidth: Double
        let scaleFactor: Double
    }

    private static func resolvePlan(
        target: CaptureTargetInput, maxWidth: Double?, content: SCShareableContent
    ) throws -> CapturePlan {
        switch target.kind {
        case "display":
            let display = try resolveDisplay(id: target.id, in: content)
            let scale = EnumerationService.backingScaleFactor(forDisplayID: display.displayID)
            let pointsWidth = Double(display.width)
            let pointsHeight = Double(display.height)
            let dims = scaledDimensions(
                nativeWidth: pointsWidth * scale, nativeHeight: pointsHeight * scale,
                maxWidth: maxWidth)
            return CapturePlan(
                filter: SCContentFilter(display: display, excludingWindows: []),
                sourceRect: nil, outputWidth: dims.width, outputHeight: dims.height,
                pointsWidth: pointsWidth, scaleFactor: scale)

        case "window":
            guard let id = target.id,
                let window = content.windows.first(where: { String($0.windowID) == id })
            else {
                throw SidecarRpcError.serverError(
                    "No window matching id \(target.id ?? "<nil>")", code: .targetNotFound)
            }
            // Same reasoning as CaptureSessionManager.startCapture: this is a
            // headless process with no CGS connection, so
            // `SCContentFilter(desktopIndependentWindow:)` aborts the
            // process (bugs.spec.md #4). Use a display-scoped filter
            // including just this window, cropped via sourceRect.
            let display = try resolveWindowDisplay(window, in: content)
            let scale = EnumerationService.backingScaleFactor(forDisplayID: display.displayID)
            let displayOrigin = CGDisplayBounds(display.displayID).origin
            let frame = window.frame
            let sourceRect = CGRect(
                x: frame.origin.x - displayOrigin.x, y: frame.origin.y - displayOrigin.y,
                width: frame.width, height: frame.height)
            let dims = scaledDimensions(
                nativeWidth: frame.width * scale, nativeHeight: frame.height * scale,
                maxWidth: maxWidth)
            return CapturePlan(
                filter: SCContentFilter(display: display, including: [window]),
                sourceRect: sourceRect, outputWidth: dims.width, outputHeight: dims.height,
                pointsWidth: Double(frame.width), scaleFactor: scale)

        case "region":
            guard let bounds = target.bounds else {
                throw SidecarRpcError.invalidParams("region target requires `bounds`")
            }
            let display = try resolveDisplay(id: target.displayId, in: content)
            let scale = EnumerationService.backingScaleFactor(forDisplayID: display.displayID)
            let displayBounds = CGDisplayBounds(display.displayID)
            let sourceRect = CaptureConfigService.regionSourceRect(
                regionPixelBounds: (
                    x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height
                ),
                displayPixelBounds: (
                    x: displayBounds.origin.x * scale, y: displayBounds.origin.y * scale,
                    width: displayBounds.width * scale, height: displayBounds.height * scale
                ),
                scaleFactor: scale)
            let dims = scaledDimensions(
                nativeWidth: bounds.width, nativeHeight: bounds.height, maxWidth: maxWidth)
            return CapturePlan(
                filter: SCContentFilter(display: display, excludingWindows: []),
                sourceRect: sourceRect, outputWidth: dims.width, outputHeight: dims.height,
                pointsWidth: bounds.width / (scale == 0 ? 1 : scale), scaleFactor: scale)

        default:
            throw SidecarRpcError.invalidParams("Unknown capture target kind '\(target.kind)'")
        }
    }

    private static func resolveDisplay(id: String?, in content: SCShareableContent) throws
        -> SCDisplay
    {
        if let id = id, let display = content.displays.first(where: { String($0.displayID) == id }) {
            return display
        }
        if id == nil, let main = content.displays.first(where: { $0.displayID == CGMainDisplayID() })
        {
            return main
        }
        throw SidecarRpcError.serverError(
            "No display matching id \(id ?? "<nil>")", code: .targetNotFound)
    }

    private static func resolveWindowDisplay(_ window: SCWindow, in content: SCShareableContent)
        throws -> SCDisplay
    {
        let origin = window.frame.origin
        for display in content.displays
        where CGDisplayBounds(display.displayID).contains(origin) {
            return display
        }
        if let main = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) {
            return main
        }
        throw SidecarRpcError.serverError(
            "No display contains window \(window.windowID)", code: .targetNotFound)
    }

    // MARK: - ScreenCaptureKit / ImageIO plumbing

    private static func fetchShareableContent() throws -> SCShareableContent {
        do {
            return try EnumerationService.fetchShareableContent()
        } catch {
            if case .timedOut(let afterMs)? = error as? EnumerationError {
                // bugs.spec.md #6: see `EnumerationError.timedOut` — same
                // reasoning as `enumerateTargets`' handling of this case in
                // main.swift, applied here since `captureFrame` also routes
                // through `fetchShareableContent` for target resolution and
                // is invoked repeatedly by the operator loop during a live
                // capture.
                throw SidecarRpcError.serverError(
                    "captureFrame failed: SCShareableContent did not respond within \(Int(afterMs))ms",
                    code: .captureFailed)
            }
            let nsError = error as NSError
            if nsError.domain == "com.apple.ScreenCaptureKit.SCStreamErrorDomain"
                && nsError.code == -3801
            {
                throw SidecarRpcError.serverError(
                    "captureFrame failed: Screen Recording permission not granted",
                    code: .permissionDenied)
            }
            throw SidecarRpcError.serverError(
                "captureFrame failed to enumerate content: \(error)", code: .internalError)
        }
    }

    /// Bound for `captureImage`'s blocking wait on `SCScreenshotManager` —
    /// see the timeout handling below and `EnumerationError.timedOut`'s doc
    /// on `fetchShareableContent` for the identical reasoning: this is one
    /// of the few blocking-bridge call sites invoked repeatedly (once per
    /// operator observe→decide→act step) while an `SCStream` recording may
    /// be simultaneously live on the same process, over the sidecar's ONE
    /// single-threaded stdio RPC loop. bugs.spec.md #6's most concrete
    /// reproduction to date showed the operate loop go completely silent —
    /// no further RPCs serviced at all — immediately after a `list_targets`
    /// call during an active recording, with the capture's own liveness
    /// watchdog firing around the same moment; a `captureFrame` step is the
    /// next thing the operator loop does in that position. Whether or not
    /// `SCScreenshotManager.captureImage`'s async task is the specific thing
    /// that stopped completing, an unbounded wait here can never be
    /// distinguished from — and can directly cause — exactly that symptom,
    /// since this thread is the sidecar's only RPC dispatcher. Bounding it
    /// converts a silent, permanent process-wide freeze into a reported,
    /// catchable per-call error.
    public static let captureImageTimeoutMs: Double = 10000

    @available(macOS 14.0, *)
    private static func captureImage(filter: SCContentFilter, configuration: SCStreamConfiguration)
        throws -> CGImage
    {
        // `SCScreenshotManager.captureImage` is async-only; the dispatch loop
        // in main.swift is synchronous, so this bridges with a semaphore —
        // the same pattern `EnumerationService.fetchShareableContent` uses,
        // and bounded for the same reason (see `captureImageTimeoutMs`'s doc).
        var result: Result<CGImage, Error>?
        let semaphore = DispatchSemaphore(value: 0)
        Task {
            do {
                let image = try await SCScreenshotManager.captureImage(
                    contentFilter: filter, configuration: configuration)
                result = .success(image)
            } catch {
                result = .failure(error)
            }
            semaphore.signal()
        }
        let waitResult = semaphore.wait(timeout: .now() + .milliseconds(Int(captureImageTimeoutMs)))
        if waitResult == .timedOut {
            throw SidecarRpcError.serverError(
                "captureFrame failed: SCScreenshotManager did not respond within \(Int(captureImageTimeoutMs))ms",
                code: .captureFailed)
        }

        switch result {
        case .success(let image):
            return image
        case .failure(let error):
            let nsError = error as NSError
            if nsError.domain == "com.apple.ScreenCaptureKit.SCStreamErrorDomain" {
                if nsError.code == -3801 {
                    throw SidecarRpcError.serverError(
                        "captureFrame failed: Screen Recording permission not granted",
                        code: .permissionDenied)
                }
                // The window/display went away between enumeration and the
                // grab — a race the operator loop hits routinely.
                throw SidecarRpcError.serverError(
                    "captureFrame failed: target no longer available (\(nsError.code))",
                    code: .targetNotFound)
            }
            throw SidecarRpcError.serverError(
                "captureFrame failed: \(error)", code: .captureFailed)
        case .none:
            throw SidecarRpcError.serverError(
                "captureFrame failed: SCScreenshotManager never completed", code: .captureFailed)
        }
    }

    private static func encode(image: CGImage, jpeg: Bool, quality: Double?) throws -> Data {
        let data = NSMutableData()
        let type = jpeg ? UTType.jpeg.identifier : UTType.png.identifier
        guard
            let destination = CGImageDestinationCreateWithData(
                data as CFMutableData, type as CFString, 1, nil)
        else {
            throw SidecarRpcError.serverError(
                "Failed to create image destination", code: .internalError)
        }
        var properties: [CFString: Any] = [:]
        if jpeg {
            properties[kCGImageDestinationLossyCompressionQuality] = normalizedQuality(quality)
        }
        CGImageDestinationAddImage(destination, image, properties as CFDictionary)
        guard CGImageDestinationFinalize(destination) else {
            throw SidecarRpcError.serverError("Failed to encode image", code: .internalError)
        }
        return data as Data
    }
}
