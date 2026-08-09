// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "windower-sidecar-macos",
    platforms: [
        .macOS("12.3")
    ],
    targets: [
        .executableTarget(
            name: "windower-sidecar-macos",
            path: "Sources/windower-sidecar-macos"
        ),
        .testTarget(
            name: "windower-sidecar-macosTests",
            path: "Tests/windower-sidecar-macosTests"
        ),
    ]
)
