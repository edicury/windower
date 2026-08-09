// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "windower-demo-app",
    platforms: [
        .macOS("13.0")
    ],
    targets: [
        .executableTarget(
            name: "windower-demo-app",
            path: "Sources/windower-demo-app"
        )
    ]
)
