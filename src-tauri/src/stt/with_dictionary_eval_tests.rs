//! BUS-138 PR C: the corpus of the PR B2 dictionary eval, spoken by an offline
//! TTS voice, through real Whisper with and without the dictionary prompt.
//! Not run in CI (needs a model and audio):
//!
//! ```sh
//! scripts/dictionary-prompt-eval-tts.py VOICE.onnx /tmp/prompt-eval-audio
//! VOXLOOM_TEST_WHISPER_MODEL=/path/ggml-base.en.bin \
//! VOXLOOM_TEST_PROMPT_EVAL_AUDIO=/tmp/prompt-eval-audio \
//!   cargo test --lib --features whisper with_dictionary_eval -- --ignored --nocapture
//! ```
//!
//! `VOXLOOM_EVAL_OUT=/tmp/eval.json` also writes every transcript. TTS speech
//! is not a person's voice and this is CPU Whisper: indicative, not a
//! measure of real dictation or of Metal. It reports; it asserts nothing.

use super::filter_config::SpeechFilterConfig;
use super::with_dictionary::transcribe_with_dictionary;

#[derive(serde::Deserialize)]
struct Corpus {
    dictionary: Vec<String>,
    items: Vec<Item>,
}

#[derive(serde::Deserialize)]
struct Item {
    id: String,
    kind: String,
    #[serde(default)]
    expect: Vec<String>,
}

fn corpus() -> Corpus {
    serde_json::from_str(include_str!("fixtures/dictionary_prompt/corpus.json")).unwrap()
}

fn pcm(dir: &std::path::Path, id: &str) -> Vec<f32> {
    let bytes = std::fs::read(dir.join(format!("{id}.s16"))).unwrap();
    (bytes.chunks_exact(2))
        .map(|b| f32::from(i16::from_le_bytes([b[0], b[1]])) / 32_768.0)
        .collect()
}

/// `word` as a whole word, spelled exactly (`exact`) or in any case.
fn mentions(text: &str, word: &str, exact: bool) -> bool {
    let (text, word) = if exact {
        (text.to_owned(), word.to_owned())
    } else {
        (text.to_lowercase(), word.to_lowercase())
    };
    text.match_indices(&word).any(|(i, m)| {
        let before = text[..i].chars().next_back();
        let after = text[i + m.len()..].chars().next();
        !before.is_some_and(char::is_alphanumeric) && !after.is_some_and(char::is_alphanumeric)
    })
}

#[derive(Default, serde::Serialize)]
struct Tally {
    fix_sentences_right: usize,
    words_right: usize,
    words_expected: usize,
    keep_sentences_changed: Vec<String>,
}

#[test]
#[ignore = "needs VOXLOOM_TEST_WHISPER_MODEL and VOXLOOM_TEST_PROMPT_EVAL_AUDIO"]
fn the_prompt_against_no_prompt_on_the_corpus() {
    let model =
        std::path::PathBuf::from(std::env::var_os("VOXLOOM_TEST_WHISPER_MODEL").expect("set it"));
    let audio = std::path::PathBuf::from(
        std::env::var_os("VOXLOOM_TEST_PROMPT_EVAL_AUDIO").expect("set it"),
    );
    let cfg = SpeechFilterConfig::default();
    let corpus = corpus();
    let mut tallies = [Tally::default(), Tally::default()]; // main, prompt
    let mut rows = vec![];
    for item in &corpus.items {
        let samples = pcm(&audio, &item.id);
        let mut texts = vec![];
        for (i, dictionary) in [&[][..], &corpus.dictionary[..]].into_iter().enumerate() {
            let out = transcribe_with_dictionary(&model, &samples, 16_000, &cfg, dictionary)
                .unwrap()
                .raw_text;
            let tally = &mut tallies[i];
            if item.kind == "fix" {
                let right = item
                    .expect
                    .iter()
                    .filter(|w| mentions(&out, w, true))
                    .count();
                tally.words_right += right;
                tally.words_expected += item.expect.len();
                tally.fix_sentences_right += usize::from(right == item.expect.len());
            } else if corpus.dictionary.iter().any(|w| mentions(&out, w, false)) {
                tally.keep_sentences_changed.push(item.id.clone());
            }
            texts.push(out);
        }
        println!("{}: main {:?} | prompt {:?}", item.id, texts[0], texts[1]);
        rows.push(serde_json::json!({"id": item.id, "main": texts[0], "prompt": texts[1]}));
    }
    // A keep sentence counts as falsely changed when its transcript holds a
    // dictionary word. Some already do without a prompt (look-alike TTS
    // speech), so `from_prompt` lists only the ones the prompt added.
    let from_prompt: Vec<&String> = (tallies[1].keep_sentences_changed.iter())
        .filter(|id| !tallies[0].keep_sentences_changed.contains(id))
        .collect();
    let summary = serde_json::json!({
        "main": tallies[0],
        "prompt": tallies[1],
        "keep_false_changes_from_prompt": from_prompt,
    });
    println!("{summary}");
    if let Some(path) = std::env::var_os("VOXLOOM_EVAL_OUT") {
        let body = serde_json::json!({"rows": rows, "summary": summary});
        std::fs::write(path, serde_json::to_string_pretty(&body).unwrap()).unwrap();
    }
}
