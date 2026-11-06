import AppKit
import FluidAudio
import Foundation
import WorkerCore

/// No repository resolution, downloader, recovery or convenience-loader calls.
public enum FluidLocalLoader {
    public static func load(_ header: LoadHeader) async throws -> any SpeechRecognizer {
        // The pinned dependency has no .fault call sites. This threshold drops
        // all its ASR logs (including debug speech and error paths) at every sink.
        AppLogger.minimumLevel = .fault
        AppLogger.mirrorsToConsole = false
        #if arch(arm64)
        guard isDirectory(header.directory), header.vocabularyDirectory.map(isDirectory) ?? true else {
            throw WorkerFailure.modelMissing
        }
        let version: AsrModelVersion = header.version == .v2 ? .v2 : .v3
        let manager = AsrManager()
        do {
            let models = try AsrModels.loadLocal(from: URL(fileURLWithPath: header.directory, isDirectory: true), version: version)
            try await manager.loadModels(models)
        } catch AsrModelsError.modelNotFound {
            throw WorkerFailure.modelMissing
        } catch {
            // Never use localizedDescription: dependency errors can embed paths.
            throw WorkerFailure.engineUnavailable
        }
        var booster: VocabularyBooster?
        if let directory = header.vocabularyDirectory {
            do {
                booster = try await VocabularyBooster.load(from: URL(fileURLWithPath: directory, isDirectory: true))
            } catch AsrModelsError.modelNotFound {
                throw WorkerFailure.modelMissing
            } catch CtcTokenizer.Error.tokenizerNotFound {
                throw WorkerFailure.modelMissing
            } catch {
                // The set is verified; Core ML failing to load it must not stop
                // dictation. Transcribe without boosting, as with no dictionary.
                booster = nil
            }
        }
        return FluidRecognizer(manager: manager, booster: booster)
        #else
        throw WorkerFailure.engineUnavailable
        #endif
    }

    private static func isDirectory(_ path: String) -> Bool {
        var isDirectory: ObjCBool = false
        return FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory) && isDirectory.boolValue
    }
}

private struct FluidRecognizer: SpeechRecognizer {
    let manager: AsrManager
    let booster: VocabularyBooster?
    func transcribe(_ samples: [Float], vocabulary: [String]) async throws -> String {
        var state = try TdtDecoderState()
        // No language hint. v3's transcript is multilingual, but ASRResult does
        // not provide detected language; the protocol must return null for it.
        let result = try await manager.transcribe(samples, decoderState: &state)
        guard let booster, !vocabulary.isEmpty else { return result.text }
        return await booster.rescore(result.text, tokenTimings: result.tokenTimings ?? [], samples: samples, vocabulary: vocabulary)
    }
}

/// Dictionary boosting for Parakeet TDT: FluidAudio's CTC keyword spotter
/// (parakeet-ctc-110m) scores the user's words against the same audio, and
/// the rescorer swaps a transcribed span for a word only on acoustic evidence.
///
/// Built from the public pieces rather than `VocabularyBoostingSession`,
/// which reads its tokenizer from FluidAudio's own Application Support cache
/// instead of the verified directory it was given.
public struct VocabularyBooster: Sendable {
    /// Rescoring thresholds. `nil` keeps FluidAudio's vocabulary-size default.
    public struct Settings: Sendable {
        public var cbw: Float?
        public var minSimilarity: Float?
        /// Audio searched each side of a span (FluidAudio's session default).
        public var marginSeconds: Double = 0.5
        public var config: VocabularyRescorer.Config

        public init(cbw: Float?, minSimilarity: Float?, config: VocabularyRescorer.Config) {
            self.cbw = cbw
            self.minSimilarity = minSimilarity
            self.config = config
        }

        /// Dictation: most saved words are absent from any one sentence, and a
        /// wrong replacement of a correctly heard word costs more than a miss.
        /// The best of those tried in the corpus eval (DictionaryBoostEvalTests).
        public static let dictation = Settings(
            cbw: 1,
            minSimilarity: 0.7,
            // Explicit values also stop FLUID_* environment overrides applying.
            config: VocabularyRescorer.Config(
                shortTermCbwTaperPivot: 1,
                spotterRescueMinSimilarity: 0.30,
                spotterRescueMultiWordMinSimilarity: 0.50,
                spotterRescueEnabled: false
            )
        )
    }

    let models: CtcModels
    let tokenizer: CtcTokenizer
    let directory: URL
    public let settings: Settings
    /// Whether a word is a real word; boosting never re-spells only real words.
    let isKnownWord: @Sendable (String) -> Bool

    init(models: CtcModels, tokenizer: CtcTokenizer, directory: URL, settings: Settings,
         isKnownWord: @escaping @Sendable (String) -> Bool = SpellingDictionary.knows) {
        self.models = models
        self.tokenizer = tokenizer
        self.directory = directory
        self.settings = settings
        self.isKnownWord = isKnownWord
    }

    public static func load(from directory: URL, settings: Settings = .dictation) async throws -> VocabularyBooster {
        let models = try await CtcModels.loadDirect(from: directory, variant: .ctc110m)
        let tokenizer = try await CtcTokenizer.load(from: directory)
        return VocabularyBooster(models: models, tokenizer: tokenizer, directory: directory, settings: settings)
    }

    /// `text` with dictionary words applied, or unchanged. Never throws:
    /// boosting must not cost the user their transcript.
    public func rescore(_ text: String, tokenTimings: [TokenTiming], samples: [Float], vocabulary: [String]) async -> String {
        let terms = vocabulary.compactMap { word -> CustomVocabularyTerm? in
            let ids = tokenizer.encode(word)
            return ids.isEmpty ? nil : CustomVocabularyTerm(text: word, ctcTokenIds: ids)
        }
        guard !terms.isEmpty, !tokenTimings.isEmpty, !samples.isEmpty else { return text }
        let context = CustomVocabularyContext(terms: terms)
        let spotter = CtcKeywordSpotter(models: models, blankId: models.vocabulary.count)
        guard let rescorer = try? await VocabularyRescorer.create(
            spotter: spotter, vocabulary: context, config: settings.config, ctcModelDirectory: directory)
        else { return text }
        let sizeDefaults = ContextBiasingConstants.rescorerConfig(forVocabSize: terms.count)
        let minSimilarity = max(settings.minSimilarity ?? sizeDefaults.minSimilarity, context.minSimilarity)
        // Text-only preflight: most sentences hold nothing like a saved word,
        // and then the CTC encoder never runs.
        guard rescorer.hasCTCRescoringCandidates(transcript: text, tokenTimings: tokenTimings, minSimilarity: minSimilarity),
              let spot = try? await spotter.spotKeywordsWithLogProbs(audioSamples: samples, customVocabulary: context),
              !spot.logProbs.isEmpty
        else { return text }
        let cbw = settings.cbw ?? sizeDefaults.cbw
        let evidence = rescorer.ctcTokenEvaluateCandidates(
            transcript: text, tokenTimings: tokenTimings, logProbs: spot.logProbs, frameDuration: spot.frameDuration,
            cbw: cbw, marginSeconds: settings.marginSeconds, minSimilarity: minSimilarity)
        guard Self.replacesOnlyMisheardWords(evidence.candidates, isKnownWord: isKnownWord) else { return text }
        let output = rescorer.ctcTokenRescore(
            transcript: text, tokenTimings: tokenTimings, logProbs: spot.logProbs, frameDuration: spot.frameDuration,
            cbw: cbw, marginSeconds: settings.marginSeconds, minSimilarity: minSimilarity)
        return output.wasModified ? output.text : text
    }

    /// Whether the rescorer would apply at least one replacement, and every one
    /// of them replaces a span holding a word that is not a real word
    /// ("Voxlum", "Kuber netes"). Re-spelling real words ("lotion", "box loom",
    /// "not ion") made most of the wrong changes in the corpus eval: they sound
    /// too much like the saved word for the CTC scores to tell apart. One such
    /// replacement keeps the whole transcript as heard, which is the transcript
    /// without boosting.
    static func replacesOnlyMisheardWords(
        _ candidates: [VocabularyRescorer.CandidateEvidence], isKnownWord: (String) -> Bool
    ) -> Bool {
        let applied = candidates.filter { $0.legacyOutcome == .applied }
        return !applied.isEmpty && applied.allSatisfy { candidate in
            candidate.basePhrase.split(whereSeparator: \.isWhitespace).contains { word in
                let core = word.trimmingCharacters(in: CharacterSet.punctuationCharacters.union(.symbols))
                return core.contains(where: \.isLetter) && !isKnownWord(core)
            }
        }
    }
}

/// The macOS spelling dictionary, which also holds the words the user taught
/// it. With no working dictionary every word is known, so boosting changes
/// nothing.
enum SpellingDictionary {
    /// English, for v2, and the user's own languages (Language & Region), for
    /// v3. A language whose dictionary is not installed reports every word as
    /// spelled right, so it must reject a made-up word to be used.
    static let languages: [String] = {
        let checker = NSSpellChecker.shared
        var languages: [String] = []
        for code in ["en"] + Locale.preferredLanguages.compactMap({ Locale.Language(identifier: $0).languageCode?.identifier })
        where !languages.contains(code) && checker.availableLanguages.contains(code) && !spells("zqxjvkwpt", in: code) {
            languages.append(code)
        }
        return languages
    }()

    @Sendable static func knows(_ word: String) -> Bool {
        // "vox" is not a word but "Vox" is a name, so any case counts.
        languages.isEmpty || Set([word, word.lowercased(), word.capitalized]).contains { form in
            languages.contains { spells(form, in: $0) }
        }
    }

    private static func spells(_ word: String, in language: String) -> Bool {
        NSSpellChecker.shared.checkSpelling(
            of: word, startingAt: 0, language: language, wrap: false, inSpellDocumentWithTag: 0, wordCount: nil
        ).location == NSNotFound
    }
}
