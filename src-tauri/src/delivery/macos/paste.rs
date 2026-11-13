//! macOS side of the paste route (terminals, Messages, and the BUS-223 native
//! field fallback): preflight facts, NSPasteboard and one ⌘V. All policy and
//! ordering live in `decide::paste`.

use super::ax::AXIsProcessTrusted;
use super::{host, keylayout, pasteboard, typing};
use crate::delivery::decide::paste::PasteHost;

#[link(name = "Carbon", kind = "framework")]
extern "C" {
    fn IsSecureEventInputEnabled() -> u8;
}

pub struct MacPaste<'a> {
    /// The app that was frontmost when the paste began.
    pub pid: i32,
    /// The native field fallback (BUS-223) also needs the focused field to
    /// still be the validated one; the terminal route has no field (None).
    pub still_field: Option<&'a dyn Fn() -> Result<(), String>>,
}

impl MacPaste<'_> {
    fn still_frontmost(&self) -> Result<(), String> {
        if host::frontmost_pid() != Some(self.pid) {
            return Err("frontmost app changed — paste skipped".into());
        }
        match self.still_field {
            Some(still_field) => still_field().map_err(|e| format!("{e} — paste skipped")),
            None => Ok(()),
        }
    }
}

impl PasteHost for MacPaste<'_> {
    type Saved = pasteboard::Snapshot;

    fn preflight(&self) -> Result<(), String> {
        if unsafe { AXIsProcessTrusted() } == 0 {
            return Err("Accessibility permission denied at paste — paste skipped".into());
        }
        if !typing::can_post_events() {
            return Err("event-posting permission denied — paste skipped".into());
        }
        if unsafe { IsSecureEventInputEnabled() } != 0 {
            return Err("Secure Keyboard Entry is on — paste skipped".into());
        }
        self.still_frontmost()
    }

    fn snapshot(&self) -> Option<Self::Saved> {
        pasteboard::snapshot()
    }

    fn write_transient(&self, text: &str) -> Result<i64, String> {
        pasteboard::write_transient(text)
    }

    fn post_paste(&self) -> Result<(), String> {
        let keycode = keylayout::v_keycode();
        // CGEventPost targets whatever is frontmost: check right before it.
        // The check/post race is unavoidable, as for Terminal typing.
        self.still_frontmost()?;
        typing::post_key_chord(keycode, typing::FLAG_COMMAND)
    }

    fn change_count(&self) -> i64 {
        pasteboard::change_count()
    }

    fn restore(&self, saved: &Self::Saved) -> Result<(), String> {
        pasteboard::restore(saved)
    }

    fn wait(&self, ms: u64) {
        std::thread::sleep(std::time::Duration::from_millis(ms));
    }
}
