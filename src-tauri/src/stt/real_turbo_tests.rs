//! Explicit opt-in smoke only: no downloads, microphone, installation or
//! recognition-superiority claim. Timing is emitted by the real engine's
//! load/inference boundaries when compiled as a test.
use super::*;

#[test]
#[ignore = "requires VOXLOOM_TEST_TURBO_MODEL pointing to approved pinned weights"]
fn real_turbo_english_dictionary_and_silence() {
    let path = std::path::PathBuf::from(
        std::env::var_os("VOXLOOM_TEST_TURBO_MODEL").expect("set VOXLOOM_TEST_TURBO_MODEL"),
    );
    assert!(path.is_file());
    let runtime = turbo::TurboRuntime::default();
    let bytes = include_bytes!("fixtures/trim_corpus/libri_128104-0008_a0.s16");
    let pcm: Vec<_> = bytes
        .chunks_exact(2)
        .map(|pair| i16::from_le_bytes([pair[0], pair[1]]) as f32 / 32768.0)
        .collect();
    let cfg = SpeechFilterConfig::default();
    let dictionary = vec!["Voxloom".into(), "Notion".into()];
    runtime.prepare(0, "real-speech", turbo::MODEL_ID).unwrap();
    let output = runtime
        .run(0, "real-speech", turbo::MODEL_ID, |cancel| {
            with_dictionary::transcribe_with_dictionary_cancellable(
                &path,
                &pcm,
                16_000,
                &cfg,
                &dictionary,
                Some(&cancel),
            )
        })
        .unwrap();
    assert_eq!(output.language.as_deref(), Some("en"));
    assert!(output.dropped.is_none());
    assert!(
        output.text.split_whitespace().count() >= 3,
        "expected meaningful English speech: {:?}",
        output.text
    );
    assert!(
        output
            .text
            .chars()
            .filter(char::is_ascii_alphabetic)
            .count()
            >= 12
    );
    let words: Vec<_> = output
        .text
        .to_ascii_lowercase()
        .split_whitespace()
        .map(|s| s.trim_matches(|c: char| !c.is_alphabetic()).to_owned())
        .collect();
    assert!(words.iter().any(|word| ["the", "and", "of", "to", "a", "in", "is", "was"].contains(&word.as_str())), "expected English words in public speech fixture");
    eprintln!("public-fixture English smoke: {:?}", output.text);
    for (id, dictionary) in [
        ("silence-dictionary", dictionary),
        ("silence-empty", vec![]),
    ] {
        runtime.prepare(0, id, turbo::MODEL_ID).unwrap();
        let silence = runtime
            .run(0, id, turbo::MODEL_ID, |cancel| {
                with_dictionary::transcribe_with_dictionary_cancellable(
                    &path,
                    &vec![0.0; 16_000],
                    16_000,
                    &cfg,
                    &dictionary,
                    Some(&cancel),
                )
            })
            .unwrap();
        assert!(silence.text.is_empty());
        assert_eq!(silence.dropped, Some(cleanup::DropReason::SilentAudio));
    }
}
