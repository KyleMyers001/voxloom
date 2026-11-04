//! BUS-138 PR C: silence, noise and very short clips with a dictionary set
//! must come out exactly as they do without one (quiet clips) and must never
//! come out as the dictionary. Real Whisper model, so not run in CI:
//!
//! ```sh
//! VOXLOOM_TEST_WHISPER_MODEL=/path/ggml-base.en.bin \
//!   cargo test --lib --features whisper with_dictionary_silence -- --ignored --nocapture
//! ```

use super::filter_config::SpeechFilterConfig;
use super::gate::AudioStats;
use super::with_dictionary::transcribe_with_dictionary;

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

/// Only dictionary words (or the prompt's label): what an echo looks like.
fn is_dictionary_only(text: &str, dict: &[String]) -> bool {
    let known: Vec<String> = dict.iter().map(|w| w.to_lowercase()).collect();
    let words: Vec<String> = text
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(str::to_lowercase)
        .collect();
    !words.is_empty() && words.iter().all(|w| w == "glossary" || known.contains(w))
}

#[test]
#[ignore = "needs VOXLOOM_TEST_WHISPER_MODEL"]
fn quiet_clips_are_unchanged_by_a_dictionary_and_nothing_echoes_it() {
    let model =
        std::path::PathBuf::from(std::env::var_os("VOXLOOM_TEST_WHISPER_MODEL").expect("set it"));
    let cfg = SpeechFilterConfig::default();
    let dict = dictionary();
    let (mut changed_quiet, mut echoed, mut differs_loud) = (vec![], vec![], vec![]);
    for (name, pcm) in clips() {
        let main = transcribe_with_dictionary(&model, &pcm, RATE, &cfg, &[]).unwrap();
        let with = transcribe_with_dictionary(&model, &pcm, RATE, &cfg, &dict).unwrap();
        let quiet = AudioStats::measure(&pcm).is_quiet(&cfg);
        println!(
            "{name} (quiet {quiet}): main {:?} {:?} | dictionary {:?} {:?}",
            main.text, main.dropped, with.text, with.dropped
        );
        if (main.text.as_str(), main.dropped) != (with.text.as_str(), with.dropped) {
            if quiet {
                changed_quiet.push(name.clone());
            } else {
                differs_loud.push(name.clone());
            }
        }
        if is_dictionary_only(&with.text, &dict) {
            echoed.push(name);
        }
    }
    println!("quiet clips changed by the dictionary: {changed_quiet:?}");
    println!("loud-noise clips whose output differs: {differs_loud:?}");
    println!("clips that came out as the dictionary: {echoed:?}");
    assert!(changed_quiet.is_empty(), "{changed_quiet:?}");
    assert!(echoed.is_empty(), "{echoed:?}");
}
