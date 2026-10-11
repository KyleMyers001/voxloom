//! AC3: ♪ ♫ removal, whitespace and punctuation normalization.

use super::*;

#[test]
fn music_symbols_are_removed_outright() {
    assert_eq!(loud("♪"), "");
    assert_eq!(loud("♪ ♫ ♪"), "");
    assert_eq!(loud("♪ La la la ♪"), "La la la");
    assert_eq!(loud("Hi♫there"), "Hi there");
}

#[test]
fn no_doubled_spaces_remain() {
    let out = loud("one  [Music]   two \t (coughs)  three");
    assert_eq!(out, "one two three");
    assert!(!out.contains("  "));
}

#[test]
fn no_space_before_punctuation() {
    assert_eq!(loud("Hello [Music] , world [NOISE] ."), "Hello, world.");
    assert_eq!(loud("Really (laughs) ?"), "Really?");
}

#[test]
fn orphan_punctuation_is_removed() {
    assert_eq!(loud("[Music], hello."), "hello.");
    assert_eq!(loud(". [Applause] Hello"), "Hello");
    assert_eq!(loud("Hi, [NOISE], there"), "Hi, there");
    assert_eq!(loud("Done, [Music]."), "Done.");
    assert_eq!(loud("Wait; [sigh] ; go"), "Wait; go");
}

#[test]
fn intentional_punctuation_survives() {
    assert_eq!(loud("Well... okay."), "Well... okay.");
    assert_eq!(loud("What?! No."), "What?! No.");
    assert_eq!(loud("Time: 5:30, ok."), "Time: 5:30, ok.");
}

#[test]
fn empty_brackets_in_the_original_are_kept() {
    assert_eq!(loud("Hi () there []"), "Hi () there []");
    assert_eq!(loud("Hi () [Music] there []"), "Hi () there []");
}

#[test]
fn clean_text_is_unchanged() {
    let s = "Send the report to Sam by Friday, please.";
    assert_eq!(loud(s), s);
}

#[test]
fn non_speech_only_reports_drop_reason() {
    let c = clean_transcript(
        "[Music] ♪",
        CleanupOptions {
            quiet: false,
            strip_outros: true,
        },
    );
    assert_eq!(c.text, "");
    assert_eq!(c.dropped, Some(DropReason::NonSpeechOnly));
}

#[test]
fn blank_input_has_no_drop_reason() {
    assert_eq!(quiet("   ").dropped, None);
    assert_eq!(quiet("").text, "");
}
