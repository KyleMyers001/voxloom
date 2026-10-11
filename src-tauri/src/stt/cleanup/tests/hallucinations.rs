//! AC4/AC5: silence hallucinations and trailing outros.

use super::*;

#[test]
fn every_hallucination_dropped_when_quiet() {
    for phrase in SILENCE_HALLUCINATIONS {
        let raw = format!("{phrase}.");
        let c = quiet(&raw);
        assert_eq!(c.text, "", "{raw}");
        assert_eq!(c.dropped, Some(DropReason::QuietHallucination), "{raw}");
    }
    let c = quiet("Subtitles by the Amara.org community");
    assert_eq!(c.dropped, Some(DropReason::QuietHallucination));
}

#[test]
fn hallucination_case_and_punctuation_variants_when_quiet() {
    for raw in [
        "Thank you.",
        "THANK YOU!",
        " thank  you ",
        "Okay?",
        "I’m sorry.",
        "Oh my God!",
    ] {
        assert_eq!(quiet(raw).text, "", "{raw:?}");
    }
}

#[test]
fn repeated_hallucination_dropped_when_quiet() {
    assert_eq!(quiet("Thank you. Thank you. Thank you.").text, "");
    assert_eq!(quiet("[Music] Thank you. [Music]").text, "");
}

#[test]
fn hallucination_kept_when_clip_is_not_quiet() {
    for phrase in ["Thank you.", "Okay.", "Bye.", "So", "You"] {
        assert_eq!(loud(phrase), phrase, "loud {phrase}");
    }
}

#[test]
fn mid_text_thank_you_and_okay_never_removed() {
    for raw in [
        "Thank you for the update, see you soon.",
        "Okay, send it now.",
        "I said thank you to her.",
        "So, okay, let's go.",
        "Thank you. Let's start the meeting.",
    ] {
        assert_eq!(loud(raw), raw, "loud {raw}");
        assert_eq!(quiet(raw).text, raw, "quiet {raw}");
    }
}

#[test]
fn hallucination_with_real_speech_is_not_dropped_when_quiet() {
    assert_eq!(quiet("Okay. Ship it.").text, "Okay. Ship it.");
}

#[test]
fn trailing_youtube_outros_are_removed() {
    assert_eq!(
        loud("Ship it today. Thanks for watching!"),
        "Ship it today."
    );
    assert_eq!(
        loud("Ship it today. Thank you for watching."),
        "Ship it today."
    );
    assert_eq!(loud("Ship it today. Please subscribe."), "Ship it today.");
    assert_eq!(
        loud("Ship it today. Subtitles by the Amara.org community"),
        "Ship it today."
    );
    assert_eq!(
        loud("Ship it. Thanks for watching. Please subscribe."),
        "Ship it."
    );
}

#[test]
fn outro_phrases_mid_text_are_kept() {
    let s = "Thanks for watching the kids. See you tonight.";
    assert_eq!(loud(s), s);
    let s = "Please subscribe me to the list.";
    assert_eq!(loud(s), s);
}

#[test]
fn lone_outro_only_dropped_when_quiet() {
    assert_eq!(loud("Thanks for watching!"), "Thanks for watching!");
    assert_eq!(quiet("Thanks for watching!").text, "");
}

#[test]
fn outro_stripping_can_be_disabled() {
    let c = clean_transcript(
        "Ship it. Thanks for watching!",
        CleanupOptions {
            quiet: false,
            strip_outros: false,
        },
    );
    assert_eq!(c.text, "Ship it. Thanks for watching!");
}
