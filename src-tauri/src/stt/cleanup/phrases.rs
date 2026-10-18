//! Silence hallucinations and trailing YouTube-style outros.

use super::lists::{
    normalize_phrase, SILENCE_HALLUCINATIONS, TRAILING_OUTROS, TRAILING_OUTRO_PREFIXES,
};

/// Split into sentences on `.`/`!`/`?` followed by whitespace or the end.
/// Each returned slice keeps its terminal punctuation.
pub fn sentences(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    for (k, &(i, c)) in chars.iter().enumerate() {
        if !matches!(c, '.' | '!' | '?') {
            continue;
        }
        let next = chars.get(k + 1).map(|&(_, n)| n);
        if next.is_none_or(char::is_whitespace) {
            let end = i + c.len_utf8();
            let piece = text[start..end].trim();
            if !piece.is_empty() {
                out.push(piece);
            }
            start = end;
        }
    }
    let tail = text[start..].trim();
    if !tail.is_empty() {
        out.push(tail);
    }
    out
}

/// True when every sentence of `text` is a known silence hallucination
/// (e.g. "Thank you." or "Thank you. Thank you."). Empty text is false.
pub fn is_only_hallucination(text: &str) -> bool {
    let parts = sentences(text);
    !parts.is_empty()
        && parts
            .iter()
            .all(|p| SILENCE_HALLUCINATIONS.contains(&normalize_phrase(p).as_str()))
}

fn is_outro(sentence: &str) -> bool {
    let key = normalize_phrase(sentence);
    TRAILING_OUTROS.contains(&key.as_str())
        || TRAILING_OUTRO_PREFIXES
            .iter()
            .any(|p| key == *p || key.starts_with(&format!("{p} ")))
}

/// Remove YouTube-style outros that end the text, but only when real
/// dictation precedes them (a lone outro is left to the quiet-clip rule).
pub fn strip_trailing_outros(text: &str) -> String {
    let mut parts = sentences(text);
    while parts.len() > 1 && parts.last().is_some_and(|s| is_outro(s)) {
        parts.pop();
    }
    if parts.len() == sentences(text).len() {
        return text.to_owned();
    }
    let keep_end = parts
        .last()
        .map(|last| last.as_ptr() as usize - text.as_ptr() as usize + last.len())
        .unwrap_or(0);
    text[..keep_end].to_owned()
}
