//! BUS-138 PR C: with a dictionary prompt set, silence and very short clips
//! must not come out as the dictionary. Real Whisper model, so not run in CI:
//!
//! ```sh
//! VOXLOOM_TEST_WHISPER_MODEL=/path/ggml-base.en.bin \
//!   cargo test --lib --features whisper with_dictionary_silence -- --ignored --nocapture
//! ```

use super::engine::transcribe_pcm;
use super::filter_config::SpeechFilterConfig;
use super::with_dictionary::{echoes_dictionary, transcribe_with_dictionary};

const RATE: u32 = 16_000;

fn dictionary() -> Vec<String> {
    [
        "Voxloom",
        "Notion",
        "Kubernetes",
        "Zentrix",
        "Anthropic",
        "Grafana",
        "Skylane",
    ]
    .map(String::from)
    .to_vec()
}

/// Reproducible white noise at roughly `rms`.
fn noise(ms: usize, rms: f32) -> Vec<f32> {
    let mut x: u32 = 0x1234_5678;
    (0..ms * 16)
        .map(|_| {
            x = x.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            ((x >> 8) as f32 / 8_388_608.0 - 1.0) * rms * 3f32.sqrt()
        })
        .collect()
}

fn click(ms: usize) -> Vec<f32> {
    let mut v = vec![0.0; ms * 16];
    v[ms * 8] = 0.5;
    v[ms * 8 + 1] = -0.4;
    v
}

fn clips() -> Vec<(String, Vec<f32>)> {
    let mut out = vec![("silence 2000 ms".to_owned(), vec![0.0; 32_000])];
    for rms in [0.003, 0.006, 0.01, 0.02] {
        for ms in [2_000, 600, 250, 100] {
            out.push((format!("noise rms {rms} {ms} ms"), noise(ms, rms)));
        }
    }
    for ms in [2_000, 300, 100] {
        out.push((format!("click in silence {ms} ms"), click(ms)));
    }
    out
}

#[test]
#[ignore = "needs VOXLOOM_TEST_WHISPER_MODEL"]
fn silence_and_short_clips_do_not_echo_the_dictionary() {
    let model =
        std::path::PathBuf::from(std::env::var_os("VOXLOOM_TEST_WHISPER_MODEL").expect("set it"));
    let cfg = SpeechFilterConfig::default();
    let dict = dictionary();
    let (mut echoed_raw, mut leaked) = (vec![], vec![]);
    for (name, pcm) in clips() {
        let raw = transcribe_pcm(&model, &pcm, RATE, &cfg, &dict).map(|t| t.raw_text);
        let none = transcribe_pcm(&model, &pcm, RATE, &cfg, &[]).map(|t| t.raw_text);
        let shipped = transcribe_with_dictionary(&model, &pcm, RATE, &cfg, &dict).unwrap();
        println!(
            "{name}: no prompt {none:?} | prompt, raw {raw:?} | shipped {:?} {:?}",
            shipped.text, shipped.dropped
        );
        if raw.as_ref().is_ok_and(|t| echoes_dictionary(t, &dict)) {
            echoed_raw.push(name.clone());
        }
        if echoes_dictionary(&shipped.text, &dict) {
            leaked.push(name);
        }
    }
    println!("whisper echoed the prompt on: {echoed_raw:?}");
    assert!(
        leaked.is_empty(),
        "dictionary words reached the output: {leaked:?}"
    );
}
