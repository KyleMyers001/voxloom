use super::*;
use std::cell::{Cell, RefCell};

/// Records every call. `Saved` is the clipboard text; the fake pasteboard
/// bumps its change count on each write, like NSPasteboard.
struct Fake {
    calls: RefCell<Vec<String>>,
    board: RefCell<String>,
    count: Cell<i64>,
    can_snapshot: bool,
    preflight_err: Option<&'static str>,
    write_err: bool,
    /// The transient marker could not be attached (the real glue fails before
    /// touching the pasteboard).
    marker_err: bool,
    post_err: bool,
    restore_err: bool,
    /// Simulates the user copying something while ⌘V is being handled.
    user_copies_during_wait: Option<&'static str>,
}

impl Fake {
    fn new(prior: &str) -> Self {
        Self {
            calls: RefCell::default(),
            board: RefCell::new(prior.into()),
            count: Cell::new(10),
            can_snapshot: true,
            preflight_err: None,
            write_err: false,
            marker_err: false,
            post_err: false,
            restore_err: false,
            user_copies_during_wait: None,
        }
    }
    fn log(&self, call: &str) {
        self.calls.borrow_mut().push(call.into());
    }
    fn calls(&self) -> Vec<String> {
        self.calls.borrow().clone()
    }
    fn write(&self, text: &str) {
        *self.board.borrow_mut() = text.into();
        self.count.set(self.count.get() + 1);
    }
}

impl PasteHost for Fake {
    type Saved = String;
    fn preflight(&self) -> Result<(), String> {
        self.log("preflight");
        self.preflight_err.map_or(Ok(()), |e| Err(e.into()))
    }
    fn snapshot(&self) -> Option<String> {
        self.log("snapshot");
        self.can_snapshot.then(|| self.board.borrow().clone())
    }
    fn write_transient(&self, text: &str) -> Result<i64, String> {
        self.log("write");
        if self.marker_err {
            require_marker(false)?;
        }
        self.write(text);
        if self.write_err {
            return Err("pasteboard write failed".into());
        }
        Ok(self.count.get())
    }
    fn post_paste(&self) -> Result<(), String> {
        self.log("post");
        if self.post_err {
            return Err("frontmost app changed".into());
        }
        Ok(())
    }
    fn change_count(&self) -> i64 {
        self.count.get()
    }
    fn restore(&self, saved: &String) -> Result<(), String> {
        self.log("restore");
        if self.restore_err {
            return Err("pasteboard busy".into());
        }
        self.write(saved);
        Ok(())
    }
    fn wait(&self, ms: u64) {
        self.log(&format!("wait {ms}"));
        if let Some(text) = self.user_copies_during_wait {
            self.write(text);
        }
    }
}

#[test]
fn pastes_then_restores_the_prior_clipboard_after_the_delay() {
    let host = Fake::new("my notes");
    let report = paste_text(&host, "hello world").unwrap();
    assert_eq!(
        host.calls(),
        [
            "preflight",
            "snapshot",
            "write",
            "post",
            "wait 500",
            "restore"
        ]
    );
    assert_eq!(CLIPBOARD_RESTORE_DELAY_MS, 500);
    assert_eq!(*host.board.borrow(), "my notes");
    assert_eq!(
        report,
        PasteReport {
            clipboard_restored: true,
            restore_skipped_reason: None
        }
    );
}

#[test]
fn an_empty_prior_clipboard_is_restored_too() {
    let host = Fake::new("");
    assert!(paste_text(&host, "hi").unwrap().clipboard_restored);
    assert_eq!(*host.board.borrow(), "");
}

#[test]
fn a_copy_made_meanwhile_is_never_clobbered() {
    let mut host = Fake::new("my notes");
    host.user_copies_during_wait = Some("fresh copy");
    let report = paste_text(&host, "hello").unwrap();
    assert!(!report.clipboard_restored);
    assert_eq!(
        report.restore_skipped_reason.as_deref(),
        Some("clipboard changed during paste — left as-is")
    );
    assert!(!host.calls().contains(&"restore".to_string()));
    assert_eq!(*host.board.borrow(), "fresh copy");
}

#[test]
fn an_unsavable_clipboard_still_pastes_and_says_it_was_not_restored() {
    let mut host = Fake::new("my notes");
    host.can_snapshot = false;
    let report = paste_text(&host, "hello").unwrap();
    assert!(host.calls().contains(&"post".to_string()));
    assert!(!host.calls().contains(&"restore".to_string()));
    assert!(!report.clipboard_restored);
    assert_eq!(
        report.restore_skipped_reason.as_deref(),
        Some("prior clipboard could not be saved")
    );
}

#[test]
fn a_failed_restore_is_reported_not_hidden() {
    let mut host = Fake::new("my notes");
    host.restore_err = true;
    let report = paste_text(&host, "hello").unwrap();
    assert!(!report.clipboard_restored);
    assert_eq!(
        report.restore_skipped_reason.as_deref(),
        Some("restore did not complete: pasteboard busy")
    );
}

#[test]
fn unsafe_text_is_refused_before_anything_happens() {
    for text in [
        "",
        "a\nb",
        "a\rb",
        "tab\there",
        "a\u{2028}b",
        "a\u{0}b",
        "esc\u{1b}",
    ] {
        let host = Fake::new("my notes");
        assert!(paste_text(&host, text).is_err(), "{text:?}");
        assert!(host.calls().is_empty(), "{text:?}: {:?}", host.calls());
    }
    let host = Fake::new("x");
    assert!(paste_text(&host, &"a".repeat(4097)).is_err());
    assert!(host.calls().is_empty());
}

#[test]
fn a_failed_preflight_never_touches_the_clipboard() {
    let mut host = Fake::new("my notes");
    host.preflight_err = Some("Secure Keyboard Entry is on — paste skipped");
    let error = paste_text(&host, "hello").unwrap_err();
    assert!(error.contains("Secure Keyboard Entry"));
    assert_eq!(host.calls(), ["preflight"]);
    assert_eq!(host.count.get(), 10);
}

#[test]
fn a_failed_post_is_an_error_and_puts_the_clipboard_back() {
    let mut host = Fake::new("my notes");
    host.post_err = true;
    assert_eq!(
        paste_text(&host, "hello").unwrap_err(),
        "frontmost app changed"
    );
    assert_eq!(*host.board.borrow(), "my notes");
    assert!(!host.calls().iter().any(|c| c.starts_with("wait")));
}

#[test]
fn a_failed_write_is_an_error_and_puts_the_clipboard_back() {
    let mut host = Fake::new("my notes");
    host.write_err = true;
    assert_eq!(
        paste_text(&host, "hello").unwrap_err(),
        "pasteboard write failed"
    );
    assert!(!host.calls().contains(&"post".to_string()));
    assert_eq!(*host.board.borrow(), "my notes");
}

#[test]
fn a_transcript_that_cannot_be_marked_transient_is_never_pasted() {
    assert!(require_marker(true).is_ok());
    let mut host = Fake::new("my notes");
    host.marker_err = true;
    let error = paste_text(&host, "hello").unwrap_err();
    assert!(
        error.contains("transient") && error.ends_with("paste skipped"),
        "{error}"
    );
    // No ⌘V, no wait, and the user's clipboard is exactly what it was.
    assert!(!host.calls().contains(&"post".to_string()));
    assert!(!host.calls().iter().any(|c| c.starts_with("wait")));
    assert_eq!(*host.board.borrow(), "my notes");
}
