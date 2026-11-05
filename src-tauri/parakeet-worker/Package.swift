// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "VoxloomParakeetWorker",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "voxloom-parakeet-worker", targets: ["ParakeetWorker"]),
               .executable(name: "parakeet-worker-fixture", targets: ["ParakeetFixture"])],
    dependencies: [
        .package(url: "https://github.com/FluidInference/FluidAudio.git", revision: "ee78635d23d52379117554ba72358b65a0612447", traits: []),
    ],
    targets: [
        .target(name: "WorkerCore"),
        .target(name: "LocalASR", dependencies: ["WorkerCore", .product(name: "FluidAudio", package: "FluidAudio")]),
        .executableTarget(name: "ParakeetWorker", dependencies: ["WorkerCore", "LocalASR"]),
        .testTarget(name: "WorkerCoreTests", dependencies: ["WorkerCore"]),
        .testTarget(name: "LocalASRTests", dependencies: ["LocalASR", "WorkerCore", .product(name: "FluidAudio", package: "FluidAudio")]),
        .executableTarget(name: "ParakeetFixture", dependencies: ["WorkerCore"], path: "Tests/ParakeetFixture"),
    ]
)
