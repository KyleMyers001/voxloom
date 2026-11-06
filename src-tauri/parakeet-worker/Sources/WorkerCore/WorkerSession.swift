import Foundation

public protocol SpeechRecognizer: Sendable {
    /// `vocabulary` holds the user's dictionary words; empty means none.
    func transcribe(_ samples: [Float], vocabulary: [String]) async throws -> String
}
public enum WorkerInput: Sendable {
    case load(LoadHeader)
    case audio([Float], vocabulary: [String] = [])
    case failure(WorkerFailure)
}
public enum WorkerPhase: Sendable { case loading, awaitingAudio, transcribing, writing }
public enum WorkerSession {
    public typealias Loader = @Sendable (LoadHeader) async throws -> any SpeechRecognizer
    public typealias Sender = @Sendable (Data) async throws -> Void
    public static func run(input: AsyncStream<WorkerInput>, load: Loader, send: Sender,
                           phase: @Sendable (WorkerPhase) -> Void = { _ in }) async {
        var iterator = input.makeAsyncIterator()
        guard case .load(let header) = await iterator.next() else {
            try? await send(errorReply(requestId: "", failure: .engineUnavailable))
            return
        }
        var fallback = WorkerFailure.engineUnavailable
        do {
            phase(.loading)
            let recognizer = try await load(header)
            phase(.writing)
            try await send(JSONSerialization.data(withJSONObject: ["protocolVersion": 1, "op": "ready", "requestId": header.requestId]))
            phase(.awaitingAudio)
            let samples: [Float]
            let vocabulary: [String]
            switch await iterator.next() {
            case .audio(let audio, let words): (samples, vocabulary) = (audio, words)
            case .failure(let failure): throw failure
            default: throw WorkerFailure.unsupportedAudio
            }
            fallback = .transcribeFailed
            phase(.transcribing)
            let text: String
            do { text = try await recognizer.transcribe(samples, vocabulary: vocabulary) }
            catch { throw WorkerFailure.transcribeFailed }
            guard text.utf8.count <= Wire.maxControlBytes else { throw WorkerFailure.transcribeFailed }
            let result: [String: Any] = ["protocolVersion": 1, "op": "result", "requestId": header.requestId,
                "text": text, "rawText": text, "language": header.version == .v2 ? "en" : NSNull(), "dropped": NSNull()]
            let reply = try JSONSerialization.data(withJSONObject: result)
            guard reply.count <= Wire.maxControlBytes else { throw WorkerFailure.transcribeFailed }
            phase(.writing)
            try await send(reply)
        } catch {
            phase(.writing)
            try? await send(errorReply(requestId: header.requestId, failure: error as? WorkerFailure ?? fallback))
        }
    }

    private static func errorReply(requestId: String, failure: WorkerFailure) throws -> Data {
        try JSONSerialization.data(withJSONObject: ["protocolVersion": 1, "op": "error", "requestId": requestId,
            "code": failure.rawValue, "message": "Parakeet worker could not complete the request."])
    }
}
