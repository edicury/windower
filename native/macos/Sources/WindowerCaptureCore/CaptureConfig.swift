import CoreGraphics
import CoreMedia
import Foundation
import WindowerSidecarShared

/// Pure geometry/config math for building `SCStreamConfiguration` inputs
/// from `VideoSettings`/`CaptureTarget` (data-model.md). No SCStream,
/// SCShareableContent, or AVAssetWriter calls live here — those belong to
/// the capture-session and asset-writer pieces of Phase 4. Everything in
/// this file is a plain, headlessly-testable function.
public enum CaptureConfigService {
    /// Bits-per-pixel budget per quality tier, applied against a 30fps
    /// reference baseline: `bitrate = bpp * width * height * 30`. Screen
    /// content (mostly static UI/text, not high-motion video) tolerates a
    /// much lower bpp than typical camera-video presets.
    ///
    /// | quality         | bpp  | 1920x1080 (30fps ref) |
    /// |------------------|------|------------------------|
    /// | low              | 0.04 | ≈ 2.49 Mbps            |
    /// | medium           | 0.08 | ≈ 4.98 Mbps            |
    /// | high             | 0.15 | ≈ 9.33 Mbps            |
    /// | lossless_ish     | 0.35 | ≈ 21.77 Mbps           |
    ///
    /// Worked example: medium at 1920x1080 → 0.08 * 1920 * 1080 * 30 =
    /// 4,976,640 bps ≈ 4.98 Mbps.
    ///
    /// Unknown/unrecognized `quality` strings fall back to `"medium"`'s
    /// bpp rather than crashing (defensive against a future data-model
    /// value this sidecar build predates).
    public static func bitrate(forQuality quality: String, width: Int, height: Int) -> Int {
        let bppByQuality: [String: Double] = [
            "low": 0.04,
            "medium": 0.08,
            "high": 0.15,
            "lossless_ish": 0.35,
        ]
        let bpp = bppByQuality[quality] ?? bppByQuality["medium"]!
        let referenceFps = 30.0
        let bitrate = bpp * Double(width) * Double(height) * referenceFps
        return Int(bitrate.rounded())
    }

    /// `SCStreamConfiguration.minimumFrameInterval` wants an *interval*
    /// (seconds per frame), not a rate — `CMTime(value: 1, timescale: fps)`
    /// is the standard way to express "1/fps seconds" as a `CMTime`.
    public static func minimumFrameInterval(forFps fps: Int) -> CMTime {
        CMTime(value: 1, timescale: CMTimeScale(fps))
    }

    /// Resolves the output pixel dimensions for a capture: explicit
    /// `VideoSettings.resolution` when provided, otherwise the target's
    /// native pixel bounds (data-model.md: `resolution` omitted means
    /// "native target resolution"). H.264/HEVC hardware encoders require
    /// even width/height, so the final result is always rounded *down* to
    /// the nearest even integer (never up past the source dimension) and
    /// never returned below 2.
    public static func resolvedPixelDimensions(
        requestedWidth: Double?, requestedHeight: Double?,
        nativeWidth: Double, nativeHeight: Double
    ) -> (width: Int, height: Int) {
        let width = requestedWidth ?? nativeWidth
        let height = requestedHeight ?? nativeHeight
        return (roundDownToEven(width), roundDownToEven(height))
    }

    private static func roundDownToEven(_ value: Double) -> Int {
        var truncated = Int(value)
        if truncated % 2 != 0 {
            truncated -= 1
        }
        return max(2, truncated)
    }

    /// Computes `SCStreamConfiguration.sourceRect` for a `region` capture
    /// target (data-model.md: `{ kind: "region", displayId, bounds }`,
    /// `bounds` in global-space pixels — same space `display.bounds` lives
    /// in). `sourceRect` is specified in **points, relative to the
    /// display's own top-left origin** (research.md §2 — region crop is
    /// performed against a display capture, SCK has no native arbitrary-
    /// rect target). So: subtract the display's global-pixel origin from
    /// the region's global-pixel origin to get the region's offset within
    /// the display, then divide by `scaleFactor` to convert pixels to
    /// points.
    public static func regionSourceRect(
        regionPixelBounds: (x: Double, y: Double, width: Double, height: Double),
        displayPixelBounds: (x: Double, y: Double, width: Double, height: Double),
        scaleFactor: Double
    ) -> CGRect {
        let offsetX = regionPixelBounds.x - displayPixelBounds.x
        let offsetY = regionPixelBounds.y - displayPixelBounds.y
        return CGRect(
            x: offsetX / scaleFactor,
            y: offsetY / scaleFactor,
            width: regionPixelBounds.width / scaleFactor,
            height: regionPixelBounds.height / scaleFactor
        )
    }
}
