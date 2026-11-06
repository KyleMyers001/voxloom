import Foundation
import FluidAudio
@testable import LocalASR
import XCTest

/// The BUS-138 dictionary corpus through real Parakeet with and without CTC
/// dictionary boosting. Skipped unless pointed at local models and audio:
///
/// ```sh
/// VOXLOOM_TEST_PARAKEET_MODEL=/path/parakeet-tdt-0.6b-v2 \
/// VOXLOOM_TEST_PARAKEET_VERSION=v2 \
/// VOXLOOM_TEST_PARAKEET_CTC=/path/parakeet-ctc-110m \
/// VOXLOOM_TEST_PROMPT_EVAL_AUDIO=/tmp/eval-audio \
///   swift test --filter DictionaryBoostEvalTests
/// ```
///
/// Audio is one `<id>.wav` (16 kHz mono s16le) or `<id>.s16` per corpus
/// sentence, in the directory or its subdirectories (one per voice):
/// `scripts/dictionary-prompt-eval-tts.py` makes `.s16` files, or use `say`.
/// `VOXLOOM_EVAL_OUT=/tmp/eval.json` writes every transcript. TTS speech is
/// not a person's voice: indicative only. It reports; it asserts nothing.
final class DictionaryBoostEvalTests: XCTestCase, @unchecked Sendable {
    private struct Corpus: Decodable {
        let dictionary: [String]
        let items: [Item]
    }
    private struct Item: Decodable {
        let id: String
        let kind: String
        let expect: [String]?
    }

    func testBoostingAgainstNoBoostingOnTheCorpus() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let model = env["VOXLOOM_TEST_PARAKEET_MODEL"], let ctc = env["VOXLOOM_TEST_PARAKEET_CTC"],
              let audio = env["VOXLOOM_TEST_PROMPT_EVAL_AUDIO"] else {
            throw XCTSkip("needs VOXLOOM_TEST_PARAKEET_MODEL, VOXLOOM_TEST_PARAKEET_CTC and VOXLOOM_TEST_PROMPT_EVAL_AUDIO")
        }
        let corpusURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("../src/stt/fixtures/dictionary_prompt/corpus.json").standardized
        let corpus = try JSONDecoder().decode(Corpus.self, from: Data(contentsOf: corpusURL))
        let manager = AsrManager()
        let version: AsrModelVersion = env["VOXLOOM_TEST_PARAKEET_VERSION"] == "v3" ? .v3 : .v2
        try await manager.loadModels(AsrModels.loadLocal(from: URL(fileURLWithPath: model, isDirectory: true), version: version))
        let base = try await VocabularyBooster.load(from: URL(fileURLWithPath: ctc, isDirectory: true))

        let dictation = VocabularyBooster.Settings.dictation
        let respellAnything: @Sendable (String) -> Bool = { _ in false }
        let settings: [(String, VocabularyBooster.Settings, (@Sendable (String) -> Bool)?)] = [
            ("dictation", dictation, nil),
            ("dictation-no-word-guard", dictation, respellAnything),
            ("cbw-default", .init(cbw: nil, minSimilarity: 0.7, config: dictation.config), nil),
            ("fluidaudio-default-no-word-guard", .init(cbw: nil, minSimilarity: nil, config: .default), respellAnything),
        ]
        var tallies = Array(repeating: Tally(), count: settings.count + 1)
        var rows: [[String: String]] = []
        var boostSeconds = 0.0
        for clip in clips(in: URL(fileURLWithPath: audio, isDirectory: true), ids: corpus.items.map(\.id)) {
            let item = corpus.items.first { $0.id == clip.id }!
            let samples = try pcm(clip.url)
            var state = try TdtDecoderState()
            let result = try await manager.transcribe(samples, decoderState: &state)
            var texts = [result.text]
            for (_, setting, isKnownWord) in settings {
                let booster = VocabularyBooster(
                    models: base.models, tokenizer: base.tokenizer, directory: base.directory, settings: setting,
                    isKnownWord: isKnownWord ?? base.isKnownWord)
                let start = Date()
                texts.append(await booster.rescore(result.text, tokenTimings: result.tokenTimings ?? [], samples: samples, vocabulary: corpus.dictionary))
                boostSeconds += Date().timeIntervalSince(start)
            }
            for (index, text) in texts.enumerated() {
                tallies[index].add(item: item, text: text, dictionary: corpus.dictionary, baseline: texts[0], clip: clip.name)
            }
            var row = ["clip": clip.name, "baseline": texts[0]]
            for (index, (name, _, _)) in settings.enumerated() { row[name] = texts[index + 1] }
            rows.append(row)
            let changed = texts.dropFirst().contains { $0 != texts[0] }
            print("\(clip.name): \(texts[0])" + (changed ? " → " + texts.dropFirst().joined(separator: " | ") : ""))
        }
        print("baseline: \(tallies[0].summary)")
        for (index, (name, _, _)) in settings.enumerated() { print("\(name): \(tallies[index + 1].summary)") }
        print(String(format: "boost time: %.2fs total over %d settings", boostSeconds, settings.count))
        if let out = env["VOXLOOM_EVAL_OUT"] {
            try JSONSerialization.data(withJSONObject: rows, options: .prettyPrinted).write(to: URL(fileURLWithPath: out))
        }
    }

    private struct Tally {
        var fixRight = 0, fixTotal = 0, wordsRight = 0, wordsExpected = 0
        var keepWithWord: [String] = []
        var keepChanged: [String] = []

        mutating func add(item: Item, text: String, dictionary: [String], baseline: String, clip: String) {
            if item.kind == "fix" {
                let expect = item.expect ?? []
                let right = expect.filter { mentions(text, $0, exact: true) }.count
                wordsRight += right
                wordsExpected += expect.count
                fixTotal += 1
                fixRight += right == expect.count ? 1 : 0
            } else {
                if dictionary.contains(where: { mentions(text, $0, exact: false) }) { keepWithWord.append(clip) }
                if text != baseline { keepChanged.append(clip) }
            }
        }
        var summary: String {
            "fix \(fixRight)/\(fixTotal), words \(wordsRight)/\(wordsExpected), keep with a dictionary word \(keepWithWord.count) \(keepWithWord), keep changed by boosting \(keepChanged.count) \(keepChanged)"
        }
    }

    private struct Clip { let id: String; let name: String; let url: URL }

    private func clips(in root: URL, ids: [String]) -> [Clip] {
        let files = (FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil)?.allObjects as? [URL]) ?? []
        return files.compactMap { url -> Clip? in
            let id = url.deletingPathExtension().lastPathComponent
            guard ["wav", "s16"].contains(url.pathExtension), ids.contains(id) else { return nil }
            let voice = url.deletingLastPathComponent().standardized == root.standardized ? "" : url.deletingLastPathComponent().lastPathComponent + "/"
            return Clip(id: id, name: voice + id, url: url)
        }.sorted { $0.name < $1.name }
    }

    private func pcm(_ url: URL) throws -> [Float] {
        var data = try Data(contentsOf: url)
        if url.pathExtension == "wav" {
            // Skip RIFF chunks up to "data".
            var offset = 12
            while offset + 8 <= data.count {
                let id = String(decoding: data[offset..<offset + 4], as: UTF8.self)
                let size = Int(data[offset + 4..<offset + 8].withUnsafeBytes { $0.loadUnaligned(as: UInt32.self).littleEndian })
                if id == "data" { data = data.subdata(in: offset + 8..<min(data.count, offset + 8 + size)); break }
                offset += 8 + size + (size & 1)
            }
        }
        return stride(from: 0, to: data.count - 1, by: 2).map { offset in
            Float(Int16(littleEndian: data.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: offset, as: Int16.self) })) / 32_768
        }
    }
}

/// `word` as a whole word, spelled exactly (`exact`) or in any case.
private func mentions(_ text: String, _ word: String, exact: Bool) -> Bool {
    let (haystack, needle) = exact ? (text, word) : (text.lowercased(), word.lowercased())
    var range = haystack.startIndex..<haystack.endIndex
    while let found = haystack.range(of: needle, range: range) {
        let before = found.lowerBound == haystack.startIndex ? nil : haystack[haystack.index(before: found.lowerBound)]
        let after = found.upperBound == haystack.endIndex ? nil : haystack[found.upperBound]
        if !(before?.isLetter ?? false || before?.isNumber ?? false) && !(after?.isLetter ?? false || after?.isNumber ?? false) {
            return true
        }
        range = found.upperBound..<haystack.endIndex
    }
    return false
}
