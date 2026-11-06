import Foundation

public enum ModelVersion: String, Codable, Sendable { case v2, v3 }
public struct LoadHeader: Sendable {
    public let requestId: String
    public let version: ModelVersion
    public let directory: String
    /// The verified CTC keyword-spotting set used for dictionary boosting.
    public let vocabularyDirectory: String?
    public init(requestId: String, version: ModelVersion, directory: String, vocabularyDirectory: String? = nil) {
        self.requestId = requestId
        self.version = version
        self.directory = directory
        self.vocabularyDirectory = vocabularyDirectory
    }
}
public enum WorkerFailure: String, Error, Sendable {
    case modelMissing = "model-missing"
    case unsupportedAudio = "unsupported-audio"
    case transcribeFailed = "transcribe-failed"
    case engineUnavailable = "engine-unavailable"
}
public enum Wire {
    public static let maxControlBytes = 65_536
    public static let maxSamples = 1_920_000
    public static let maxVocabularyTerms = 256
    public static let maxVocabularyTermBytes = 128

    public static func frame(_ data: Data) throws -> Data {
        guard !data.isEmpty, data.count <= maxControlBytes else { throw WorkerFailure.engineUnavailable }
        var length = UInt32(data.count).littleEndian
        var result = withUnsafeBytes(of: &length) { Data($0) }
        result.append(data)
        return result
    }
    public static func load(_ data: Data) throws -> LoadHeader {
        struct Header: Decodable {
            let protocolVersion: Int
            let op: String
            let requestId: String
            let modelVersion: ModelVersion
            let modelDirectory: String
            let vocabularyDirectory: String?
        }
        guard !data.isEmpty, data.count <= maxControlBytes else { throw WorkerFailure.engineUnavailable }
        let header = try JSONDecoder().decode(Header.self, from: data)
        guard header.protocolVersion == 1, header.op == "load", validID(header.requestId),
              validDirectory(header.modelDirectory),
              header.vocabularyDirectory.map(validDirectory) ?? true else { throw WorkerFailure.engineUnavailable }
        return LoadHeader(requestId: header.requestId, version: header.modelVersion, directory: header.modelDirectory,
                          vocabularyDirectory: header.vocabularyDirectory)
    }

    public struct AudioHeader: Sendable {
        public let sampleCount: Int
        /// Dictionary words to boost; empty when the user has none.
        public let vocabulary: [String]
    }
    public static func audioHeader(_ data: Data, requestId: String) throws -> AudioHeader {
        struct Header: Decodable {
            let protocolVersion: Int
            let op: String
            let requestId: String
            let sampleRateHz: Int
            let sampleCount: Int
            let vocabulary: [String]?
        }
        guard !data.isEmpty, data.count <= maxControlBytes else { throw WorkerFailure.unsupportedAudio }
        let header = try JSONDecoder().decode(Header.self, from: data)
        let vocabulary = header.vocabulary ?? []
        guard header.protocolVersion == 1, header.op == "transcribe", header.requestId == requestId,
              header.sampleRateHz == 16_000, (1...maxSamples).contains(header.sampleCount),
              vocabulary.count <= maxVocabularyTerms, vocabulary.allSatisfy(validTerm) else {
            throw WorkerFailure.unsupportedAudio
        }
        return AudioHeader(sampleCount: header.sampleCount, vocabulary: vocabulary)
    }
    public static func samples(_ data: Data, count: Int) throws -> [Float] {
        guard (1...maxSamples).contains(count), data.count == count * 4 else { throw WorkerFailure.unsupportedAudio }
        // Check every sample before allocating the inference array.
        try data.withUnsafeBytes { bytes in
            for offset in stride(from: 0, to: bytes.count, by: 4) {
                let sample = Float(bitPattern: UInt32(littleEndian: bytes.loadUnaligned(fromByteOffset: offset, as: UInt32.self)))
                guard sample.isFinite, (-1...1).contains(sample) else { throw WorkerFailure.unsupportedAudio }
            }
        }
        return stride(from: 0, to: data.count, by: 4).map { offset in
            let bits = data.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: offset, as: UInt32.self) }
            return Float(bitPattern: UInt32(littleEndian: bits))
        }
    }

    static func validDirectory(_ path: String) -> Bool {
        path.hasPrefix("/") && path.utf8.count <= 4096 && !path.contains("\u{0}")
    }

    /// Nonempty, bounded and free of control characters, as the app's entry filter.
    static func validTerm(_ term: String) -> Bool {
        !term.isEmpty && term.utf8.count <= maxVocabularyTermBytes
            // Cc only, as Rust's char::is_control: format characters such as ZWNJ are spelling.
            && !term.unicodeScalars.contains { $0.properties.generalCategory == .control || $0 == "\u{2028}" || $0 == "\u{2029}" }
    }

    public static func validID(_ id: String) -> Bool {
        !id.isEmpty && id.utf8.count <= 128 && id.utf8.allSatisfy {
            (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || [45, 95, 46, 58].contains($0)
        }
    }
}
