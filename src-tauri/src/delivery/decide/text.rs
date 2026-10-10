//! Transcript guards and Unicode key-event chunking.

/// Refuse text that would be silently mangled: an empty AXSelectedText write
/// deletes the user's selection, and interior NULs truncate CFStrings.
pub fn check_insert_text(text: &str) -> Result<(), String> {
    if text.is_empty() {
        return Err("empty transcript — insert skipped".into());
    }
    if text.contains('\0') {
        return Err("transcript contains NUL — insert skipped".into());
    }
    Ok(())
}

/// Max UTF-16 units per CGEventKeyboardSetUnicodeString event (AppKit limit).
pub const KEY_EVENT_UTF16_MAX: usize = 20;

/// Split into UTF-16 chunks of at most `max` units, never splitting a
/// surrogate pair (emoji) across key events.
pub fn utf16_chunks(text: &str, max: usize) -> Vec<Vec<u16>> {
    let mut chunks: Vec<Vec<u16>> = Vec::new();
    let mut cur: Vec<u16> = Vec::new();
    let mut buf = [0u16; 2];
    for ch in text.chars() {
        let units = ch.encode_utf16(&mut buf);
        if !cur.is_empty() && cur.len() + units.len() > max.max(2) {
            chunks.push(std::mem::take(&mut cur));
        }
        cur.extend_from_slice(units);
    }
    if !cur.is_empty() {
        chunks.push(cur);
    }
    chunks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_empty_or_nul_text() {
        assert!(check_insert_text("").is_err());
        assert!(check_insert_text("a\0b").is_err());
        assert!(check_insert_text("héllo 👋 你好").is_ok());
    }

    #[test]
    fn chunks_respect_limit_and_surrogates() {
        let text = "a".repeat(19) + "👋" + "bc";
        let chunks = utf16_chunks(&text, KEY_EVENT_UTF16_MAX);
        assert!(chunks.iter().all(|c| c.len() <= KEY_EVENT_UTF16_MAX));
        assert_eq!(chunks[0].len(), 19); // emoji (2 units) moved to next chunk
        let joined: Vec<u16> = chunks.concat();
        assert_eq!(String::from_utf16(&joined).unwrap(), text);
        assert!(utf16_chunks("", 20).is_empty());
    }
}
