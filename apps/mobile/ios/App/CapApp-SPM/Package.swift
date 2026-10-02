// swift-tools-version: 5.9
import PackageDescription

// DO NOT MODIFY THIS FILE - managed by Capacitor CLI commands
let package = Package(
    name: "CapApp-SPM",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "CapApp-SPM",
            targets: ["CapApp-SPM"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.5.2"),
        .package(name: "CapacitorApp", path: "../../../../../node_modules/.pnpm/@capacitor+app@8.0.0_@capacitor+core@8.5.2/node_modules/@capacitor/app"),
        .package(name: "CapacitorClipboard", path: "../../../../../node_modules/.pnpm/@capacitor+clipboard@8.0.0_@capacitor+core@8.5.2/node_modules/@capacitor/clipboard"),
        .package(name: "CapacitorKeyboard", path: "../../../../../node_modules/.pnpm/@capacitor+keyboard@8.0.4_@capacitor+core@8.5.2/node_modules/@capacitor/keyboard"),
        .package(name: "CapawesomeCapacitorFilePicker", path: "../../../../../node_modules/.pnpm/@capawesome+capacitor-file-picker@8.0.0_@capacitor+core@8.5.2/node_modules/@capawesome/capacitor-file-picker")
    ],
    targets: [
        .target(
            name: "CapApp-SPM",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                .product(name: "CapacitorApp", package: "CapacitorApp"),
                .product(name: "CapacitorClipboard", package: "CapacitorClipboard"),
                .product(name: "CapacitorKeyboard", package: "CapacitorKeyboard"),
                .product(name: "CapawesomeCapacitorFilePicker", package: "CapawesomeCapacitorFilePicker")
            ]
        )
    ]
)
