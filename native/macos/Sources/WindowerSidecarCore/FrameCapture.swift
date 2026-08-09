import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

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

    public static func captureFrame(params: CaptureFrameParams) throws -> CaptureFrameResult {
        guard PermissionsService.screenRecordingStatus() == .granted else {
            throw SidecarRpcError.serverError(
                "captureFrame requires the Screen Recording permission", code: .permissionDenied)
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

    @available(macOS 14.0, *)
    private static func captureImage(filter: SCContentFilter, configuration: SCStreamConfiguration)
        throws -> CGImage
    {
        // `SCScreenshotManager.captureImage` is async-only; the dispatch loop
        // in main.swift is synchronous, so this bridges with a semaphore —
        // the same pattern `EnumerationService.fetchShareableContent` uses.
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
        semaphore.wait()

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
