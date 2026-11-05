import Foundation
import XCTest
@testable import WorkerCore

private actor Replies {
    var values: [Data] = []
    func append(_ data: Data) { values.append(data) }
}
private struct Recognizer: SpeechRecognizer {
    let text: String
    func transcribe(_ samples: [Float]) async throws -> String {
        XCTAssertEqual(samples, [0])
        return text
    }
}

private struct PrivateError: Error { let detail = "/private/model SECRET SPEECH" }
private struct FailingRecognizer: SpeechRecognizer {
    func transcribe(_ samples: [Float]) async throws -> String { throw PrivateError() }
}

final class SessionTests: XCTestCase, @unchecked Sendable {
    private func stream(_ tail: WorkerInput = .audio([0])) -> AsyncStream<WorkerInput> {
        AsyncStream { continuation in
            continuation.yield(.load(LoadHeader(requestId: "job-1", version: .v3, directory: "/verified/local")))
            continuation.yield(tail)
            continuation.finish()
        }
    }
    private func assertError(_ data: Data?, code: String, file: StaticString = #filePath, line: UInt = #line) throws {
        let data = try XCTUnwrap(data, file: file, line: line)
        let error = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any], file: file, line: line)
        XCTAssertEqual(error["op"] as? String, "error", file: file, line: line)
        XCTAssertEqual(error["code"] as? String, code, file: file, line: line)
        XCTAssertEqual(error["requestId"] as? String, "job-1", file: file, line: line)
        XCTAssertLessThan((error["message"] as? String ?? "").utf8.count, 128, file: file, line: line)
        XCTAssertFalse(String(decoding: data, as: UTF8.self).contains("PRIVATE"), file: file, line: line)
        XCTAssertFalse(String(decoding: data, as: UTF8.self).contains("/private"), file: file, line: line)
    }
    func testLoaderErrorsAreBoundedGenericAndDoNotExposePaths() async throws {
        for failure: any Error in [WorkerFailure.modelMissing, PrivateError()] {
            let replies = Replies()
            await WorkerSession.run(input: stream(), load: { _ in throw failure }, send: { await replies.append($0) })
            let values = await replies.values
            XCTAssertEqual(values.count, 1)
            try assertError(values.last, code: failure is WorkerFailure ? "model-missing" : "engine-unavailable")
        }
    }
    func testInferenceErrorsAreBoundedGeneric() async throws {
        let replies = Replies()
        await WorkerSession.run(input: stream(), load: { _ in FailingRecognizer() }, send: { await replies.append($0) })
        try assertError(await replies.values.last, code: "transcribe-failed")
    }
    func testOversizedResultIsRejectedNotTruncated() async throws {
        let replies = Replies()
        await WorkerSession.run(input: stream(), load: { _ in Recognizer(text: String(repeating: "x", count: 40_000)) }, send: { await replies.append($0) })
        try assertError(await replies.values.last, code: "transcribe-failed")
    }
    func testMalformedAudioEventDoesNotReachInference() async throws {
        let replies = Replies()
        await WorkerSession.run(input: stream(.failure(.unsupportedAudio)), load: { _ in FailingRecognizer() }, send: { await replies.append($0) })
        try assertError(await replies.values.last, code: "unsupported-audio")
    }

    func testBothVersionsUseInjectedLocalLoaderAndReturnExactWireResult() async throws {
        for version in [ModelVersion.v2, .v3] {
            let input = AsyncStream<WorkerInput> { continuation in
                continuation.yield(.load(LoadHeader(requestId: "job-1", version: version, directory: "/verified/local")))
                continuation.yield(.audio([0]))
                continuation.finish()
            }
            let replies = Replies()
            await WorkerSession.run(input: input, load: { header in
                XCTAssertEqual(header.version, version)
                XCTAssertEqual(header.directory, "/verified/local")
                return Recognizer(text: "mock transcript")
            }, send: { await replies.append($0) })
            let frames = await replies.values
            XCTAssertEqual(frames.count, 2)
            guard frames.count == 2 else { continue }
            let ready = try XCTUnwrap(JSONSerialization.jsonObject(with: frames[0]) as? [String: Any])
            XCTAssertEqual(ready["op"] as? String, "ready")
            let result = try XCTUnwrap(JSONSerialization.jsonObject(with: frames[1]) as? [String: Any])
            XCTAssertEqual(Set(result.keys), Set(["protocolVersion", "op", "requestId", "text", "rawText", "language", "dropped"]))
            XCTAssertEqual(result["text"] as? String, "mock transcript")
            XCTAssertEqual(result["rawText"] as? String, "mock transcript")
            if version == .v2 { XCTAssertEqual(result["language"] as? String, "en") }
            else { XCTAssertTrue(result["language"] is NSNull) }
            XCTAssertTrue(result["dropped"] is NSNull)
        }
    }
}
