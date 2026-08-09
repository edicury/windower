// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "windower-sidecar-macos",
    platforms: [
        // Bumped from 12.3 to 13.0 in Phase 5 (Audio): SCStreamConfiguration.capturesAudio
        // (system-audio capture via ScreenCaptureKit) requires macOS 13.0+.
        .macOS("13.0")
    ],
    targets: [
        // All protocol/envelope/enumeration/permissions logic lives in a
        // library target so XCTest can `@testable import` it — SPM cannot
        // reliably `@testable import` an executable target that uses
        // top-level-code `main.swift` (the ordinary `@main` struct route
        // isn't used here to keep the stdio loop's control flow simple).
        .target(
            name: "WindowerSidecarCore",
            path: "Sources/WindowerSidecarCore"
        ),
        .executableTarget(
            name: "windower-sidecar-macos",
            dependencies: ["WindowerSidecarCore"],
            path: "Sources/windower-sidecar-macos"
        ),
        .testTarget(
            name: "windower-sidecar-macosTests",
            dependencies: ["WindowerSidecarCore"],
            path: "Tests/windower-sidecar-macosTests"
        ),
    ]
)
