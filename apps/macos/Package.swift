// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "YunBoxDesktop",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "YunBox", targets: ["YunBoxDesktop"])],
    targets: [
        .target(name: "YunBoxKit"),
        .executableTarget(name: "YunBoxDesktop", dependencies: ["YunBoxKit"]),
        .testTarget(name: "YunBoxKitTests", dependencies: ["YunBoxKit"]),
    ]
)
