// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "AgentMuxNativeMacOS",
    platforms: [
        .macOS(.v12)
    ],
    products: [
        .library(
            name: "AgentMuxNativeMacOSCore",
            targets: ["AgentMuxNativeMacOSCore"]
        ),
        .executable(
            name: "agentmux-native-macos",
            targets: ["AgentMuxNativeMacOS"]
        )
    ],
    targets: [
        .target(
            name: "AgentMuxNativeMacOSCore",
            path: "Sources/AgentMuxNativeMacOSCore"
        ),
        .executableTarget(
            name: "AgentMuxNativeMacOS",
            dependencies: ["AgentMuxNativeMacOSCore"],
            path: "Sources/AgentMuxNativeMacOS"
        ),
        .testTarget(
            name: "AgentMuxNativeMacOSTests",
            dependencies: ["AgentMuxNativeMacOSCore"],
            path: "Tests/AgentMuxNativeMacOSTests"
        )
    ]
)
