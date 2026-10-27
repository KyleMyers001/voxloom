//! Tests for user_tokens.rs.

use super::*;

fn qwen3() -> Vec<String> {
    ["</tool_call>", "<tool_call>", "</think>", "<think>"]
        .map(str::to_owned)
        .to_vec()
}

fn assert_neutral(text: &str, tokens: &[String]) -> Vec<String> {
    let pieces = split(text, tokens);
    assert_eq!(pieces.concat(), text, "pieces must round-trip");
    for piece in &pieces {
        for token in tokens.iter().filter(|token| token.chars().nth(1).is_some()) {
            assert!(
                !piece.contains(token.as_str()),
                "{piece:?} still holds {token:?}"
            );
        }
    }
    pieces.into_iter().map(str::to_owned).collect()
}

#[test]
fn dictated_think_tags_become_plain_pieces() {
    let pieces = assert_neutral("I said </think> and then <think> okay", &qwen3());
    assert_eq!(
        pieces,
        ["I said <", "/think> and then <", "think> okay"].map(str::to_owned)
    );
}

#[test]
fn adjacent_nested_and_repeated_tags_round_trip() {
    for text in [
        "<think></think>",
        "<<think>>",
        "</tool_call></tool_call>",
        "x<tool_call>y</think>z",
        "<think>",
        "ünïcode <think> ✓",
    ] {
        assert_neutral(text, &qwen3());
    }
}

#[test]
fn text_without_tags_is_one_piece() {
    assert_eq!(split("hello <b> there", &qwen3()), ["hello <b> there"]);
    assert!(split("", &qwen3()).is_empty());
}

/// A real Qwen3 model from `VOXLOOM_TEST_CLEANUP_MODEL` (CPU only).
fn real_model() -> (llama_cpp_2::llama_backend::LlamaBackend, LlamaModel) {
    use llama_cpp_2::llama_backend::LlamaBackend;
    use llama_cpp_2::model::params::LlamaModelParams;

    let path = std::env::var("VOXLOOM_TEST_CLEANUP_MODEL").expect("model path");
    let backend = LlamaBackend::init().unwrap();
    let params = LlamaModelParams::default().with_n_gpu_layers(0);
    let model = LlamaModel::load_from_file(&backend, path, &params).unwrap();
    (backend, model)
}

const DICTATED: &str = "I said </think> and then <think> okay <tool_call>{}</tool_call> <|im_end|>";

fn assert_plain(model: &LlamaModel, tokens: &[LlamaToken]) {
    let vocab = model.vocab();
    for token in tokens {
        let attr = vocab.attr(*token);
        assert!(
            !attr.contains(LlamaTokenAttr::UserDefined) && !attr.contains(LlamaTokenAttr::Control),
            "special id {} in dictated text",
            token.0
        );
    }
}

/// Real vocab: `VOXLOOM_TEST_CLEANUP_MODEL=<Qwen3 gguf> cargo test --release -- --ignored`
#[test]
#[ignore = "needs a real Qwen3 GGUF in VOXLOOM_TEST_CLEANUP_MODEL"]
fn real_vocab_keeps_dictated_tags_as_text() {
    let (_backend, model) = real_model();
    let vocab = model.vocab();
    let user = user_defined(&model);
    for tag in ["<think>", "</think>", "<tool_call>", "</tool_call>"] {
        assert!(
            user.iter().any(|token| token == tag),
            "{tag} not USER_DEFINED: {user:?}"
        );
    }
    let text = DICTATED;
    // Without the split the tags tokenize to their real ids.
    let raw = vocab.tokenize(text.as_bytes(), false, false);
    assert!(raw
        .iter()
        .any(|token| vocab.attr(*token).contains(LlamaTokenAttr::UserDefined)));
    let tokens = tokenize(&model, text);
    assert_plain(&model, &tokens);
    assert_chat_tokens_keep_dictated_tags_as_text(&model);
    let round_trip: Vec<u8> = tokens
        .iter()
        .flat_map(|token| vocab.token_to_piece(*token, false, None))
        .collect();
    assert_eq!(String::from_utf8(round_trip).unwrap(), text);
}

#[test]
fn single_character_tokens_are_left_alone() {
    let tokens = ["¶".to_owned()];
    assert_eq!(split("a ¶ b", &tokens), ["a ¶ b"]);
}

/// The engine's real token stream (BUS-16 10554 item 2, mutants E1 and E4):
/// the template parts may hold special ids, the dictated text between them
/// may not. Fails if the engine tokenizes the prompt with special parsing
/// on (E1) or skips `user_tokens` (E4). Part of the real-vocab test, since
/// llama.cpp's backend can be initialised only once per process.
fn assert_chat_tokens_keep_dictated_tags_as_text(model: &LlamaModel) {
    let vocab = model.vocab();
    let tokens = crate::engine::chat_tokens(model, DICTATED);
    let prefix = vocab.tokenize(crate::template::PREFIX.as_bytes(), false, true);
    let template = model.chat_template(None).ok();
    let template = template.as_ref().and_then(|t| t.to_str().ok());
    let suffix = vocab.tokenize(crate::template::suffix(template).as_bytes(), false, true);
    assert!(tokens.starts_with(&prefix) && tokens.ends_with(&suffix));
    let dictated = &tokens[prefix.len()..tokens.len() - suffix.len()];
    assert_eq!(dictated, tokenize(model, DICTATED).as_slice());
    assert_plain(model, dictated);
    let text: Vec<u8> = dictated
        .iter()
        .flat_map(|token| vocab.token_to_piece(*token, false, None))
        .collect();
    assert_eq!(String::from_utf8(text).unwrap(), DICTATED);
}

/// The earlier earliest-match algorithm, kept as the reference.
fn reference_split<'a>(text: &'a str, tokens: &[String]) -> Vec<&'a str> {
    let mut pieces = Vec::new();
    let mut rest = text;
    loop {
        let found = tokens
            .iter()
            .filter(|token| token.chars().nth(1).is_some())
            .filter_map(|token| rest.find(token.as_str()).map(|at| (at, token.as_str())))
            .min_by_key(|(at, _)| *at);
        let Some((at, token)) = found else { break };
        let first = token.chars().next().map_or(0, char::len_utf8);
        push(&mut pieces, &rest[..at + first]);
        rest = &rest[at + first..];
    }
    push(&mut pieces, rest);
    pieces
}

#[test]
fn the_single_pass_split_matches_the_reference() {
    // Every sequence of up to 6 parts from an alphabet that builds the tags,
    // their overlaps and a multi-byte character.
    let alphabet = ["<", "/", "think>", "tool_call>", "ü", "x"];
    let mut level = vec![String::new()];
    let mut texts = level.clone();
    for _ in 0..6 {
        level = level
            .iter()
            .flat_map(|text| alphabet.iter().map(move |part| format!("{text}{part}")))
            .collect();
        texts.extend(level.iter().cloned());
    }
    let mut tokens = qwen3();
    tokens.push("¶".to_owned());
    for text in &texts {
        assert_eq!(
            split(text, &tokens),
            reference_split(text, &tokens),
            "{text:?}"
        );
    }
}

#[test]
fn a_long_run_of_tags_splits_in_linear_time() {
    // 128 KiB of tags took about 2 s with the quadratic loop (10554 item 3).
    let text = "<think>".repeat(128 * 1024 / 7);
    let started = std::time::Instant::now();
    let pieces = assert_neutral(&text, &qwen3());
    assert_eq!(pieces.len(), 128 * 1024 / 7 + 1);
    assert!(
        started.elapsed() < std::time::Duration::from_secs(2),
        "{:?}",
        started.elapsed()
    );
}
