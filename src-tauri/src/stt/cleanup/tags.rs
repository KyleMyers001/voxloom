//! Strip known non-speech tags (`[Music]`, `(coughs)`, `*applause*`) and
//! music symbols. Repeated sound tags disappear with each removal.

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

/// Split `text` around known sound tags and music symbols.
///
/// Returns `None` when nothing was removed (the caller keeps the text
/// byte-for-byte). Otherwise returns the kept pieces; a removal sits
/// between every pair of adjacent pieces. Unknown tags such as `(I think)`,
/// `[sic]` or an empty `()` are kept verbatim, including repeats.
pub fn strip_tags(text: &str) -> Option<Vec<&str>> {
    let mut pieces = Vec::new();
    let mut piece_start = 0;
    let mut removed = false;
    let mut i = 0;
    while i < text.len() {
        let rest = &text[i..];
        let c = rest.chars().next().unwrap_or(' ');
        let cut = if MUSIC_SYMBOLS.contains(&c) {
            Some(c.len_utf8())
        } else {
            tag_len(rest).filter(|&len| is_sound_tag(inner(&rest[..len])))
        };
        match cut {
            Some(len) => {
                pieces.push(&text[piece_start..i]);
                removed = true;
                i += len;
                piece_start = i;
            }
            None => {
                // Skip a whole unknown tag so its inner text is not re-scanned.
                i += tag_len(rest).unwrap_or(c.len_utf8());
            }
        }
    }
    pieces.push(&text[piece_start..]);
    removed.then_some(pieces)
}
