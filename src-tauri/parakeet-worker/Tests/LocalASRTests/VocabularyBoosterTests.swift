import FluidAudio
@testable import LocalASR
import XCTest

final class VocabularyBoosterTests: XCTestCase {
    private let known: Set<String> = ["lotion", "box", "loom", "not", "ion", "Kuber"]

    private func candidate(_ base: String, _ outcome: VocabularyRescorer.LegacyApplicationOutcome = .applied) -> VocabularyRescorer.CandidateEvidence {
        VocabularyRescorer.CandidateEvidence(
            candidateID: 0, origin: .termCentricSingleWord, basePhrase: base, canonicalTerm: "Term", matchedAlias: nil,
            similarity: 0.8, rawVocabularyCTCScore: -1, rawOriginalCTCScore: -2, effectiveBoost: 0, wordRange: 0..<1,
            tokenRange: nil, baseTextUTF8Range: nil, startTime: nil, endTime: nil,
            comparisonPassed: outcome != .rejectedByComparison, legacyOutcome: outcome, reason: "")
    }

    private func allowed(_ candidates: [VocabularyRescorer.CandidateEvidence]) -> Bool {
        VocabularyBooster.replacesOnlyMisheardWords(candidates, isKnownWord: known.contains)
    }

    func testAMisheardWordMayBeReplaced() {
        XCTAssertTrue(allowed([candidate("Voxlum")]))
        XCTAssertTrue(allowed([candidate("pubernets.")]))
        // One word that is not a word is enough in a split span.
        XCTAssertTrue(allowed([candidate("Kuber netes")]))
    }

    func testRealWordsAreNeverRespelled() {
        XCTAssertFalse(allowed([candidate("lotion.")]))
        XCTAssertFalse(allowed([candidate("box loom")]))
        XCTAssertFalse(allowed([candidate("not ion,")]))
        // Numbers and punctuation are not misheard words.
        XCTAssertFalse(allowed([candidate("box 42 —")]))
    }

    func testOneRealWordReplacementKeepsTheWholeTranscript() {
        XCTAssertFalse(allowed([candidate("Voxlum"), candidate("lotion")]))
    }

    func testOnlyAppliedCandidatesCount() {
        XCTAssertFalse(allowed([]))
        XCTAssertFalse(allowed([candidate("Voxlum", .rejectedByComparison)]))
        XCTAssertTrue(allowed([candidate("Voxlum"), candidate("lotion", .rejectedByComparison), candidate("box", .supersededByOverlap)]))
    }

    func testTheMacSpellingDictionaryTellsWordsFromMishearings() {
        for word in ["lotion", "motion", "box", "skyline", "vox"] {
            XCTAssertTrue(SpellingDictionary.knows(word), word)
        }
        for word in ["Voxlum", "pubernets", "Kubernetis", "Notian"] {
            XCTAssertFalse(SpellingDictionary.knows(word), word)
        }
    }
}
