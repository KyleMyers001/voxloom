//! Clipboard paste route for apps that expose no insertable AX field
//! (WezTerm, Alacritty, kitty, Ghostty, iTerm2, Apple Messages), and the
//! BUS-223 ⌘V fallback for native fields AX refuses (`paste_into_field`).
//! Pure orchestration over `PasteHost`; the macOS adapter supplies the
//! pasteboard and ⌘V.
//!
//! Contract (as `delivery_insert_text`): `Err` means ⌘V was not posted. After
//! it was, the result is `Ok`, with the clipboard restore reported honestly.

use super::report::PasteReport;
use super::terminal::check_terminal_text;
use super::text::check_insert_text;

/// How long the transcript stays on the clipboard after ⌘V before the user's
/// own clipboard is restored. A terminal reads the pasteboard when it handles
/// the key; one that is slower than this would paste the *restored* contents.
/// That slow-terminal race is known and not handled here (no completion signal
/// exists), so this is a tuning constant.
pub const CLIPBOARD_RESTORE_DELAY_MS: u64 = 500;

/// The same delay for the native field fallback. Office (Word, Excel,
/// PowerPoint) can take well over 500 ms to read the pasteboard on ⌘V, and
/// a restore before that would paste the user's old clipboard instead.
pub const FIELD_RESTORE_DELAY_MS: u64 = 1500;

pub trait PasteHost {
    /// The user's clipboard, whole (every item and type).
    type Saved;
    /// Trust, event access, Secure Keyboard Entry off, frontmost app is a
    /// supported terminal. Must not touch the pasteboard.
    fn preflight(&self) -> Result<(), String>;
    /// None when the clipboard cannot be copied in full.
    fn snapshot(&self) -> Option<Self::Saved>;
    /// Replace the clipboard with `text` (marked transient). Returns the
    /// pasteboard change count right after our write.
    fn write_transient(&self, text: &str) -> Result<i64, String>;
    /// Re-check the frontmost app, then post one ⌘V. Err = nothing posted.
    fn post_paste(&self) -> Result<(), String>;
    fn change_count(&self) -> i64;
    fn restore(&self, saved: &Self::Saved) -> Result<(), String>;
    fn wait(&self, ms: u64);
}

/// The transient marker keeps clipboard managers from recording the
/// transcript. If it cannot be attached, the transcript must not go on the
/// clipboard at all: `write_transient` returns this `Err` before it touches
/// the pasteboard, so nothing is pasted and the user's clipboard is untouched.
pub fn require_marker(attached: bool) -> Result<(), String> {
    if attached {
        Ok(())
    } else {
        Err("could not mark the clipboard copy as transient — paste skipped".into())
    }
}

pub fn paste_text<H: PasteHost>(host: &H, text: &str) -> Result<PasteReport, String> {
    check_terminal_text(text)?;
    paste_checked(host, text, CLIPBOARD_RESTORE_DELAY_MS)
}

/// The native field fallback. Terminals never come here, and web content only
/// with single-line text (`fallback::may_paste`), so the text otherwise keeps
/// the AX write's contract (`check_insert_text`).
pub fn paste_into_field<H: PasteHost>(host: &H, text: &str) -> Result<PasteReport, String> {
    check_insert_text(text)?;
    paste_checked(host, text, FIELD_RESTORE_DELAY_MS)
}

fn paste_checked<H: PasteHost>(
    host: &H,
    text: &str,
    restore_delay_ms: u64,
) -> Result<PasteReport, String> {
    host.preflight()?;
    let saved = host.snapshot();
    let ours = match host.write_transient(text) {
        Ok(count) => count,
        Err(error) => {
            // The write may have cleared the clipboard before failing.
            if let Some(saved) = &saved {
                let _ = host.restore(saved);
            }
            return Err(error);
        }
    };
    if let Err(error) = host.post_paste() {
        let _ = restore_if_unchanged(host, saved, ours);
        return Err(error);
    }
    host.wait(restore_delay_ms);
    Ok(match restore_if_unchanged(host, saved, ours) {
        Ok(()) => PasteReport {
            clipboard_restored: true,
            restore_skipped_reason: None,
        },
        Err(reason) => PasteReport {
            clipboard_restored: false,
            restore_skipped_reason: Some(reason),
        },
    })
}

/// Put the user's clipboard back only if nothing but us wrote to it since:
/// a change count other than ours means the user (or a clipboard manager)
/// copied something, and that copy must not be clobbered.
fn restore_if_unchanged<H: PasteHost>(
    host: &H,
    saved: Option<H::Saved>,
    ours: i64,
) -> Result<(), String> {
    let saved = saved.ok_or("prior clipboard could not be saved")?;
    if host.change_count() != ours {
        return Err("clipboard changed during paste — left as-is".into());
    }
    host.restore(&saved)
        .map_err(|e| format!("restore did not complete: {e}"))
}

#[cfg(test)]
#[path = "paste_tests.rs"]
mod tests;
