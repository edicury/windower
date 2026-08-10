// swift-tools-version:5.9
import PackageDescription

// Phase 21 — capture/control process split.
//
// The target graph below is not organizational tidiness: it is the mechanism
// that enforces this phase's governing invariant ("exactly one process on the
// machine may ever hold ScreenCaptureKit state"). `windower-control-macos`
// cannot `import ScreenCaptureKit` — not even transitively — because nothing
// it depends on links it. That is checked mechanically by
// `scripts/check-no-screencapturekit.sh` (run from `pnpm --filter
// @windower/sidecar-macos test`), so the split cannot silently regress the
// way a convention would.
//
//   WindowerSidecarShared   — no ScreenCaptureKit. Wire types, JSON-RPC
//                             envelope, permissions, display geometry, the
//                             synthetic-event tag, the TTL cache.
//        ├── WindowerCaptureCore  — the ONLY ScreenCaptureKit-linked target.
//        └── WindowerControlCore  — CGEvent + AX only.
//
//   windower-capture-macos  = WindowerCaptureCore + WindowerSidecarShared
//   windower-control-macos  = WindowerControlCore + WindowerSidecarShared
let package = Package(
    name: "windower-sidecar-macos",
    platforms: [
        // Bumped from 12.3 to 13.0 in Phase 5 (Audio): SCStreamConfiguration.capturesAudio
        // (system-audio capture via ScreenCaptureKit) requires macOS 13.0+.
        .macOS("13.0")
    ],
    targets: [
        // Everything both surfaces need and neither owns. MUST stay free of
        // ScreenCaptureKit — it is on `windower-control-macos`'s dependency
        // path, so an import here would defeat the whole split.
        .target(
            name: "WindowerSidecarShared",
            path: "Sources/WindowerSidecarShared"
        ),
        // Capture surface: enumeration, frames, recording, event timeline.
        .target(
            name: "WindowerCaptureCore",
            dependencies: ["WindowerSidecarShared"],
            path: "Sources/WindowerCaptureCore"
        ),
        // Control surface: synthetic input and window control. Zero
        // ScreenCaptureKit dependency, by construction.
        .target(
            name: "WindowerControlCore",
            dependencies: ["WindowerSidecarShared"],
            path: "Sources/WindowerControlCore"
        ),
        // Both executables keep their dispatch loop in a top-level-code
        // `main.swift` (rather than an `@main` struct) so the stdio loop's
        // control flow stays simple; all testable logic therefore lives in the
        // library targets above, which XCTest can `@testable import`.
        .executableTarget(
            name: "windower-capture-macos",
            dependencies: ["WindowerCaptureCore", "WindowerSidecarShared"],
            path: "Sources/windower-capture-macos"
        ),
        .executableTarget(
            name: "windower-control-macos",
            dependencies: ["WindowerControlCore", "WindowerSidecarShared"],
            path: "Sources/windower-control-macos"
        ),
        .testTarget(
            name: "WindowerSidecarSharedTests",
            dependencies: ["WindowerSidecarShared"],
            path: "Tests/WindowerSidecarSharedTests"
        ),
        .testTarget(
            name: "WindowerCaptureCoreTests",
            dependencies: ["WindowerCaptureCore"],
            path: "Tests/WindowerCaptureCoreTests"
        ),
        // Deliberately does NOT depend on WindowerCaptureCore: a test target
        // that pulled it in would make it easy to write a control-surface test
        // against capture-surface symbols and never notice the layering slip.
        .testTarget(
            name: "WindowerControlCoreTests",
            dependencies: ["WindowerControlCore"],
            path: "Tests/WindowerControlCoreTests"
        ),
    ]
)
