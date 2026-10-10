//! Transcript guards and user-facing native error text.

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

/// Error text for a ⌘V whose effect could not be read back. The text may be
/// in the page already; TS shows "May have been pasted — also copied".
pub const UNVERIFIED_PASTE: &str = "⌘V sent but could not be verified — may have been pasted";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_empty_or_nul_text() {
        assert!(check_insert_text("").is_err());
        assert!(check_insert_text("a\0b").is_err());
        assert!(check_insert_text("héllo 👋 你好").is_ok());
    }
}
