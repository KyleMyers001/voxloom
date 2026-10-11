//! AC1/AC2: every listed tag variant is stripped; asides are preserved.

use super::*;

/// Every variant named in BUS-23, as Whisper emits it.
const LISTED: &[&str] = &[
    "[BLANK_AUDIO]",
    "[Silence]",
    "[ Silence ]",
    "(silence)",
    "[Music]",
    "[MUSIC]",
    "[ Music ]",
    "(wind blowing)",
    "[NOISE]",
    "(music)",
    "(beep)",
    "(mumbling)",
    "[inaudible]",
    "[Applause]",
    "[Laughter]",
    "[ Pause ]",
    "[sigh]",
    "(breathing)",
    "(sighs)",
    "(static)",
    "(applause)",
    "(laughs)",
    "(coughs)",
    "(clicking)",
    "(keyboard clicking)",
    "*music*",
    "*applause*",
];

#[test]
fn every_listed_tag_is_stripped_alone() {
    for tag in LISTED {
        assert_eq!(loud(tag), "", "{tag} alone");
    }
}

#[test]
fn every_listed_tag_is_stripped_inside_text() {
    for tag in LISTED {
        assert_eq!(
            loud(&format!("Hello {tag} world.")),
            "Hello world.",
            "{tag}"
        );
        assert_eq!(
            loud(&format!("{tag} Hello world.")),
            "Hello world.",
            "{tag}"
        );
        assert_eq!(
            loud(&format!("Hello world. {tag}")),
            "Hello world.",
            "{tag}"
        );
    }
}

#[test]
fn case_variants_are_stripped() {
    for tag in [
        "[music]",
        "[mUsIc]",
        "(MUSIC)",
        "*Music*",
        "[blank_audio]",
        "(Keyboard Clicking)",
    ] {
        assert_eq!(loud(&format!("a {tag} b")), "a b", "{tag}");
    }
}

#[test]
fn spacing_variants_are_stripped() {
    for tag in [
        "[  Music  ]",
        "(  coughs )",
        "[\tSilence\t]",
        "( keyboard   clicking )",
        "* applause *",
        "[ BLANK_AUDIO ]",
        "[BLANK AUDIO]",
    ] {
        assert_eq!(loud(&format!("a {tag} b")), "a b", "{tag:?}");
    }
}

#[test]
fn adjacent_tags_without_spaces_are_stripped() {
    assert_eq!(loud("[Music][Music](applause)Hi."), "Hi.");
    assert_eq!(loud("Hi[NOISE]there"), "Hi there");
}

#[test]
fn repeated_noise_tags_collapse_to_nothing() {
    assert_eq!(loud("[NOISE] [NOISE] [NOISE] [NOISE]"), "");
    assert_eq!(loud("Okay [NOISE] [NOISE] [NOISE] go."), "Okay go.");
}

#[test]
fn non_sound_parentheticals_are_preserved() {
    assert_eq!(
        loud("It works (I think) mostly."),
        "It works (I think) mostly."
    );
    assert_eq!(loud("He said teh [sic] word."), "He said teh [sic] word.");
    assert_eq!(loud("Use *really* bold text."), "Use *really* bold text.");
    assert_eq!(loud("Call me (maybe) later."), "Call me (maybe) later.");
    assert_eq!(loud("Music (the band) rocks."), "Music (the band) rocks.");
}

#[test]
fn sound_words_outside_tags_are_kept() {
    assert_eq!(
        loud("I love music and silence."),
        "I love music and silence."
    );
    assert_eq!(loud("Hear the applause"), "Hear the applause");
}

#[test]
fn partial_or_phrase_tags_are_kept() {
    // Only exact list entries are stripped.
    assert_eq!(
        loud("(music playing loudly) hi"),
        "(music playing loudly) hi"
    );
    assert_eq!(loud("[Music: jazz] hi"), "[Music: jazz] hi");
}

#[test]
fn repeated_unknown_tags_collapse_to_one() {
    assert_eq!(
        loud("Wait (crosstalk) (crosstalk) ok"),
        "Wait (crosstalk) ok"
    );
    assert_eq!(loud("(I think) so (I think)"), "(I think) so (I think)");
}

#[test]
fn unclosed_or_nested_brackets_are_left_alone() {
    assert_eq!(loud("a (music b"), "a (music b");
    assert_eq!(loud("a [x (music) y] b"), "a [x y] b");
    assert_eq!(loud("2 * 3 = 6"), "2 * 3 = 6");
}
