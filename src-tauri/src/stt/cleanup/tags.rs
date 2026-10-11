//! Strip known non-speech tags (`[Music]`, `(coughs)`, `*applause*`) and
//! music symbols; collapse identical tags repeated back to back.

use super::lists::{is_sound_tag, MUSIC_SYMBOLS};

/// Closing delimiter for a tag opener.
fn closer(open: char) -> Option<char> {
    match open {
        '[' => Some(']'),
        '(' => Some(')'),
        '*' => Some('*'),
        _ => None,
    }
}

/// Byte length of the tag starting at `rest` (opener included), if `rest`
/// begins with a complete single-line, non-nested tag.
fn tag_len(rest: &str) -> Option<usize> {
    let open = rest.chars().next()?;
    let close = closer(open)?;
    let body = &rest[open.len_utf8()..];
    for (i, c) in body.char_indices() {
        if c == close {
            if i == 0 {
                return None; // "[]" / "**": not a tag
            }
            return Some(open.len_utf8() + i + close.len_utf8());
        }
        if c == '\n' || (c != close && closer(c).is_some() && c != '*') {
            return None; // newline or nested opener
        }
    }
    None
}

fn inner(tag: &str) -> &str {
    let open = tag.chars().next().map_or(0, char::len_utf8);
    let close = tag.chars().last().map_or(0, char::len_utf8);
    &tag[open..tag.len() - close]
}

/// Remove known sound tags and music symbols. Unknown tags are kept, but an
/// unknown tag identical to the immediately preceding one is dropped.
pub fn strip_tags(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut last_kept_tag: Option<String> = None;
    let mut i = 0;
    while i < text.len() {
        let rest = &text[i..];
        let c = rest.chars().next().unwrap_or(' ');
        if MUSIC_SYMBOLS.contains(&c) {
            out.push(' ');
            i += c.len_utf8();
            continue;
        }
        if let Some(len) = tag_len(rest) {
            let tag = &rest[..len];
            let key = super::lists::normalize_key(inner(tag));
            if is_sound_tag(inner(tag)) || last_kept_tag.as_deref() == Some(key.as_str()) {
                out.push(' ');
            } else {
                out.push_str(tag);
                last_kept_tag = Some(key);
            }
            i += len;
            continue;
        }
        if !c.is_whitespace() {
            last_kept_tag = None;
        }
        out.push(c);
        i += c.len_utf8();
    }
    out
}
