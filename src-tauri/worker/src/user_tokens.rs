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
/// Single-character tokens cannot be split and are left alone. One pass
/// over the text (BUS-16 10554 item 3: the earlier earliest-match loop
/// searched the rest again after every cut, quadratic in the tag count).
pub fn split<'a>(text: &'a str, tokens: &[String]) -> Vec<&'a str> {
    let splittable: Vec<&str> = tokens
        .iter()
        .map(String::as_str)
        .filter(|token| token.chars().nth(1).is_some())
        .collect();
    let mut pieces = Vec::new();
    let mut start = 0;
    for (at, first) in text.char_indices() {
        // A token starting here is cut after its first character, so no
        // piece holds it whole. Tokens starting at the same place share that
        // character, so which one matched doesn't matter.
        if splittable.iter().any(|token| text[at..].starts_with(token)) {
            let cut = at + first.len_utf8();
            push(&mut pieces, &text[start..cut]);
            start = cut;
        }
    }
    push(&mut pieces, &text[start..]);
    pieces
}

fn push<'a>(pieces: &mut Vec<&'a str>, piece: &'a str) {
    if !piece.is_empty() {
        pieces.push(piece);
    }
}

#[cfg(test)]
#[path = "user_tokens_tests.rs"]
mod tests;
