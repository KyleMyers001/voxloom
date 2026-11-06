import Foundation
import FluidAudio
import WorkerCore

/// No repository resolution, downloader, recovery or convenience-loader calls.
public enum FluidLocalLoader {
    public static func load(_ header: LoadHeader) async throws -> any SpeechRecognizer {
        // The pinned dependency has no .fault call sites. This threshold drops
        // all its ASR logs (including debug speech and error paths) at every sink.
        AppLogger.minimumLevel = .fault
        AppLogger.mirrorsToConsole = false
        #if arch(arm64)
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: header.directory, isDirectory: &isDirectory), isDirectory.boolValue else {
            throw WorkerFailure.modelMissing
        }
        let version: AsrModelVersion = header.version == .v2 ? .v2 : .v3
        do {
            let models = try AsrModels.loadLocal(from: URL(fileURLWithPath: header.directory, isDirectory: true), version: version)
            let manager = AsrManager()
            try await manager.loadModels(models)
            return FluidRecognizer(manager: manager)
        } catch AsrModelsError.modelNotFound {
            throw WorkerFailure.modelMissing
        } catch {
            // Never use localizedDescription: dependency errors can embed paths.
            throw WorkerFailure.engineUnavailable
        }
        #else
        throw WorkerFailure.engineUnavailable
        #endif
    }
}

private struct FluidRecognizer: SpeechRecognizer {
    let manager: AsrManager
    func transcribe(_ samples: [Float]) async throws -> String {
        var state = try TdtDecoderState()
        // No language hint. v3's transcript is multilingual, but ASRResult does
        // not provide detected language; the protocol must return null for it.
        return try await manager.transcribe(samples, decoderState: &state).text
    }
}
