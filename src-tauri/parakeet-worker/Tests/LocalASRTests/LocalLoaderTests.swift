import Foundation
import FluidAudio
import LocalASR
import WorkerCore
import XCTest

final class LocalLoaderTests: XCTestCase, @unchecked Sendable {
    func testEmptyLocalDirectoryFailsThroughRealLocalLoaderWithoutRecovery() async throws {
        let directory = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("voxloom-empty-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: directory) }
        for version in ["v2", "v3"] {
            let header = try Wire.load(JSONSerialization.data(withJSONObject: ["protocolVersion": 1, "op": "load", "requestId": "job-1", "modelVersion": version, "modelDirectory": directory.path]))
            do {
                _ = try await FluidLocalLoader.load(header)
                XCTFail("empty local model was accepted")
            } catch {
                XCTAssertEqual(error as? WorkerFailure, .modelMissing)
            }
        }
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path), [])
    }

    func testBothVersionsFailLocallyForMissingDirectoryWithoutCreatingIt() async throws {
        let directory = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("voxloom-missing-\(UUID().uuidString)")
        for version in ["v2", "v3"] {
            let header = try Wire.load(JSONSerialization.data(withJSONObject: ["protocolVersion": 1, "op": "load", "requestId": "job-1", "modelVersion": version, "modelDirectory": directory.path]))
            do {
                _ = try await FluidLocalLoader.load(header)
                XCTFail("missing local model was accepted")
            } catch {
                XCTAssertEqual(error as? WorkerFailure, .modelMissing)
            }
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.path))
        XCTAssertEqual(AppLogger.minimumLevel, .fault)
        XCTAssertFalse(AppLogger.mirrorsToConsole)
    }
}
