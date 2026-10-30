//! BUS-143: the committed corpus through the whole pipeline with a real
//! Whisper model. Counts the clips whose last word is dropped and the ones
//! with a hallucinated trailing "Thank you." / "you". Not run in CI (no
//! model there; `trim_corpus_tests` is the CI half):
//!
//! ```sh
//! VOXLOOM_TEST_WHISPER_MODEL=/path/ggml-base.en.bin \
//!   cargo test --lib --features whisper trim::corpus_model_tests -- --ignored --nocapture
//! ```
//!
//! `expected_word` in the manifest is a word base.en hears on the untrimmed
//! clip; another model may not hear it, so use base.en for the word count.

use super::corpus_tests::{corpus, Kind};
use crate::stt::{engine, filter_config::SpeechFilterConfig, gate::NoVad, pipeline};

fn words(text: &str) -> Vec<String> {
    let clean: String = (text.to_lowercase().chars())
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect();
    clean.split_whitespace().map(str::to_owned).collect()
}

fn hallucinated(text: &str) -> bool {
    let w = words(text).join(" ");
    ["thank you", "thanks", "bye", "you"]
        .iter()
        .any(|p| w == *p || w.ends_with(&format!(" {p}")))
}

#[test]
#[ignore = "needs VOXLOOM_TEST_WHISPER_MODEL"]
fn the_corpus_loses_no_last_word_and_gains_no_hallucination() {
    let model =
        std::path::PathBuf::from(std::env::var_os("VOXLOOM_TEST_WHISPER_MODEL").expect("set it"));
    let cfg = SpeechFilterConfig::default();
    let (mut dropped, mut halluc) = (vec![], vec![]);
    for clip in corpus() {
        let out = pipeline::transcribe_filtered(&clip.samples, 16_000, &cfg, &NoVad, |pcm| {
            engine::transcribe_pcm(&model, pcm, 16_000, &cfg)
        })
        .unwrap();
        println!("{}: {:?}", clip.name, out.raw_text);
        match clip.kind {
            Kind::TrailOff if !words(&out.raw_text).contains(&clip.word) => dropped.push(clip.name),
            Kind::Halluc if hallucinated(&out.raw_text) => halluc.push(clip.name),
            _ => {}
        }
    }
    println!("dropped last word: {dropped:?}; hallucinated tail: {halluc:?}");
    assert!(dropped.is_empty(), "dropped last word: {dropped:?}");
    assert!(halluc.is_empty(), "hallucinated tail: {halluc:?}");
}
