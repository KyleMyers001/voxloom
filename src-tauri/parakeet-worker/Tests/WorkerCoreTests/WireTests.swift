import Foundation
import XCTest
@testable import WorkerCore

final class WireTests: XCTestCase {
    func testRejectsUntrustedLoadFieldsBeforeLoading() throws {
        let valid: [String: Any] = ["protocolVersion": 1, "op": "load", "requestId": "job-1", "modelVersion": "v3", "modelDirectory": "/local/model"]
        let badFields: [(String, Any)] = [
            ("protocolVersion", 2), ("protocolVersion", true), ("op", "transcribe"),
            ("requestId", ""), ("requestId", String(repeating: "a", count: 129)),
            ("requestId", "speech\n"), ("modelVersion", "v4"),
            ("modelDirectory", "relative"), ("modelDirectory", "/bad\u{0}path"),
            ("vocabularyDirectory", "relative"), ("vocabularyDirectory", "/bad\u{0}path"),
            ("vocabularyDirectory", 7),
        ]
        for (field, value) in badFields {
            var input = valid
            input[field] = value
            XCTAssertThrowsError(try Wire.load(JSONSerialization.data(withJSONObject: input)), field)
        }
        XCTAssertThrowsError(try Wire.load(Data(repeating: 32, count: 65_537)))
        XCTAssertThrowsError(try Wire.frame(Data()))
        XCTAssertThrowsError(try Wire.frame(Data(repeating: 0, count: 65_537)))
    }

    func testReadsMonoFloat32LEAudio() throws {
        let header = try Wire.audioHeader(Data(#"{"protocolVersion":1,"op":"transcribe","requestId":"job-1","sampleRateHz":16000,"sampleCount":3}"#.utf8), requestId: "job-1")
        XCTAssertEqual(header.sampleCount, 3)
        XCTAssertEqual(header.vocabulary, [])
        XCTAssertEqual(try Wire.samples(Data([0, 0, 128, 191, 0, 0, 0, 0, 0, 0, 128, 63]), count: 3), [-1, 0, 1])
    }

    func testRejectsUntrustedAudioHeadersBeforeAllocation() throws {
        let valid: [String: Any] = ["protocolVersion": 1, "op": "transcribe", "requestId": "job-1", "sampleRateHz": 16000, "sampleCount": 1]
        for (field, value) in [("protocolVersion", 2 as Any), ("op", "load"), ("requestId", "other"), ("sampleRateHz", 48000), ("sampleCount", -1), ("sampleCount", 0), ("sampleCount", 1_920_001), ("sampleCount", 1.5), ("sampleCount", true)] {
            var input = valid
            input[field] = value
            XCTAssertThrowsError(try Wire.audioHeader(JSONSerialization.data(withJSONObject: input), requestId: "job-1"), field)
        }
    }

    func testRejectsNonFiniteOutOfRangeOrMismatchedPCMBeforeInference() throws {
        for sample: Float in [.nan, .infinity, -.infinity, 1.01, -1.01] {
            var bits = sample.bitPattern.littleEndian
            let data = withUnsafeBytes(of: &bits) { Data($0) }
            XCTAssertThrowsError(try Wire.samples(data, count: 1))
        }
        XCTAssertThrowsError(try Wire.samples(Data([0, 0, 0, 0]), count: 2))
    }

    func testLoadHeaderRoundTripsThroughLittleEndianFrame() throws {
        let json = Data(#"{"protocolVersion":1,"op":"load","requestId":"job-1","modelVersion":"v2","modelDirectory":"/local/model"}"#.utf8)
        let frame = try Wire.frame(json)
        XCTAssertEqual(Array(frame.prefix(4)), [UInt8(json.count), 0, 0, 0])
        let header = try Wire.load(json)
        XCTAssertEqual(header.requestId, "job-1")
        XCTAssertEqual(header.version, .v2)
        XCTAssertEqual(header.directory, "/local/model")
    }

    func testLoadHeaderCarriesOptionalVocabularyDirectory() throws {
        var input: [String: Any] = ["protocolVersion": 1, "op": "load", "requestId": "job-1", "modelVersion": "v3", "modelDirectory": "/local/model"]
        XCTAssertNil(try Wire.load(JSONSerialization.data(withJSONObject: input)).vocabularyDirectory)
        input["vocabularyDirectory"] = "/local/ctc"
        XCTAssertEqual(try Wire.load(JSONSerialization.data(withJSONObject: input)).vocabularyDirectory, "/local/ctc")
    }

    func testAudioHeaderCarriesBoundedDictionaryWords() throws {
        var input: [String: Any] = ["protocolVersion": 1, "op": "transcribe", "requestId": "job-1", "sampleRateHz": 16000, "sampleCount": 1]
        input["vocabulary"] = ["Voxloom", "Kubernetes", "ZWNJ\u{200C}word", String(repeating: "é", count: 64)]
        XCTAssertEqual(try Wire.audioHeader(JSONSerialization.data(withJSONObject: input), requestId: "job-1").vocabulary.count, 4)
        let bad: [Any] = [
            [""], ["tab\tword"], ["line\u{2028}word"], [String(repeating: "x", count: 129)],
            Array(repeating: "word", count: 257), "Voxloom", [7],
        ]
        for value in bad {
            input["vocabulary"] = value
            XCTAssertThrowsError(try Wire.audioHeader(JSONSerialization.data(withJSONObject: input), requestId: "job-1"), "\(value)")
        }
    }
}
