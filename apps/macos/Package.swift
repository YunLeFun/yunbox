// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "YunBoxDesktop",
    platforms: [.macOS("26.0")],
    products: [.executable(name: "YunBox", targets: ["YunBoxDesktop"])],
    dependencies: [
        // Auto-update; the release workflow signs each zip with the key whose public half is SUPublicEDKey.
        .package(url: "https://github.com/sparkle-project/Sparkle", exact: "2.10.0"),
    ],
    targets: [
        .target(name: "YunBoxKit"),
        .executableTarget(
            name: "YunBoxDesktop",
            dependencies: ["YunBoxKit", .product(name: "Sparkle", package: "Sparkle")],
            // SwiftPM copies Sparkle.framework next to the binary; the .app keeps it in Contents/Frameworks.
            linkerSettings: [.unsafeFlags(["-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks"])]
        ),
        .testTarget(name: "YunBoxKitTests", dependencies: ["YunBoxKit"]),
    ]
)
