//! macOS side of the terminal paste route: preflight facts, NSPasteboard and
//! one ⌘V. All policy and ordering live in `decide::paste`.

use super::ax::AXIsProcessTrusted;
use super::{host, keylayout, pasteboard, typing};
use crate::delivery::decide::paste::PasteHost;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn CGPreflightPostEventAccess() -> bool;
}

#[link(name = "Carbon", kind = "framework")]
extern "C" {
    fn IsSecureEventInputEnabled() -> u8;
}

pub struct MacPaste {
    /// The terminal that was frontmost when the paste began.
    pub pid: i32,
}

impl MacPaste {
    fn still_frontmost(&self) -> Result<(), String> {
        if host::frontmost_pid() == Some(self.pid) {
            Ok(())
        } else {
            Err("frontmost app changed — paste skipped".into())
        }
    }
}

impl PasteHost for MacPaste {
    type Saved = pasteboard::Snapshot;

    fn preflight(&self) -> Result<(), String> {
        if unsafe { AXIsProcessTrusted() } == 0 {
            return Err("Accessibility permission denied at paste — paste skipped".into());
        }
        if !unsafe { CGPreflightPostEventAccess() } {
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
