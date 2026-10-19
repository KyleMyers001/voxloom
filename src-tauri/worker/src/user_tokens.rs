//! Keep dictated text from turning into Qwen3's user-defined tokens.
//!
//! Tokenizing with special-token parsing off only escapes CONTROL tokens
//! (`<|im_end|>` …). llama.cpp still matches USER_DEFINED tokens (`<think>`,
//! `</think>`, `<tool_call>` …) anywhere in the text, so "I said </think>"
//! would reach the model as the real tag. Split the text so no piece contains
//! such a string: each occurrence is tokenized as its first character plus
//! the rest. The pieces concatenate back to the exact original text.

use llama_cpp_2::model::LlamaModel;
use llama_cpp_2::token::LlamaToken;
use llama_cpp_2::token_type::LlamaTokenAttr;

/// Tokenize dictated text as plain text: no CONTROL or USER_DEFINED ids.
pub fn tokenize(model: &LlamaModel, text: &str) -> Vec<LlamaToken> {
    let vocab = model.vocab();
    split(text, &user_defined(model))
        .into_iter()
        .flat_map(|piece| vocab.tokenize(piece.as_bytes(), false, false))
        .collect()
}

/// Every USER_DEFINED token's text in the model vocab.
pub fn user_defined(model: &LlamaModel) -> Vec<String> {
    let vocab = model.vocab();
    (0..vocab.n_tokens())
        .map(LlamaToken)
        .filter(|token| vocab.attr(*token).contains(LlamaTokenAttr::UserDefined))
        .filter_map(|token| vocab.text(token)?.to_str().ok().map(str::to_owned))
        .collect()
}

/// Split `text` into pieces, none of which contains a string from `tokens`.
/// Single-character tokens cannot be split and are left alone.
pub fn split<'a>(text: &'a str, tokens: &[String]) -> Vec<&'a str> {
    let mut pieces = Vec::new();
    let mut rest = text;
    while let Some((at, token)) = first_match(rest, tokens) {
        let first = token.chars().next().map_or(0, char::len_utf8);
        push(&mut pieces, &rest[..at + first]);
        rest = &rest[at + first..];
    }
    push(&mut pieces, rest);
    pieces
}

/// The earliest occurrence of any splittable token. Tokens starting at the
/// same place split at the same character, so which one wins doesn't matter.
fn first_match<'t>(text: &str, tokens: &'t [String]) -> Option<(usize, &'t str)> {
    tokens
        .iter()
        .filter(|token| token.chars().nth(1).is_some())
        .filter_map(|token| text.find(token.as_str()).map(|at| (at, token.as_str())))
        .min_by_key(|(at, _)| *at)
}

fn push<'a>(pieces: &mut Vec<&'a str>, piece: &'a str) {
    if !piece.is_empty() {
        pieces.push(piece);
    }
}

#[cfg(test)]
mod tests {
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

    /// Real vocab: `VOXLOOM_TEST_CLEANUP_MODEL=<Qwen3 gguf> cargo test --release -- --ignored`
    #[test]
    #[ignore = "needs a real Qwen3 GGUF in VOXLOOM_TEST_CLEANUP_MODEL"]
    fn real_vocab_keeps_dictated_tags_as_text() {
        use llama_cpp_2::llama_backend::LlamaBackend;
        use llama_cpp_2::model::params::LlamaModelParams;

        let path = std::env::var("VOXLOOM_TEST_CLEANUP_MODEL").expect("model path");
        let backend = LlamaBackend::init().unwrap();
        let params = LlamaModelParams::default().with_n_gpu_layers(0);
        let model = LlamaModel::load_from_file(&backend, path, &params).unwrap();
        let vocab = model.vocab();
        let user = user_defined(&model);
        for tag in ["<think>", "</think>", "<tool_call>", "</tool_call>"] {
            assert!(
                user.iter().any(|token| token == tag),
                "{tag} not USER_DEFINED: {user:?}"
            );
        }
        let text = "I said </think> and then <think> okay <tool_call>{}</tool_call> <|im_end|>";
        // Without the split the tags tokenize to their real ids.
        let raw = vocab.tokenize(text.as_bytes(), false, false);
        assert!(raw
            .iter()
            .any(|token| vocab.attr(*token).contains(LlamaTokenAttr::UserDefined)));
        let tokens = tokenize(&model, text);
        for token in &tokens {
            let attr = vocab.attr(*token);
            assert!(
                !attr.contains(LlamaTokenAttr::UserDefined)
                    && !attr.contains(LlamaTokenAttr::Control),
                "special id {} in dictated text",
                token.0
            );
        }
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
}
