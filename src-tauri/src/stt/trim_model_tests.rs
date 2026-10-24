//! Real-model check: speech plus a silent tail must not gain a hallucinated
//! trailing "Thank you." / "you". Use a raw recording that keeps its own
//! room noise after the last word (e.g. LibriSpeech 1272-128104-0001) and
//! does not itself end in "you"; the zeros appended here then follow that
//! noise, as after a noise gate. Not run in CI:
//!
//! ```sh
//! ffmpeg -i speech.wav -ar 16000 -ac 1 -f s16le speech.pcm
//! VOXLOOM_TEST_WHISPER_MODEL=/path/ggml-base.en.bin \
//! VOXLOOM_TEST_SPEECH_PCM=speech.pcm \
//!   cargo test --lib --features whisper trim::model_tests -- --ignored
//! ```

use crate::stt::{engine, filter_config::SpeechFilterConfig, gate::NoVad, pipeline};

fn env_path(name: &str) -> std::path::PathBuf {
    std::env::var_os(name)
        .unwrap_or_else(|| panic!("set {name}"))
        .into()
}

#[test]
#[ignore = "needs VOXLOOM_TEST_WHISPER_MODEL and VOXLOOM_TEST_SPEECH_PCM"]
fn silent_tail_adds_no_trailing_hallucination() {
    let model = env_path("VOXLOOM_TEST_WHISPER_MODEL");
    let bytes = std::fs::read(env_path("VOXLOOM_TEST_SPEECH_PCM")).unwrap();
    let mut samples: Vec<f32> = bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|&b| f32::from(i16::from_le_bytes(b)) / 32_768.0)
        .collect();
    samples.extend(std::iter::repeat_n(0.0, 40_000)); // 2.5 s
    let cfg = SpeechFilterConfig::default();
    let out = pipeline::transcribe_filtered(&samples, 16_000, &cfg, &NoVad, |pcm| {
        engine::transcribe_pcm(&model, pcm, 16_000, &cfg)
    })
    .unwrap();
    let tail = out
        .raw_text
        .to_lowercase()
        .trim_end_matches(|c: char| !c.is_alphanumeric())
        .to_owned();
    assert!(!out.text.is_empty(), "speech was transcribed");
    for phrase in ["thank you", " you"] {
        assert!(
            !tail.ends_with(phrase),
            "hallucinated tail: {:?}",
            out.raw_text
        );
    }
}
